"""Minimal self-hosted codeapi server: implements just enough of the
`@librechat/agents` CodeExecutor/file-management HTTP contract for
`execute_code` to work end-to-end, sandboxed via bubblewrap (no Docker).

Endpoints (see codeapi_server/README.md for the full contract and the
simplifications relative to the real, multi-tenant codeapi service this
mimics):
    POST   /exec
    POST   /upload
    POST   /upload/batch
    GET    /download/{session_id}/{file_id:path}
    DELETE /sessions/{session_id}/objects/{file_id:path}
    DELETE /files/{session_id}/{file_id:path}
"""

import logging
import uuid
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

import config
import sandbox
import storage

logging.basicConfig(level=logging.INFO, format="%(asctime)s [codeapi] %(message)s")
logger = logging.getLogger("codeapi")

app = FastAPI(title="LibreChat minimal self-hosted code sandbox")

VALID_KINDS = {"skill", "agent", "user"}


class InjectedFile(BaseModel):
    id: str
    name: str
    storage_session_id: Optional[str] = None
    kind: Optional[str] = None
    resource_id: Optional[str] = None
    version: Optional[int] = None
    path: Optional[str] = None


class ExecRequest(BaseModel):
    lang: str
    code: str
    args: List[str] = Field(default_factory=list)
    session_id: Optional[str] = None
    files: List[InjectedFile] = Field(default_factory=list)
    # Accepted but unused: this minimal server has no "warm machine" runtime
    # reuse to route to - every call is a fresh sandbox regardless of hint.
    runtime_session_hint: Optional[str] = None


@app.post("/exec")
def exec_code(body: ExecRequest):
    if body.lang not in sandbox.SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported language {body.lang!r}. This minimal sandbox only "
                f"runs: {', '.join(sandbox.SUPPORTED_LANGUAGES)}. See "
                f"codeapi_server/README.md to add more."
            ),
        )

    session_id = body.session_id or str(uuid.uuid4())
    session_dir = storage.session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)

    for injected in body.files:
        if injected.storage_session_id:
            ok = storage.copy_into_session(
                injected.storage_session_id, injected.id, session_id, injected.name
            )
            if not ok:
                logger.warning(
                    "exec session=%s: could not inject file %r from %r (missing?)",
                    session_id, injected.name, injected.storage_session_id,
                )

    before = storage.snapshot(session_id)
    try:
        stdout, stderr, returncode = sandbox.run(body.lang, body.code, body.args, session_dir)
    except sandbox.UnsupportedLanguageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    after = storage.snapshot(session_id)

    changed_paths = storage.diff_new_or_changed(before, after)
    files = [
        {
            "id": rel_path,
            "name": rel_path.rsplit("/", 1)[-1],
            "path": rel_path,
            "storage_session_id": session_id,
            "kind": "user",
        }
        for rel_path in sorted(changed_paths)
    ]

    if returncode != 0 and not stderr:
        stderr = f"[codeapi] Process exited with status {returncode}.\n"

    logger.info(
        "exec session=%s lang=%s exit=%s files=%d",
        session_id, body.lang, returncode, len(files),
    )

    response = {
        "session_id": session_id,
        "stdout": stdout,
        "stderr": stderr,
    }
    if files:
        response["files"] = files
    return response


def _resolve_identity(kind: str, resource_id: str, version: Optional[int]) -> str:
    if kind not in VALID_KINDS:
        raise HTTPException(
            status_code=400, detail=f"kind must be one of: {', '.join(sorted(VALID_KINDS))}"
        )
    if not resource_id:
        raise HTTPException(status_code=400, detail="id is required")
    if kind == "skill" and version is None:
        raise HTTPException(status_code=400, detail='kind "skill" requires a numeric version')
    if kind != "skill" and version is not None:
        raise HTTPException(status_code=400, detail="version is only valid for kind \"skill\"")
    return storage.build_storage_session_id(kind, resource_id, version)


@app.post("/upload")
async def upload(
    file: UploadFile = File(...),
    kind: str = Form(...),
    id: str = Form(...),
    version: Optional[int] = Form(None),
):
    storage_session_id = _resolve_identity(kind, id, version)
    dest_dir = storage.session_dir(storage_session_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe_name = storage.sanitize_segment(file.filename or "file")
    dest_path = storage.safe_file_path(storage_session_id, safe_name)
    if dest_path is None:
        raise HTTPException(status_code=400, detail="Invalid filename")
    contents = await file.read()
    dest_path.write_bytes(contents)
    logger.info("upload storage_session=%s file=%s (%d bytes)", storage_session_id, safe_name, len(contents))
    return {
        "message": "success",
        "storage_session_id": storage_session_id,
        "files": [{"fileId": safe_name, "filename": file.filename or safe_name}],
    }


@app.post("/upload/batch")
async def upload_batch(
    file: List[UploadFile] = File(...),
    kind: str = Form(...),
    id: str = Form(...),
    version: Optional[int] = Form(None),
    read_only: Optional[str] = Form(None),
):
    storage_session_id = _resolve_identity(kind, id, version)
    dest_dir = storage.session_dir(storage_session_id)
    dest_dir.mkdir(parents=True, exist_ok=True)

    results = []
    succeeded = 0
    failed = 0
    for uploaded in file:
        safe_name = storage.sanitize_segment(uploaded.filename or "file")
        dest_path = storage.safe_file_path(storage_session_id, safe_name)
        if dest_path is None:
            failed += 1
            results.append({"status": "error", "filename": uploaded.filename or safe_name, "error": "Invalid filename"})
            continue
        try:
            contents = await uploaded.read()
            dest_path.write_bytes(contents)
            succeeded += 1
            results.append({"status": "success", "fileId": safe_name, "filename": uploaded.filename or safe_name})
        except Exception as exc:  # noqa: BLE001 - reported per-file, not fatal to the batch
            failed += 1
            results.append({"status": "error", "filename": uploaded.filename or safe_name, "error": str(exc)})

    logger.info(
        "upload/batch storage_session=%s succeeded=%d failed=%d",
        storage_session_id, succeeded, failed,
    )
    return {
        "message": "error" if succeeded == 0 else "success",
        "storage_session_id": storage_session_id,
        "files": results,
        "succeeded": succeeded,
        "failed": failed,
    }


@app.get("/download/{session_id}/{file_id:path}")
def download(session_id: str, file_id: str):
    path = storage.safe_file_path(session_id, file_id)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, filename=path.name)


def _delete_file(session_id: str, file_id: str) -> JSONResponse:
    path = storage.safe_file_path(session_id, file_id)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    path.unlink()
    logger.info("delete session=%s file=%s", session_id, file_id)
    return JSONResponse({"message": "success"})


@app.delete("/sessions/{session_id}/objects/{file_id:path}")
def delete_object(session_id: str, file_id: str):
    return _delete_file(session_id, file_id)


@app.delete("/files/{session_id}/{file_id:path}")
def delete_file_legacy(session_id: str, file_id: str):
    return _delete_file(session_id, file_id)


@app.get("/health")
def health():
    return {"status": "ok", "supported_languages": sandbox.SUPPORTED_LANGUAGES}


if __name__ == "__main__":
    import uvicorn

    # reload=False for the same reason as rag_server/app.py: this process
    # shells out to long-ish-running sandboxed subprocesses, and a reload
    # mid-execution would orphan or kill them non-deterministically.
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
