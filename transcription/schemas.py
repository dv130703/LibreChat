from pydantic import BaseModel, Field


class WordSpan(BaseModel):
    """One aligned word, with its own independently-computed speaker
    assignment - see `assign_word_speakers` in the installed `whisperx`
    package. Kept alongside the segment's own `speaker` (rather than
    discarded, as `WhisperXService.transcribe` used to do) because the two
    are calculated independently: a word disagreeing with its segment's
    overall label is itself a diagnostic signal, not noise.
    """

    word: str
    start: float | None = None
    end: float | None = None
    # None when `assignment_method` is "unknown" - no diarization evidence
    # was close enough to trust, so this deliberately isn't guessed. `speaker`
    # is then rendered as "Unknown" downstream, not left blank.
    speaker: str | None = None
    assignment_method: str = "none"
    # Seconds from the nearest diarization turn - 0 for "overlap", None for
    # "channel_split"/"none" (not applicable), a real gap for "nearest"/
    # "unknown". See MAX_NEAREST_FALLBACK_DISTANCE_S in whisperx_service.py.
    assignment_distance_s: float | None = None


class DiarizationTurn(BaseModel):
    """One raw pyannote speaker turn, before this app's own sequential
    "Speaker N" renumbering - see `WhisperXService._speaker_label`. Empty for
    channel-split transcriptions, which never call pyannote at all.
    """

    start: float
    end: float
    speaker: str


class TranscriptSegment(BaseModel):
    id: str
    start: float
    end: float
    speaker: str
    text: str
    # How `speaker` above was actually decided - "overlap" (a diarization
    # turn genuinely covered this segment), "nearest" (no turn overlapped it,
    # but the nearest one was within MAX_NEAREST_FALLBACK_DISTANCE_S),
    # "unknown" (no turn overlapped it and the nearest one was too far away
    # to trust - `speaker` is "Unknown", not a guess), "channel_split" (no
    # pyannote involved - the speaker is just which audio channel this came
    # from), or "none" (diarization wasn't run at all). See
    # `WhisperXService._resolve_speaker_assignment`.
    assignment_method: str = "none"
    assignment_distance_s: float | None = None
    # Per-word detail, including each word's own independently-computed
    # speaker - see WordSpan.
    words: list[WordSpan] = Field(default_factory=list)


class TranscriptionDiagnostics(BaseModel):
    alignment_gap_count: int = 0
    alignment_gap_total_s: float = 0.0
    alignment_failed: bool = False
    diarization_backend: str = "pyannote"
    diarization_speaker_count: int = 0
    # Whether speakers came from splitting the file's own audio channels
    # instead of pyannote clustering - see WhisperXService.transcribe.
    channel_split_applied: bool = False
    # Which ASR model actually produced this transcript. `model_requested`
    # is what the caller asked for - None when they left it on "auto" -
    # and `model_used` is what the server resolved that to and loaded, so
    # a transcript never leaves it ambiguous which model wrote it.
    model_requested: str | None = None
    model_used: str | None = None
    # Whether digits were suppressed at the decoder for this run. Reported
    # because it is not recoverable afterwards: a numeral the decoder was
    # forbidden to emit leaves no trace in the transcript to correct.
    suppress_numerals: bool | None = None
    # What the prompt window actually took, from WhisperXService.build_prompt -
    # a term the caller typed and that never reached the model is worth saying
    # out loud, not silently dropped here the same way it would be silently
    # dropped from the prompt itself.
    context_terms_used: int = 0
    context_terms_dropped: list[str] = Field(default_factory=list)
    context_terms_harvested: list[str] = Field(default_factory=list)
    context_prompt_tokens: int = 0
    context_prompt_budget: int = 0
    # Term count in the combined hotwords string actually sent to the decoder
    # (deployment glossary + this recording's confirmed terms) - see
    # WhisperXService._build_request_hotwords. 0 means neither had anything
    # to contribute this run.
    hotwords_term_count: int = 0
    speaker_min_requested: int | None = None
    speaker_max_requested: int | None = None
    speaker_hint_applied: bool = False
    speaker_hint_adjustments: list[str] = Field(default_factory=list)
    speaker_count_within_hint: bool | None = None
    # Raw pyannote label (e.g. "SPEAKER_00") -> this transcript's renumbered
    # "Speaker N"/"Channel N" label, so a raw turn or embedding can be traced
    # back to what the transcript actually displays for it.
    speaker_label_map: dict[str, str] = Field(default_factory=dict)
    # Whether a "difficult" first diarization pass triggered one automatic
    # retry at a different clustering threshold, and what happened - see
    # DIFFICULT_RETRY_CLUSTERING_THRESHOLD in whisperx_service.py.
    # `diarization_retry_kept` is "retry" (the retry measurably reduced
    # suspicious_segment_ratio), "original" (it didn't, or the retry itself
    # failed), or None (no retry was attempted).
    diarization_retry_attempted: bool = False
    diarization_retry_kept: str | None = None
    diarization_retry_threshold: float | None = None
    diarization_original_suspicious_ratio: float | None = None
    diarization_retry_suspicious_ratio: float | None = None


class RecordingProfile(BaseModel):
    """A statistical fingerprint of the recording's turn-taking - see
    `transcription/recording_profile.py`. Purely descriptive: nothing here
    changes what got transcribed or how; it exists so a reviewer (or
    downstream code) can tell a rapid two-person dialogue apart from a
    monologue apart from messy, low-confidence cross-talk without
    re-deriving it from raw segments.
    """

    speaker_count: int = 0
    turn_count: int = 0
    median_turn_duration_s: float = 0.0
    mean_turn_duration_s: float = 0.0
    p95_turn_duration_s: float = 0.0
    longest_turn_s: float = 0.0
    speaker_switches_per_minute: float = 0.0
    speaker_time_distribution_s: dict[str, float] = Field(default_factory=dict)
    overlap_ratio: float = 0.0
    unassigned_audio_ratio: float = 0.0
    short_turn_ratio: float = 0.0
    diarization_coverage_ratio: float = 0.0
    boundary_conflict_ratio: float = 0.0
    word_segment_disagreement_ratio: float = 0.0
    suspicious_segment_ratio: float = 0.0
    suspicious_segment_ids: list[str] = Field(default_factory=list)
    # "monologue" | "conversation" | "rapid_dialogue" | "difficult" |
    # "insufficient_data" - see `_classify` in recording_profile.py.
    classification: str = "insufficient_data"


class TranscriptionResponse(BaseModel):
    segments: list[TranscriptSegment]
    language: str
    diagnostics: TranscriptionDiagnostics | None = None
    # The raw diarization turns pyannote produced, before word/segment
    # assignment - the forensic ground truth `segments[*].speaker` is derived
    # from. Empty for channel-split transcriptions.
    diarization_turns: list[DiarizationTurn] = Field(default_factory=list)
    # One embedding vector per detected speaker cluster, keyed by pyannote's
    # raw label - not requested/stored anywhere before this. `None` for
    # channel-split transcriptions (no pyannote involved).
    speaker_embeddings: dict[str, list[float]] | None = None
    recording_profile: RecordingProfile = Field(default_factory=RecordingProfile)


class TranscriptionConfig(BaseModel):
    """This deployment's effective transcription defaults.

    Served so the client can name what "auto" actually resolves to rather than
    showing a blank that hides the server's own choice.
    """

    models: list[str]
    default_model: str
    default_language: str | None = None
    default_suppress_numerals: bool
    default_clustering_threshold: float | None = None
    hotwords_configured: bool
    suggested_terms: list[str] = Field(default_factory=list)
    # Same number `resolve_speaker_bounds` clamps to server-side - served so
    # the client can stop the user at the real limit instead of silently
    # clamping a larger number after the fact.
    max_speakers: int
