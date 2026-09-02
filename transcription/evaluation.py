"""Diarization evaluation metrics - Diarization Error Rate (DER), its three
standard components (missed speech, false alarm, speaker confusion), a
normalized "false speaker assignment" rate derived from confusion, and
word-level speaker accuracy.

This is the diarization-pipeline audit's Phase 4 measurement tooling - it
answers "how accurate is this system, really?" against a reference you
supply (a hand-verified ground truth), which is the one input nothing in
this codebase can manufacture on its own. Nothing here changes the
transcription pipeline; it only scores output that already exists against a
reference that already exists.

Terminology and the DER formula follow the standard NIST RT / DIHARD
diarization scoring convention (the same one `pyannote.metrics`
implements): reference and hypothesis speaker identities are not compared
directly (a system's "Speaker 1" has no reason to equal a reference's
"Alice") - an optimal one-to-one label mapping is found first (maximizing
total temporal overlap), and every metric below is computed through that
mapping.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment


def _overlap_seconds(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _build_overlap_matrix(
    reference: list[dict], hypothesis: list[dict]
) -> dict[tuple[str, str], float]:
    """`(hypothesis_speaker, reference_speaker) -> total overlapping seconds`
    across every reference/hypothesis segment pair - the raw material the
    optimal mapping is chosen from."""
    matrix: dict[tuple[str, str], float] = {}
    for ref_seg in reference:
        for hyp_seg in hypothesis:
            overlap = _overlap_seconds(
                ref_seg["start"], ref_seg["end"], hyp_seg["start"], hyp_seg["end"]
            )
            if overlap > 0:
                key = (hyp_seg["speaker"], ref_seg["speaker"])
                matrix[key] = matrix.get(key, 0.0) + overlap
    return matrix


def find_optimal_speaker_mapping(reference: list[dict], hypothesis: list[dict]) -> dict[str, str]:
    """The hypothesis-speaker -> reference-speaker mapping that maximizes
    total temporal overlap, found all at once via the Hungarian algorithm
    (`scipy.optimize.linear_sum_assignment`) rather than each hypothesis
    speaker greedily picking its own best match - two hypothesis speakers
    both best-matching the same reference speaker is exactly the case a
    greedy per-speaker choice gets wrong and a joint assignment doesn't.

    A hypothesis speaker with zero overlap with any reference speaker (or
    vice versa) is left out of the mapping entirely, rather than forced into
    a same-index pairing the assignment algorithm's square-matrix mechanics
    would otherwise produce - an unmapped hypothesis speaker's speech is
    scored as confusion/false alarm by `compute_der`, not silently credited
    to a reference speaker it never actually overlapped.
    """
    hyp_speakers = sorted({seg["speaker"] for seg in hypothesis})
    ref_speakers = sorted({seg["speaker"] for seg in reference})
    if not hyp_speakers or not ref_speakers:
        return {}

    overlap_matrix = _build_overlap_matrix(reference, hypothesis)
    # linear_sum_assignment minimizes cost; overlap is negated so maximizing
    # overlap becomes minimizing cost. Handles a non-square matrix (unequal
    # speaker counts) natively.
    cost = np.zeros((len(hyp_speakers), len(ref_speakers)))
    for i, hyp in enumerate(hyp_speakers):
        for j, ref in enumerate(ref_speakers):
            cost[i, j] = -overlap_matrix.get((hyp, ref), 0.0)

    row_indices, col_indices = linear_sum_assignment(cost)
    mapping: dict[str, str] = {}
    for i, j in zip(row_indices, col_indices):
        if cost[i, j] < 0:  # negative cost == positive overlap actually existed
            mapping[hyp_speakers[i]] = ref_speakers[j]
    return mapping


def _apply_collar(reference: list[dict], collar: float) -> list[tuple[float, float]]:
    """Excluded time ranges around every reference segment boundary - the
    NIST scoring convention that exact boundary placement is inherently
    ambiguous (even between two human annotators) and shouldn't be scored as
    an error. `collar` seconds total, split evenly before/after each
    boundary. Ranges are merged so overlapping collars around adjacent
    boundaries don't double-exclude the same instant."""
    if collar <= 0:
        return []
    half = collar / 2
    raw_ranges: list[tuple[float, float]] = []
    for seg in reference:
        raw_ranges.append((seg["start"] - half, seg["start"] + half))
        raw_ranges.append((seg["end"] - half, seg["end"] + half))
    raw_ranges.sort()
    merged: list[tuple[float, float]] = []
    for start, end in raw_ranges:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _is_excluded(midpoint: float, excluded_ranges: list[tuple[float, float]]) -> bool:
    for start, end in excluded_ranges:
        if start <= midpoint < end:
            return True
    return False


@dataclass
class DiarizationErrorRateResult:
    der: float
    missed_speech_s: float
    false_alarm_s: float
    speaker_confusion_s: float
    correct_speaker_s: float
    total_reference_speech_s: float
    # Of the speaker-time where reference AND hypothesis both had someone
    # speaking (i.e. excluding pure missed-speech/false-alarm time), what
    # fraction went to the wrong (mapped) speaker - a normalized read on
    # speaker confusion, independent of how much speech was simply missed or
    # hallucinated. This is the audit's "False Speaker Assignment" rate.
    false_speaker_assignment_rate: float
    collar_s: float
    speaker_mapping: dict[str, str] = field(default_factory=dict)


def compute_der(
    reference: list[dict],
    hypothesis: list[dict],
    collar: float = 0.0,
    speaker_mapping: dict[str, str] | None = None,
) -> DiarizationErrorRateResult:
    """`reference`/`hypothesis`: lists of `{start, end, speaker}` (extra keys
    ignored - a `TTranscriptSegment`-shaped list works as-is). Reference
    segments MAY genuinely overlap (a human annotator can mark simultaneous
    speech); hypothesis segments from this codebase's own pipeline never do
    (see the diarization-pipeline audit - no multi-speaker representation
    exists here), but the scoring sweep supports either.

    `collar`: seconds of NIST-convention boundary tolerance - 0 (the
    default) scores every instant strictly; pass e.g. 0.25 to match common
    RT/DIHARD evaluation practice.
    """
    resolved_mapping = (
        speaker_mapping
        if speaker_mapping is not None
        else find_optimal_speaker_mapping(reference, hypothesis)
    )
    excluded_ranges = _apply_collar(reference, collar)

    boundaries: set[float] = set()
    for seg in reference:
        boundaries.add(seg["start"])
        boundaries.add(seg["end"])
    for seg in hypothesis:
        boundaries.add(seg["start"])
        boundaries.add(seg["end"])
    sorted_boundaries = sorted(boundaries)

    missed = 0.0
    false_alarm = 0.0
    confusion = 0.0
    correct = 0.0
    total_reference_speech = 0.0

    for start, end in zip(sorted_boundaries, sorted_boundaries[1:]):
        duration = end - start
        if duration <= 0:
            continue
        midpoint = (start + end) / 2
        if _is_excluded(midpoint, excluded_ranges):
            continue

        ref_active = {
            seg["speaker"] for seg in reference if seg["start"] <= midpoint < seg["end"]
        }
        hyp_active_raw = {
            seg["speaker"] for seg in hypothesis if seg["start"] <= midpoint < seg["end"]
        }
        hyp_active_mapped = {
            resolved_mapping[speaker] for speaker in hyp_active_raw if speaker in resolved_mapping
        }

        n_ref = len(ref_active)
        n_hyp = len(hyp_active_mapped)
        n_correct = len(ref_active & hyp_active_mapped)

        missed += duration * max(0, n_ref - n_hyp)
        false_alarm += duration * max(0, n_hyp - n_ref)
        confusion += duration * (min(n_ref, n_hyp) - n_correct)
        correct += duration * n_correct
        total_reference_speech += duration * n_ref

    der = (missed + false_alarm + confusion) / total_reference_speech if total_reference_speech > 0 else 0.0
    matched_speech = confusion + correct
    false_speaker_assignment_rate = confusion / matched_speech if matched_speech > 0 else 0.0

    return DiarizationErrorRateResult(
        der=round(der, 4),
        missed_speech_s=round(missed, 2),
        false_alarm_s=round(false_alarm, 2),
        speaker_confusion_s=round(confusion, 2),
        correct_speaker_s=round(correct, 2),
        total_reference_speech_s=round(total_reference_speech, 2),
        false_speaker_assignment_rate=round(false_speaker_assignment_rate, 4),
        collar_s=collar,
        speaker_mapping=resolved_mapping,
    )


@dataclass
class WordLevelAccuracyResult:
    accuracy: float
    correct_count: int
    total_count: int
    # Reference words with no hypothesis word covering their timestamp at
    # all - counted separately from wrong-speaker words, since "we said
    # nothing here" and "we said the wrong person" are different failures.
    unmatched_count: int
    speaker_mapping: dict[str, str] = field(default_factory=dict)


def compute_word_level_speaker_accuracy(
    reference_words: list[dict],
    hypothesis_words: list[dict],
    speaker_mapping: dict[str, str] | None = None,
) -> WordLevelAccuracyResult:
    """`reference_words`/`hypothesis_words`: lists of `{start, end, speaker}`
    - a `TWordSpan`-shaped list works as-is. This is purely a speaker-label
    lookup by timestamp, not a text/wording comparison (that's word error
    rate's job, a different metric this function doesn't attempt) - a
    reference word's `word` text, if present, is never read.
    """
    resolved_mapping = (
        speaker_mapping
        if speaker_mapping is not None
        else find_optimal_speaker_mapping(
            [{"start": w["start"], "end": w["end"], "speaker": w["speaker"]} for w in reference_words],
            [{"start": w["start"], "end": w["end"], "speaker": w["speaker"]} for w in hypothesis_words],
        )
    )

    sorted_hyp = sorted(hypothesis_words, key=lambda w: w["start"])
    hyp_starts = [w["start"] for w in sorted_hyp]

    correct = 0
    unmatched = 0
    for ref_word in reference_words:
        midpoint = (ref_word["start"] + ref_word["end"]) / 2
        index = bisect.bisect_right(hyp_starts, midpoint) - 1
        hyp_word = sorted_hyp[index] if 0 <= index < len(sorted_hyp) and sorted_hyp[index]["end"] > midpoint else None
        if hyp_word is None:
            unmatched += 1
            continue
        if resolved_mapping.get(hyp_word["speaker"]) == ref_word["speaker"]:
            correct += 1

    total = len(reference_words)
    accuracy = correct / total if total > 0 else 0.0
    return WordLevelAccuracyResult(
        accuracy=round(accuracy, 4),
        correct_count=correct,
        total_count=total,
        unmatched_count=unmatched,
        speaker_mapping=resolved_mapping,
    )
