"""Runs one piece of code inside a `bwrap` (bubblewrap) sandbox.

No Docker daemon involved (this fork removed Docker entirely - see
SETUP.md). `bwrap` is the same unprivileged-namespace sandboxing tool
Flatpak uses to run untrusted apps: it needs no daemon, no root, and no
setup beyond the `bwrap` binary being on PATH.

Isolation, per execution:
- New mount namespace: the sandbox only sees a read-only `/usr` (with `/bin`,
  `/lib`, `/lib64`, `/sbin` recreated as symlinks into it, matching this
  host's usrmerge layout) and `/etc`, a fresh empty `/tmp` (tmpfs - this is
  exactly what makes `/tmp` "same-call scratch only", not a bug to work
  around), a read-only `/code` holding just this call's script, and the
  session's own directory bind-mounted read-write at `/mnt/data`. Nothing
  else on the host filesystem is reachable.
- New network namespace with nothing configured in it: no network access at
  all, not even loopback.
- New PID/IPC/UTS/cgroup namespaces: the sandboxed process can't see or
  signal anything outside itself.
- `--die-with-parent`: nothing survives this request past its own lifetime.

Resource limits, layered on top:
- An outer `timeout --kill-after` enforces the wall-clock budget even if the
  sandboxed process ignores SIGTERM.
- `ulimit -v/-t/-f/-u/-c` (set in a wrapper shell, inherited across `exec`)
  bound memory, CPU time, output file size, process count, and core dumps.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Tuple

import config

_LANG_TO_INTERPRETER = {
    "py": (config.PYTHON3_PATH, "script.py"),
    "bash": (config.BASH_PATH, "script.sh"),
}

SUPPORTED_LANGUAGES = sorted(_LANG_TO_INTERPRETER.keys())


class UnsupportedLanguageError(Exception):
    pass


def _build_ulimit_wrapper() -> str:
    """A fixed shell script (no user input interpolated into it) that applies
    rlimits and then execs whatever argv follows - see `run()` for how the
    argv after `--` is threaded through as `"$@"`.

    Deliberately does NOT set `ulimit -u` (RLIMIT_NPROC): that limit is
    accounted per real UID system-wide, not per process subtree, so on any
    machine where this user already runs a normal number of processes
    (an IDE, other services, ...) a low cap here makes even `bwrap`'s own
    namespace setup fail immediately with "Resource temporarily
    unavailable" - it doesn't scope to just the sandboxed subtree the way
    `-v`/`-t`/`-f` do. The PID namespace (`--unshare-all` below) already
    isolates the sandbox from the rest of the system for signaling/
    visibility; a fork bomb inside it still counts against this same
    system-wide limit, but bounding that properly needs cgroups, which is
    out of scope for this minimal, single-user, cooperative-code sandbox."""
    mem_kb = config.EXEC_MEMORY_MB * 1024
    file_kb = config.EXEC_MAX_OUTPUT_FILE_MB * 1024
    cpu_seconds = config.EXEC_TIMEOUT_SECONDS + 5
    return (
        f"ulimit -v {mem_kb} 2>/dev/null; "
        f"ulimit -t {cpu_seconds} 2>/dev/null; "
        f"ulimit -f {file_kb} 2>/dev/null; "
        f"ulimit -c 0 2>/dev/null; "
        f'exec "$@"'
    )


def _build_bwrap_argv(code_dir: Path, session_dir: Path) -> List[str]:
    argv = [
        config.BWRAP_PATH,
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--setenv", "PATH", "/usr/bin:/bin",
        "--setenv", "HOME", "/tmp",
        "--setenv", "LANG", "C.UTF-8",
        "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/sbin", "/sbin",
    ]
    if os.path.isdir("/lib64"):
        argv += ["--symlink", "usr/lib64", "/lib64"]
    if os.path.isdir("/etc"):
        argv += ["--ro-bind", "/etc", "/etc"]
    argv += [
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--ro-bind", str(code_dir), "/code",
        "--bind", str(session_dir), "/mnt/data",
        "--chdir", "/mnt/data",
    ]
    return argv


def run(
    lang: str,
    code: str,
    args: List[str],
    session_dir: Path,
) -> Tuple[str, str, int]:
    """Returns (stdout, stderr, returncode). Raises UnsupportedLanguageError
    for anything outside SUPPORTED_LANGUAGES - callers turn that into a
    clean error response rather than a 500."""
    if lang not in _LANG_TO_INTERPRETER:
        raise UnsupportedLanguageError(
            f"Unsupported language {lang!r}. This sandbox only runs: "
            f"{', '.join(SUPPORTED_LANGUAGES)}."
        )
    interpreter, script_name = _LANG_TO_INTERPRETER[lang]
    session_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="codeapi-code-") as code_dir_str:
        code_dir = Path(code_dir_str)
        script_path = code_dir / script_name
        script_path.write_text(code)

        bwrap_argv = _build_bwrap_argv(code_dir, session_dir)
        bwrap_argv += ["--", interpreter, f"/code/{script_name}", *args]

        full_argv = [
            config.TIMEOUT_PATH,
            "--kill-after=2",
            f"{config.EXEC_TIMEOUT_SECONDS}s",
            "bash",
            "-c",
            _build_ulimit_wrapper(),
            "sandbox",
            *bwrap_argv,
        ]

        try:
            completed = subprocess.run(
                full_argv,
                capture_output=True,
                text=True,
                timeout=config.EXEC_TIMEOUT_SECONDS + 5,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
            stderr = ((exc.stderr or "") if isinstance(exc.stderr, str) else "") + (
                f"\n[codeapi] Execution killed after exceeding the "
                f"{config.EXEC_TIMEOUT_SECONDS}s time limit.\n"
            )
            return _truncate(stdout), _truncate(stderr), 124

        stdout, stderr = completed.stdout, completed.stderr
        # `timeout` exits 124 when it had to kill the process, or 128+SIGNAL
        # when the sandboxed process itself was killed for hitting a ulimit
        # (out-of-memory -> SIGKILL, CPU time -> SIGXCPU) - surfaced as-is so
        # callers can tell "ran and failed" apart from "was cut off".
        if completed.returncode == 124:
            stderr += (
                f"\n[codeapi] Execution killed after exceeding the "
                f"{config.EXEC_TIMEOUT_SECONDS}s time limit.\n"
            )
        return _truncate(stdout), _truncate(stderr), completed.returncode


def _truncate(text: str) -> str:
    limit = config.EXEC_MAX_OUTPUT_CHARS
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n[codeapi] Output truncated at {limit} characters.\n"


def list_session_files(session_dir: Path) -> List[Path]:
    """Every file currently in a session's /mnt/data, recursively - used to
    diff before/after an exec and report newly-written files as artifacts."""
    if not session_dir.is_dir():
        return []
    return [p for p in session_dir.rglob("*") if p.is_file()]
