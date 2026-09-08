"""Two-tier voice activity detection.

A forensic transcript loses more to speech that VAD threw away than to noise it
let through: discarded audio never reaches Whisper and cannot be recovered from
the result, while admitted noise arrives as text a reviewer can see and delete.

So the same audio is thresholded twice. The confident tier is the deployment's
normal pair; the permissive tier reaches lower and catches quiet speech the
first pass would have dropped. What only the permissive tier found is the
*borderline* band - transcribed, but flagged rather than trusted.
"""

import logging
from bisect import bisect_right
from dataclasses import dataclass

import numpy as np

from .config import Settings
from .vad import SAMPLE_RATE, VAD_CHUNK_SIZE, Interval, PyannoteVad

logger = logging.getLogger(__name__)

__all__ = [
    "SAMPLE_RATE",
    "VAD_CHUNK_SIZE",
    "Interval",
    "VadTiers",
    "compute_tiers",
    "contains",
    "merge_intervals",
    "overlaps",
    "subtract_intervals",
    "tag_segments",
    "total_duration",
]


def merge_intervals(intervals: list[Interval]) -> list[Interval]:
    """Sort and coalesce, dropping empties. Touching intervals become one."""
    ordered = sorted((float(start), float(end)) for start, end in intervals if end > start)
    if not ordered:
        return []

    merged = [ordered[0]]
    for start, end in ordered[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
            continue
        merged.append((start, end))
    return merged


def subtract_intervals(minuend: list[Interval], subtrahend: list[Interval]) -> list[Interval]:
    """The parts of `minuend` no interval in `subtrahend` covers."""
    blockers = merge_intervals(subtrahend)
    if not blockers:
        return merge_intervals(minuend)

    remaining: list[Interval] = []
    for start, end in merge_intervals(minuend):
        cursor = start
        for blocker_start, blocker_end in blockers:
            if blocker_end <= cursor:
                continue
            if blocker_start >= end:
                break
            if blocker_start > cursor:
                remaining.append((cursor, blocker_start))
            cursor = blocker_end
            if cursor >= end:
                break
        if cursor < end:
            remaining.append((cursor, end))
    return remaining


def total_duration(intervals: list[Interval]) -> float:
    return sum(end - start for start, end in merge_intervals(intervals))


def contains(intervals: list[Interval], instant: float) -> bool:
    """Whether `instant` falls inside a sorted, non-overlapping interval list.

    Binary search rather than a scan: this runs once per word, against a list
    that can hold thousands of speech regions for a long interview.
    """
    if not intervals:
        return False

    index = bisect_right(intervals, (instant, float("inf"))) - 1
    if index < 0:
        return False

    start, end = intervals[index]
    return start <= instant <= end


def overlaps(intervals: list[Interval], start: float, end: float) -> bool:
    """Whether any interval intersects the span."""
    return any(
        interval_start < end and start < interval_end for interval_start, interval_end in intervals
    )


@dataclass(frozen=True)
class VadTiers:
    """Speech regions split by how much confidence the thresholds justify."""

    confident: list[Interval]
    borderline: list[Interval]

    @property
    def union(self) -> list[Interval]:
        """Everything to put in front of the recogniser."""
        return merge_intervals(self.confident + self.borderline)

    @property
    def is_split(self) -> bool:
        return bool(self.borderline)


def tag_segments(segments: list[dict], tiers: VadTiers) -> tuple[int, int]:
    """Mark aligned words, and the segments holding them, by VAD tier.

    Follows the same internal-field convention `_resolve_speaker_assignment`
    uses elsewhere in this pipeline: `_vad_confidence`/`_vad_borderline` here,
    surfaced without the underscore only in the final assembly loop. Neither
    function needs to know about the other's fields, since each only ever
    touches its own.

    Has to run on aligned output rather than on the decoder's own segments:
    whisperx emits one segment per batching window of up to VAD_CHUNK_SIZE
    seconds, so a borderline region routinely shares a segment with confident
    speech. Only word timings are fine-grained enough to tell them apart.

    Returns the borderline word and segment counts.
    """
    borderline_words = 0
    borderline_segments = 0

    for segment in segments:
        words = segment.get("words") or []
        is_flagged = False

        for word in words:
            start = word.get("start")
            end = word.get("end")
            if start is None or end is None:
                continue
            if contains(tiers.confident, (start + end) / 2):
                word["_vad_confidence"] = "high"
                continue
            word["_vad_confidence"] = "borderline"
            borderline_words += 1
            is_flagged = True

        if not words:
            is_flagged = overlaps(tiers.borderline, segment["start"], segment["end"])

        segment["_vad_borderline"] = is_flagged
        borderline_segments += is_flagged

    return borderline_words, borderline_segments


def compute_tiers(audio: np.ndarray, settings: Settings, vad: PyannoteVad) -> VadTiers:
    """Split `audio` into confident and borderline speech.

    One forward pass, two binarizations: the second tier reads scores the first
    already computed, so recovering quiet speech costs a walk over an array
    rather than another pass over the recording.

    Configuring the borderline pair equal to the confident one leaves the
    borderline tier empty, which is how a deployment opts out of the second
    tier without a separate switch.
    """
    scores = vad.scores(audio)
    confident = merge_intervals(vad.binarize(scores, settings.vad_onset, settings.vad_offset))
    permissive = vad.binarize(
        scores, settings.vad_borderline_onset, settings.vad_borderline_offset
    )

    tiers = VadTiers(
        confident=confident,
        borderline=subtract_intervals(permissive, confident),
    )

    logger.info(
        "VAD tiers: %.1fs confident across %d regions, %.1fs borderline across %d regions",
        total_duration(tiers.confident),
        len(tiers.confident),
        total_duration(tiers.borderline),
        len(tiers.borderline),
    )
    return tiers
