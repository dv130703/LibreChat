"""`_drop_prompt_echoes` - removing Whisper's recitals of its own
`initial_prompt` from the transcript.

Whisper emits its prompt back as if it were speech (a well-known failure
mode; `build_initial_prompt`'s own docstring warns that "framing is what
leaks into the transcript"). On a real 3-hour interview the full 14-term
glossary was transcribed verbatim as dialogue eight separate times, at
timestamps where nobody said it - fabricated content in a forensic record.
"""

from transcription.whisperx_service import (
    MIN_PROMPT_ECHO_WORDS,
    _drop_prompt_echoes,
    _is_prompt_echo,
    _normalize_for_echo,
)

# The exact term list from the recording this was found on.
PROMPT = (
    "Serious Fraud Office, SFO, Counter Fraud Centre, CFC, Quay Street, "
    "Auckland CBD, forensic accountant, financial investigation, proceeds of "
    "crime, beneficial ownership, suspicious transaction, search warrant, "
    "bank statement, conflict of interest."
)
PROMPT_WORDS = _normalize_for_echo(PROMPT)


def _seg(text):
    return {"text": text, "start": 0.0, "end": 1.0}


def test_drops_a_verbatim_recital_of_the_whole_prompt():
    assert _is_prompt_echo(PROMPT, PROMPT_WORDS)


def test_drops_the_truncated_recital_seen_in_the_real_transcript():
    # Whisper cut the recital off mid-list, exactly as observed.
    leaked = (
        "Serious Fraud Office, SFO, Counter Fraud Centre, CFC, Quay Street, "
        "Auckland CBD, forensic accountant, financial investigation"
    )
    assert _is_prompt_echo(leaked, PROMPT_WORDS)


def test_drops_the_alignment_failing_fragment():
    # The fragment whisperx logged "backtrack failed" on - it was never spoken.
    assert _is_prompt_echo(
        "Forensic accountant, financial investigation, proceeds of crime.", PROMPT_WORDS
    )


def test_keeps_real_speech_that_uses_a_listed_term():
    # Listing a term is precisely so it gets transcribed - using one must
    # never cost a line.
    for spoken in [
        "I'm an investigator here at the Serious Fraud Office and also present is my colleague.",
        "We obtained a search warrant for the bank statement records.",
        "Brendan Miffey, Senior Forensic Accountant.",
        "That would be a conflict of interest.",
    ]:
        assert not _is_prompt_echo(spoken, PROMPT_WORDS), spoken


def test_keeps_short_fragments_even_if_they_match():
    # Under the word floor, a match is far more likely to be real speech.
    short = " ".join(PROMPT_WORDS[:MIN_PROMPT_ECHO_WORDS - 1])
    assert not _is_prompt_echo(short, PROMPT_WORDS)


def test_no_prompt_means_nothing_is_dropped():
    segments = [_seg(PROMPT), _seg("ordinary speech")]
    assert _drop_prompt_echoes(segments, None) == 0
    assert len(segments) == 2


def test_drops_in_place_and_reports_the_count():
    segments = [
        _seg("Okay, so that's recording now."),
        _seg(PROMPT),
        _seg("So my name is Elman Closold."),
        _seg("Serious Fraud Office, SFO, Counter Fraud Centre, CFC, Quay Street, Auckland CBD"),
    ]
    dropped = _drop_prompt_echoes(segments, PROMPT)

    assert dropped == 2
    assert [s["text"] for s in segments] == [
        "Okay, so that's recording now.",
        "So my name is Elman Closold.",
    ]
