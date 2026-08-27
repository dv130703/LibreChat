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
    speaker_min_requested: int | None = None
    speaker_max_requested: int | None = None
    speaker_hint_applied: bool = False
    speaker_hint_adjustments: list[str] = Field(default_factory=list)
    speaker_count_within_hint: bool | None = None


class TranscriptionResponse(BaseModel):
    segments: list[TranscriptSegment]
    language: str
    diagnostics: TranscriptionDiagnostics | None = None
