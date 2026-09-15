import os
import shutil
from pathlib import Path
from dotenv import load_dotenv

# Same pattern as rag_server/config.py: this server lives inside the
# LibreChat repo, so the root .env is LibreChat's own. Shared values load
# first; a local .env (if present) loads second with override, so
# server-local settings always win over anything LibreChat happens to
# define under the same name.
ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

# Server
# CODEAPI_-prefixed so this never collides with LibreChat's own HOST/PORT
# (0.0.0.0:3080) or rag_server's RAG_HOST/RAG_PORT.
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
HOST = os.getenv("CODEAPI_HOST", "127.0.0.1")

# Loopback-only by default, same reasoning as rag_server: this service has
# no authentication unless CODEAPI_JWT_ENABLED is set on LibreChat's side
# (see packages/api/src/auth/codeapi.ts) and this server does not currently
# verify that JWT at all - reachability alone is enough to run arbitrary
# code. Never bind a reachable address without adding real auth first.
_ALLOW_REMOTE = os.getenv("CODEAPI_ALLOW_REMOTE_HOST", "").strip().lower() in {"1", "true", "yes"}
if HOST not in LOOPBACK_HOSTS and not _ALLOW_REMOTE:
    raise ValueError(
        f"CODEAPI_HOST={HOST!r} is not a loopback address. This server binds loopback only "
        f"unless CODEAPI_ALLOW_REMOTE_HOST=true is also set, and it has NO request "
        f"authentication - anyone who can reach this port can execute arbitrary code on "
        f"this machine. Only do that on a fully trusted, isolated network. Otherwise use "
        f"one of {sorted(LOOPBACK_HOSTS)}."
    )

# Port. Must match LIBRECHAT_CODE_BASEURL in the root .env.
PORT = int(os.getenv("CODEAPI_PORT", 1235))

# Where per-session /mnt/data directories live. Each session_id gets its own
# subdirectory here, bind-mounted read-write into the sandbox - this is what
# makes files "persist between calls" within one session.
SESSIONS_DIR = Path(os.getenv("CODEAPI_SESSIONS_DIR", str(Path(__file__).resolve().parent / "sessions")))
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

# Resource limits applied to every execution via `ulimit` (inherited across
# exec) plus an outer `timeout` for wall-clock enforcement, on top of the
# `bwrap` sandbox's own namespace isolation (no network, isolated
# mount/pid/ipc, fresh /tmp). See sandbox.py.
EXEC_TIMEOUT_SECONDS = int(os.getenv("CODEAPI_EXEC_TIMEOUT_SECONDS", 30))
EXEC_MEMORY_MB = int(os.getenv("CODEAPI_EXEC_MEMORY_MB", 512))
EXEC_MAX_OUTPUT_FILE_MB = int(os.getenv("CODEAPI_EXEC_MAX_FILE_MB", 100))

# Max stdout/stderr this server will read back into the JSON response -
# independent of EXEC_MAX_OUTPUT_FILE_MB, which bounds what the sandboxed
# process is allowed to WRITE to disk (via `ulimit -f`).
EXEC_MAX_OUTPUT_CHARS = int(os.getenv("CODEAPI_EXEC_MAX_OUTPUT_CHARS", 200_000))

BWRAP_PATH = shutil.which("bwrap")
TIMEOUT_PATH = shutil.which("timeout")
PYTHON3_PATH = shutil.which("python3")
BASH_PATH = shutil.which("bash")

if not BWRAP_PATH:
    raise RuntimeError(
        "bubblewrap ('bwrap') was not found on PATH. Install it (e.g. "
        "`apt install bubblewrap`) - it's what sandboxes every execution "
        "(isolated mount/pid/network namespaces, no Docker daemon required)."
    )
if not TIMEOUT_PATH:
    raise RuntimeError("coreutils 'timeout' was not found on PATH.")
