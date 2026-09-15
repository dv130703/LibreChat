# LibreChat Setup (this fork)

This fork runs without Docker (removed in `d657219d6`) and ships a local
Python RAG server (`rag_server/`) instead of the upstream `rag_api`
container. Upstream's Docker/Helm-based install docs do not apply here —
this document reflects what's actually in this repo today.

## 1. Prerequisites

| Requirement | Version / notes |
|---|---|
| Node.js | **24.16.0** exactly (`.nvmrc` pins this — `nvm use`) |
| MongoDB | any recent Community Server, running locally or a hosted URI |
| Python | 3.11+, only if you're running the RAG/file-search server |
| Ollama | only if you're using local models and/or RAG embeddings |
| Meilisearch | only if you want conversation/message search (`SEARCH=true`) |

Nothing here is containerized — each of MongoDB/Meilisearch/Ollama needs to
already be running (locally installed, or a hosted equivalent) before you
start LibreChat.

## 2. Install dependencies

```bash
nvm use            # or otherwise ensure node v24.16.0
npm run smart-reinstall   # installs deps (if lockfile changed) + builds workspaces via Turborepo
```

`npm install` also works if you don't need the build step yet — `smart-reinstall`
is the one-shot "get to a working tree" command.

## 3. Configure `.env`

```bash
cp .env.example .env
```

**Before running anything beyond a one-off local test**, regenerate these —
the values shipped in `.env.example` are public (they're in this repo's git
history) and must not be reused:

```bash
# 32-byte keys (64 hex chars)
openssl rand -hex 32   # -> CREDS_KEY
openssl rand -hex 32   # -> JWT_SECRET
openssl rand -hex 32   # -> JWT_REFRESH_SECRET
# 16-byte key (32 hex chars)
openssl rand -hex 16   # -> CREDS_IV
```

Set `MONGO_URI` to point at your MongoDB instance (default:
`mongodb://127.0.0.1:27017/LibreChat`, i.e. a local Mongo on the default
port). See step 6 for wiring up a model provider (e.g. local Ollama).

## 4. MongoDB

LibreChat will not start without a reachable Mongo. Three ways to get one —
pick based on whether you have root on the machine.

### Option A — apt, via curl (Ubuntu/Debian, needs sudo)

Verified against this environment: Ubuntu 24.04 (noble), x86_64. MongoDB's
official apt repo publishes 8.0.x for `noble` (7.0.x does not support noble —
confirmed via `repo.mongodb.org`, so don't pin to 7.0 on 24.04).

```bash
# 1. Import the signing key (curl, no apt-key)
curl -fsSL https://pgp.mongodb.com/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor

# 2. Add the repo (adjust "noble" if you're on a different Ubuntu/Debian codename)
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

# 3. Install and start
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

### Option B — no-root binary (sandboxes, CI, containers without sudo)

MongoDB also ships a plain tarball — no package manager, no root. This is
what was actually used to verify the steps below in this environment (no
interactive sudo was available here):

```bash
curl -fsSL -o mongodb.tgz \
  "https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2404-8.0.29.tgz"
  # for a different OS/arch, resolve the current URL first:
  # curl -fsSL https://downloads.mongodb.org/current.json | \
  #   python3 -c "import json,sys; d=json.load(sys.stdin); print(d['versions'][0]['downloads'])"
mkdir -p mongodb && tar xzf mongodb.tgz --strip-components=1 -C mongodb
mkdir -p ~/mongodb-data
./mongodb/bin/mongod --dbpath ~/mongodb-data --port 27017 --bind_ip 127.0.0.1 \
  --fork --logpath ~/mongodb-data/mongod.log
```

### Option C — hosted (skip local install)

Point `MONGO_URI` at a hosted cluster (e.g. MongoDB Atlas free tier) and
skip local install entirely.

### Verify it actually works

```bash
npx --yes mongosh "mongodb://127.0.0.1:27017/LibreChat" --quiet \
  --eval 'disableTelemetry(); db.runCommand({ ping: 1 }); db.stats().db'
```

Expect `{ ok: 1 }` followed by `LibreChat` — confirms the exact connection
string from `.env.example`'s default `MONGO_URI` reaches a live `mongod` and
selects the database LibreChat will use. This was run against a live
instance while writing this doc (Option B, since no root was available) and
returned exactly that.

To stop a manually-started (Option B) instance:
`./mongodb/bin/mongod --dbpath ~/mongodb-data --shutdown`. Option A is
managed by systemd (`sudo systemctl stop mongod`).

## 5. Meilisearch (optional — conversation/message search)

`SEARCH=true` in `.env.example` expects a Meilisearch instance at
`MEILI_HOST` (default `http://0.0.0.0:7700`) with `MEILI_MASTER_KEY` set.
Either install and run Meilisearch locally, point at a hosted instance, or
set `SEARCH=false` to skip it entirely — LibreChat runs fine without search.

## 6. Ollama (optional — local models and/or RAG embeddings)

If you want local chat models or the RAG/file-search server (step 7), install
[Ollama](https://ollama.com) and set `OLLAMA_BASE_URL` in `.env` (default
`http://localhost:11434`). If Ollama requires an API key in your setup,
configure it per-user under **Settings → API Keys** in the UI, not in `.env`.

For RAG specifically, pull the embedding model the RAG server expects:

```bash
ollama pull nomic-embed-text
```

For chat, pull at least one chat-capable model, e.g. `ollama pull llama3.1`.

**Setting `OLLAMA_BASE_URL` alone does not make Ollama appear in model
selection.** LibreChat has no automatic "known env var → endpoint" wiring —
you need an explicit `custom` endpoint entry in `librechat.yaml`. One is
already included in `librechat.example.yaml` (and was added to this repo's
`librechat.yaml` while diagnosing exactly this):

```yaml
endpoints:
  custom:
    - name: 'Ollama' # must lowercase to "ollama" for the built-in icon to match
      apiKey: 'ollama' # local Ollama ignores this
      baseURL: '${OLLAMA_BASE_URL}/v1/'
      models:
        default: ['llama3.1:latest'] # replace with what you've pulled
        fetch: true
      titleConvo: true
      titleModel: 'current_model'
      modelDisplayLabel: 'Ollama'
```

Verify the fetch path actually works before relying on it:

```bash
curl -fsS http://localhost:11434/v1/models
```

Should list every model `ollama pull`'d. Restart the backend after editing
`librechat.yaml` — it's only read at startup.

## 7. RAG / file-search server (optional)

Only needed if you want agents to use `file_search` on uploaded documents.
See [`rag.yml`](rag.yml) for the full contract (routes, auth, vector store
layout) — it's a reference doc, not something anything reads at runtime.

```bash
cd rag_server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The server reads the **root** `.env` first, then `rag_server/.env` (if
present) with override — so `JWT_SECRET` and `OLLAMA_BASE_URL` are shared
automatically from the root `.env`; only add `rag_server/.env` for
RAG-specific overrides (`RAG_PORT`, `LANCEDB_PATH`, etc. — see
`rag_server/config.py`). Make sure `RAG_API_URL` in the root `.env` matches
`RAG_PORT` (default `http://localhost:1234`).

> `rag_server/seed_guidance.py` seeds authoring guidance for the
> `create_document` tool, which has been **removed** from this fork (see git
> history) — that script and its `/guidance` endpoint are currently unused.
> No need to run it unless you reintroduce a tool that reads that table.

## 8. Code Interpreter / sandbox server (optional)

Only needed if you want agents to use `execute_code` (already enabled by
default — see `defaultAgentCapabilities` in
`packages/data-provider/src/config.ts` — this step is what makes it
actually work rather than fail every call). See
[`codeapi_server/README.md`](codeapi_server/README.md) for the full
contract and its deliberate limitations (Python + bash only, no Docker —
sandboxed via `bwrap`/bubblewrap instead).

```bash
cd codeapi_server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Requires `bwrap` on PATH (`apt install bubblewrap` if missing). Reads the
**root** `.env` first, then `codeapi_server/.env` (if present) with
override, same pattern as `rag_server`. Make sure `LIBRECHAT_CODE_BASEURL`
in the root `.env` matches `CODEAPI_PORT` (default
`http://localhost:1235`).

## 9. Build the workspaces

```bash
npm run build:packages   # data-provider, data-schemas, api, client package
# or, once, from a clean tree:
npm run build            # turbo, parallel + cached
```

## 10. Run it

All-in-one (RAG + code sandbox + backend + frontend, if you did steps 7-8):

```bash
npm run dev
```

Or piece by piece:

```bash
npm run backend:dev      # Express server, port 3080, file-watching
npm run frontend:dev     # Vite dev server, port 3090, HMR (needs backend running)
npm run rag              # only if you set up rag_server in step 7
npm run codeapi          # only if you set up codeapi_server in step 8
```

Production-style (no watching): `npm run backend` + `npm run frontend`
(builds client assets, then serve from the backend).

## 11. Create your first user

With `ALLOW_REGISTRATION=true` (the default), just sign up through the UI at
`http://localhost:3080` (or `:3090` in dev). To create one from the CLI
instead:

```bash
npm run create-user -- <email> <name> <username>
```

## 12. Verify

- Backend: `http://localhost:3080` — should serve the app (or JSON from
  `/api/...` routes) once Mongo is reachable.
- Frontend dev server: `http://localhost:3090`.
- Startup log should show the RAG health check either passing or being
  skipped (`RAG_API_URL` unset) — it no longer blocks server startup either
  way (see commit `049594f9d`).
- Code sandbox: `curl http://localhost:1235/health` should return
  `{"status":"ok",...}` if you set up step 8.

## Tests

```bash
npm run test:all      # client + api + all packages
# or per workspace, e.g.:
cd api && npx jest <pattern>
cd packages/api && npx jest <pattern>
```

## Fork-specific gotchas

- **No Docker/Helm anywhere in this repo** — if you find old instructions
  (upstream docs, cached READMEs, etc.) mentioning `docker-compose up`, they
  don't apply here.
- MongoDB and Meilisearch are **not** auto-started by any npm script — they
  must already be running before `npm run backend`/`npm run dev`.
- The RAG server binds loopback only (`RAG_HOST` must be `127.0.0.1` /
  `localhost` / `::1`) — it refuses to start otherwise, by design.
- Same for the code sandbox (`CODEAPI_HOST`) — it has no request
  authentication at all, so loopback-only is the only thing stopping anyone
  who can reach the port from running arbitrary code on this machine.
- `JWT_SECRET` must be byte-identical between the root `.env` and
  `rag_server/.env` (if you override it there) — otherwise every RAG request
  401s.
