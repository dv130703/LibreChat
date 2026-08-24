# Speak Summary

Convert, transcribe, and summarise audio and video — entirely on your own
machine. Drop in a file, get a speaker-labelled timestamped transcript, then
turn it into an overview, key points, and action items.

- **Convert** — any audio/video file to a clean audio format, in-browser (ffmpeg.wasm), no upload needed for this step.
- **Transcribe** — timestamped, speaker-labelled transcript via [WhisperX](https://github.com/m-bain/whisperx), editable in place, exportable as `.txt`/`.docx`.
- **Summarise** — overview / key points / action items via a local [Ollama](https://ollama.com) model, in your choice of style and length.
- **Session history** — past sessions are kept in the sidebar (saved in your browser) so you can reopen a transcript/summary later.

Nothing leaves your machine: conversion happens in the browser, transcription
runs against your own WhisperX install, and summarisation runs against your
own local Ollama model.

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────┐
│  Frontend (Vite + React) │  HTTP  │  Backend (FastAPI)        │
│  - ffmpeg.wasm conversion│───────▶│  - WhisperX transcription │
│  - stage-by-stage UI     │        │  - Ollama summarisation   │
│  - session history       │◀───────│                            │
│    (localStorage)        │        └──────────┬─────────────────┘
└──────────────────────────┘                   │
                                                 ▼
                                   ┌─────────────────────────────┐
                                   │  Ollama (local, separate     │
                                   │  process — `ollama serve`)   │
                                   └───────────────────────────────┘
```

The frontend never talks to Ollama directly — it always goes through the
FastAPI backend, which also does the WhisperX transcription.

## Prerequisites

| Requirement | Needed for | Notes |
| --- | --- | --- |
| [Node.js](https://nodejs.org) 20+ | Frontend | `npm` comes with it |
| [Python](https://www.python.org) 3.10+ | Backend | |
| `ffmpeg` on `PATH` | Backend | Used server-side by WhisperX. (The frontend's own audio conversion step uses ffmpeg.wasm and needs nothing installed.) |
| [Ollama](https://ollama.com) | Summarisation | Run locally; not needed for transcription alone |
| NVIDIA GPU + CUDA driver | Backend (optional) | Strongly recommended — WhisperX falls back to CPU otherwise, which is much slower |
| Hugging Face account | Backend (optional) | Only needed for speaker diarization (telling speakers apart) |

## Quickstart

Once the prerequisites above are installed, this is the fastest path to a
running app (see [Detailed setup](#detailed-setup) below if anything here
doesn't make sense):

```bash
git clone https://github.com/dv130703/speak-summary.git
cd speak-summary

# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121  # adjust for your CUDA version
pip install -r requirements.txt
cp .env.example .env
cd ..

# Frontend
npm install
```

Then, in three separate terminals:

```bash
# Terminal 1 - Ollama
ollama serve

# Terminal 2 - Backend (from backend/, with .venv activated)
uvicorn app.main:app --reload --host 0.0.0.0 --port 5000

# Terminal 3 - Frontend
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

## Detailed setup

### 1. Clone the repo

```bash
git clone https://github.com/dv130703/speak-summary.git
cd speak-summary
```

### 2. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate

# Install PyTorch first, with the right build for your machine.
# See https://pytorch.org/get-started/locally/ for the exact command -
# the one below is for CUDA 12.1; use --index-url .../cpu for CPU-only.
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121

pip install -r requirements.txt

cp .env.example .env
```

**Speaker diarization** (telling speakers apart) downloads
[`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1)
by default, which needs a Hugging Face token:

1. Accept the terms on that model's page while logged in to Hugging Face.
2. Create a token at https://huggingface.co/settings/tokens.
3. Add it to `backend/.env` as `WHISPERX_HF_TOKEN=...`.

Without a token, transcription still works fine — just leave diarization off
for a given transcript (the app has a toggle for this).

For the full breakdown of diarization backends (including the more accurate
but heavier NeMo option) and every `.env` setting, see
[`backend/README.md`](backend/README.md).

**Verify the backend on its own** before wiring up the frontend:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 5000
```

`--host 0.0.0.0` makes the API reachable from other devices on your LAN via
this machine's IP (e.g. `http://192.168.x.x:5000`), not just `localhost`. Drop
it if you don't need that.

Visit http://localhost:5000/api/health — you should get back JSON describing
the device, compute type, and configured model. Leave this running (or restart
it later) for the frontend to talk to.

### 3. Ollama

Install Ollama from https://ollama.com, then in a separate terminal:

```bash
ollama serve
```

Pull at least one chat-capable model (this is what generates the summary):

```bash
ollama pull llama3.1
```

Any Ollama chat model works — bigger models give better summaries but are
slower. The app lets you pick from whatever models you have pulled.

### 4. Frontend

From the repo root (not `backend/`):

```bash
npm install
npm run dev
```

Open the printed URL (usually http://localhost:5173). By default the frontend
talks to the backend at `http://localhost:5000` — if your backend runs
elsewhere, create a `.env` file at the repo root with:

```
VITE_API_BASE_URL=http://your-backend-host:5000
```

## Running everything together

You need three things running at once during development:

1. `ollama serve` — for summarisation
2. `uvicorn app.main:app --reload --host 0.0.0.0 --port 5000` (from `backend/`, venv active) — for transcription + summarisation
3. `npm run dev` (from the repo root) — the app itself

Then, in the browser:

1. **Audio** — drop in a file. Video files need a format picked and converted
   first (in-browser, no upload); audio files are ready immediately, but you
   can still convert them to a different format if you want.
2. **Transcript** — click *Generate transcript*. Toggle diarization and
   speaker-count hints under *Options* first if you want them.
3. **Summary** — once a transcript exists, pick a model/style/length under
   *Options* and click *Generate summary*.

Past sessions show up in the left sidebar and can be reopened at any time.

## Building for production

```bash
npm run build   # type-checks then builds to dist/
npm run preview # serve the production build locally to sanity-check it
```

This project is built for local/personal use (everything assumes the backend,
Ollama, and frontend are all reachable from your own machine or network) —
there's no deployment config included. If you do deploy the backend somewhere
else, update `WHISPERX_CORS_ORIGINS` in `backend/.env` and `VITE_API_BASE_URL`
in the frontend's `.env` accordingly.

## Environment variables

**Frontend** (`.env` at repo root, all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:5000` | Where the backend lives |

**Backend** (`backend/.env`, copy from `backend/.env.example`): every setting
is prefixed `WHISPERX_`. The most relevant ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WHISPERX_WHISPER_MODEL` | — | `tiny` up to `large-v3` — bigger is slower but more accurate |
| `WHISPERX_HF_TOKEN` | — | Required for the default diarization backend |
| `WHISPERX_DEVICE` / `WHISPERX_COMPUTE_TYPE` | auto-detect | Force CPU/GPU or a specific compute type |
| `WHISPERX_DIARIZATION_BACKEND` | `pyannote` | `pyannote` or `nemo` (see `backend/README.md`) |
| `WHISPERX_CORS_ORIGINS` | — | Extra allowed frontend origins (any `localhost`/`127.0.0.1` port is already allowed) |

Full list and details: [`backend/README.md`](backend/README.md).

## Troubleshooting

- **`pip install torch` grabs the wrong build / no GPU detected** — you
  installed the CPU-only wheel or the wrong CUDA version. Check
  https://pytorch.org/get-started/locally/ for the exact command for your
  driver, reinstall `torch`/`torchaudio` with that, then `pip install -r
  requirements.txt` again.
- **"No chat-capable models found" in the Summary step** — run `ollama pull
  llama3.1` (or any other chat model) and make sure `ollama serve` is
  running.
- **Diarization fails / 400 error mentioning a token** — either add
  `WHISPERX_HF_TOKEN` to `backend/.env` (see step 2 above), or turn off the
  *Speaker diarization* toggle in the Transcript step's Options.
  Diarization also needs you to have accepted the model's terms on
  Hugging Face while logged in, not just have a token.
- **CORS error in the browser console** — the backend only auto-allows any
  `localhost`/`127.0.0.1` origin. If you're accessing the frontend from
  another device or a different host, add that origin to
  `WHISPERX_CORS_ORIGINS` in `backend/.env`.
- **Port already in use** — `uvicorn ... --port 5001` or `npm run dev --
  --port 5174`, and set `VITE_API_BASE_URL` accordingly if you moved the
  backend's port.
- **Can't reach the backend from another device via its LAN IP** — make sure
  uvicorn was started with `--host 0.0.0.0` (not the default `127.0.0.1`,
  which only accepts connections from the same machine), and that your OS
  firewall allows inbound connections on the backend's port.
- **Session history missing after clearing browser data** — it's stored in
  `localStorage`, scoped to the frontend's origin; clearing site data or
  using a different browser/profile starts fresh.

## Project structure

```
speak-summary/
├── src/
│   ├── App.tsx                  # app shell: sidebar, stage flow, session state
│   └── exclusives/
│       ├── UploadIntake.tsx     # stage 1: drag/drop, format conversion
│       ├── AudioPlayer.tsx      # custom player chrome
│       ├── TranscriptPanel.tsx  # stage 2: transcript generation & editing
│       ├── SummaryPanel.tsx     # stage 3: summary generation
│       ├── SessionHistoryPanel.tsx / sessionHistory.ts  # sidebar + localStorage persistence
│       ├── StageNav.tsx         # numbered 1/2/3 stage navigation
│       ├── transcribeApi.ts / summarizeApi.ts           # backend API clients
│       └── convertAudio.ts / ffmpegClient.ts            # in-browser conversion (ffmpeg.wasm)
└── backend/
    ├── app/
    │   ├── main.py               # FastAPI app, CORS
    │   ├── routers/               # /api/transcribe, /api/summarize, /api/ollama/models
    │   └── services/              # WhisperX + Ollama integration
    └── scripts/download_model.py # pre-download models
```

For the full backend API reference (request/response shapes, all config
options, the NeMo diarization backend), see [`backend/README.md`](backend/README.md).
