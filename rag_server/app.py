"""RAG server implementing the HTTP contract LibreChat expects.

LibreChat holds no RAG logic of its own; it calls this service for every
embed, query, and delete. The routes below mirror what it calls:

    POST   /embed                        store a file's chunks
    POST   /query                        semantic search within one file
    DELETE /documents                    drop every chunk of the given files
    GET    /documents/{file_id}/context  whole document (RAG_USE_FULL_CONTEXT)
    POST   /guidance                     document authoring rules (create_document)
    POST   /text                         plain-text extraction, no embedding
    POST   /transcribe                   speaker-labelled audio/video transcription
    GET    /health                       readiness probe

Response shapes are dictated by LibreChat's parsing and are documented per
route; changing them silently breaks retrieval rather than erroring.
"""

import logging
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

# Installed before any other local or third-party import - some libraries
# (huggingface_hub, sentence-transformers, etc.) make their own connection
# attempts at *import* time, not just when a route handler runs, so anything
# imported after this point still needs to be logged, which means this can't
# wait until after the imports it's trying to observe.
import net_diagnostics

net_diagnostics.install()

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

# transcription/ is a sibling of rag_server/, not a subpackage of it - both are
# separately-rooted folders by design (RAG and transcription are distinct
# concerns), sharing only this process and venv. Running from within
# rag_server/ (see the "rag" npm script) means the repo root isn't on
# sys.path by default, so add it before importing the sibling package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db
import logs
import guidance
from auth import get_user_id
from config import LOG_REQUESTS, embed_documents, embed_query
from extract import UnsupportedFileType, chunk_text, extract_pages, is_supported
from transcription.config import get_settings
from transcription.speaker_bounds import MAX_ALLOWED_SPEAKERS
from transcription.vocabulary import SUGGESTED_TERMS
from transcription.schemas import TranscriptionConfig, TranscriptionResponse
from transcription.whisperx_service import NoSpeakerSegments, get_whisperx_service

logs.configure()
logger = logging.getLogger("rag_server")
# Request lines cross both services; tagging them with either one would be a lie
# for half the traffic (see logs.py).
request_logger = logging.getLogger("http")

app = FastAPI(title="RAG Server", description="A server for RAG operations", version="1.0.0")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """One line in, one line out for every call LibreChat makes.

    LibreChat reports a failed retrieval as an ordinary "no results" answer, so
    without this the difference between "never asked" and "asked and got
    nothing" is invisible. `->` marks an inbound request, `<-` its response.
    """
    if not LOG_REQUESTS or request.url.path == "/health":
        return await call_next(request)

    request_logger.info("-> %s %s", request.method, request.url.path)
    started = time.perf_counter()
    response = await call_next(request)
    elapsed = (time.perf_counter() - started) * 1000
    request_logger.info(
        "<- %s %s %s (%.0fms)",
        request.method,
        request.url.path,
        response.status_code,
        elapsed,
    )
    return response


# Chunks embedded per request to the processing machine.
EMBED_BATCH = 64


class GuidanceRequest(BaseModel):
    query: str | None = None
    k: int = 4
    category: str | None = None


class QueryRequest(BaseModel):
    file_id: str
    query: str
    k: int = 4
    entity_id: str | None = None


@app.get("/health", tags=["Health"])
def health_check():
    return {"status": "healthy"}


@app.post("/embed", tags=["Documents"])
async def embed_file(
    file_id: str = Form(...),
    file: UploadFile = File(...),
    entity_id: str | None = Form(default=None),
    storage_metadata: str | None = Form(default=None),
    user_id: str = Depends(get_user_id),
):
    """Chunk, embed, and store an uploaded file.

    LibreChat reads `known_type` and `status`: `known_type: false` reports an
    unsupported file type to the user, a falsy `status` reports a failed
    embedding, and `embedded` on the file record is set from `known_type`.
    """
    filename = file.filename or file_id

    if not is_supported(filename):
        logger.info("Rejected unsupported file type: %s", filename)
        return {"status": False, "known_type": False, "file_id": file_id}

    data = await file.read()

    try:
        pages = extract_pages(data, filename)
    except UnsupportedFileType:
        return {"status": False, "known_type": False, "file_id": file_id}
    except Exception as error:
        logger.exception("Extraction failed for %s", filename)
        raise HTTPException(status_code=500, detail=f"Failed to read file: {error}")

    rows = _build_rows(pages, filename, file_id, user_id, entity_id)

    if not rows:
        # A file with no extractable text (e.g. a scanned PDF) would embed as
        # nothing and silently return no results, so fail loudly instead.
        logger.warning("No extractable text in %s", filename)
        return {"status": False, "known_type": True, "file_id": file_id}

    try:
        _attach_vectors(rows)
    except Exception as error:
        logger.exception("Embedding failed for %s", filename)
        raise HTTPException(status_code=500, detail=f"Failed to embed file: {error}")

    # Re-uploading the same file_id replaces its chunks rather than duplicating.
    db.delete_files(user_id, [file_id])
    db.add_chunks(rows)

    logger.info("Embedded %s (%s) as %d chunks", filename, file_id, len(rows))
    return {
        "status": True,
        "known_type": True,
        "file_id": file_id,
        "chunks": len(rows),
    }


@app.post("/query", tags=["Documents"])
def query_documents(request: QueryRequest, user_id: str = Depends(get_user_id)):
    """Search one file and return LibreChat's expected `[document, distance]` pairs.

    The second element must be a DISTANCE, not a similarity: LibreChat displays
    relevance as `1.0 - distance`. Vectors are L2-normalised, so cosine distance
    lands in [0, 2] and behaves as `1 - cosine_similarity`.
    """
    try:
        vector = embed_query(request.query)
    except Exception as error:
        logger.exception("Query embedding failed")
        raise HTTPException(status_code=500, detail=f"Failed to embed query: {error}")

    hits = db.search(
        user_id=user_id,
        file_id=request.file_id,
        vector=vector,
        k=max(1, request.k),
        entity_id=request.entity_id,
    )

    if LOG_REQUESTS:
        # `distance` is what LibreChat turns into the relevance it shows; 0 hits
        # here with a populated table means the scope filter excluded everything.
        best = f"{hits[0]['_distance']:.4f}" if hits else "n/a"
        logger.info(
            '   query file=%s entity=%s k=%d -> %d hit(s), best distance %s | "%s"',
            request.file_id,
            request.entity_id or "-",
            request.k,
            len(hits),
            best,
            request.query,
        )

    return [
        [
            {
                "page_content": hit["text"],
                "metadata": {
                    "source": hit["source"],
                    "page": hit.get("page"),
                    "file_id": hit["file_id"],
                    # Already stored per chunk (see db.py's schema) but not
                    # previously surfaced here - combined with file_id, a
                    # stable identifier for exactly which chunk a retrieved
                    # passage came from. See fileSearch.js's evidence
                    # provenance.
                    "chunk_index": hit.get("chunk_index"),
                },
            },
            float(hit["_distance"]),
        ]
        for hit in hits
    ]


@app.post("/guidance", tags=["Guidance"])
def document_guidance(request: GuidanceRequest, user_id: str = Depends(get_user_id)):
    """Authoring rules for the create_document tool.

    With a `query`, returns the closest entries; without one, returns everything
    (optionally one `category`) in authoring order, which is what LibreChat pulls
    to build the tool's system context. Guidance is shared reference material, so
    it is not scoped to the caller - authentication only keeps it off the network.
    """
    if request.query:
        entries = guidance.search(request.query, k=request.k, category=request.category)
    else:
        entries = guidance.by_category(request.category)

    if LOG_REQUESTS:
        logger.info(
            "   guidance category=%s query=%s -> %d entr(ies)",
            request.category or "-",
            f'"{request.query}"' if request.query else "(all)",
            len(entries),
        )

    return {"count": len(entries), "entries": entries}


@app.get("/documents/{file_id}/context", tags=["Documents"])
def document_context(file_id: str, user_id: str = Depends(get_user_id)):
    """Whole stored document, used when RAG_USE_FULL_CONTEXT is enabled.

    LibreChat interpolates the response body directly, so this returns a bare
    JSON string rather than an object.
    """
    text = db.document_text(user_id, file_id)
    if not text:
        raise HTTPException(status_code=404, detail="Document not found")
    return text


@app.delete("/documents", tags=["Documents"])
def delete_documents(file_ids: list[str], user_id: str = Depends(get_user_id)):
    """Delete every chunk of the given files for this user.

    LibreChat sends a bare JSON array and treats 404 as already-deleted, so a
    no-op delete still returns 200.
    """
    deleted = db.delete_files(user_id, file_ids)
    logger.info("Deleted %d chunks for %s", deleted, file_ids)
    return {"status": True, "deleted": deleted}


@app.post("/text", tags=["Documents"])
async def extract_file_text(
    file_id: str = Form(...),
    file: UploadFile = File(...),
    user_id: str = Depends(get_user_id),
):
    """Plain-text extraction with no embedding or storage.

    LibreChat falls back to its own native parser on any failure here, so a 4xx
    degrades rather than breaking the upload.
    """
    filename = file.filename or file_id
    data = await file.read()

    try:
        pages = extract_pages(data, filename)
    except UnsupportedFileType as error:
        raise HTTPException(status_code=415, detail=str(error))
    except Exception as error:
        logger.exception("Text extraction failed for %s", filename)
        raise HTTPException(status_code=500, detail=f"Failed to read file: {error}")

    return {"text": "\n\n".join(text for _, text in pages).strip()}


_TRANSCRIBE_CONTENT_PREFIXES = ("audio/", "video/")

# The only sizes this deployment will ever load on request. `model` reaches
# `whisperx.load_model()` -> faster-whisper, which otherwise accepts *any*
# string as a Hugging Face repo id and will attempt to download it - letting
# an API caller name an arbitrary model would turn a transcription request
# into an unbounded, uncontrolled download from an untrusted source. Keep in
# sync with the frontend's own model list (`TranscribeOptionsDialog.tsx`).
_ALLOWED_WHISPER_MODELS = frozenset(
    {"tiny", "small", "medium", "large-v2", "large-v3", "large-v3-turbo"}
)


@app.get("/transcribe/config", tags=["Transcription"], response_model=TranscriptionConfig)
async def transcribe_config(user_id: str = Depends(get_user_id)) -> TranscriptionConfig:
    """What this deployment's "auto" actually resolves to.

    Read straight off Settings rather than the service, so it costs nothing and
    never loads a model. The client uses it to name the defaults in its own UI:
    an option labelled only "auto" hides which model ran, which is exactly how a
    recording ends up transcribed by something the operator never chose.
    """
    settings = get_settings()
    return TranscriptionConfig(
        models=sorted(_ALLOWED_WHISPER_MODELS),
        default_model=settings.whisper_model,
        default_language=settings.default_language,
        default_suppress_numerals=settings.suppress_numerals,
        default_clustering_threshold=settings.diarization_clustering_threshold,
        hotwords_configured=bool(settings.hotwords),
        suggested_terms=list(SUGGESTED_TERMS),
        max_speakers=MAX_ALLOWED_SPEAKERS,
    )


@app.post("/transcribe", tags=["Transcription"], response_model=TranscriptionResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    diarize: bool = Form(True),
    min_speakers: int | None = Form(None),
    max_speakers: int | None = Form(None),
    # None uses this deployment's configured default
    # (WHISPERX_DIARIZATION_CLUSTERING_THRESHOLD, itself pipeline-default when
    # unset) - see WhisperXService.transcribe for what this actually tunes.
    clustering_threshold: float | None = Form(None),
    language: str | None = Form(None),
    # Per-recording accuracy hints - see `WhisperXService.build_prompt`.
    # `context_terms` (names/jargon the caller confirms) is packed into
    # Whisper's initial_prompt first and always wins; `context` (free prose)
    # is never sent to the model verbatim - only mined for proper nouns to
    # fill whatever budget the confirmed terms didn't need.
    context_terms: str | None = Form(None),
    context: str | None = Form(None),
    # None uses this deployment's configured default (WHISPERX_WHISPER_MODEL).
    model: str | None = Form(None),
    # None uses WHISPERX_SUPPRESS_NUMERALS. Digits are suppressed at the decoder
    # (whisperx/asr.py:256-262), so this is the only point at which a caller who
    # needs numerals in the transcript can ask for them.
    suppress_numerals: bool | None = Form(None),
    # True when the caller confirmed splitting by audio channel instead of
    # pyannote clustering (see /transcribe/probe-channels) - each channel is
    # transcribed and labelled as its own speaker, bypassing diarization
    # entirely.
    channel_split: bool = Form(False),
    user_id: str = Depends(get_user_id),
) -> TranscriptionResponse:
    """Speaker-labelled transcript via WhisperX (model set by WHISPERX_WHISPER_MODEL).

    Runs the actual ASR/diarization pipeline in a thread pool - it is a long,
    blocking, GPU/CPU-bound call, and this server also answers /embed and
    /query for every other request in flight.
    """
    if file.content_type and not file.content_type.startswith(_TRANSCRIBE_CONTENT_PREFIXES):
        raise HTTPException(status_code=400, detail="File must be an audio or video file")
    if model is not None and model not in _ALLOWED_WHISPER_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported model '{model}'. Choose one of: {', '.join(sorted(_ALLOWED_WHISPER_MODELS))}.",
        )

    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    data = await file.read()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    service = get_whisperx_service()
    try:
        (
            segments,
            detected_language,
            diagnostics,
            diarization_turns,
            speaker_embeddings,
            recording_profile,
        ) = (
            await run_in_threadpool(
                service.transcribe,
                tmp_path,
                language=language,
                diarize=diarize,
                min_speakers=min_speakers,
                max_speakers=max_speakers,
                clustering_threshold=clustering_threshold,
                context_terms=context_terms,
                context=context,
                model=model,
                suppress_numerals=suppress_numerals,
                channel_split=channel_split,
            )
        )
    except NoSpeakerSegments as error:
        # Not a server fault - the uploaded recording has no speech to label.
        # Logged at warning (no traceback): nothing here needs debugging, and
        # a 500-style stack trace for an ordinary silent file is just noise.
        logger.warning("No speech detected in %s: %s", file.filename, error)
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        logger.exception("Transcription failed for %s", file.filename)
        raise HTTPException(status_code=500, detail=str(error)) from error
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    logger.info(
        "Transcribed %s for user=%s: %d segment(s), language=%s",
        file.filename,
        user_id,
        len(segments),
        detected_language,
    )
    return TranscriptionResponse(
        segments=segments,
        language=detected_language,
        diagnostics=diagnostics,
        diarization_turns=diarization_turns,
        speaker_embeddings=speaker_embeddings,
        recording_profile=recording_profile,
    )


def _build_rows(
    pages: list[tuple[int | None, str]],
    filename: str,
    file_id: str,
    user_id: str,
    entity_id: str | None,
) -> list[dict]:
    rows: list[dict] = []
    index = 0

    for page, text in pages:
        for chunk in chunk_text(text):
            rows.append(
                {
                    "id": uuid.uuid4().hex,
                    "file_id": file_id,
                    "user_id": user_id,
                    "entity_id": entity_id or "",
                    "source": filename,
                    "page": page,
                    "chunk_index": index,
                    "text": chunk,
                    "vector": None,
                }
            )
            index += 1

    return rows


def _attach_vectors(rows: list[dict]) -> None:
    for start in range(0, len(rows), EMBED_BATCH):
        batch = rows[start : start + EMBED_BATCH]
        vectors = embed_documents([row["text"] for row in batch])

        if len(vectors) != len(batch):
            raise Exception(
                f"Processing machine returned {len(vectors)} vectors for {len(batch)} chunks"
            )

        for row, vector in zip(batch, vectors):
            row["vector"] = vector


if __name__ == "__main__":
    import uvicorn
    from config import HOST, PORT

    # reload=True kills and restarts this whole process on any file change under
    # the watched dirs - fine for quick embed/query calls, but it silently drops
    # in-flight /transcribe requests (which legitimately run 30-90+s), with no
    # error surfacing to the caller. Disabled; restart `npm run rag` manually
    # after editing rag_server/ or transcription/.
    # HOST is validated as loopback in config.py
    uvicorn.run(
        "app:app",
        host=HOST,
        port=PORT,
        reload=False,
    )
