"""File storage for code-execution sessions.

Simplified relative to the real codeapi protocol this mimics: every storage
bucket (an exec `session_id`, or a `kind:id[:v:version]` upload bucket) is
just a directory under `config.SESSIONS_DIR`, and a file's `id` is its path
relative to that directory. There's no cross-user sharing, no skill-version
cache invalidation, no auth-scoped bucketing by tenant - this is a
single-user, self-hosted minimal implementation, not a faithful port of the
full multi-tenant service. See codeapi_server/README.md.
"""

import re
import shutil
from pathlib import Path
from typing import Optional

import config

_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]")


def sanitize_segment(value: str) -> str:
    """One path segment, stripped of anything that isn't safe for a
    directory/file name - collapses everything else to `_`."""
    cleaned = _UNSAFE_CHARS.sub("_", value.strip())
    return cleaned or "_"


def build_storage_session_id(kind: str, resource_id: str, version: Optional[int]) -> str:
    parts = [sanitize_segment(kind), sanitize_segment(resource_id)]
    if version is not None:
        parts.append(f"v{version}")
    return "-".join(parts)


def session_dir(storage_session_id: str) -> Path:
    return config.SESSIONS_DIR / sanitize_segment(storage_session_id)


def safe_file_path(storage_session_id: str, file_id: str) -> Optional[Path]:
    """Resolves `file_id` (may contain `/` for a nested path) against a
    session's directory, refusing anything that would escape it (`../`,
    absolute paths, symlink tricks) - returns None rather than raising, so
    every caller is forced to handle the "not found / not allowed" case the
    same way a missing file would be handled."""
    base = session_dir(storage_session_id).resolve()
    candidate = (base / file_id.lstrip("/")).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return candidate


def snapshot(storage_session_id: str) -> dict:
    """relative-path -> (size, mtime_ns) for every file currently in a
    session - diffed before/after an exec to report new/changed files."""
    base = session_dir(storage_session_id)
    if not base.is_dir():
        return {}
    result = {}
    for path in base.rglob("*"):
        if path.is_file():
            stat = path.stat()
            result[str(path.relative_to(base))] = (stat.st_size, stat.st_mtime_ns)
    return result


def diff_new_or_changed(before: dict, after: dict) -> list:
    changed = []
    for rel_path, meta in after.items():
        if before.get(rel_path) != meta:
            changed.append(rel_path)
    return changed


def copy_into_session(
    source_storage_session_id: str,
    source_file_id: str,
    dest_storage_session_id: str,
    dest_name: str,
) -> bool:
    """Best-effort copy of an injected input file into an exec session's
    /mnt/data before running. Returns False (never raises) if the source
    doesn't exist or isn't reachable - a missing injected file should not
    fail the whole execution, since the sandboxed code may not even need
    it."""
    source = safe_file_path(source_storage_session_id, source_file_id)
    if source is None or not source.is_file():
        return False
    dest_dir = session_dir(dest_storage_session_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = safe_file_path(dest_storage_session_id, sanitize_segment(dest_name))
    if dest is None:
        return False
    shutil.copyfile(source, dest)
    return True
