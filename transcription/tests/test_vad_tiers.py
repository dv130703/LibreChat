"""The interval algebra the two-tier VAD rests on, plus the tagging that turns
it into per-word verdicts. No model involved for most of these: these are the
decisions about what counts as borderline, and they have to be right
independently of which VAD produced the timelines.

Field names here follow this pipeline's own internal-field convention: words
and segments carry underscore-prefixed working fields (`_vad_confidence`,
`_vad_borderline`) that only the final assembly loop in whisperx_service.py
strips the underscore from - the same convention `_resolve_speaker_assignment`
uses for `_assignment_method`/`_assignment_distance_s`.
"""

import numpy as np
import pytest

from transcription.config import Settings
from transcription.vad import PyannoteVad
from transcription.vad_tiers import (
    SAMPLE_RATE,
    VadTiers,
    compute_tiers,
    contains,
    merge_intervals,
    overlaps,
    subtract_intervals,
    tag_segments,
    total_duration,
)


def test_merge_coalesces_overlapping_and_touching_regions():
    assert merge_intervals([(0.0, 1.0), (0.5, 2.0), (2.0, 3.0)]) == [(0.0, 3.0)]


def test_merge_sorts_and_drops_empty_regions():
    assert merge_intervals([(5.0, 6.0), (1.0, 1.0), (2.0, 3.0)]) == [(2.0, 3.0), (5.0, 6.0)]


def test_subtract_splits_a_region_the_confident_tier_covers_the_middle_of():
    assert subtract_intervals([(0.0, 10.0)], [(4.0, 6.0)]) == [(0.0, 4.0), (6.0, 10.0)]


def test_subtract_trims_leading_and_trailing_overlap():
    assert subtract_intervals([(2.0, 8.0)], [(0.0, 3.0), (7.0, 9.0)]) == [(3.0, 7.0)]


def test_fully_covered_permissive_region_leaves_no_borderline():
    assert subtract_intervals([(2.0, 4.0)], [(0.0, 10.0)]) == []


def test_subtract_without_blockers_returns_the_normalised_minuend():
    assert subtract_intervals([(3.0, 4.0), (0.0, 1.0)], []) == [(0.0, 1.0), (3.0, 4.0)]


def test_identical_tiers_produce_an_empty_borderline_band():
    # How a deployment opts out of the second tier: configure both threshold
    # pairs the same and nothing is ever flagged.
    timeline = [(0.0, 1.0), (4.0, 9.0)]
    assert subtract_intervals(timeline, timeline) == []


def test_total_duration_counts_overlapping_regions_once():
    assert total_duration([(0.0, 5.0), (2.0, 8.0)]) == 8.0


def test_contains_covers_boundaries_and_gaps():
    intervals = [(0.0, 2.0), (5.0, 6.0)]
    assert contains(intervals, 0.0)
    assert contains(intervals, 2.0)
    assert contains(intervals, 5.5)
    assert not contains(intervals, 3.0)
    assert not contains(intervals, 9.0)
    assert not contains([], 1.0)


def test_overlaps_needs_a_real_intersection():
    assert overlaps([(4.0, 6.0)], 5.0, 7.0)
    assert not overlaps([(4.0, 6.0)], 6.0, 7.0)
    assert not overlaps([], 0.0, 100.0)


def test_union_is_both_tiers_merged():
    tiers = VadTiers(confident=[(0.0, 2.0)], borderline=[(2.0, 3.0), (8.0, 9.0)])
    assert tiers.union == [(0.0, 3.0), (8.0, 9.0)]
    assert tiers.is_split


def _segment(start, end, words):
    return {
        "start": start,
        "end": end,
        "words": [{"word": text, "start": w_start, "end": w_end} for text, w_start, w_end in words],
    }


def test_words_are_tagged_by_the_tier_their_timing_falls_in():
    tiers = VadTiers(confident=[(0.0, 3.0)], borderline=[(3.0, 5.0)])
    segments = [_segment(0.0, 5.0, [("yes", 0.5, 1.0), ("maybe", 3.5, 4.0)])]

    borderline_words, borderline_segments = tag_segments(segments, tiers)

    assert [word["_vad_confidence"] for word in segments[0]["words"]] == ["high", "borderline"]
    assert (borderline_words, borderline_segments) == (1, 1)


def test_a_segment_spanning_both_tiers_is_flagged():
    # whisperx batches up to 30s per segment, so confident and borderline speech
    # routinely share one. A single unverified word is enough to flag the line.
    tiers = VadTiers(confident=[(0.0, 20.0)], borderline=[(20.0, 22.0)])
    segments = [
        _segment(0.0, 22.0, [("clearly", 1.0, 2.0), ("audible", 3.0, 4.0), ("mutter", 20.5, 21.0)])
    ]

    tag_segments(segments, tiers)

    assert segments[0]["_vad_borderline"]


def test_a_wholly_confident_segment_is_not_flagged():
    tiers = VadTiers(confident=[(0.0, 10.0)], borderline=[])
    segments = [_segment(0.0, 10.0, [("on", 1.0, 2.0), ("record", 3.0, 4.0)])]

    borderline_words, borderline_segments = tag_segments(segments, tiers)

    assert not segments[0]["_vad_borderline"]
    assert (borderline_words, borderline_segments) == (0, 0)


def test_unalignable_words_are_left_untagged_rather_than_guessed():
    tiers = VadTiers(confident=[(0.0, 3.0)], borderline=[])
    segments = [{"start": 0.0, "end": 3.0, "words": [{"word": "hm", "start": None, "end": None}]}]

    tag_segments(segments, tiers)

    assert "_vad_confidence" not in segments[0]["words"][0]
    assert not segments[0]["_vad_borderline"]


def test_a_segment_without_words_falls_back_to_its_own_span():
    # No alignment model for the language, so there are no word timings to
    # place; the segment's own span is all there is to judge it by.
    tiers = VadTiers(confident=[(0.0, 4.0)], borderline=[(4.0, 6.0)])
    segments = [{"start": 4.5, "end": 5.5, "words": []}]

    borderline_words, borderline_segments = tag_segments(segments, tiers)

    assert segments[0]["_vad_borderline"]
    assert (borderline_words, borderline_segments) == (0, 1)


@pytest.fixture(scope="module")
def vad():
    try:
        return PyannoteVad(device="cpu")
    except Exception as exc:
        pytest.skip(f"pyannote segmentation model unavailable: {exc}")


def _speech_like_audio() -> np.ndarray:
    """Formant-ish bursts at descending levels over a quiet noise floor.

    Not real speech - the point is to drive the real segmentation model with
    something structured enough to threshold, at levels far enough apart that
    the two tiers have a chance of disagreeing.
    """
    rng = np.random.default_rng(0)
    duration_s = 12
    t = np.arange(duration_s * SAMPLE_RATE) / SAMPLE_RATE
    audio = rng.normal(0.0, 0.001, t.shape)

    for index, (start, level) in enumerate([(1.0, 0.3), (5.0, 0.02), (9.0, 0.005)]):
        window = (t >= start) & (t < start + 1.5)
        carrier = np.sin(2 * np.pi * (120 + 40 * index) * t) + 0.5 * np.sin(2 * np.pi * 700 * t)
        envelope = 1 + np.sin(2 * np.pi * 4 * t)
        audio[window] += (level * carrier * envelope)[window]

    return audio.astype(np.float32)


def test_lowering_the_thresholds_never_loses_speech(vad):
    # The invariant the whole design rests on: the permissive tier is a
    # superset, so the borderline band is only ever an addition to what the
    # confident pass already found - never a substitution for it.
    audio = _speech_like_audio()
    settings = Settings(device="cpu", vad_borderline_onset=0.150, vad_borderline_offset=0.100)

    tiers = compute_tiers(audio, settings, vad)

    assert subtract_intervals(tiers.confident, tiers.union) == []
    assert subtract_intervals(tiers.borderline, tiers.union) == []
    assert total_duration(tiers.union) >= total_duration(tiers.confident)


def test_matching_tiers_leave_nothing_borderline(vad):
    # The documented way to opt out: same pair twice, so the second pass can
    # find nothing the first did not.
    audio = _speech_like_audio()
    settings = Settings(device="cpu", vad_borderline_onset=0.500, vad_borderline_offset=0.363)

    tiers = compute_tiers(audio, settings, vad)

    assert tiers.borderline == []
    assert not tiers.is_split
    assert tiers.union == tiers.confident
