"""RAG server implementing the HTTP contract LibreChat expects.

LibreChat holds no RAG logic of its own; it calls this service for every
embed, query, and delete. The routes below mirror what it calls:

    POST   /embed                        store a file's chunks
    POST   /query                        semantic search within one file
    DELETE /documents                    drop every chunk of the given files
    GET    /documents/{file_id}/context  whole document (RAG_USE_FULL_CONTEXT)
    POST   /guidance                     document authoring rules (create_document)
    POST   /text                         plain-text extraction, no embedding
    GET    /health                       readiness probe

Response shapes are dictated by LibreChat's parsing and are documented per
route; changing them silently breaks retrieval rather than erroring.
"""

import logging
import time
import uuid

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

import db
import guidance
from auth import get_user_id
from config import LOG_REQUESTS, embed_documents, embed_query
from extract import UnsupportedFileType, chunk_text, extract_pages, is_supported

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("rag_server")

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

    logger.info("-> %s %s", request.method, request.url.path)
    started = time.perf_counter()
    response = await call_next(request)
    elapsed = (time.perf_counter() - started) * 1000
    logger.info(
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

    # HOST is validated as loopback in config.py
    uvicorn.run("app:app", host=HOST, port=PORT, reload=True)
