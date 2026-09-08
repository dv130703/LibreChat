import os
from pathlib import Path
import requests
from dotenv import load_dotenv

# This server lives inside the LibreChat repo, so the root .env it reads is
# LibreChat's own. Shared values (JWT_SECRET, OLLAMA_BASE_URL) come from there;
# the local .env is loaded second with override so server-local settings always
# win over anything LibreChat happens to define under the same name.
ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

# huggingface_hub caches downloaded model files as content-addressed blobs and
# symlinks them into the per-model snapshot directory. Creating a symlink on
# Windows requires SeCreateSymbolicLinkPrivilege (admin, or Developer Mode
# enabled) - without it, downloads fail with WinError 1314 ("A required
# privilege is not held by the client") right as the snapshot is assembled.
# Must be set before any huggingface_hub/transformers import triggers a
# download, so it lives here at the top of config, which every entry point
# imports first.
if os.name == "nt":
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# Any `subprocess` call to ffmpeg/ffprobe (ours or a dependency's) resolves
# via PATH, so when ffmpeg isn't already installed system-wide, prepending
# its directory here covers that. It does NOT cover torchcodec: on Windows,
# Python 3.8+ no longer searches PATH for a loaded DLL's own dependencies
# (avcodec-*.dll etc for torchcodec's libtorchcodec_core*.dll) - that requires
# the explicit os.add_dll_directory() call below instead.
_ffmpeg_dir = os.getenv("FFMPEG_PATH")
if _ffmpeg_dir and _ffmpeg_dir not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    if os.name == "nt" and os.path.isdir(_ffmpeg_dir):
        os.add_dll_directory(_ffmpeg_dir)

# Server
# Deliberately RAG_-prefixed: LibreChat's .env sets HOST=0.0.0.0 and PORT=3080
# for its own Express server, and reading the bare names would make this server
# refuse to start (non-loopback host) or fight LibreChat for port 3080.
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
HOST = os.getenv("RAG_HOST", "127.0.0.1")

# Loopback stays the default, so nothing is exposed by accident. Binding a
# reachable address is allowed only when asked for explicitly, which is what
# lets one machine act as the transcription worker for another (the client
# side of that is TRANSCRIPTION_API_URL in LibreChat's .env).
#
# Every route here is authenticated - LibreChat signs a 5-minute HS256 token
# per call (see auth.py) - so the exposure is guarded by JWT_SECRET and
# nothing else. That makes JWT_SECRET the whole boundary the moment this is
# switched on: leaving it at the value shipped in .env.example (a published
# constant) lets anyone who can reach this port mint a valid token for any
# user id. Set a real one, identical on both machines, before enabling this,
# and keep the port on a trusted network.
_ALLOW_REMOTE = os.getenv("RAG_ALLOW_REMOTE_HOST", "").strip().lower() in {"1", "true", "yes"}
if HOST not in LOOPBACK_HOSTS and not _ALLOW_REMOTE:
    raise ValueError(
        f"RAG_HOST={HOST!r} is not a loopback address. This server binds loopback only "
        f"unless RAG_ALLOW_REMOTE_HOST=true is also set (do that only on a trusted "
        f"network, and only with a non-default JWT_SECRET - it is the only thing "
        f"authenticating callers). Otherwise use one of {sorted(LOOPBACK_HOSTS)}."
    )

# Port
# Must match the port in LibreChat's RAG_API_URL.
PORT = int(os.getenv("RAG_PORT", 1234))

# Processing Machine
# Falls back to the same Ollama instance LibreChat is configured against.
_ollama = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
PROCESSING_MACHINE = os.getenv("PROCESSING_MACHINE", f"{_ollama}/api")

# LanceDB
LANCEDB_PATH = os.getenv("LANCEDB_PATH", str(Path.home() / ".lancedb" / "docs"))

# Logging
# When on, every request from LibreChat is logged with its query text and result
# count, so RAG traffic is visible in the terminal as it happens.
LOG_REQUESTS = os.getenv("RAG_LOG_REQUESTS", "true").strip().lower() not in {"0", "false", "no"}

# Authentication
# Must be byte-identical to LibreChat's JWT_SECRET: it signs every RAG request.
JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET:
    raise ValueError(
        "JWT_SECRET is not set. Copy the value from LibreChat's .env into this "
        "project's .env, otherwise every request from LibreChat will 401."
    )

# Embeddings
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text:latest")
# nomic-embed-text returns 768-dimension, L2-normalised vectors.
EMBED_DIM = int(os.getenv("EMBED_DIM", 768))

# Chunking
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", 1000))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", 200))
# A paragraph this long stands as its own chunk instead of being merged with its
# neighbours; merging distinct topics dilutes the embedding and hurts ranking.
MIN_CHUNK = int(os.getenv("MIN_CHUNK", 200))


# Embedding functions
# Embed a document using the embedding model hosted on processing machine
def embed_document(text: str, num_ctx: int = 8192) -> list[float]:
    return _embed(f"search_document: {text}", num_ctx, "document")


# Embed a query using the embedding model hosted on processing machine
def embed_query(text: str, num_ctx: int = 8192) -> list[float]:
    return _embed(f"search_query: {text}", num_ctx, "query")


def embed_documents(texts: list[str], num_ctx: int = 8192) -> list[list[float]]:
    """Embed many chunks in one round trip to the processing machine."""
    if not texts:
        return []
    return _embed([f"search_document: {text}" for text in texts], num_ctx, "document", batch=True)


def _embed(text, num_ctx: int, kind: str, batch: bool = False):
    """Call the processing machine's embedding endpoint.

    nomic-embed-text is asymmetric: documents and queries carry different
    prefixes, applied by the callers above.
    """
    try:
        resp = requests.post(
            f"{PROCESSING_MACHINE}/embed",
            json={
                "model": EMBED_MODEL,
                "input": text,
                "options": {"num_ctx": num_ctx},
            },
            timeout=120,
        )

        if resp.status_code != 200:
            raise Exception(f"Failed to embed {kind}: {resp.text}")

        embeddings = resp.json()["embeddings"]
        return embeddings if batch else embeddings[0]

    except requests.exceptions.Timeout:
        raise Exception(
            f"Request to embed {kind} timed out. Please check the processing machine and try again."
        )
    except requests.exceptions.ConnectionError as e:
        raise Exception(
            f"Connection error while embedding {kind}: {e}. "
            "Please check the processing machine and try again."
        )
