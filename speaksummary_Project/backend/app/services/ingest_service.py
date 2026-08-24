import hashlib
import json
import logging
import subprocess
import tempfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np

from ..config import Settings, get_settings
from ..schemas import (
    AudioQualityMetrics,
    AudioStream,
    ChannelIndependenceAnalysis,
    Manifest,
    ManifestChannelMode,
    PairwiseCorrelation,
    PerChannelStatistics,
    WindowedCorrelationAnalysis,
)
from .quality_analyzer import QualityAnalyzer

logger = logging.getLogger(__name__)
PIPELINE_VERSION = "2.0"


class IngestService:
    """Probe, register, and route ingested audio/video files."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.manifest_store: dict[str, Manifest] = {}
        self.quality_analyzer = QualityAnalyzer()

        # Initialize artifact cache directory
        if settings.artifact_cache_dir:
            self.cache_dir = Path(settings.artifact_cache_dir)
        else:
            self.cache_dir = Path(tempfile.gettempdir()) / "speak-summary-cache"

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"Artifact cache directory: {self.cache_dir}")

    def _hash_file(self, path: Path) -> str:
        """Compute SHA256 of file, streamed in 64KB chunks."""
        sha256 = hashlib.sha256()
        chunk_size = 64 * 1024
        with open(path, "rb") as f:
            while chunk := f.read(chunk_size):
                sha256.update(chunk)
        return sha256.hexdigest()

    def _run_ffprobe(self, path: Path) -> dict:
        """Probe file without decoding. Returns dict with format and streams."""
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
        return json.loads(result.stdout)

    def _detect_audio_streams(self, probe: dict) -> list[AudioStream]:
        """Extract audio stream metadata from ffprobe output."""
        streams = []
        for stream in probe.get("streams", []):
            if stream.get("codec_type") != "audio":
                continue

            streams.append(
                AudioStream(
                    index=stream.get("index", 0),
                    codec=stream.get("codec_name", "unknown"),
                    channels=stream.get("channels", 1),
                    channel_layout=stream.get("channel_layout"),
                    sample_rate=int(stream.get("sample_rate", 0)),
                    bit_rate=int(stream.get("bit_rate", 0)) if stream.get("bit_rate") else None,
                    duration_s=float(stream.get("duration", 0)) if stream.get("duration") else None,
                )
            )
        return streams

    def _validate_file(self, path: Path, probe: dict) -> tuple[bool, str]:
        """Validate file for basic issues. Returns (is_valid, reason)."""
        format_info = probe.get("format", {})
        streams = probe.get("streams", [])
        duration = float(format_info.get("duration", 0))

        # Check for audio stream
        audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
        if not audio_streams:
            return False, "No audio stream found in file"

        # Check for zero or negative duration
        if duration <= 0:
            return False, "File has zero or invalid duration"

        # Sanity check: duration vs file size
        # Rough heuristic: audio should be 10KB-10MB per second
        file_size_kb = path.stat().st_size / 1024
        if file_size_kb > 0:
            kb_per_second = file_size_kb / duration
            if kb_per_second < 1 or kb_per_second > 10000:
                return False, f"File size ({file_size_kb:.0f}KB) inconsistent with duration ({duration:.1f}s)"

        return True, ""

    def _extract_per_channel_statistics(
        self, path: Path, channel_count: int, duration_s: float
    ) -> list[PerChannelStatistics]:
        """Extract per-channel statistics (RMS, peak, silence, clipping) using FFmpeg astats."""
        stats = []
        try:
            # Use astats to get detailed per-channel metrics
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-i",
                    str(path),
                    "-af",
                    "astats=metadata=1:reset=1,silencedetect=n=-40dB:d=0.5",
                    "-f",
                    "null",
                    "-",
                ],
                capture_output=True,
                text=True,
                check=False,
            )

            # Parse astats output for each channel
            for ch_idx in range(channel_count):
                rms_db = None
                peak_db = None
                dynamic_range = None
                clipping_ratio = 0.0

                for line in result.stderr.split("\n"):
                    if f"Channel: {ch_idx}" in line or f"[astats" in line:
                        # Look ahead for channel-specific metrics
                        continue

                    # Peak level for channel
                    if f"Peak level dB" in line and not "Overall" in line:
                        try:
                            parts = line.split("Peak level dB: ")
                            if len(parts) > 1:
                                peak_db = float(parts[1].split()[0])
                        except (IndexError, ValueError):
                            pass

                    # RMS level
                    if f"Mean   level dB" in line:
                        try:
                            parts = line.split("Mean   level dB: ")
                            if len(parts) > 1:
                                rms_db = float(parts[1].split()[0])
                        except (IndexError, ValueError):
                            pass

                    # Dynamic range
                    if "Dynamic range" in line:
                        try:
                            parts = line.split("Dynamic range: ")
                            if len(parts) > 1:
                                dynamic_range = float(parts[1].split()[0])
                        except (IndexError, ValueError):
                            pass

                # Calculate clipping ratio (peak near 0dB)
                if peak_db is not None and peak_db > -0.5:
                    clipping_ratio = 0.05  # Rough heuristic

                # Estimate silence ratio from RMS
                silence_ratio = None
                if rms_db is not None:
                    # If RMS is very low (< -60dB), assume mostly silent
                    silence_ratio = min(1.0, max(0.0, (-rms_db - 40) / 20))

                stats.append(
                    PerChannelStatistics(
                        index=ch_idx,
                        rms_db=rms_db,
                        peak_db=peak_db,
                        silence_ratio=silence_ratio,
                        clipping_ratio=clipping_ratio if clipping_ratio > 0 else None,
                        dynamic_range_db=dynamic_range,
                    )
                )

        except Exception:
            # Fallback: create basic stats
            for ch_idx in range(channel_count):
                stats.append(PerChannelStatistics(index=ch_idx))

        return stats

    def _calculate_windowed_correlation(
        self, path: Path, duration_s: float, channel_count: int = 2, window_size_s: float = 10.0
    ) -> WindowedCorrelationAnalysis | None:
        """
        Compute correlation in multiple windows throughout the recording.
        Avoids false positives where independent sources happen to overlap.
        """
        if channel_count < 2:
            return None

        correlations = []
        try:
            # Sample every window_size_s seconds
            num_windows = max(1, int(duration_s / window_size_s))
            window_size = min(window_size_s, duration_s)

            for i in range(num_windows):
                start_time = (duration_s - window_size) * (i / max(1, num_windows - 1)) if num_windows > 1 else 0

                result = subprocess.run(
                    [
                        "ffmpeg",
                        "-ss",
                        str(start_time),
                        "-t",
                        str(window_size),
                        "-i",
                        str(path),
                        "-ac",
                        str(channel_count),
                        "-f",
                        "f32le",
                        "-",
                    ],
                    capture_output=True,
                    check=True,
                    timeout=30,
                )

                samples = np.frombuffer(result.stdout, dtype=np.float32)
                if len(samples) < channel_count * 2:
                    continue

                # Separate channels
                channels_data = [samples[ch::channel_count] for ch in range(channel_count)]

                # Correlation between first two channels
                if len(channels_data) >= 2:
                    ch0 = channels_data[0]
                    ch1 = channels_data[1]
                    if len(ch0) > 1 and len(ch1) > 1:
                        corr = np.corrcoef(ch0, ch1)[0, 1]
                        if not np.isnan(corr):
                            correlations.append(float(corr))

        except Exception:
            pass

        if not correlations:
            return None

        return WindowedCorrelationAnalysis(
            window_size_s=window_size_s,
            windows=correlations,
            mean_correlation=float(np.mean(correlations)),
            max_correlation=float(np.max(correlations)),
            min_correlation=float(np.min(correlations)),
        )

    def _analyze_channel_independence(
        self, path: Path, streams: list[AudioStream], duration_s: float
    ) -> ChannelIndependenceAnalysis:
        """
        Comprehensive channel independence analysis.
        Returns classification (mono/mixed/independent/unknown) with forensic detail.
        """
        # Single stream → mono
        if len(streams) != 1:
            return ChannelIndependenceAnalysis(
                channel_count=len(streams),
                per_channel_stats=[],
                pairwise_correlations=[],
                independence_score=0.0,
                classification="mono",
                rationale=f"Multiple discrete audio streams ({len(streams)} streams)",
            )

        stream = streams[0]
        channel_count = stream.channels

        # True mono
        if channel_count == 1:
            return ChannelIndependenceAnalysis(
                channel_count=1,
                per_channel_stats=[PerChannelStatistics(index=0)],
                pairwise_correlations=[],
                independence_score=0.0,
                classification="mono",
                rationale="Single-channel audio",
            )

        # Multi-channel: extract statistics
        per_channel_stats = self._extract_per_channel_statistics(path, channel_count, duration_s)

        # Compute pairwise correlations with windowing
        windowed = self._calculate_windowed_correlation(path, duration_s, channel_count, window_size_s=10.0)

        pairwise_corrs = []
        mean_correlation = 0.0

        if windowed and windowed.windows:
            mean_correlation = windowed.mean_correlation
            # Create a pairwise entry for the primary correlation
            if channel_count >= 2:
                pairwise_corrs.append(
                    PairwiseCorrelation(
                        channel_a=0,
                        channel_b=1,
                        correlation=mean_correlation,
                    )
                )
        else:
            # Fallback single-point correlation
            try:
                sample_duration = min(30, duration_s * 0.5)
                start_time = max(0, (duration_s - sample_duration) / 2)

                result = subprocess.run(
                    [
                        "ffmpeg",
                        "-ss",
                        str(start_time),
                        "-t",
                        str(sample_duration),
                        "-i",
                        str(path),
                        "-ac",
                        str(channel_count),
                        "-f",
                        "f32le",
                        "-",
                    ],
                    capture_output=True,
                    check=True,
                    timeout=30,
                )

                samples = np.frombuffer(result.stdout, dtype=np.float32)
                if len(samples) >= channel_count * 2:
                    channels_data = [samples[ch::channel_count] for ch in range(channel_count)]
                    if len(channels_data) >= 2:
                        corr = np.corrcoef(channels_data[0], channels_data[1])[0, 1]
                        if not np.isnan(corr):
                            mean_correlation = float(corr)
                            pairwise_corrs.append(
                                PairwiseCorrelation(
                                    channel_a=0,
                                    channel_b=1,
                                    correlation=mean_correlation,
                                )
                            )
            except Exception:
                pass

        # Classify based on correlations and statistics
        independence_score = 1.0 - min(1.0, max(0.0, mean_correlation))
        if mean_correlation > 0.98:
            classification = "mixed"
            rationale = f"High correlation ({mean_correlation:.3f}) indicates channels are duplicated or heavily mixed"
        elif mean_correlation > 0.70:
            classification = "mixed"
            rationale = f"Moderate-to-high correlation ({mean_correlation:.3f}) suggests significant overlap"
        elif mean_correlation > 0.40:
            classification = "unknown"
            rationale = f"Moderate correlation ({mean_correlation:.3f}); inconclusive independence"
        else:
            classification = "independent"
            rationale = f"Low correlation ({mean_correlation:.3f}) indicates substantially different signals"

        # Check for extreme level differences (one channel much quieter)
        if len(per_channel_stats) >= 2:
            rms_values = [s.rms_db for s in per_channel_stats if s.rms_db is not None]
            if len(rms_values) >= 2:
                rms_diff = max(rms_values) - min(rms_values)
                if rms_diff > 20:
                    # Huge level difference → likely independent sources
                    classification = "independent"
                    rationale = f"Large RMS difference ({rms_diff:.1f}dB) indicates independent sources"

        return ChannelIndependenceAnalysis(
            channel_count=channel_count,
            per_channel_stats=per_channel_stats,
            pairwise_correlations=pairwise_corrs,
            windowed_analysis=windowed,
            independence_score=independence_score,
            classification=classification,
            rationale=rationale,
        )

    def _derive_artifacts(
        self, path: Path, channel_mode: ManifestChannelMode, cache_dir: Path
    ) -> tuple[str | None, str | None, list[str], list[str]]:
        """
        Derive and cache audio artifacts:
        - asr_16k_mono: 16kHz, mono, pcm_s16le, for speech recognition
        - diar_16k: 16kHz, mono or per-channel, for diarization

        Returns: (asr_path, asr_sha256, diar_paths, diar_sha256s)
        """
        asr_path = None
        asr_sha256 = None
        diar_paths = []
        diar_sha256s = []

        try:
            # Derive asr_16k_mono (always mono, 16kHz, from unpreprocessed source)
            asr_artifact_path = cache_dir / "asr_16k_mono.wav"
            if not asr_artifact_path.exists():
                subprocess.run(
                    [
                        "ffmpeg",
                        "-nostdin",
                        "-threads",
                        "1",
                        "-i",
                        str(path),
                        "-vn",
                        "-sn",
                        "-dn",
                        "-ac",
                        "1",
                        "-ar",
                        "16000",
                        "-c:a",
                        "pcm_s16le",
                        "-af",
                        "aresample=resampler=soxr:precision=28:dither_method=triangular",
                        str(asr_artifact_path),
                    ],
                    capture_output=True,
                    check=True,
                    timeout=300,
                )
                logger.info(f"Derived ASR artifact: {asr_artifact_path}")
            else:
                logger.info(f"ASR artifact already cached: {asr_artifact_path}")

            asr_path = str(asr_artifact_path)
            asr_sha256 = self._hash_file(asr_artifact_path)

            # Derive diar_16k based on channel mode
            if channel_mode.mode in ("mono", "stereo_duplicate"):
                diar_artifact_path = cache_dir / "diar_16k.wav"
                if not diar_artifact_path.exists():
                    subprocess.run(
                        [
                            "ffmpeg",
                            "-nostdin",
                            "-threads",
                            "1",
                            "-i",
                            str(path),
                            "-vn",
                            "-sn",
                            "-dn",
                            "-ac",
                            "1",
                            "-ar",
                            "16000",
                            "-c:a",
                            "pcm_s16le",
                            "-af",
                            "aresample=resampler=soxr:precision=28:dither_method=triangular",
                            str(diar_artifact_path),
                        ],
                        capture_output=True,
                        check=True,
                        timeout=300,
                    )
                    logger.info(f"Derived diarization artifact: {diar_artifact_path}")
                else:
                    logger.info(f"Diarization artifact already cached: {diar_artifact_path}")

                diar_paths.append(str(diar_artifact_path))
                diar_sha256s.append(self._hash_file(diar_artifact_path))
            else:
                # Per-channel mode: create one artifact per channel
                for ch_idx in range(channel_mode.num_discrete_channels):
                    diar_artifact_path = cache_dir / f"diar_16k_ch{ch_idx}.wav"
                    if not diar_artifact_path.exists():
                        subprocess.run(
                            [
                                "ffmpeg",
                                "-nostdin",
                                "-threads",
                                "1",
                                "-i",
                                str(path),
                                "-vn",
                                "-sn",
                                "-dn",
                                "-map_channel",
                                f"0.0.{ch_idx}",
                                "-ar",
                                "16000",
                                "-c:a",
                                "pcm_s16le",
                                "-af",
                                "aresample=resampler=soxr:precision=28:dither_method=triangular",
                                str(diar_artifact_path),
                            ],
                            capture_output=True,
                            check=True,
                            timeout=300,
                        )
                        logger.info(f"Derived per-channel diarization artifact: {diar_artifact_path}")
                    else:
                        logger.info(f"Per-channel diarization artifact already cached: {diar_artifact_path}")

                    diar_paths.append(str(diar_artifact_path))
                    diar_sha256s.append(self._hash_file(diar_artifact_path))

        except Exception as e:
            logger.error(f"Artifact derivation failed: {e}")
            raise

        return asr_path, asr_sha256, diar_paths, diar_sha256s

    def _detect_channel_mode(
        self, streams: list[AudioStream], path: Path, duration_s: float
    ) -> ManifestChannelMode:
        """
        Determine channel routing using comprehensive independence analysis.
        Routes to: mono, stereo_distinct, stereo_duplicate, or per_channel.
        """
        # Multiple discrete audio streams (e.g., multi-track interview)
        if len(streams) > 1:
            num_discrete = len(streams)
            return ManifestChannelMode(
                mode="per_channel",
                description=f"{num_discrete} discrete audio streams (per-stream transcription, skip diarization)",
                num_discrete_channels=num_discrete,
            )

        # Single stream: analyze independence
        analysis = self._analyze_channel_independence(path, streams, duration_s)
        stream = streams[0]

        # Route based on analysis classification
        if analysis.classification == "mono" or stream.channels == 1:
            return ManifestChannelMode(
                mode="mono",
                description="Mono audio (single channel or declared mono)",
                num_discrete_channels=1,
                analysis=analysis,
            )

        if stream.channels == 2:
            # Stereo: check for duplication
            if analysis.classification == "mixed":
                # High correlation → channels are duplicated
                mean_corr = analysis.pairwise_correlations[0].correlation if analysis.pairwise_correlations else 0.0
                return ManifestChannelMode(
                    mode="stereo_duplicate",
                    description=f"Stereo container but channels are highly correlated (r={mean_corr:.3f}), treating as mono",
                    num_discrete_channels=1,
                    correlation=mean_corr,
                    analysis=analysis,
                )

            # Independent or inconclusive: treat as distinct stereo mix
            mean_corr = analysis.pairwise_correlations[0].correlation if analysis.pairwise_correlations else 0.0
            return ManifestChannelMode(
                mode="stereo_distinct",
                description=f"Stereo with distinct channels (r={mean_corr:.3f}), will be transcribed as mix",
                num_discrete_channels=2,
                correlation=mean_corr,
                analysis=analysis,
            )

        # Multichannel (3+)
        if analysis.classification == "independent":
            return ManifestChannelMode(
                mode="per_channel",
                description=f"{stream.channels}-channel audio with independent sources (per-channel transcription, skip diarization)",
                num_discrete_channels=stream.channels,
                analysis=analysis,
            )

        # Conservative: treat multichannel as mixed downmix if not clearly independent
        return ManifestChannelMode(
            mode="mono",
            description=f"{stream.channels}-channel audio (insufficient evidence of independence, will be downmixed)",
            num_discrete_channels=stream.channels,
            analysis=analysis,
        )

    def _measure_audio_quality(self, path: Path, duration_s: float) -> AudioQualityMetrics:
        """
        Measure audio quality using three core metrics: noise, loudness, clipping.

        Uses:
          1. SNR via Voice Activity Detection (VAD)
          2. LUFS (EBU R128 integrated loudness)
          3. PCM-level clipping detection

        Returns full metrics with quality assessment and preprocessing recommendations.
        """
        return self.quality_analyzer.analyze(path)

    def _extract_audio_from_video(self, video_path: Path) -> Path:
        """Extract audio stream to separate file. Returns path to audio artifact."""
        probe = self._run_ffprobe(video_path)
        streams = self._detect_audio_streams(probe)

        if not streams:
            raise ValueError("No audio stream found in video")

        # Use first audio stream
        audio_stream = streams[0]
        ext = audio_stream.codec if audio_stream.codec != "aac" else "aac"

        output_path = Path(tempfile.gettempdir()) / f"audio_extracted_{video_path.stem}.{ext}"

        subprocess.run(
            [
                "ffmpeg",
                "-i",
                str(video_path),
                "-vn",  # no video
                "-c:a",
                "copy",  # copy codec, no re-encode
                "-y",  # overwrite
                str(output_path),
            ],
            capture_output=True,
            check=True,
        )

        return output_path

    def ingest(self, path: Path, ingested_by: str | None = None) -> Manifest:
        """Probe, validate, and register an audio/video file.

        Returns a manifest. If the file has been seen before (same sha256),
        returns the cached manifest from disk or memory.
        """
        # 1. Hash the original bytes
        sha256 = self._hash_file(path)

        # 2. Check cache (disk first, then memory)
        cache_manifest_path = self.cache_dir / sha256 / "manifest.json"
        if cache_manifest_path.exists():
            try:
                with open(cache_manifest_path) as f:
                    manifest_data = json.load(f)
                manifest = Manifest.model_validate(manifest_data)
                logger.info(f"Loaded manifest from disk cache: {sha256}")
                self.manifest_store[sha256] = manifest
                return manifest
            except Exception as e:
                logger.warning(f"Failed to load cached manifest from disk: {e}")

        if sha256 in self.manifest_store:
            return self.manifest_store[sha256]

        # 3. Setup cache directory for this file
        file_cache_dir = self.cache_dir / sha256
        file_cache_dir.mkdir(parents=True, exist_ok=True)

        # 4. Probe without decoding
        probe = self._run_ffprobe(path)

        # 5. Validate
        is_valid, reason = self._validate_file(path, probe)
        if not is_valid:
            raise ValueError(f"File validation failed: {reason}")

        # Extract metadata
        format_info = probe.get("format", {})
        duration_s = float(format_info.get("duration", 0))
        container = format_info.get("format_name", "unknown").split(",")[0]

        # Get audio streams
        audio_streams = self._detect_audio_streams(probe)
        if not audio_streams:
            raise ValueError("No audio stream found in file")

        # Detect channel routing
        channel_mode = self._detect_channel_mode(audio_streams, path, duration_s)

        # Extract audio if video
        audio_artifact_path = None
        audio_artifact_sha256 = None
        is_video = any(s.get("codec_type") == "video" for s in probe.get("streams", []))

        if is_video:
            audio_artifact_path = self._extract_audio_from_video(path)
            audio_artifact_sha256 = self._hash_file(audio_artifact_path)

        # Measure quality (from original, unprocessed source)
        quality_metrics = self._measure_audio_quality(path, duration_s)

        # Derive and cache audio artifacts (asr_16k_mono, diar_16k)
        asr_artifact_path, asr_artifact_sha256, diar_artifact_paths, diar_artifact_sha256s = (
            self._derive_artifacts(path, channel_mode, file_cache_dir)
        )

        # Create manifest with artifact information
        manifest = Manifest(
            audio_sha256=sha256,
            original_filename=path.name,
            size_bytes=path.stat().st_size,
            container=container,
            duration_s=duration_s,
            ingested_at=datetime.now(timezone.utc),
            ingested_by=ingested_by,
            pipeline_version=PIPELINE_VERSION,
            channel_mode=channel_mode,
            streams=audio_streams,
            quality_metrics=quality_metrics,
            audio_artifact_path=str(audio_artifact_path) if audio_artifact_path else None,
            audio_artifact_sha256=audio_artifact_sha256,
            asr_artifact_path=asr_artifact_path,
            asr_artifact_sha256=asr_artifact_sha256,
            diar_artifact_paths=diar_artifact_paths,
            diar_artifact_sha256s=diar_artifact_sha256s,
        )

        # Persist manifest to disk
        try:
            with open(cache_manifest_path, "w") as f:
                json.dump(manifest.model_dump(mode="json"), f, indent=2, default=str)
            logger.info(f"Persisted manifest to disk: {cache_manifest_path}")
        except Exception as e:
            logger.error(f"Failed to persist manifest to disk: {e}")
            # Continue anyway — in-memory store is sufficient

        # Register in in-memory store
        self.manifest_store[sha256] = manifest

        return manifest

    def get_cached_manifest(self, sha256: str) -> Manifest | None:
        """Get a manifest from cache (disk or memory)."""
        # Check memory first (faster)
        if sha256 in self.manifest_store:
            return self.manifest_store[sha256]

        # Check disk
        cache_manifest_path = self.cache_dir / sha256 / "manifest.json"
        if cache_manifest_path.exists():
            try:
                with open(cache_manifest_path) as f:
                    manifest_data = json.load(f)
                manifest = Manifest.model_validate(manifest_data)
                self.manifest_store[sha256] = manifest
                return manifest
            except Exception as e:
                logger.warning(f"Failed to load manifest from disk: {e}")

        return None


@lru_cache
def get_ingest_service() -> IngestService:
    return IngestService(get_settings())
