import json
import logging
import os
import tempfile
from pathlib import Path

from ..schemas import AudioQualityAssessment, Manifest, TranscriptionResponse
from .ingest_service import IngestService, get_ingest_service
from .quality_analyzer import QualityAnalyzer
from .whisperx_service import WhisperXService, get_whisperx_service

logger = logging.getLogger(__name__)


class SessionService:
    """Orchestrates the session-based transcription pipeline.

    Coordinates:
    - Ingest (file hashing, probing, artifact derivation)
    - Quality assessment
    - Optional preprocessing
    - Transcription (ASR + diarization)
    - Result caching
    """

    def __init__(
        self,
        ingest_service: IngestService = None,
        whisperx_service: WhisperXService = None,
    ):
        self.ingest_service = ingest_service or get_ingest_service()
        self.whisperx_service = whisperx_service or get_whisperx_service()
        self.quality_analyzer = QualityAnalyzer()

    def create_session(self, upload_path: Path, ingested_by: str | None = None) -> Manifest:
        """Create a new session: ingest and register the file.

        Returns the manifest with artifact information and quality assessment.
        """
        manifest = self.ingest_service.ingest(upload_path, ingested_by)
        return manifest

    def get_quality(self, sha256: str) -> AudioQualityAssessment:
        """Get quality assessment for a manifest (from original, unpreprocessed source).

        Does not re-upload or re-measure — uses the assessment in the cached manifest.
        """
        manifest = self.ingest_service.get_cached_manifest(sha256)
        if not manifest:
            raise ValueError(f"Manifest not found for {sha256}")

        if not manifest.quality_metrics or not manifest.quality_metrics.assessment:
            raise ValueError(f"No quality assessment in manifest for {sha256}")

        return manifest.quality_metrics.assessment

    def preprocess(
        self, sha256: str, adjust_gain: bool, replace: bool = False
    ) -> AudioQualityAssessment:
        """Apply optional preprocessing to audio.

        If replace=True, updates the manifest to prefer the preprocessed artifact for ASR.
        Diarization always uses the unpreprocessed artifact regardless.

        Returns the quality assessment of the preprocessed audio.
        """
        manifest = self.ingest_service.get_cached_manifest(sha256)
        if not manifest:
            raise ValueError(f"Manifest not found for {sha256}")

        if not manifest.asr_artifact_path:
            raise ValueError(f"No ASR artifact found for {sha256}")

        # Apply preprocessing to a new artifact
        original_asr_path = Path(manifest.asr_artifact_path)
        preprocessed_path = original_asr_path.with_name("asr_16k_mono_preprocessed.wav")

        if not preprocessed_path.exists():
            preprocessed_path = self.quality_analyzer.apply_preprocessing(
                original_asr_path, adjust_gain=adjust_gain
            )
            logger.info(f"Created preprocessed artifact: {preprocessed_path}")

        # Measure quality of preprocessed audio
        quality_metrics = self.quality_analyzer.analyze(preprocessed_path)

        # Optionally update manifest to prefer the preprocessed artifact
        if replace and quality_metrics.assessment:
            manifest.preferred_asr_artifact = "preprocessed"
            # Persist the updated manifest
            cache_dir = original_asr_path.parent
            manifest_path = cache_dir / "manifest.json"
            try:
                with open(manifest_path, "w") as f:
                    json.dump(manifest.model_dump(mode="json"), f, indent=2, default=str)
                logger.info(f"Updated manifest with preprocessed artifact preference: {manifest_path}")
            except Exception as e:
                logger.error(f"Failed to update manifest: {e}")

        return quality_metrics.assessment

    def transcribe(
        self,
        sha256: str,
        diarize: bool = True,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
        language: str | None = None,
        auto_detect: bool = False,
    ) -> TranscriptionResponse:
        """Transcribe audio.

        Uses the manifest's preferred ASR artifact (original or preprocessed).
        Diarization always uses the unpreprocessed diar_16k artifact.

        Returns a TranscriptionResponse with segments, diagnostics, and provenance.
        """
        manifest = self.ingest_service.get_cached_manifest(sha256)
        if not manifest:
            raise ValueError(f"Manifest not found for {sha256}")

        # Tier 3b: pin_language_by_default enforcement
        from ..config import get_settings
        settings = get_settings()
        if settings.pin_language_by_default and not auto_detect and not language:
            raise ValueError(
                "Language is required when pin_language_by_default is enabled. "
                "Either provide a language code or set auto_detect=true."
            )

        # Determine which ASR artifact to use
        if manifest.preferred_asr_artifact == "preprocessed":
            asr_artifact_path = Path(manifest.asr_artifact_path).with_name("asr_16k_mono_preprocessed.wav")
            if not asr_artifact_path.exists():
                logger.warning(
                    f"Preprocessed artifact not found, falling back to original: {asr_artifact_path}"
                )
                asr_artifact_path = Path(manifest.asr_artifact_path)
        else:
            asr_artifact_path = Path(manifest.asr_artifact_path)

        if not asr_artifact_path.exists():
            raise ValueError(f"ASR artifact not found: {asr_artifact_path}")

        # Transcribe (now returns segments, language, diagnostics)
        segments, detected_language, diagnostics = self.whisperx_service.transcribe(
            str(asr_artifact_path),
            language=language or (None if auto_detect else settings.default_language),
            diarize=diarize and manifest.channel_mode.mode != "per_channel",
            min_speakers=min_speakers,
            max_speakers=max_speakers,
        )

        # Build response with diagnostics and provenance
        preprocessing_applied = []
        if manifest.preferred_asr_artifact == "preprocessed":
            # Could parse from metadata, but for now just mark it was used
            preprocessing_applied.append("normalization")  # conservative default

        response = TranscriptionResponse(
            segments=segments,
            language=detected_language,
            file_sha256=manifest.audio_sha256,
            diagnostics=diagnostics,  # Add diagnostics from transcription
            provenance={
                "audio_sha256": manifest.audio_sha256,
                "asr_artifact_sha256": manifest.asr_artifact_sha256,
                "diar_artifact_sha256s": manifest.diar_artifact_sha256s,
                "preprocessing_applied": preprocessing_applied,
                "pipeline_version": "2.0",
            },
        )

        return response

    def get_result(self, sha256: str) -> TranscriptionResponse | None:
        """Retrieve a cached transcription result (not yet implemented in this version)."""
        # TODO: Implement result caching (load from {cache_dir}/{sha256}/result.json)
        return None


def get_session_service() -> SessionService:
    """Dependency injection for SessionService."""
    return SessionService()
