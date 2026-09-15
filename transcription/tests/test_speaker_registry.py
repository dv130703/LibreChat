"""`_SpeakerRegistry` - keeping one identity per real person across windows
that were each diarized independently.

Each window is clustered on its own, so its `SPEAKER_00` has nothing to do
with the previous window's `SPEAKER_00`; only the embedding relates them.
"""

import numpy as np

from transcription.whisperx_service import _SpeakerRegistry, _merge_adjacent_turns


def _emb(*values):
    return np.array(values, dtype=np.float64)


ALICE = _emb(1.0, 0.0, 0.0)
BOB = _emb(0.0, 1.0, 0.0)
CAROL = _emb(0.0, 0.0, 1.0)


def test_same_voice_in_two_windows_keeps_one_identity():
    reg = _SpeakerRegistry()
    first = reg.resolve_window([(ALICE, 10.0)])
    second = reg.resolve_window([(ALICE * 0.9, 10.0)])
    assert first == second


def test_different_voices_get_different_identities():
    reg = _SpeakerRegistry()
    labels = reg.resolve_window([(ALICE, 10.0), (BOB, 10.0)])
    assert len(set(labels)) == 2


def test_two_speakers_in_one_window_never_collapse_onto_the_same_identity():
    """The bug this guards: the diarizer already decided these are different
    people within the window, so however similar their embeddings look, they
    must not both be matched back to one earlier speaker. On real audio that
    re-merged a lawyer into the interviewer after the window had correctly
    separated them."""
    reg = _SpeakerRegistry()
    reg.resolve_window([(ALICE, 30.0)])

    # Both lean towards Alice, one slightly more than the other.
    near = ALICE + _emb(0.0, 0.05, 0.0)
    nearer = ALICE + _emb(0.0, 0.01, 0.0)
    labels = reg.resolve_window([(near, 5.0), (nearer, 5.0)])

    assert len(set(labels)) == 2, "two speakers in one window collapsed into one"


def test_unusable_embedding_gets_its_own_identity_rather_than_a_guess():
    reg = _SpeakerRegistry()
    reg.resolve_window([(ALICE, 10.0)])
    labels = reg.resolve_window([(None, 5.0), (_emb(np.nan, np.nan, np.nan), 5.0)])
    assert len(set(labels)) == 2


def test_centroid_is_refined_by_later_longer_windows():
    # An identity built from two seconds should be pulled towards the voice as
    # heard at length, so a later window matches it more readily.
    reg = _SpeakerRegistry()
    reg.resolve_window([(ALICE, 2.0)])
    reg.resolve_window([(ALICE * 0.8 + BOB * 0.2, 120.0)])
    assert reg.resolve_window([(ALICE * 0.8 + BOB * 0.2, 5.0)]) == ["SPEAKER_00"]


def test_merge_adjacent_turns_rejoins_a_turn_split_at_a_window_boundary():
    turns = [
        {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_00"},
        {"start": 5.0, "end": 9.0, "speaker": "SPEAKER_00"},
        {"start": 9.0, "end": 12.0, "speaker": "SPEAKER_01"},
    ]
    merged = _merge_adjacent_turns(turns)
    assert [(t["start"], t["end"], t["speaker"]) for t in merged] == [
        (0.0, 9.0, "SPEAKER_00"),
        (9.0, 12.0, "SPEAKER_01"),
    ]


def test_merge_adjacent_turns_keeps_a_real_gap_between_same_speaker_turns():
    turns = [
        {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_00"},
        {"start": 8.0, "end": 9.0, "speaker": "SPEAKER_00"},
    ]
    assert len(_merge_adjacent_turns(turns)) == 2
