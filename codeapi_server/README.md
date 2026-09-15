# codeapi_server

A minimal, self-hosted implementation of the HTTP service LibreChat's
`execute_code` agent capability talks to (referred to as "codeapi" in
`@librechat/agents`' own source and comments). LibreChat does not ship or
vendor this service itself — by default `execute_code` points at
`https://api.librechat.ai/v1`, LibreChat's own paid hosted sandbox. This is
a from-scratch, self-hosted alternative for this fork, which runs without
Docker (see root `SETUP.md`).

## What it actually does

Each `/exec` call runs the submitted code inside a fresh
[`bwrap`](https://github.com/containers/bubblewrap) (bubblewrap) sandbox —
the same unprivileged-namespace tool Flatpak uses to run untrusted apps. No
Docker daemon, no root, no VM. Per execution:

- **New mount namespace**: only a read-only `/usr` (with `/bin`, `/lib`,
  `/lib64`, `/sbin` recreated as symlinks, matching this host's usrmerge
  layout) and `/etc` are visible from the host. A fresh, empty `/tmp`
  (tmpfs — this is *why* `/tmp` is scratch-only between calls, not a
  limitation to work around). A read-only `/code` holding just that call's
  script. The session's own directory, read-write, at `/mnt/data`.
- **New network namespace**, nothing configured in it: no network access at
  all, not even loopback.
- **New PID/IPC/UTS/cgroup namespaces**: nothing outside the sandbox is
  visible or signalable.
- `ulimit -v/-t/-f/-c` (memory, CPU time, output file size, core dumps) plus
  an outer `timeout --kill-after` for wall-clock enforcement.

See `sandbox.py` for the exact `bwrap` invocation.

## Deliberate limitations vs. the real codeapi service

This is **not** a faithful reimplementation of LibreChat's actual hosted
service — it supports exactly enough of the wire contract for
`execute_code` to work for a single self-hosted user:

- **Only `py` and `bash`.** The real service supports 13 languages
  including several compiled ones (C/C++/Java/Rust/Go/Fortran/R/PHP/D/JS/TS).
  Adding another interpreted language is a couple of lines in
  `sandbox._LANG_TO_INTERPRETER`; a compiled one additionally needs a
  compile step before exec.
- **No "warm machine" stateful sessions.** The real service can reuse one
  warm runtime across calls in a conversation (`runtime_session_hint`).
  Every call here is a brand-new sandbox — `/mnt/data` still persists within
  a `session_id` (files, not process state), which matches what the tool's
  own prompt to the model already says: *"each execution is a NEW
  process... only /mnt/data is durable."*
- **No auth.** `CODEAPI_JWT_*` (see `packages/api/src/auth/codeapi.ts`) is
  not verified here at all. This server MUST stay loopback-only
  (`CODEAPI_HOST`, enforced in `config.py`) unless you add real
  authentication — reachability alone lets a caller run arbitrary code on
  this machine.
- **No multi-tenant file sharing / skill-version cache invalidation.**
  `kind`/`id`/`version` (skill/agent/user file buckets) are mapped to a flat
  directory name (`storage.build_storage_session_id`) rather than the real
  service's tenant-scoped, version-aware cache. Fine for one user; not a
  faithful port.
- **No cgroup-based fork-bomb defense.** `ulimit -u` (process count) is
  deliberately *not* set — see the comment in
  `sandbox._build_ulimit_wrapper` for why (it's a system-wide-per-UID limit,
  not a per-subtree one, so a low value breaks `bwrap`'s own namespace setup
  on any machine already running a normal number of processes). The PID
  namespace isolates the sandbox for signaling/visibility, but a real
  fork-bomb defense needs cgroups, which this doesn't set up.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/exec` | Run code, return stdout/stderr + any new/changed files |
| POST | `/upload` | Store one file under a `kind`/`id`(`/version`) bucket |
| POST | `/upload/batch` | Store multiple files in one request |
| GET | `/download/{session_id}/{file_id}` | Stream a stored file back |
| DELETE | `/sessions/{session_id}/objects/{file_id}` | Delete a file |
| DELETE | `/files/{session_id}/{file_id}` | Same, legacy path LibreChat also tries |
| GET | `/health` | `{"status": "ok", "supported_languages": [...]}` |

Request/response shapes match `@librechat/agents`' `CodeExecutor.ts` and
`packages/api/src/files/code/*` exactly (checked against the installed
`@librechat/agents` version's TypeScript source) — this is what makes it a
drop-in `LIBRECHAT_CODE_BASEURL` target rather than needing any change on
the LibreChat side.

## Setup

```bash
cd codeapi_server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Requires `bwrap` (bubblewrap) and coreutils' `timeout` on PATH — both are
standard on any modern Debian/Ubuntu (`apt install bubblewrap` if missing).

Reads the **root** `.env` first, then `codeapi_server/.env` (if present)
with override — same pattern as `rag_server`. Set `LIBRECHAT_CODE_BASEURL`
in the root `.env` to match `CODEAPI_PORT` (default `http://localhost:1235`).

Run with `npm run codeapi` (or `npm run dev`, which now also starts this
alongside `rag`/`backend:dev`/`frontend:dev`).

## Config (`codeapi_server/.env`, all optional)

| Var | Default | Meaning |
|---|---|---|
| `CODEAPI_HOST` | `127.0.0.1` | Bind address — loopback only unless `CODEAPI_ALLOW_REMOTE_HOST=true` (there is no auth; only do this on a fully trusted network) |
| `CODEAPI_PORT` | `1235` | Must match `LIBRECHAT_CODE_BASEURL`'s port |
| `CODEAPI_SESSIONS_DIR` | `codeapi_server/sessions` | Where per-session `/mnt/data` directories live on disk |
| `CODEAPI_EXEC_TIMEOUT_SECONDS` | `30` | Wall-clock limit per execution |
| `CODEAPI_EXEC_MEMORY_MB` | `512` | `ulimit -v` per execution |
| `CODEAPI_EXEC_MAX_FILE_MB` | `100` | `ulimit -f` — max size of any file the sandboxed process writes |
| `CODEAPI_EXEC_MAX_OUTPUT_CHARS` | `200000` | Truncates stdout/stderr before it's returned in the JSON response |
