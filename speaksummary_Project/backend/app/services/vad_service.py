import logging
from pathlib import Path

import numpy as np
from silero_vad import load_silero_vad, get_speech_timestamps

logger = logging.getLogger(__name__)


class VadService:
    """Voice Activity Detection using Silero VAD.

    Detects speech/non-speech regions in audio for use by quality analysis,
    ASR tuning, and diarization reconciliation.
    """

    def __init__(self, onset: float = 0.500, offset: float = 0.363, device: str = "cpu"):
        """
        Initialize VAD with tuned thresholds.

        Args:
            onset: Onset threshold (lower = catches quieter speech)
            offset: Offset threshold (higher = trims trailing silence)
            device: "cpu" or "cuda"
        """
        self.onset = onset
        self.offset = offset
        self.device = device

        try:
            self.model = load_silero_vad(onnx=False)
            logger.info(f"Silero VAD model loaded on {device}")
        except Exception as e:
            logger.error(f"Failed to load Silero VAD model: {e}")
            raise RuntimeError(
                "Silero VAD model failed to load. Ensure silero-vad package is installed and torch is available."
            ) from e

    def get_speech_timeline(self, audio_path: Path) -> list[tuple[float, float]]:
        """
        Detect speech regions in audio.

        Args:
            audio_path: Path to audio file (must be readable by librosa/soundfile)

        Returns:
            List of (start_s, end_s) tuples for each detected speech region.
        """
        try:
            # Load audio (librosa-style interface via soundfile/scipy)
            import librosa

            audio, sr = librosa.load(str(audio_path), sr=16000, mono=True)

            # Get speech timestamps from Silero
            speech_timestamps = get_speech_timestamps(
                audio,
                self.model,
                sampling_rate=16000,
                threshold=self.onset,
                neg_threshold=self.offset,
                min_speech_duration_ms=250,
                min_silence_duration_ms=300,
                window_size_samples=512,
                return_seconds=True,
            )

            # Convert to list of (start, end) tuples
            timeline = [(ts["start"], ts["end"]) for ts in speech_timestamps]

            logger.info(f"Detected {len(timeline)} speech regions in {audio_path.name}")
            return timeline

        except Exception as e:
            logger.error(f"VAD analysis failed for {audio_path}: {e}")
            raise


def get_vad_service(onset: float = 0.500, offset: float = 0.363, device: str = "cpu") -> VadService:
    """Dependency injection for VadService."""
    return VadService(onset=onset, offset=offset, device=device)
