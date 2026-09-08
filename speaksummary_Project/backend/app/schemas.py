from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class WordToken(BaseModel):
    text: str
    start: float | None = None
    end: float | None = None
    confidence: float | None = None
    speaker: str | None = None
    speaker_overlap: bool = False
    is_alignment_gap: bool = False
    # Which VAD tier admitted this word. "borderline" means only the permissive
    # thresholds found it: transcribed so it isn't lost, but unverified.
    vad_confidence: Literal["high", "borderline"] | None = None


class TranscriptSegment(BaseModel):
    id: str
    start: float
    end: float
    speaker: str
    text: str
    words: list[WordToken] | None = None
    avg_confidence: float | None = None
    # True when any word here came from the borderline tier. A line worth a
    # reviewer's ear before the transcript is relied on.
    vad_borderline: bool = False


class TranscriptionDiagnostics(BaseModel):
    alignment_gap_count: int = 0
    alignment_gap_total_s: float = 0.0
    low_confidence_word_count: int = 0
    diarization_backend: str = "pyannote"
    diarization_speaker_count: int = 0
    # Share of the recording the confident tier called speech.
    vad_speech_ratio: float | None = None
    # What the second, permissive tier recovered. Reported rather than left
    # implicit: this is audio the old single-threshold pass would have dropped
    # without trace, so the size of it is the number to check.
    vad_borderline_duration_s: float = 0.0
    vad_borderline_word_count: int = 0
    vad_borderline_segment_count: int = 0
    vad_onset: float | None = None
    vad_offset: float | None = None
    vad_borderline_onset: float | None = None
    vad_borderline_offset: float | None = None
    # How much of the caller's supplied terminology actually reached the model.
    # Whisper's prompt window is finite, so a long list is truncated; saying so
    # beats letting the caller assume every term was applied.
    context_terms_used: int = 0
    context_terms_dropped: list[str] = Field(default_factory=list)
    # Proper nouns lifted out of the free-text description to fill window the
    # explicit terms didn't need.
    context_terms_harvested: list[str] = Field(default_factory=list)
    context_prompt_tokens: int = 0
    context_prompt_budget: int = 0
    # The speaker-count hint, end to end. `applied` is false when one was given
    # and the active diarization backend couldn't take it; `within_hint` is null
    # when there was no hint to measure against.
    speaker_min_requested: int | None = None
    speaker_max_requested: int | None = None
    speaker_hint_applied: bool = False
    speaker_hint_adjustments: list[str] = Field(default_factory=list)
    speaker_count_within_hint: bool | None = None


class TranscriptionProvenance(BaseModel):
    audio_sha256: str
    asr_artifact_sha256: str
    diar_artifact_sha256s: list[str] = Field(default_factory=list)
    preprocessing_applied: list[str] = Field(default_factory=list)
    pipeline_version: str = "2.0"


class TranscriptionResponse(BaseModel):
    segments: list[TranscriptSegment]
    language: str
    file_sha256: str | None = None
    diagnostics: TranscriptionDiagnostics | None = None
    provenance: TranscriptionProvenance | None = None


class HealthResponse(BaseModel):
    status: str
    device: str
    compute_type: str
    whisper_model: str
    model_loaded: bool


class OllamaModel(BaseModel):
    name: str


class OllamaModelsResponse(BaseModel):
    models: list[OllamaModel]


class SummarizeRequest(BaseModel):
    segments: list[TranscriptSegment]
    style: Literal["concise", "bullets", "detailed"] = "concise"
    length: Literal["short", "long"] = "short"
    model: str
    # What the recording is about, in the user's own words. The system prompt
    # already undertakes to use "supplied interview metadata" as source of
    # truth; this is that metadata. Unlike Whisper, the summariser follows
    # instructions, so prose is worth something here.
    context: str | None = None


class SummaryResponse(BaseModel):
    overview: str
    key_points: list[str]
    action_items: list[str]


class AudioStream(BaseModel):
    """Metadata for a single audio stream in a container."""

    index: int
    codec: str
    channels: int
    channel_layout: str | None = None
    sample_rate: int
    bit_rate: int | None = None
    duration_s: float | None = None


class PerChannelStatistics(BaseModel):
    """Per-channel audio statistics."""

    index: int
    rms_db: float | None = None
    peak_db: float | None = None
    silence_ratio: float | None = None
    clipping_ratio: float | None = None
    dynamic_range_db: float | None = None


class PairwiseCorrelation(BaseModel):
    """Correlation between two channels."""

    channel_a: int
    channel_b: int
    correlation: float


class WindowedCorrelationAnalysis(BaseModel):
    """Windowed correlation to detect localized correlation."""

    window_size_s: float
    windows: list[float]  # correlation per window
    mean_correlation: float
    max_correlation: float
    min_correlation: float


class ChannelIndependenceAnalysis(BaseModel):
    """Detailed channel independence analysis."""

    channel_count: int
    per_channel_stats: list[PerChannelStatistics]
    pairwise_correlations: list[PairwiseCorrelation]
    windowed_analysis: WindowedCorrelationAnalysis | None = None
    independence_score: float  # 0.0 (identical) to 1.0 (independent)
    classification: Literal["mono", "mixed", "independent", "unknown"]
    rationale: str


class ManifestChannelMode(BaseModel):
    """Channel configuration and routing decision."""

    mode: Literal["mono", "stereo_distinct", "stereo_duplicate", "per_channel"]
    description: str
    num_discrete_channels: int = 1
    correlation: float | None = None  # stereo_duplicate detection
    analysis: ChannelIndependenceAnalysis | None = None  # detailed forensic data


class ClippingAnalysis(BaseModel):
    """Detailed clipping detection at PCM level."""

    clipping_percentage: float = 0.0  # % of samples at peak
    max_consecutive_clipped_samples: int = 0
    clipping_event_count: int = 0
    has_significant_clipping: bool = False


class AudioQualityAssessment(BaseModel):
    """User-facing quality rating with recommended actions."""

    rating: Literal["good", "acceptable", "poor", "very_poor"]
    description: str
    # Suggested preprocessing actions
    should_adjust_gain: bool = False
    show_clipping_warning: bool = False


class AudioQualityMetrics(BaseModel):
    """Comprehensive audio quality assessment using three key metrics: noise, loudness, clipping."""

    # Legacy fields (kept for backward compatibility)
    speech_duration_s: float | None = None
    silence_duration_s: float | None = None
    speech_ratio: float | None = None
    peak_level_db: float | None = None
    rms_level_db: float | None = None

    # Core quality metrics
    # 1. Noise: Signal-to-Noise Ratio from VAD (Voice Activity Detection)
    snr_db: float | None = None
    vad_detected_speech_db: float | None = None
    vad_detected_noise_db: float | None = None

    # 2. Loudness: Integrated LUFS (EBU R128 standard)
    lufs_integrated: float | None = None
    lufs_short_term: float | None = None
    loudness_range_lu: float | None = None

    # 3. Clipping: Detailed PCM-level analysis
    clipping: ClippingAnalysis | None = None

    # Extended metrics (v2.0)
    bandwidth_hz: float | None = None
    reverb_c50_proxy: float | None = None
    codec_provenance: dict | None = None

    # Overall assessment
    assessment: AudioQualityAssessment | None = None


class Manifest(BaseModel):
    """Immutable record of an ingested file.

    Establishes what "this file" means. Everything downstream is a claim
    about these specific bytes, keyed by audio_sha256.
    """

    audio_sha256: str = Field(
        description="SHA256 of original audio bytes. Idempotency key and integrity proof."
    )
    original_filename: str
    size_bytes: int
    container: str  # e.g., "mp4", "wav", "webm"
    duration_s: float
    ingested_at: datetime
    ingested_by: str | None = None
    pipeline_version: str

    # Channel routing decision
    channel_mode: ManifestChannelMode
    streams: list[AudioStream]

    # Quality signals
    quality_metrics: AudioQualityMetrics | None = None

    # Artifact paths (video extraction)
    audio_artifact_path: str | None = None
    audio_artifact_sha256: str | None = None

    # Derived artifacts (v2.0)
    asr_artifact_path: str | None = None
    asr_artifact_sha256: str | None = None
    diar_artifact_paths: list[str] = Field(default_factory=list)
    diar_artifact_sha256s: list[str] = Field(default_factory=list)
    vad_timeline_path: str | None = None

    # ASR artifact preference (original vs. preprocessed)
    preferred_asr_artifact: Literal["original", "preprocessed"] = "original"
