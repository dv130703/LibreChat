"""`find_unclaimed_speech` / `group_recovery_slices` - making sure speech the
VAD identified is never left undecoded.

The batched decoder concatenates VAD regions into ~30s chunks, and a short,
quiet utterance alone between long silences gets buried in one and skipped.
Measured on a real interview: a 65s stretch the VAD scored as speech (peak
0.929) produced a single 0.4s line, while the same audio decoded on its own
yielded four more utterances.
"""

from transcription.whisperx_service import (
    MAX_RECOVERY_SLICE_S,
    find_unclaimed_speech,
    group_recovery_slices,
)


def _seg(start, end, text="something"):
    return {"start": start, "end": end, "text": text}


def test_speech_with_no_transcript_at_all_is_unclaimed():
    speech = [(10.0, 12.0), (50.0, 52.0)]
    segments = [_seg(10.2, 11.5)]
    assert find_unclaimed_speech(speech, segments) == [(50.0, 52.0)]


def test_any_overlap_counts_as_claimed():
    # The decoder looked there; that it produced little is not this pass's call.
    speech = [(10.0, 20.0)]
    segments = [_seg(19.9, 25.0)]
    assert find_unclaimed_speech(speech, segments) == []


def test_regions_shorter_than_the_floor_are_ignored():
    speech = [(10.0, 10.1)]
    assert find_unclaimed_speech(speech, []) == []


def test_no_speech_means_nothing_to_recover():
    assert find_unclaimed_speech([], [_seg(0, 5)]) == []


def test_everything_unclaimed_when_asr_returned_nothing():
    speech = [(1.0, 3.0), (8.0, 9.0)]
    assert find_unclaimed_speech(speech, []) == [(1.0, 3.0), (8.0, 9.0)]


def test_nearby_regions_are_grouped_into_one_slice():
    # Decoded together they carry each other's context, as in a fumbled exchange.
    assert group_recovery_slices([(10.0, 11.0), (14.0, 15.0), (18.0, 19.0)]) == [(10.0, 19.0)]


def test_distant_regions_stay_separate():
    assert group_recovery_slices([(10.0, 11.0), (600.0, 601.0)]) == [
        (10.0, 11.0),
        (600.0, 601.0),
    ]


def test_a_slice_never_grows_past_the_cap():
    # Regions each within the grouping gap, but spanning far more than the cap.
    regions = [(i * 10.0, i * 10.0 + 1.0) for i in range(60)]
    for start, end in group_recovery_slices(regions):
        assert end - start <= MAX_RECOVERY_SLICE_S
