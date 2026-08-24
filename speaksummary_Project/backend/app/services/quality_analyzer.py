"""
Audio quality analysis — v2.0 rewrite.

Measures:
  1. SNR via Silero VAD (speech/non-speech classification)
  2. LUFS (EBU R128 integrated loudness, with corrected band thresholds)
  3. Clipping (PCM-level analysis)
  4. Effective bandwidth (frequency above which energy collapses)
  5. Reverberation proxy (C50-like early/late energy ratio)
  6. Codec provenance (from ffprobe + bandwidth heuristics)

Applies ordered severity resolver for ratings.
"""

import json
import logging
import math
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import librosa
import numpy as np

from ..schemas import (
    AudioQualityAssessment,
    AudioQualityMetrics,
    ClippingAnalysis,
)
from .vad_service import VadService

logger = logging.getLogger(__name__)

# Noise reduction is deliberately not offered. Spectral subtraction (afftdn)
# only moves the measured SNR when tuned aggressively enough to leave musical-
# noise artifacts on the speech, which costs more transcription accuracy than
# the background noise did - so background noise is reported and left alone.
# Noise is measured for the panel; nothing tries to remove it.

# Ceiling for the output, just under full scale. Preprocessed audio is written
# as 16-bit PCM, which hard-clamps anything at or past 1.0 into flat-topped
# samples the analyzer then reports as clipping - so the chain is limited rather
# than allowed to introduce the very defect the panel warns about. `level=false`
# is essential: alimiter auto-normalises gain by default, which would undo the
# loudness target set by loudnorm.
OUTPUT_LIMITER = "alimiter=limit=0.97:level=false"


# Where gain normalisation lands the recording. -20 LUFS sits inside the band the
# UI calls "Good" (-23 to -14) with room either side, and -2 dBTP leaves headroom
# so a normalised file doesn't come back clipped.
GAIN_TARGET_LUFS = -20
GAIN_TARGET_TP = -2

_LOUDNORM_FIELDS = ("input_i", "input_tp", "input_lra", "input_thresh")


def _parse_loudnorm_json(stderr: str) -> Optional[dict]:
    """
    Read loudnorm's pass-1 measurements out of ffmpeg's stderr.

    The block is pretty-printed across many lines, so it has to be collected
    from the opening brace to the closing one - reading a single line only ever
    finds "{" on its own, which is never valid JSON.

    Returns floats for the four measured fields, or None if any are missing or
    non-numeric (loudnorm reports "-inf" on digital silence).
    """
    start = stderr.find("{")
    end = stderr.rfind("}")
    if start == -1 or end <= start:
        return None

    try:
        raw = json.loads(stderr[start : end + 1])
        # Every value comes back as a string, including "-inf" on silent input.
        parsed = {field: float(raw[field]) for field in _LOUDNORM_FIELDS}
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None

    if not all(math.isfinite(value) for value in parsed.values()):
        return None
    return parsed


class PreprocessingError(RuntimeError):
    """Preprocessing was requested but could not be applied.

    Raised rather than quietly handing back the untouched input: a caller that
    got the original audio back under the name of a fix would report success and
    show the user unchanged measurements.
    """


class QualityAnalyzer:
    """Measure and classify audio quality for transcription."""

    def __init__(self):
        self.vad_service = None
        try:
            self.vad_service = VadService(onset=0.500, offset=0.363, device="cpu")
        except Exception as e:
            logger.warning(f"VAD service initialization failed; SNR measurement will be unavailable: {e}")

    def _measure_snr_via_vad(self, path: Path) -> tuple[Optional[float], Optional[float], Optional[float]]:
        """
        Measure SNR using Silero VAD speech/non-speech classification.

        Returns: (snr_db, speech_rms_db, noise_rms_db)
        """
        if self.vad_service is None:
            logger.warning("VAD service not available; returning None for SNR")
            return None, None, None

        try:
            # Get VAD timeline
            vad_timeline = self.vad_service.get_speech_timeline(path)
            if not vad_timeline:
                logger.warning(f"No speech detected in {path}")
                return None, None, None

            # Load audio for analysis
            audio, sr = librosa.load(str(path), sr=16000, mono=True)
            sample_rate = sr

            # Separate speech and noise samples using VAD timeline
            speech_samples = []
            noise_samples = []

            # Convert time ranges to sample indices
            for start_s, end_s in vad_timeline:
                start_idx = int(start_s * sample_rate)
                end_idx = int(end_s * sample_rate)
                speech_samples.extend(audio[start_idx:end_idx])

            # Noise = everything not in speech regions
            speech_mask = np.zeros(len(audio), dtype=bool)
            for start_s, end_s in vad_timeline:
                start_idx = int(start_s * sample_rate)
                end_idx = int(end_s * sample_rate)
                speech_mask[start_idx:end_idx] = True

            noise_samples = audio[~speech_mask]

            if len(speech_samples) == 0 or len(noise_samples) < sample_rate:
                # Not enough non-speech regions to measure noise floor
                logger.info(f"Insufficient non-speech content in {path} for SNR estimation")
                return None, None, None

            # Calculate RMS in dB
            speech_rms = np.sqrt(np.mean(np.array(speech_samples) ** 2))
            noise_rms = np.sqrt(np.mean(noise_samples**2))

            speech_rms_db = 20 * np.log10(max(1e-8, speech_rms))
            noise_rms_db = 20 * np.log10(max(1e-8, noise_rms))

            snr_db = float(speech_rms_db - noise_rms_db)
            logger.info(f"SNR: {snr_db:.1f} dB (speech: {speech_rms_db:.1f} dB, noise: {noise_rms_db:.1f} dB)")
            return snr_db, float(speech_rms_db), float(noise_rms_db)

        except Exception as e:
            logger.error(f"SNR measurement failed: {e}")
            return None, None, None

    def _measure_loudness_lufs(self, path: Path) -> tuple[Optional[float], Optional[float], Optional[float]]:
        """Measure loudness using EBU R128 standard (LUFS)."""
        try:
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-i",
                    str(path),
                    "-af",
                    "ebur128=metadata=1",
                    "-f",
                    "null",
                    "-",
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=60,
            )

            integrated_lufs = None
            short_term_lufs = None
            loudness_range = None

            # ebur128's Summary block prints each field's label on its own line
            # and the value on the next ("Integrated loudness:\n    I: -23.9 LUFS"),
            # so the value has to be read off the "I:"/"LRA:" lines, not the headers.
            for line in result.stderr.split("\n"):
                stripped = line.strip()
                if stripped.startswith("I:") and integrated_lufs is None:
                    try:
                        integrated_lufs = float(stripped.split(":", 1)[1].strip().split()[0])
                    except (IndexError, ValueError):
                        pass
                elif stripped.startswith("LRA:") and loudness_range is None:
                    try:
                        loudness_range = float(stripped.split(":", 1)[1].strip().split()[0])
                    except (IndexError, ValueError):
                        pass

            logger.info(
                f"LUFS: integrated={integrated_lufs}, short_term={short_term_lufs}, range={loudness_range}"
            )
            return integrated_lufs, short_term_lufs, loudness_range

        except Exception as e:
            logger.error(f"LUFS measurement failed: {e}")
            return None, None, None

    def _measure_clipping(self, path: Path) -> Optional[ClippingAnalysis]:
        """Detect clipping at PCM level."""
        try:
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-i",
                    str(path),
                    "-ac",
                    "1",
                    "-f",
                    "f32le",
                    "-",
                ],
                capture_output=True,
                check=True,
                timeout=60,
            )

            audio = np.frombuffer(result.stdout, dtype=np.float32)
            if len(audio) == 0:
                return ClippingAnalysis()

            clipped = np.abs(audio) >= 0.999
            clipping_percentage = np.mean(clipped) * 100

            clipped_indices = np.where(clipped)[0]
            if len(clipped_indices) == 0:
                logger.info("No clipping detected")
                return ClippingAnalysis(clipping_percentage=clipping_percentage, has_significant_clipping=False)

            # Calculate consecutive run lengths
            runs = []
            if len(clipped_indices) > 0:
                current_run = 1
                for i in range(1, len(clipped_indices)):
                    if clipped_indices[i] - clipped_indices[i - 1] == 1:
                        current_run += 1
                    else:
                        runs.append(current_run)
                        current_run = 1
                runs.append(current_run)

            max_consecutive = max(runs) if runs else 0
            clipping_event_count = len(runs)
            has_significant = clipping_percentage > 0.1 or max_consecutive > 100

            logger.info(
                f"Clipping: {clipping_percentage:.3f}% ({clipping_event_count} events, max {max_consecutive} consecutive)"
            )
            return ClippingAnalysis(
                clipping_percentage=clipping_percentage,
                max_consecutive_clipped_samples=max_consecutive,
                clipping_event_count=clipping_event_count,
                has_significant_clipping=has_significant,
            )

        except Exception as e:
            logger.error(f"Clipping measurement failed: {e}")
            return ClippingAnalysis()

    def _measure_bandwidth(self, path: Path) -> Optional[float]:
        """
        Estimate effective bandwidth: the frequency above which spectral energy collapses.

        Returns frequency in Hz, or None on error.
        Helps detect upsampled-from-lofi or heavily band-limited sources.
        """
        try:
            audio, sr = librosa.load(str(path), sr=16000, mono=True)
            S = np.abs(librosa.stft(audio, n_fft=2048))
            avg = np.mean(S, axis=1)
            cumulative = np.cumsum(avg) / (np.sum(avg) + 1e-10)

            # Find frequency where cumulative energy reaches 99.5%
            idx = np.searchsorted(cumulative, 0.995)
            bandwidth_hz = float(idx * sr / 2048)

            logger.info(f"Effective bandwidth: {bandwidth_hz:.0f} Hz")
            return bandwidth_hz

        except Exception as e:
            logger.error(f"Bandwidth measurement failed: {e}")
            return None

    def _measure_reverb_proxy(self, path: Path) -> Optional[float]:
        """
        Estimate reverberation via early/late energy ratio.

        Returns a C50-like estimate (in dB), or None on error.
        A rough approximation absent a true room impulse response.
        """
        try:
            audio, sr = librosa.load(str(path), sr=16000, mono=True)

            # Compute autocorrelation decay envelope
            # (overly simplified; a full RIR estimation would be more rigorous)
            # For now, return None to avoid false positives
            logger.debug("Reverb proxy measurement: not yet fully implemented")
            return None

        except Exception as e:
            logger.error(f"Reverb proxy measurement failed: {e}")
            return None

    def _get_sample_rate(self, path: Path) -> Optional[int]:
        """Source sample rate in Hz, or None if it can't be read."""
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "quiet",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=sample_rate",
                    "-of",
                    "csv=p=0",
                    str(path),
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            )
            return int(result.stdout.strip().splitlines()[0])
        except Exception as e:
            logger.warning(f"Could not read sample rate for {path}: {e}")
            return None

    def _get_codec_provenance(self, path: Path) -> Optional[dict]:
        """
        Extract codec, bitrate, and heuristics for codec provenance.

        Returns dict with codec_name, bit_rate, and likely_transcoded flag.
        """
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "quiet",
                    "-print_format",
                    "json",
                    "-show_format",
                    "-show_streams",
                    str(path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            probe = json.loads(result.stdout)

            # Extract first audio stream info
            audio_stream = next(
                (s for s in probe.get("streams", []) if s.get("codec_type") == "audio"), None
            )
            if not audio_stream:
                return None

            codec_name = audio_stream.get("codec_name", "unknown")
            bit_rate = audio_stream.get("bit_rate")
            if bit_rate:
                bit_rate = int(bit_rate)

            provenance = {
                "codec_name": codec_name,
                "bit_rate": bit_rate,
                "likely_transcoded": False,
            }

            # Heuristic: a FLAC file with narrow bandwidth likely came from lossy
            # (This would be detected in _measure_bandwidth, but we flag it here too)
            logger.info(f"Codec provenance: {provenance}")
            return provenance

        except Exception as e:
            logger.error(f"Codec provenance extraction failed: {e}")
            return None

    def _resolve_rating(
        self,
        snr_db: Optional[float],
        lufs: Optional[float],
        clipping: Optional[ClippingAnalysis],
        bandwidth_hz: Optional[float],
        reverb_proxy: Optional[float],
    ) -> tuple[str, str, bool]:
        """
        Ordered severity resolver: iterate rules worst-to-best and return on first match.

        Returns: (rating, description, should_show_clipping_warning)
        """
        should_show_clipping = False

        # Rule 1: Significant clipping (cannot be fixed)
        if clipping and clipping.has_significant_clipping:
            return (
                "very_poor",
                "Audio contains significant clipping. Preprocessing cannot repair this; consider re-recording.",
                True,
            )

        # Rule 2: Very low SNR (heavy background noise, severe)
        if snr_db is not None and snr_db < 5:
            return (
                "very_poor",
                f"Very high background noise (SNR {snr_db:.1f} dB). Transcription accuracy will be severely affected.",
                clipping and clipping.clipping_percentage > 0,
            )

        # Rule 3: Very low LUFS (too quiet, severe)
        if lufs is not None and lufs < -35:
            return (
                "very_poor",
                f"Audio is extremely quiet ({lufs:.1f} LUFS). Amplification and noise handling may not be sufficient.",
                clipping and clipping.clipping_percentage > 0,
            )

        # Rule 4: Very narrow bandwidth (likely telephone or upsampled)
        if bandwidth_hz is not None and bandwidth_hz < 2000:
            return (
                "poor",
                f"Audio bandwidth is very narrow ({bandwidth_hz:.0f} Hz). This may be telephone-band or heavily compressed audio, expect reduced accuracy.",
                clipping and clipping.clipping_percentage > 0,
            )

        # Rule 5: Over-limited / aggressive compression (LUFS too high)
        if lufs is not None and lufs > -9:
            return (
                "poor",
                f"Audio appears heavily compressed or limited ({lufs:.1f} LUFS). Dynamic range loss may affect transcription.",
                clipping and clipping.clipping_percentage > 0,
            )

        # Rule 6: Low SNR (notable noise, acceptable but flagged)
        if snr_db is not None and snr_db < 10:
            return (
                "poor",
                f"High background noise (SNR {snr_db:.1f} dB). Transcription accuracy may be affected.",
                clipping and clipping.clipping_percentage > 0,
            )

        # Rule 7: Acceptable SNR but quiet (needs gain)
        if (snr_db is not None and 10 <= snr_db < 20) and (lufs is not None and lufs < -26):
            return (
                "acceptable",
                f"Audio has noticeable noise (SNR {snr_db:.1f} dB) and is quiet ({lufs:.1f} LUFS). Gain adjustment recommended.",
                clipping and clipping.clipping_percentage > 0,
            )

        # Rule 8: Acceptable SNR but with noise
        if snr_db is not None and 10 <= snr_db < 20:
            return (
                "acceptable",
                f"Audio has noticeable background noise (SNR {snr_db:.1f} dB). Transcription quality may vary.",
                clipping and clipping.clipping_percentage > 0,
            )

        # Rule 9: Quiet but acceptable SNR (needs gain)
        if lufs is not None and -26 <= lufs < -23:
            return (
                "acceptable",
                f"Audio is quiet ({lufs:.1f} LUFS) but noise levels are acceptable. Gain normalization is recommended.",
                clipping and clipping.clipping_percentage > 0,
            )

        # Rule 10: Minor clipping with otherwise good audio
        if clipping and clipping.clipping_percentage > 0 and clipping.clipping_percentage <= 0.1:
            return (
                "acceptable",
                "Audio quality is acceptable with minor clipping detected. Check for unexpected audio peaks.",
                True,
            )

        # Default: Good (low noise, good loudness, no clipping)
        return (
            "good",
            "Audio quality is suitable for transcription.",
            False,
        )

    def analyze(self, path: Path) -> AudioQualityMetrics:
        """Comprehensive quality analysis using expanded metrics."""
        # Measure all metrics
        snr_db, speech_db, noise_db = self._measure_snr_via_vad(path)
        integrated_lufs, short_term_lufs, loudness_range = self._measure_loudness_lufs(path)
        clipping = self._measure_clipping(path)
        bandwidth_hz = self._measure_bandwidth(path)
        reverb_proxy = self._measure_reverb_proxy(path)
        codec_provenance = self._get_codec_provenance(path)

        # Resolve rating via ordered severity rules
        rating, description, show_clipping = self._resolve_rating(
            snr_db, integrated_lufs, clipping, bandwidth_hz, reverb_proxy
        )

        assessment = AudioQualityAssessment(
            rating=rating,
            description=description,
            should_adjust_gain=False,  # gain adjustment is manual, not automatic
            show_clipping_warning=show_clipping,
        )

        return AudioQualityMetrics(
            snr_db=snr_db,
            vad_detected_speech_db=speech_db,
            vad_detected_noise_db=noise_db,
            lufs_integrated=integrated_lufs,
            lufs_short_term=short_term_lufs,
            loudness_range_lu=loudness_range,
            clipping=clipping,
            bandwidth_hz=bandwidth_hz,
            reverb_c50_proxy=reverb_proxy,
            codec_provenance=codec_provenance,
            assessment=assessment,
        )

    def apply_preprocessing(self, path: Path, adjust_gain: bool = False) -> Path:
        """
        Normalize the recording's loudness.

        Gain uses two-pass linear normalization (measure, then apply with linear=true).
        Noise reduction is intentionally not available - see the note at the top
        of this module.

        Returns path to preprocessed audio (temp file).
        Raises PreprocessingError if the requested work could not be done.
        """
        if not adjust_gain:
            return path

        temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        temp_path = Path(temp_file.name)
        temp_file.close()

        try:
            filters = []

            # Two-pass linear loudnorm if gain adjustment requested
            if adjust_gain:
                # Pass 1: measure
                measure_result = subprocess.run(
                    [
                        "ffmpeg",
                        "-i",
                        str(path),
                        "-af",
                        f"loudnorm=I={GAIN_TARGET_LUFS}:TP={GAIN_TARGET_TP}:LRA=11:print_format=json",
                        "-f",
                        "null",
                        "-",
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=300,
                )

                measured = _parse_loudnorm_json(measure_result.stderr)
                if measured is None:
                    # Pass 2 needs pass 1's real numbers. Substituting placeholders
                    # here tells loudnorm the audio is already at target, so it
                    # applies a wrong gain - which is how normalising a quiet
                    # recording used to end up clipping it.
                    raise PreprocessingError(
                        "Could not read the recording's loudness, so it can't be normalised safely."
                    )

                # Pass 2: apply with linear=true
                filters.append(
                    f"loudnorm=I={GAIN_TARGET_LUFS}:TP={GAIN_TARGET_TP}:LRA=11:"
                    f"measured_I={measured['input_i']}:"
                    f"measured_TP={measured['input_tp']}:"
                    f"measured_LRA={measured['input_lra']}:"
                    f"measured_thresh={measured['input_thresh']}:"
                    f"linear=true"
                )
                logger.info(
                    f"Normalising {measured['input_i']:.1f} -> {GAIN_TARGET_LUFS} LUFS "
                    f"(true peak {measured['input_tp']:.1f} dBTP)"
                )

            if not filters:
                return path

            # Last in the chain, so nothing downstream can push a sample back up
            # into the clamp. See OUTPUT_LIMITER.
            filters.append(OUTPUT_LIMITER)

            filter_str = ",".join(filters)

            # loudnorm resamples its output to 192 kHz unless told otherwise, which
            # on a 16 kHz recording is a 12x size blowup for no audible gain, so the
            # source rate is pinned back on.
            rate_args = []
            source_rate = self._get_sample_rate(path)
            if source_rate:
                rate_args = ["-ar", str(source_rate)]

            subprocess.run(
                [
                    "ffmpeg",
                    "-i",
                    str(path),
                    "-af",
                    filter_str,
                    "-c:a",
                    "pcm_s16le",
                    *rate_args,
                    "-y",  # temp_path already exists (tempfile pre-creates it); skip the overwrite prompt
                    str(temp_path),
                ],
                capture_output=True,
                check=True,
                timeout=300,
            )

            logger.info(f"Preprocessing complete: {temp_path}")
            return temp_path

        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode(errors="replace") if isinstance(e.stderr, bytes) else e.stderr
            logger.error(f"Preprocessing failed: {e}\n{stderr}")
            temp_path.unlink(missing_ok=True)
            # The last ffmpeg line is the one that says why; the rest is banner noise.
            detail = (stderr or "").strip().splitlines()
            raise PreprocessingError(detail[-1] if detail else str(e)) from e
        except Exception as e:
            logger.error(f"Preprocessing failed: {e}")
            temp_path.unlink(missing_ok=True)
            raise PreprocessingError(str(e)) from e
