# Transcription API Reference

Every API surface involved in turning an uploaded recording into a speaker-labelled
transcript: the public LibreChat REST API the frontend calls, the internal Python
service that does the actual ASR/diarization work, and the engine class underneath it.
See `ARCHITECTURE.md` in this directory for the migration/design narrative; this
document is a pure reference to endpoints, parameters, and return shapes.

```
Browser
  │
  ├─ POST/GET  /api/transcribe/*              (api/server/routes/transcribe.js)
  ├─ GET       /api/transcribe/:id/audio       (api/server/routes/transcribeStream.js)
  └─ */        /api/transcript-corrections/*   (api/server/routes/transcriptCorrections.js)
        │
        │  transcribeAndEmbed() — api/server/services/Transcription/index.js
        ▼
  POST {TRANSCRIPTION_API_URL or RAG_API_URL}/transcribe   (rag_server/app.py, FastAPI)
        │
        │  WhisperXService.transcribe()
        ▼
  transcription/whisperx_service.py  →  faster-whisper / pyannote.audio / WhisperX
```

- **Layer 1 — LibreChat Node API** (`api/server/routes/transcribe*.js`, `transcriptCorrections.js`): what the React client calls. Handles auth, file storage, job queueing/status, and the correction/re-embed workflow.
- **Layer 2 — RAG server HTTP API** (`rag_server/app.py`): a FastAPI service, separate Python process, that exposes the ASR/diarization pipeline over HTTP (`POST /transcribe`).
- **Layer 3 — `WhisperXService`** (`transcription/whisperx_service.py`): the Python class that actually runs faster-whisper (ASR), pyannote.audio (VAD + diarization), and WhisperX (forced alignment).

---

## 1. LibreChat Node API (`/api/transcribe`, `/api/transcript-corrections`)

All routes below require `requireJwtAuth` (a normal logged-in session) **except**
`GET /api/transcribe/:sourceFileId/audio`, which uses a short-lived token instead
(see that route). Every `:sourceFileId`-scoped route re-verifies the caller owns
that file (`user: req.user.id`) before doing anything.

### `POST /api/transcribe`

Uploads a new recording, stores it, creates/attaches a conversation, and
**queues** a transcription job — it returns as soon as the job is queued, not
once transcription finishes (async job, tracked via `GET /status`).

Multipart form fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `file` | file | yes | Audio or video; MIME must start with `audio/` or `video/` |
| `conversationId` | string (UUID) | yes | Existing conversation to attach to, or a fresh id to create one |
| `endpoint` | string | no | Used only when creating a new conversation |
| `agent_id` | string | no | Checked against `PermissionBits.VIEW` via `canAccessAgentFromBody` |
| `parentMessageId` | string | no | Defaults to `Constants.NO_PARENT` |
| `isTemporary` | `"true"` / omitted | no | Must be the literal string `"true"` to mark the conversation/files as temporary (retention expiry) |
| `options` | JSON string | no | See **Transcription options**, below |

**Transcription options** (all optional, parsed from the `options` JSON field and forwarded to the RAG server):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `includeTimestamps` | boolean | `true` | Whether formatted transcript lines include timestamps |
| `diarize` | boolean | `true` | Run speaker diarization |
| `speakerCount` | number | — | Hint for expected speaker count (clamped server-side to 1–8) |
| `clusteringThreshold` | number | deployment default | pyannote clustering threshold override |
| `language` | string | deployment default | Force a transcription language (e.g. `"en"`) instead of auto-detect |
| `contextTerms` | string | — | Comma/semicolon/newline-separated names & jargon, packed into Whisper's `initial_prompt` |
| `model` | string | deployment default | One of `tiny, small, medium, large-v2, large-v3, large-v3-turbo` |
| `suppressNumerals` | boolean | deployment default | Force digits to be spelled out (`"2014"` → `"twenty fourteen"`) |
| `channelSplit` | boolean | `false` | Use per-audio-channel speaker separation instead of pyannote clustering (bypasses `speakerCount`/`clusteringThreshold`) |

Response `202`:
```json
{
  "conversationId": "…",
  "messageId": "…",
  "sourceFile": { "file_id": "…", "filename": "…" },
  "status": "queued",
  "queuePosition": 0
}
```

### `GET /api/transcribe/config`

Proxies `GET {TRANSCRIPTION_API_URL}/transcribe/config` — this deployment's
effective defaults (allowed models, default model/language, whether a
deployment-wide glossary is configured, suggested vocabulary terms, max
speakers). No parameters. `503` if no transcription backend is configured.

### `POST /api/transcribe/probe`

Stateless: uploads a file (`file` field), returns its audio channel count, then
deletes the upload. Used to offer channel-split mode before a real transcribe
job is queued.

Response: `{ "channelCount": 2 }`

### `GET /api/transcribe/status?fileIds=id1,id2,...`

Batch job-status poll. `fileIds` is a comma-separated list (or repeated query
param) of **source audio** file ids. Returns only files the caller owns and
that carry transcription state; unknown/unowned ids are silently omitted.

```json
{
  "files": [
    {
      "file_id": "…",
      "status": "queued | transcribing | ready | failed",
      "error": null,
      "cancelled": false,
      "transcriptFileId": "…",
      "diarizationDetailFileId": "…"
    }
  ]
}
```

### `GET /api/transcribe/conversation/:conversationId`

Every recording attached to one conversation, with per-recording status. No
body/query parameters beyond the path.

### `GET /api/transcribe/:sourceFileId/audio-token`

Mints a 6-hour, single-purpose JWT for streaming that file's audio (see next
route). Response: `{ "url": "/api/transcribe/<id>/audio?token=...", "expiresIn": 21600 }`.

### `GET /api/transcribe/:sourceFileId/audio?token=...` *(transcribeStream.js)*

**Not** behind `requireJwtAuth` — a native `<audio>`/`<video>` tag can't send an
Authorization header, so this route takes the token above as a query param
instead. Streams the raw source audio bytes, with HTTP range support (`206`
partial content) when the file is stored locally.

### `POST /api/transcribe/:sourceFileId/retry`

Re-queues a job whose status is `failed`, using the exact options it originally
ran with. `409` if the current status isn't `failed`. No body.

### `POST /api/transcribe/:sourceFileId/cancel`

Best-effort cancel of a `queued` or `transcribing` job — writes a terminal
`failed` status immediately and aborts the in-flight HTTP request to the RAG
server if one is running. `409` if the job isn't in a cancellable state. No body.

### `POST /api/transcribe/:sourceFileId/retranscribe`

Re-runs transcription on the audio already stored for this source file (no
re-upload), replacing its conversation's transcript. Existing corrections for
that conversation are discarded (they'd address line indices in text that no
longer exists).

Body: `{ "options": { ...same shape as POST / above... } }` (JSON object or
JSON-encoded string, both accepted).

### `POST /api/transcribe/:sourceFileId/interview-docx`

Generates an "interview cover sheet" `.docx` export, regenerating the
corrected transcript server-side from the stored correction log.

Body: `{ "form": {...}, "speakers": [...] }` (both required; shape defined by
`InterviewTranscriptDialog.tsx` on the frontend). Response: binary `.docx`.

### `POST /api/transcribe/:sourceFileId/meeting-minutes-docx`

Same as above, but produces a meeting-minutes-formatted `.docx`.

Body: `{ "form": {...}, "speakers": [...] }`. Response: binary `.docx`.

---

### `/api/transcript-corrections/*`

Append-only correction log for a transcript — every edit is recorded as an
event, never an in-place text mutation, so the original pipeline output stays
recoverable. Every route requires `conversationId` (body or query) and
verifies the caller owns it.

| Route | Body fields | Effect |
|---|---|---|
| `GET /:transcriptFileId?conversationId=` | — | All correction events, chronological |
| `POST /:transcriptFileId/speaker-rename` | `conversationId, speakerId, fromName, toName` | Renames a speaker everywhere they appear |
| `POST /:transcriptFileId/segment-reassign` | `conversationId, lineIndex, fromSpeakerId, toSpeakerId` | Reassigns one line to a different speaker |
| `POST /:transcriptFileId/text-edit` | `conversationId, lineIndex, fromText, toText` | Edits one line's text |
| `POST /:transcriptFileId/time-edit` | `conversationId, lineIndex, fromSeconds, fromEndSeconds, seconds, endSeconds` | Corrects one line's start/end time (`endSeconds > seconds` required) |
| `POST /:transcriptFileId/line-insert` | `conversationId, lineIndex (synthetic, e.g. 4.5), speaker, text, seconds, endSeconds` | Inserts a line the pipeline missed |
| `GET /:transcriptFileId/index-status?conversationId=` | — | `{ transcriptVersion, indexVersion, indexStatus }` — whether RAG `file_search` has caught up |
| `POST /:transcriptFileId/reindex` | `conversationId` | Manually re-embeds the corrected transcript into RAG (normally automatic after each correction) |

Every correction-writing route triggers an async re-embed into RAG (queued
per-transcript so concurrent edits can't race and overwrite each other) —
callers don't wait on it except `/reindex`, which does.

---

## 2. RAG server HTTP API (`rag_server/app.py`)

A separate FastAPI process (Python). Its base URL is `TRANSCRIPTION_API_URL` if
set, else `RAG_API_URL` — see `packages/api/src/transcription/endpoint.ts`
(lets ASR run on a different machine than the RAG/embedding service). Requires
`Authorization: Bearer <jwt>`, verified via `get_user_id`.

### `GET /transcribe/config`

Returns `TranscriptionConfig` — this deployment's resolved defaults, read
straight off `Settings` (no model loaded, costs nothing):

```json
{
  "models": ["large-v2", "large-v3", "large-v3-turbo", "medium", "small", "tiny"],
  "default_model": "large-v3-turbo",
  "default_language": "en",
  "default_suppress_numerals": true,
  "default_clustering_threshold": null,
  "hotwords_configured": false,
  "suggested_terms": ["Serious Fraud Office", "SFO", "…"],
  "max_speakers": 8
}
```

### `POST /transcribe`

The actual ASR/diarization pipeline call. Multipart form:

| Field | Type | Default | Notes |
|---|---|---|---|
| `file` | file | required | Must be `audio/*` or `video/*` |
| `diarize` | bool | `true` | |
| `speaker_count` | int \| null | `null` | Clamped to 1–8 (`speaker_count.py`) |
| `clustering_threshold` | float \| null | `null` (→ deployment/pipeline default) | pyannote clustering hyperparameter |
| `language` | str \| null | `null` (deployment default) | |
| `context_terms` | str \| null | `null` | Packed into `initial_prompt`, see §4.4 |
| `model` | str \| null | `null` (deployment default) | Must be one of `_ALLOWED_WHISPER_MODELS` or `400` |
| `suppress_numerals` | bool \| null | `null` (deployment default) | |
| `channel_split` | bool | `false` | Bypasses diarization entirely |

Runs in a thread pool (blocking, GPU/CPU-bound; this server also answers
`/embed` and `/query` concurrently). Returns `TranscriptionResponse` (schema
below) as JSON. `422` if the recording has no detectable speech
(`NoSpeakerSegments`); `400` for a bad file type or unsupported model; `500`
for any other pipeline failure.

### `TranscriptionResponse` schema (`transcription/schemas.py`)

```
TranscriptionResponse
├─ segments: TranscriptSegment[]
│    ├─ id, start, end, speaker, text
│    ├─ assignment_method: "overlap" | "nearest" | "unknown" | "channel_split" | "none"
│    ├─ assignment_distance_s: float | null
│    ├─ vad_borderline: bool
│    └─ words: WordSpan[]
│         ├─ word, start, end, speaker, assignment_method, assignment_distance_s
│         └─ vad_confidence: "high" | "borderline" | null
├─ language: str
├─ diagnostics: TranscriptionDiagnostics | null   (see below)
├─ diarization_turns: DiarizationTurn[]            (raw pyannote turns; empty for channel_split)
│    └─ start, end, speaker
├─ speaker_embeddings: { [pyannoteLabel]: float[] } | null
└─ recording_profile: RecordingProfile             (see §4.6)
```

`TranscriptionDiagnostics` — everything about *how* the transcript was
produced, not what it says: which model actually ran vs. what was requested,
prompt/hotwords token budget usage, VAD tier durations, diarization retry
outcome, speaker-count hint compliance, and the raw→renumbered speaker label
map. Full field list is documented inline in `schemas.py`.

---

## 3. `transcribeAndEmbed()` — the Node→Python bridge

`api/server/services/Transcription/index.js` is the only caller of the RAG
server's `/transcribe` endpoint. Signature:

```js
transcribeAndEmbed({ req, file, sourceFileId, options, signal })
```

- `file`: multer file object (`{ path, originalname, mimetype }`)
- `sourceFileId`: id of the already-persisted source File document; the
  transcript's own file id is derived as `${sourceFileId}-transcript`, so a
  re-transcribe overwrites rather than duplicates it
- `options`: the same options object described under `POST /api/transcribe`
  above (camelCase; translated 1:1 to the Python endpoint's snake_case form
  fields)
- `signal`: an `AbortSignal`, wired to `POST /:sourceFileId/cancel`

Returns segments/diagnostics/etc. from the RAG server, plus the formatted
transcript `text`, whether it was successfully `embedded` into RAG, and the
derived `transcriptFileId`. Also embeds the transcript into RAG for later
`file_search` retrieval (`embedTranscript`, with up to 3 retries on transient
failure).

---

## 4. `WhisperXService` — the transcription engine

`transcription/whisperx_service.py`. One instance per process
(`get_whisperx_service()`, `@lru_cache`), lazily loading and caching models
across requests — never more than one ASR model resident at a time.

### 4.1 Construction

`WhisperXService(settings: Settings)` — pinned to `device="cuda"` unless
`WHISPERX_DEVICE=cpu` is set explicitly; raises immediately at startup if CUDA
isn't available (no silent CPU fallback). `compute_type` defaults to
`"float16"`.

### 4.2 `transcribe()` — the core method

```python
def transcribe(
    self,
    audio_path: str,
    language: str | None = None,
    diarize: bool = True,
    speaker_count: int | None = None,
    clustering_threshold: float | None = None,
    context_terms: str | None = None,
    model: str | None = None,
    suppress_numerals: bool | None = None,
    channel_split: bool = False,
) -> tuple[
    list[dict],               # segments
    str,                      # detected/used language
    dict,                     # diagnostics
    list[dict],               # diarization_turns
    dict[str, list[float]] | None,  # speaker_embeddings
    dict,                     # recording_profile
]
```

Pipeline, in order:
1. **Prompt build** (`build_prompt`) — budgets `context_terms` into Whisper's
   `initial_prompt` against the loaded model's real tokenizer.
2. **Speaker-count hint resolution** (`resolve_speaker_count`) — clamps
   `speaker_count` to 1–8 before any diarizer sees it.
3. **ASR + forced alignment** (`_asr_and_align`) — runs faster-whisper via
   WhisperX, then word-level alignment; also runs two-tier VAD to recover
   quiet speech a single threshold would drop (§4.5).
4. If `channel_split`: each audio channel is decoded and transcribed
   independently via `ffmpeg -map_channel`, skipping pyannote entirely — each
   channel becomes its own speaker (`CHANNEL_0`, `CHANNEL_1`, …), merged back
   into one time-ordered transcript.
5. Else if `diarize`: runs pyannote diarization (`_run_diarization`), then
   **one automatic retry** with an explicit speaker count (`detected + 1`) if
   the first pass looks "difficult" (see `recording_profile.py`'s
   classification) and the caller didn't already supply an explicit
   `speaker_count` — kept only if it measurably reduces the
   `suspicious_segment_ratio`. (The `clustering_threshold` parameter is a
   pyannote-exposed knob but is empirically inert against this pipeline's
   VBx-based clustering — `speaker_count` is the lever that actually changes
   output.)
6. Each segment/word is labelled by `_resolve_speaker_assignment`: `"overlap"`
   (a diarization turn actually covers it), `"nearest"` (nearest turn within
   `MAX_NEAREST_FALLBACK_DISTANCE_S`), `"unknown"` (nothing close enough —
   speaker is literally `"Unknown"`, not guessed), `"channel_split"`, or
   `"none"` (diarization not run).
7. `compute_recording_profile` (§4.6) summarizes turn-taking statistics.

Raises `NoSpeakerSegments` if the recording has no detectable speech at all.

### 4.3 Speaker count (`speaker_count.py`)

`resolve_speaker_count(speaker_count: int | None) -> SpeakerCountHint` clamps
into `MIN_ALLOWED_SPEAKERS = 1` … `MAX_ALLOWED_SPEAKERS = 8` (pyannote's
accuracy falls off past 8), returning both the resolved count and a list of
human-readable adjustment strings for anything that got clamped.

### 4.4 Prompt/hotwords budgeting (`transcription_prompt.py`)

Whisper is not instruction-tuned — `initial_prompt` is treated as "the
transcript that came just before," so this module emits **terms only**, never
framing sentences (prose gets echoed into the output over silence).

- `DECODER_CONTEXT_TOKENS = 448` total budget; faster-whisper caps each of
  `hotwords` and `initial_prompt` at `223` tokens (`FASTER_WHISPER_PART_CAP`)
  since they're separate parts that stack.
- `prompt_budget(hotwords_tokens=0, output_headroom=200) -> int` — remaining
  room for `initial_prompt` after the deployment glossary and reserved output
  headroom are subtracted.
- `parse_terms(raw: str) -> list[str]` — splits on commas/semicolons/newlines,
  dedupes case-insensitively, caps at 256 terms / 60 chars each.
- `build_initial_prompt(confirmed_terms, count_tokens=None, budget=None) -> PromptBuild` —
  packs terms into the budget in priority order (earliest = highest priority;
  overflow terms are dropped, not truncated mid-term).
- `pack_hotwords(terms, count_tokens) -> str | None` — same packing logic for
  faster-whisper's separate `hotwords` decode-time bias channel.
- Exact token counting when a model tokenizer is available; a pessimistic
  `~3 chars/token` heuristic (`estimate_tokens`) otherwise.

### 4.5 Voice activity detection (`vad.py`, `vad_tiers.py`)

Single pyannote segmentation forward pass, thresholded twice from the same
in-memory scores (`vad_tiers.compute_tiers`):
- **Confident tier**: `WHISPERX_VAD_ONSET` (0.500) / `WHISPERX_VAD_OFFSET`
  (0.363) — transcribed unflagged.
- **Borderline tier**: `WHISPERX_VAD_BORDERLINE_ONSET` (0.350) /
  `WHISPERX_VAD_BORDERLINE_OFFSET` (0.250) — anything *only* this permissive
  pair finds is still transcribed, but every word/segment it touches is
  flagged `vad_confidence: "borderline"` for reviewer attention. Setting the
  borderline pair equal to the confident pair disables the second tier.

### 4.6 Recording profile (`recording_profile.py`)

`compute_recording_profile(segments, diarization_turns) -> RecordingProfile` —
purely descriptive statistics computed after transcription (never changes
what got transcribed): turn count/duration percentiles, speaker switch rate,
per-speaker time distribution, overlap ratio, and several "how much of this
transcript's speaker attribution is actually trustworthy" ratios
(`unassigned_audio_ratio`, `boundary_conflict_ratio`,
`word_segment_disagreement_ratio`, rolled up into `suspicious_segment_ratio` +
`suspicious_segment_ids`). Ends in a `classification`:

| Classification | Trigger |
|---|---|
| `insufficient_data` | No turns at all |
| `monologue` | ≤ 1 real speaker |
| `difficult` | Overlap ≥ 15%, unassigned ≥ 25%, short-turn ratio ≥ 40%, boundary-conflict ≥ 10%, or word/segment disagreement ≥ 10% |
| `rapid_dialogue` | ≥ 15 speaker switches/min, or median turn < 3s |
| `conversation` | Everything else |

### 4.7 Channel isolation (`channels.py`)

- `probe_channel_count(audio_path) -> int` — reads channel count from
  container metadata via `ffprobe` (falls back to `1` on any failure).
- `load_audio_channel(audio_path, channel_index, sr=16000) -> np.ndarray` —
  decodes exactly one channel via `ffmpeg -map_channel`, avoiding the downmix
  `whisperx.load_audio` would otherwise apply.

### 4.8 Offline / Hugging Face Hub reachability (`offline.py`)

Governs whether the whisper/alignment/diarization model loaders are allowed
to reach the Hugging Face Hub at all (`WHISPERX_OFFLINE_MODE`: `"auto"` |
`"on"` | `"off"`). `"auto"` probes the hub at most once a minute
(`PROBE_TTL_S = 60`, `WHISPERX_HUB_PROBE_TIMEOUT_S = 3.0`) and falls back to
cache-only when it doesn't answer — avoiding a multi-model DNS/connect
timeout tax on every offline run.

---

## 5. Configuration reference (`transcription/config.py`)

Read from `.env` (project root, then `rag_server/.env` — both optional, root
first, `rag_server/.env` wins on conflicts), prefix `WHISPERX_` unless noted.

| Setting | Env var | Default | Purpose |
|---|---|---|---|
| `whisper_model` | `WHISPERX_WHISPER_MODEL` | `large-v3-turbo` | Any faster-whisper size |
| `device` | `WHISPERX_DEVICE` | `cuda` (forced) | Set `cpu` to opt out of the GPU requirement |
| `compute_type` | `WHISPERX_COMPUTE_TYPE` | `float16` | |
| `hf_token` | `WHISPERX_HF_TOKEN` / `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` | — | Required for diarization (gated model terms) |
| `diarization_model` | `WHISPERX_DIARIZATION_MODEL` | pyannote default (`speaker-diarization-community-1`) | |
| `default_language` | `WHISPERX_DEFAULT_LANGUAGE` | `en` | |
| `batch_size` | `WHISPERX_BATCH_SIZE` | `16` | Auto-reduced as `beam_size` grows |
| `beam_size` | `WHISPERX_BEAM_SIZE` | `5` | Main accuracy/latency knob |
| `repetition_penalty` | `WHISPERX_REPETITION_PENALTY` | `1.15` | `1.0` = off |
| `no_repeat_ngram_size` | `WHISPERX_NO_REPEAT_NGRAM_SIZE` | `5` | `0` = off |
| `hotwords` | `WHISPERX_HOTWORDS` | — | Deployment-wide glossary, comma-separated (or JSON list/object) |
| `initial_prompt` | `WHISPERX_INITIAL_PROMPT` | — | Fallback prompt when a request supplies no `context_terms` |
| `offline_mode` | `WHISPERX_OFFLINE_MODE` | `auto` | `auto` \| `on` \| `off` |
| `hub_probe_timeout_s` | `WHISPERX_HUB_PROBE_TIMEOUT_S` | `3.0` | |
| `local_files_only` | `WHISPERX_LOCAL_FILES_ONLY` | `false` | Forces `offline_mode="on"` |
| `model_cache_dir` | `WHISPERX_MODEL_CACHE_DIR` | HF default | |
| `vad_onset` / `vad_offset` | `WHISPERX_VAD_ONSET` / `_OFFSET` | `0.500` / `0.363` | Confident VAD tier |
| `vad_borderline_onset` / `_offset` | `WHISPERX_VAD_BORDERLINE_ONSET` / `_OFFSET` | `0.350` / `0.250` | Permissive VAD tier |
| `diarization_clustering_threshold` | `WHISPERX_DIARIZATION_CLUSTERING_THRESHOLD` | pipeline default (0.6) | Empirically inert on current pyannote clustering — see §4.2 step 5 |
| `suppress_numerals` | `WHISPERX_SUPPRESS_NUMERALS` | `true` | |

Deployment-wide suggested vocabulary (pre-fills the client's term picker, not
sent to the decoder on its own) lives in `transcription/vocabulary.py`
(`SUGGESTED_TERMS`), edited as a normal code change rather than via env var.
