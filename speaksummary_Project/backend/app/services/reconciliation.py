import logging
from typing import Optional
import numpy as np

logger = logging.getLogger(__name__)


class SpeakerReconciliation:
    """Reconcile word-speaker assignments using VAD timeline and duration weighting.

    Fixes over-assignment of words to speakers by:
    - Masking out non-speech regions detected by VAD
    - Using duration-weighted overlap (not point-in-time nearest-segment)
    - Smoothing single-word speaker flips surrounded by a consistent speaker
    """

    def __init__(self, vad_timeline: Optional[list[tuple[float, float]]] = None):
        """
        Initialize reconciliation.

        Args:
            vad_timeline: List of (start_s, end_s) tuples for detected speech regions.
                         If provided, words outside these regions are masked/ignored.
        """
        self.vad_timeline = vad_timeline or []

    def _is_in_vad_region(self, word_start: float, word_end: float) -> bool:
        """Check if a word falls within any VAD speech region."""
        if not self.vad_timeline:
            return True  # No VAD masking if timeline not provided

        for vad_start, vad_end in self.vad_timeline:
            # Word overlaps with VAD region if its midpoint is in the region
            word_mid = (word_start + word_end) / 2
            if vad_start <= word_mid <= vad_end:
                return True
        return False

    def _compute_overlap_duration(
        self,
        word_start: float,
        word_end: float,
        speaker_start: float,
        speaker_end: float,
    ) -> float:
        """Compute duration (in seconds) of overlap between word and speaker segment."""
        overlap_start = max(word_start, speaker_start)
        overlap_end = min(word_end, speaker_end)
        return max(0, overlap_end - overlap_start)

    def reconcile_word_speakers(
        self,
        segments: list[dict],
        speaker_segments: list[dict],
    ) -> list[dict]:
        """
        Reconcile word-speaker assignments with VAD masking and duration weighting.

        Args:
            segments: ASR segments with 'words' array (each word has start/end)
            speaker_segments: Diarization segments with 'start', 'end', 'speaker' keys

        Returns:
            Updated segments with reconciled speaker assignments for each word.
            Adds 'speaker_overlap' field to flag smoothed assignments.
        """
        if not segments:
            return segments

        reconciled_segments = []

        for segment in segments:
            segment_copy = dict(segment)

            # Reconcile words if present
            if "words" in segment and segment["words"]:
                reconciled_words = []

                for word in segment["words"]:
                    word_copy = dict(word)
                    word_start = word.get("start")
                    word_end = word.get("end")

                    # Skip words without timing or outside VAD
                    if word_start is None or word_end is None:
                        word_copy["speaker_overlap"] = False
                        reconciled_words.append(word_copy)
                        continue

                    if not self._is_in_vad_region(word_start, word_end):
                        # Word is in non-speech region per VAD; mask the speaker
                        word_copy["speaker"] = None
                        word_copy["speaker_overlap"] = True
                        reconciled_words.append(word_copy)
                        continue

                    # Compute duration-weighted overlap with each speaker segment
                    best_speaker = None
                    best_overlap = 0.0
                    word_duration = word_end - word_start

                    for spk_seg in speaker_segments:
                        spk_start = spk_seg.get("start")
                        spk_end = spk_seg.get("end")
                        speaker = spk_seg.get("speaker")

                        if spk_start is None or spk_end is None or not speaker:
                            continue

                        overlap_duration = self._compute_overlap_duration(
                            word_start, word_end, spk_start, spk_end
                        )

                        if overlap_duration > best_overlap:
                            best_overlap = overlap_duration
                            best_speaker = speaker

                    # Assign to the best-overlapping speaker (if any overlap)
                    if best_speaker:
                        overlap_ratio = best_overlap / word_duration if word_duration > 0 else 0
                        word_copy["speaker"] = best_speaker
                        word_copy["speaker_overlap"] = False
                        if overlap_ratio < 0.8:  # Mark if overlap is weak
                            word_copy["speaker_overlap"] = True
                    else:
                        # No overlapping speaker segment; preserve original or None
                        word_copy["speaker_overlap"] = True

                    reconciled_words.append(word_copy)

                segment_copy["words"] = reconciled_words

            reconciled_segments.append(segment_copy)

        # Apply single-word smoothing: if a word is surrounded by the same speaker,
        # smooth the flip
        reconciled_segments = self._smooth_single_word_flips(reconciled_segments)

        return reconciled_segments

    def _smooth_single_word_flips(self, segments: list[dict]) -> list[dict]:
        """
        Smooth single-word speaker flips: if word N has a different speaker than
        words N-1 and N+1 (which are the same), reassign word N and flag it.
        """
        for segment in segments:
            if "words" not in segment or not segment["words"]:
                continue

            words = segment["words"]
            for i in range(1, len(words) - 1):
                prev_speaker = words[i - 1].get("speaker")
                curr_speaker = words[i].get("speaker")
                next_speaker = words[i + 1].get("speaker")

                # Single-word flip detected
                if (
                    prev_speaker is not None
                    and next_speaker is not None
                    and prev_speaker == next_speaker
                    and curr_speaker != prev_speaker
                ):
                    # Smooth: reassign to surrounding speaker and flag
                    words[i]["speaker"] = prev_speaker
                    words[i]["speaker_overlap"] = True
                    logger.debug(
                        f"Smoothed single-word flip at word {i}: "
                        f"{curr_speaker} -> {prev_speaker}"
                    )

        return segments


def reconcile_word_speakers(
    segments: list[dict],
    speaker_segments: list[dict],
    vad_timeline: Optional[list[tuple[float, float]]] = None,
) -> list[dict]:
    """Convenience function: reconcile word-speaker assignments.

    Args:
        segments: ASR segments with 'words' array
        speaker_segments: Diarization segments
        vad_timeline: Optional VAD speech regions for masking

    Returns:
        Updated segments with reconciled speaker assignments.
    """
    reconciler = SpeakerReconciliation(vad_timeline=vad_timeline)
    return reconciler.reconcile_word_speakers(segments, speaker_segments)
