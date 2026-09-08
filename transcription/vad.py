"""Voice activity detection, over pyannote's segmentation model.

pyannote returns a score per frame and leaves thresholding to a separate step,
so one forward pass can be binarized at as many threshold pairs as a caller
needs. That is what makes the two-tier split in vad_tiers.py affordable: the
second tier costs a walk over scores already in memory, not a second pass over
the audio.

It is also the only backend here that honours an offset. Onset starts a speech
region and offset ends it, so a region survives dips that would never have been
enough to start one - the hysteresis a single threshold cannot express.
"""

import logging

import numpy as np
import torch
import whisperx
from pyannote.core import SlidingWindowFeature
from whisperx.vads import Pyannote
from whisperx.vads.pyannote import Binarize

logger = logging.getLogger(__name__)

Interval = tuple[float, float]

SAMPLE_RATE = 16000
# whisperx batches ASR in windows of this many seconds; also the cap Binarize
# applies when splitting an over-long active region.
VAD_CHUNK_SIZE = 30


class PyannoteVad:
    """The segmentation model, loaded once and asked as often as needed."""

    def __init__(self, device: str = "cpu"):
        # The onset here only satisfies the base class's range check. Every
        # threshold that matters is applied later, in binarize().
        self.model = Pyannote(torch.device(device), token=None, vad_onset=0.5)
        logger.info("Pyannote VAD model loaded on %s", device)

    def scores(self, audio: np.ndarray) -> SlidingWindowFeature:
        """Per-frame speech scores for 16 kHz mono audio."""
        return self.model(
            {"waveform": Pyannote.preprocess_audio(audio), "sample_rate": SAMPLE_RATE}
        )

    @staticmethod
    def binarize(scores: SlidingWindowFeature, onset: float, offset: float) -> list[Interval]:
        """Turn scores into speech regions under one threshold pair."""
        annotation = Binarize(max_duration=VAD_CHUNK_SIZE, onset=onset, offset=offset)(scores)
        return [(segment.start, segment.end) for segment in annotation.get_timeline()]

    def timeline_for_audio(
        self, audio: np.ndarray, onset: float, offset: float
    ) -> list[Interval]:
        return self.binarize(self.scores(audio), onset, offset)

    def timeline_for_path(self, path: str, onset: float, offset: float) -> list[Interval]:
        """Speech regions in a file, resampled to 16 kHz mono on the way in."""
        return self.timeline_for_audio(whisperx.load_audio(path), onset, offset)
