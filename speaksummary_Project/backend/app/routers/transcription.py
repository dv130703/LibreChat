import json
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from ..schemas import AudioQualityMetrics, Manifest, TranscriptionResponse
from ..services.ingest_service import IngestService, get_ingest_service
from ..services.whisperx_service import WhisperXService, get_whisperx_service
from ..services.quality_analyzer import PreprocessingError, QualityAnalyzer

router = APIRouter(prefix="/api", tags=["transcription"])

ALLOWED_CONTENT_PREFIXES = ("audio/", "video/")


class QualityCheckResponse(BaseModel):
    """Response from audio quality assessment endpoint."""

    quality_metrics: AudioQualityMetrics


@router.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    file: UploadFile = File(...),
    diarize: bool = Form(True),
    min_speakers: int | None = Form(None),
    max_speakers: int | None = Form(None),
    language: str | None = Form(None),
    # The terms the caller confirmed should go to the model, comma-separated.
    # In the UI these are the chips the user saw and edited, so this is a
    # decision rather than an inference.
    context_terms: str | None = Form(None),
    # Free text about the recording. Goes to the summariser whole; for Whisper
    # it is only mined for proper nouns, and only to fill budget the confirmed
    # terms did not need. Never sent as prose - Whisper echoes it.
    context: str | None = Form(None),
    ingest_service: IngestService = Depends(get_ingest_service),
    transcribe_service: WhisperXService = Depends(get_whisperx_service),
) -> TranscriptionResponse:
    if file.content_type and not file.content_type.startswith(ALLOWED_CONTENT_PREFIXES):
        raise HTTPException(status_code=400, detail="File must be an audio or video file")

    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    tmp_path_obj = Path(tmp_path)
    manifest = None
    try:
        # Step 1: Ingest and register (hash, probe, validate, extract audio)
        try:
            manifest = ingest_service.ingest(tmp_path_obj)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"File validation failed: {str(e)}") from e

        # Use extracted audio if video, otherwise use original
        audio_path = manifest.audio_artifact_path or tmp_path

        # Step 2: Route based on channel mode
        # For per-channel streams, transcribe each independently without diarization
        if manifest.channel_mode.mode == "per_channel":
            diarize = False  # Disable diarization for per-stream transcription

        # Step 3: Transcribe. The prompt is budgeted inside the service, which
        # is where the model's tokenizer and the deployment glossary both live.
        segments, detected_language, diagnostics = transcribe_service.transcribe(
            audio_path,
            language=language,
            diarize=diarize,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
            context_terms=context_terms,
            context=context,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        # Clean up extracted audio artifact if it was created
        if manifest and manifest.audio_artifact_path:
            try:
                os.unlink(manifest.audio_artifact_path)
            except Exception:
                pass

    return TranscriptionResponse(
        segments=segments, language=detected_language, file_sha256=manifest.audio_sha256, diagnostics=diagnostics
    )


@router.post("/quality-check", response_model=QualityCheckResponse)
async def check_audio_quality(file: UploadFile = File(...)) -> QualityCheckResponse:
    """
    Measure audio quality. Read-only - see /api/preprocess to actually fix audio.

    The assessment includes:
      - SNR (signal-to-noise ratio) via VAD
      - LUFS (integrated loudness)
      - Clipping detection
      - Overall rating (good/acceptable/poor/very_poor)
    """
    if file.content_type and not file.content_type.startswith(ALLOWED_CONTENT_PREFIXES):
        raise HTTPException(status_code=400, detail="File must be an audio or video file")

    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        return QualityCheckResponse(quality_metrics=QualityAnalyzer().analyze(Path(tmp_path)))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@router.post("/preprocess")
async def preprocess_audio(
    file: UploadFile = File(...),
    apply_gain: bool = Form(False),
) -> FileResponse:
    """
    Normalize the recording's loudness and return the repaired audio.

    The fixed audio is the response body (WAV); its re-measured quality rides
    along in the X-Quality-Metrics header as JSON. Returning the audio is the
    point - the caller replaces the file it holds with this one, so the player
    and everything downstream work from the repaired recording rather than
    being told a fix happened to a file they still have the broken copy of.
    """
    if file.content_type and not file.content_type.startswith(ALLOWED_CONTENT_PREFIXES):
        raise HTTPException(status_code=400, detail="File must be an audio or video file")

    if not apply_gain:
        raise HTTPException(status_code=400, detail="No preprocessing requested")

    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    processed_path: Path | None = None
    try:
        analyzer = QualityAnalyzer()
        # Only the result is analyzed, never the source - the caller already has
        # the source's measurements and is waiting on the repaired file's.
        processed_path = analyzer.apply_preprocessing(Path(tmp_path), adjust_gain=apply_gain)
        quality_metrics = analyzer.analyze(processed_path)
    except PreprocessingError as exc:
        raise HTTPException(status_code=422, detail=f"Could not repair this audio: {exc}") from exc
    except Exception as exc:
        # Measuring the result is the only step that can fail with the repaired
        # file already on disk, and nothing downstream will send or delete it.
        if processed_path is not None:
            processed_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    stem = Path(file.filename or "audio").stem
    return FileResponse(
        path=processed_path,
        media_type="audio/wav",
        filename=f"{stem}-repaired.wav",
        headers={"X-Quality-Metrics": json.dumps(quality_metrics.model_dump(mode="json"))},
        # Deleted only once the body has finished sending.
        background=BackgroundTask(lambda: Path(processed_path).unlink(missing_ok=True)),
    )


@router.get("/manifest/{file_sha256}", response_model=Manifest)
async def get_manifest(
    file_sha256: str,
    service: IngestService = Depends(get_ingest_service),
) -> Manifest:
    """Retrieve the manifest for a previously ingested file by its SHA256 hash."""
    manifest = service.manifest_store.get(file_sha256)
    if not manifest:
        raise HTTPException(
            status_code=404, detail=f"No manifest found for file hash {file_sha256}"
        )
    return manifest
