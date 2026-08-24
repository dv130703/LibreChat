import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..schemas import AudioQualityAssessment, Manifest, TranscriptionResponse
from ..services.session_service import SessionService, get_session_service

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

ALLOWED_CONTENT_PREFIXES = ("audio/", "video/")


@router.post("", response_model=Manifest)
async def create_session(
    file: UploadFile = File(...),
    service: SessionService = Depends(get_session_service),
) -> Manifest:
    """Create a new session: ingest and register the uploaded file.

    Returns:
      - Manifest with file metadata, artifact paths, quality assessment, and channel routing.
    """
    if file.content_type and not file.content_type.startswith(ALLOWED_CONTENT_PREFIXES):
        raise HTTPException(status_code=400, detail="File must be an audio or video file")

    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    tmp_path_obj = Path(tmp_path)
    try:
        manifest = service.create_session(tmp_path_obj)
        return manifest
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"File validation failed: {str(e)}") from e
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@router.get("/{sha256}", response_model=Manifest)
async def get_session(
    sha256: str,
    service: SessionService = Depends(get_session_service),
) -> Manifest:
    """Retrieve a session manifest by SHA256."""
    manifest = service.ingest_service.get_cached_manifest(sha256)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"Session not found: {sha256}")
    return manifest


@router.get("/{sha256}/quality", response_model=AudioQualityAssessment)
async def get_quality(
    sha256: str,
    service: SessionService = Depends(get_session_service),
) -> AudioQualityAssessment:
    """Get quality assessment for a session.

    Returns:
      - AudioQualityAssessment with rating, metrics, and recommendations.
    """
    try:
        return service.get_quality(sha256)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.post("/{sha256}/preprocess", response_model=AudioQualityAssessment)
async def preprocess_session(
    sha256: str,
    adjust_gain: bool = Form(False),
    replace: bool = Form(False),
    service: SessionService = Depends(get_session_service),
) -> AudioQualityAssessment:
    """Apply optional preprocessing (loudness normalization).

    Parameters:
      - adjust_gain: Apply two-pass loudness normalization
      - replace: If true, update manifest to prefer the preprocessed artifact for transcription

    Returns:
      - AudioQualityAssessment of the preprocessed audio.
    """
    try:
        return service.preprocess(sha256, adjust_gain, replace)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/{sha256}/transcribe", response_model=TranscriptionResponse)
async def transcribe_session(
    sha256: str,
    diarize: bool = Form(True),
    language: str | None = Form(None),
    auto_detect: bool = Form(False),
    min_speakers: int | None = Form(None),
    max_speakers: int | None = Form(None),
    service: SessionService = Depends(get_session_service),
) -> TranscriptionResponse:
    """Transcribe audio.

    Parameters:
      - diarize: Enable speaker diarization (disabled for per_channel mode)
      - language: Language code (e.g., "en"). If unset and pin_language_by_default is true, returns 400.
      - auto_detect: Explicitly request language auto-detection (overrides pin_language_by_default)
      - min_speakers: Minimum expected speakers (diarization hint)
      - max_speakers: Maximum expected speakers (diarization hint)

    Returns:
      - TranscriptionResponse with segments, diagnostics, and provenance.
    """
    try:
        return service.transcribe(
            sha256,
            diarize=diarize,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
            language=language,
            auto_detect=auto_detect,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/{sha256}/result", response_model=TranscriptionResponse)
async def get_result(
    sha256: str,
    service: SessionService = Depends(get_session_service),
) -> TranscriptionResponse:
    """Retrieve a cached transcription result (if available).

    Returns 404 if the result hasn't been computed yet.
    """
    result = service.get_result(sha256)
    if not result:
        raise HTTPException(status_code=404, detail=f"Result not found for session: {sha256}")
    return result
