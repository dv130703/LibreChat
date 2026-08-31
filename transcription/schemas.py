from pydantic import BaseModel, Field


class TranscriptSegment(BaseModel):
    id: str
    start: float
    end: float
    speaker: str
    text: str


class TranscriptionDiagnostics(BaseModel):
    alignment_gap_count: int = 0
    alignment_gap_total_s: float = 0.0
    alignment_failed: bool = False
    diarization_backend: str = "pyannote"
    diarization_speaker_count: int = 0
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
    speaker_min_requested: int | None = None
    speaker_max_requested: int | None = None
    speaker_hint_applied: bool = False
    speaker_hint_adjustments: list[str] = Field(default_factory=list)
    speaker_count_within_hint: bool | None = None


class TranscriptionResponse(BaseModel):
    segments: list[TranscriptSegment]
    language: str
    diagnostics: TranscriptionDiagnostics | None = None


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
