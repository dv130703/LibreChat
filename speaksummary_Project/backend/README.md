# Transcription backend

FastAPI service that wraps [WhisperX](https://github.com/m-bain/whisperx) for
timestamped transcription with speaker diarization, and a local
[Ollama](https://ollama.com) instance for summarization.

## Prerequisites

- Python 3.10+
- `ffmpeg` on `PATH`
- An NVIDIA GPU + CUDA driver is strongly recommended (falls back to CPU otherwise)
- [Ollama](https://ollama.com) running locally (`ollama serve`), with at least one
  chat-capable model pulled, e.g. `ollama pull llama3.1` — required for the
  summarization step, not for transcription

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate

# Install PyTorch first with the right CUDA build for your machine.
# See https://pytorch.org/get-started/locally/ for the exact command for your setup.
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121

pip install -r requirements.txt

cp .env.example .env
```

Diarization (telling speakers apart) downloads
[`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1)
by default, which needs a Hugging Face token:

1. Accept the terms on that model's page (and any linked component models it
   requires) while logged in to Hugging Face.
2. Create a token at https://huggingface.co/settings/tokens
3. Put it in `.env` as `WHISPERX_HF_TOKEN=...`

Without a token, `/api/transcribe` still works with `diarize=false`.

The older [`pyannote/speaker-diarization-3.1`](https://huggingface.co/pyannote/speaker-diarization-3.1)
model can be used instead by setting `WHISPERX_DIARIZATION_MODEL=pyannote/speaker-diarization-3.1`
in `.env` — it needs its own terms acceptance (and the
[`pyannote/segmentation-3.0`](https://huggingface.co/pyannote/segmentation-3.0) model it depends on)
on the same Hugging Face account before its first download will succeed.

### NeMo (Sortformer) diarization backend

[`nvidia/diar_streaming_sortformer_4spk-v2`](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)
is the most accurate diarizer tested here:

- **License is CC-BY-4.0** (permissive, commercial use OK).
- **Hard cap of 4 speakers**, and `min_speakers`/`max_speakers` hints are ignored.
- **Streaming architecture** processes audio in bounded-memory chunks (an "Arrival-Order Speaker
  Cache" keeps speaker identity consistent across chunks), so it handles long recordings fine -
  a 20-minute file peaks around 7-8GB VRAM alongside the whisper medium model. The non-streaming
  `nvidia/diar_sortformer_4spk-v1` was tried first and dropped: it runs the whole file through
  self-attention in one pass and reliably OOMs (surfaces as a confusing
  `CUDA driver error: device not ready`, not a clean out-of-memory message) past roughly
  10-15 minutes of audio on a 12GB GPU.
- **Runs in a separate venv** (`backend/.venv-nemo`) because NeMo needs a `lightning` version
  that conflicts with the one pyannote/whisperx needs, plus ~40 extra packages. The main
  backend calls it via subprocess per request, so each diarization request pays the cost of
  reloading the model from disk (~a few seconds, even on GPU) — there's no in-process caching
  like the pyannote path gets.

Setup:

```bash
cd backend
python3 -m venv .venv-nemo
.venv-nemo/bin/pip install torch --index-url https://download.pytorch.org/whl/cu124
.venv-nemo/bin/pip install Cython packaging
.venv-nemo/bin/pip install "nemo_toolkit[asr] @ git+https://github.com/NVIDIA/NeMo.git@main"
```

Then set `WHISPERX_DIARIZATION_BACKEND=nemo` in `.env`. No Hugging Face token is needed for this
one — the model is public. Switch back by removing that line (or setting it to `pyannote`).

## Run

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 5000
```

`--host 0.0.0.0` binds to all network interfaces instead of just `localhost`, so
the API is reachable from other devices on the LAN via this machine's IP
(e.g. `http://192.168.x.x:5000`). Drop it (or use `--host 127.0.0.1`) to
restrict access to this machine only.

The whisper model loads lazily on the first request. To pre-download it (and
the alignment/diarization models) up front instead:

```bash
python scripts/download_model.py
```

## API

### `GET /api/health`

Returns the device, compute type, configured model, and whether it's loaded yet.

### `POST /api/transcribe`

Multipart form:

| field          | type   | default | notes                                   |
| -------------- | ------ | ------- | ---------------------------------------- |
| `file`         | file   | —       | audio or video file                      |
| `diarize`      | bool   | `true`  | requires `WHISPERX_HF_TOKEN`             |
| `min_speakers` | int?   | auto    |                                           |
| `max_speakers` | int?   | auto    |                                           |
| `language`     | str?   | auto    | e.g. `en`, `es`                          |

Response:

```json
{
  "language": "en",
  "segments": [
    { "id": "segment-0", "start": 0.0, "end": 3.4, "speaker": "Speaker 1", "text": "..." }
  ]
}
```

This shape matches the frontend's `TranscriptSegment` type (`src/exclusives/transcript.ts`).

### `GET /api/ollama/models`

Lists locally available Ollama models capable of chat/completion (filters out
embedding-only models like `nomic-embed-text`). Returns `502` if Ollama isn't reachable.

```json
{ "models": [{ "name": "llama3.1:latest" }, { "name": "qwen2.5:14b" }] }
```

### `POST /api/summarize`

JSON body:

| field      | type              | default    | notes                                    |
| ---------- | ----------------- | ---------- | ----------------------------------------- |
| `segments` | `TranscriptSegment[]` | —      | from `/api/transcribe`                    |
| `style`    | `concise`/`bullets`/`detailed` | `concise` |                              |
| `length`   | `short`/`long`    | `short`    |                                            |
| `model`    | string            | —          | one of the names from `/api/ollama/models` |

Response:

```json
{
  "overview": "...",
  "key_points": ["..."],
  "action_items": ["..."]
}
```

Uses Ollama's structured-output mode (`format` as a JSON schema) so the response reliably
parses, and sets `num_ctx: 8192` since Ollama's default context window is much smaller
than what these models support - transcripts are truncated to fit that budget.

## Config

All settings are read from `backend/.env` (see `.env.example`), prefixed with
`WHISPERX_`. Notably `WHISPERX_WHISPER_MODEL` (`tiny` up to `large-v3` — bigger
is slower but more accurate) and `WHISPERX_CORS_ORIGINS` (which frontend origins
may call this API - though `app/main.py` also allows any `localhost`/`127.0.0.1`
port via regex, since Vite silently picks a different port when its default is
already taken, so `WHISPERX_CORS_ORIGINS` really only matters for non-local
origins).
