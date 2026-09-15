"""`WhisperXService._build_speaker_segments` - grouping already-resolved words
into speaker-pure output segments, instead of one segment per Whisper ASR
decode chunk. Pure function over plain dicts, called directly on the class
(it's a `@staticmethod`) - no model loading, no `WhisperXService` instance
needed.

Word fixtures below mirror the shape `_resolve_speaker_assignment` leaves
words in: `speaker` is the raw diarization/channel id (or `None` when nothing
was close enough to trust), `_assignment_method` is how that speaker was
decided (`overlap`/`nearest`/`unknown`/`channel_split`/`none`), matching the
`_` -> stripped convention documented in `test_vad_tiers.py`.
"""

from transcription.recording_profile import UNKNOWN_SPEAKER_LABEL
from transcription.whisperx_service import (
    MAX_SEGMENT_WORDS,
    SEGMENT_HARD_CAP_FACTOR,
    WhisperXService,
)


def _word(word, start, end, speaker="SPEAKER_00", method="overlap", distance=0.0, vad_confidence=0.9):
    return {
        "word": word,
        "start": start,
        "end": end,
        "speaker": speaker,
        "_assignment_method": method,
        "_assignment_distance_s": distance,
        "_vad_confidence": vad_confidence,
    }


def _segment(words, start=None, end=None, vad_borderline=False):
    return {
        "start": start if start is not None else words[0]["start"],
        "end": end if end is not None else words[-1]["end"],
        "text": "".join(w["word"] for w in words).strip(),
        "words": words,
        "_vad_borderline": vad_borderline,
    }


def test_alternating_speakers_split_one_segment_into_three():
    words = [
        _word(" Hello", 0.0, 0.3, speaker="SPEAKER_00"),
        _word(" there", 0.3, 0.6, speaker="SPEAKER_00"),
        _word(" no", 0.6, 0.9, speaker="SPEAKER_01"),
        _word(" wait", 0.9, 1.2, speaker="SPEAKER_00"),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert [(s["speaker"], s["text"], s["start"], s["end"]) for s in result] == [
        ("Speaker 1", "Hello there", 0.0, 0.6),
        ("Speaker 2", "no", 0.6, 0.9),
        ("Speaker 1", "wait", 0.9, 1.2),
    ]


def test_same_speaker_run_merges_across_a_segment_boundary():
    seg_a = _segment([_word(" Hi", 0.0, 0.3, speaker="SPEAKER_00")])
    seg_b = _segment([_word(" there", 0.6, 1.0, speaker="SPEAKER_00")])

    result = WhisperXService._build_speaker_segments([seg_a, seg_b], {})

    assert len(result) == 1
    assert result[0]["text"] == "Hi there"
    assert result[0]["start"] == 0.0
    assert result[0]["end"] == 1.0


def test_unknown_words_form_their_own_segment_without_consuming_a_speaker_number():
    words = [
        _word(" Yes", 0.0, 0.2, speaker="SPEAKER_00", method="overlap"),
        _word(" mumble", 0.2, 0.5, speaker=None, method="unknown", distance=8.0, vad_confidence=0.4),
        _word(" okay", 0.5, 0.8, speaker="SPEAKER_00", method="overlap"),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert [(s["speaker"], s["text"]) for s in result] == [
        ("Speaker 1", "Yes"),
        (UNKNOWN_SPEAKER_LABEL, "mumble"),
        ("Speaker 1", "okay"),
    ]


def test_text_reconstruction_preserves_punctuation_spacing():
    words = [
        _word(" Hello", 0.0, 0.3),
        _word(",", 0.3, 0.35),
        _word(" world", 0.35, 0.6),
        _word(".", 0.6, 0.65),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert len(result) == 1
    assert result[0]["text"] == "Hello, world."


def test_text_reconstruction_spaces_bare_aligner_words():
    """WhisperX's forced aligner splits on whitespace and returns BARE words,
    unlike Whisper's own tokens which carry a leading space. Concatenating
    those directly is what produced run-together transcripts
    ("Thankyouverymuch") - every separator in the line was dropped."""
    words = [
        _word("Thank", 0.0, 0.2),
        _word("you", 0.2, 0.4),
        _word("very", 0.4, 0.6),
        _word("much.", 0.6, 0.9),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert result[0]["text"] == "Thank you very much."


def test_text_reconstruction_handles_bare_words_with_detached_punctuation():
    words = [
        _word("Hello", 0.0, 0.3),
        _word(",", 0.3, 0.35),
        _word("world", 0.35, 0.6),
        _word(".", 0.6, 0.65),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert result[0]["text"] == "Hello, world."


def test_text_reconstruction_handles_mixed_token_conventions():
    words = [
        _word(" Mixed", 0.0, 0.2),
        _word("tokens", 0.2, 0.4),
        _word(" here", 0.4, 0.6),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert result[0]["text"] == "Mixed tokens here"


def test_segment_reports_least_confident_word_in_its_run():
    words = [
        _word(" One", 0.0, 0.3, method="overlap", distance=0.0),
        _word(" two", 0.3, 0.6, method="nearest", distance=1.4),
        _word(" three", 0.6, 0.9, method="overlap", distance=0.0),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert len(result) == 1
    assert result[0]["assignment_method"] == "nearest"
    assert result[0]["assignment_distance_s"] == 1.4


def test_vad_borderline_is_true_if_any_source_segment_was_borderline():
    seg_a = _segment([_word(" Hi", 0.0, 0.3)], vad_borderline=True)
    seg_b = _segment([_word(" there", 0.3, 0.6)], vad_borderline=False)

    result = WhisperXService._build_speaker_segments([seg_a, seg_b], {})

    assert len(result) == 1
    assert result[0]["vad_borderline"] is True


def test_channel_split_words_stay_speaker_pure():
    words = [
        _word(" Hi", 0.0, 0.3, speaker="CHANNEL_0", method="channel_split", distance=None, vad_confidence=None),
        _word(" there", 0.3, 0.6, speaker="CHANNEL_0", method="channel_split", distance=None, vad_confidence=None),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert len(result) == 1
    assert result[0]["speaker"] == "Speaker 1"
    assert result[0]["assignment_method"] == "channel_split"
    assert result[0]["text"] == "Hi there"


# --- Breaking one speaker's continuous speech into readable lines ---------
# Grouping by speaker alone produced 250-second single-paragraph lines on real
# interview audio (an interviewer reading a formal notice legitimately holds
# the floor for minutes). These cover the boundaries that now end a line
# early - without ever moving a word to a different speaker.


def _run_of(count, *, start=0.0, step=0.3, word="word", speaker="SPEAKER_00"):
    """`count` consecutive words, `step` apart, with no pause between them."""
    return [
        _word(word, start + i * step, start + i * step + step / 2, speaker=speaker)
        for i in range(count)
    ]


def test_long_pause_splits_one_speakers_run():
    words = [
        _word("Hello", 0.0, 0.3),
        _word("there.", 0.3, 0.6),
        # 2s of silence - well past the 1.5s threshold
        _word("Right,", 2.6, 2.9),
        _word("continuing.", 2.9, 3.2),
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert [s["text"] for s in result] == ["Hello there.", "Right, continuing."]
    assert all(s["speaker"] == "Speaker 1" for s in result)


def test_short_pause_does_not_split():
    words = [
        _word("Hello", 0.0, 0.3),
        _word("there.", 1.0, 1.3),  # 0.7s gap - ordinary speech rhythm
    ]
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert len(result) == 1


def test_long_monologue_splits_at_a_sentence_end():
    # Past the word cap, then a sentence ends - that is where it breaks.
    words = _run_of(MAX_SEGMENT_WORDS + 5)
    words[-1]["word"] = "end."
    words += _run_of(5, start=words[-1]["end"] + 0.1, word="next")
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert len(result) == 2
    assert result[0]["text"].endswith("end.")
    assert result[1]["text"].startswith("next")


def test_run_with_no_sentence_end_is_still_capped():
    # No punctuation anywhere: the hard cap has to break it regardless, or a
    # run could grow without bound.
    words = _run_of(int(MAX_SEGMENT_WORDS * SEGMENT_HARD_CAP_FACTOR) + 10)
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    assert len(result) > 1
    assert all(len(s["words"]) <= MAX_SEGMENT_WORDS * SEGMENT_HARD_CAP_FACTOR for s in result)


def test_splitting_never_moves_a_word_between_speakers():
    words = (
        _run_of(3, start=0.0, word="a", speaker="SPEAKER_00")
        + _run_of(3, start=10.0, word="b", speaker="SPEAKER_01")
        + _run_of(3, start=20.0, word="c", speaker="SPEAKER_00")
    )
    result = WhisperXService._build_speaker_segments([_segment(words)], {})

    # Every word keeps its own speaker, and order is preserved end to end.
    for segment in result:
        assert {w["speaker"] for w in segment["words"]} == {segment["speaker"]}
    assert [w["word"] for s in result for w in s["words"]] == [w["word"] for w in words]
