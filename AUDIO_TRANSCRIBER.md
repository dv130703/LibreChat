# LibreChat Audio Transcriber — Full Technical Reference

This document describes the **Audio Transcriber** feature in the LibreChat monorepo end to end: what it does, every option it exposes, and exactly how a request flows from the browser through Node/Express to a Python WhisperX microservice and back, including what gets persisted in MongoDB.

> **Not to be confused with:** LibreChat's separate, pre-existing live-mic Speech-to-Text (STT) voice-input feature (`client/src/components/Chat/Input/AudioRecorder.tsx`, `client/src/components/Nav/SettingsTabs/Speech/STT/`, `api/server/services/Files/Audio/STTService.js`). That system converts live microphone speech into composer text. It shares the word "transcribe" but is otherwise unrelated to everything below.

---

## 1. What it is, in one paragraph

Audio Transcriber is a standalone workspace page (`/audio-transcriber`, not embedded in normal chat) where a user uploads a recording (audio or video), it gets transcribed by a self-hosted WhisperX pipeline (Whisper ASR + forced alignment + pyannote speaker diarization), and the result opens as a two-pane view: a real LibreChat chat on the left (with the transcript automatically embedded into the conversation's RAG/file_search index, so the user can *ask questions about the recording*) and an editable transcript panel on the right (speaker labels, per-line timestamps, inline text/speaker/time corrections, re-transcribe, and export to `.docx` in "interview transcript" or "meeting minutes" formats). It appears to be purpose-built for **forensic/investigative use** (witness interviews, case recordings) — see the UI copy, the append-only audit-trail correction model, and the interview export's witness/role/case fields.

---

## 2. Architecture at a glance

```
┌─────────────────────────────┐
│  client/src/components/     │
│  AudioTranscriber/          │   UploadStep → TranscribeOptionsDialog → Workspace
│  (React, standalone route)  │   (ChatRoute pane | TranscriptPanel pane)
└──────────────┬───────────────┘
               │ multipart POST /api/transcribe (+ retranscribe, corrections, exports)
               ▼
┌─────────────────────────────┐
│  api/server/routes/         │   transcribe.js, transcriptCorrections.js
│  api/server/services/       │   Transcription/index.js (Node → Python bridge)
│  (Express, legacy JS)       │   Files/process.js (Mongo persistence)
└──────────────┬───────────────┘
               │ multipart POST {TRANSCRIPTION_API_URL or RAG_API_URL}/transcribe
               │ multipart POST {RAG_API_URL}/embed
               │ Bearer: short-lived JWT (per-request)
               ▼
┌─────────────────────────────┐
│  standalone Transcription    │   FastAPI: GET /health, GET /transcribe/config,
│  Pipeline service            │   POST /transcribe (WhisperX/pyannote)
│  (separate repo/process -    │
│   see §5)                    │
└─────────────────────────────┘
               │
               ▼
        MongoDB (Conversation.transcription, File docs for
        source audio / transcript / diarization-detail,
        TranscriptCorrection append-only log)
```

Three independently-owned layers, each documented in its own section below:
- **Frontend** — `client/src/components/AudioTranscriber/`, `client/src/data-provider/AudioTranscriber/`, shared types in `packages/data-provider`.
- **Node backend** — `api/server/routes/transcribe.js`, `transcriptCorrections.js`, `api/server/services/Transcription/index.js`, persistence helpers in `api/server/services/Files/process.js`.
- **Transcription microservice** — a standalone service reached via `TRANSCRIPTION_API_URL`, outside this repo. `rag_server/app.py` no longer serves `/transcribe` (see §5).

The feature is explicitly designed to be **self-contained and removable** — its own README (`client/src/components/AudioTranscriber/README.md`) lists every place it had to touch in otherwise-general files.

---

## 3. Frontend — user flow and UI

### 3.1 Where it lives
- Routes: `/audio-transcriber` and `/audio-transcriber/:conversationId`, both lazy-loading `AudioTranscriberPage.tsx` (`client/src/routes/index.tsx`).
- Sidebar entry: unconditional nav link (`client/src/hooks/Nav/useSideNavLinks.ts`) — no permission gate in the UI.
- `AudioTranscriberPage.tsx`: no `:conversationId` → renders `UploadStep`; once a conversation id exists → renders `Workspace`.

### 3.2 Step 1 — Upload (`UploadStep.tsx`)
1. Dropzone (drag-and-drop or click-to-browse), `accept="audio/*,video/*"`, three visual states (none/valid/invalid).
2. **Client-side multi-channel probe**: decodes a chunk of the file via `AudioContext.decodeAudioData` (up to 5MB chunk, falls back to full decode up to 150MB) and heuristically judges whether a 2-channel file looks like **one speaker per channel** rather than an ordinary stereo mix (>60% of "someone's talking" time has only one channel active). 3+ channels are always treated as separate speakers without the heuristic.
3. If it looks like separate-speaker channels, `MultiChannelDialog` offers: "Use channels as speakers" (`channelSplit: true`, skips pyannote diarization entirely) or "No, detect speakers automatically" (normal diarization).
4. `TranscribeOptionsDialog` opens next (full option list in §3.3).
5. On confirm: mints a fresh `uuidv4()` conversation id client-side, builds `FormData` (`file`, `conversationId`, `endpoint`, optional `agent_id`, `options` as a JSON string), calls `useTranscribeAudioMutation()` → `POST /api/transcribe` (20-minute axios timeout, real byte-level upload progress).
6. UI shows upload progress (`Uploading… N%`), then an **indeterminate elapsed-seconds counter** ("Processing recording… (Ns elapsed)") for the transcription phase — there is no real progress signal once the upload itself completes.
7. On error: shows the server's own diagnosis text if present (e.g. "No speech could be detected in this recording...") with "Try again" / "Choose a different file".
8. On success: navigates (`replace: true`) to `/audio-transcriber/:conversationId`, force-enables `file_search` on the conversation's ephemeral agent.

### 3.3 `TranscribeOptionsDialog.tsx` — every configurable option

Two-step wizard, reused for both initial upload and Re-transcribe (seeded with prior options).

**Step 1 — main settings:**
| Option | Control | Notes |
|---|---|---|
| Transcription model | Dropdown: Auto, Tiny, Small, Medium, Large v2, Large v3, Large v3 Turbo | List hand-kept in sync with the server's `_ALLOWED_WHISPER_MODELS` allowlist. |
| Spoken language | Dropdown: Auto-detect + 20 languages | en, es, fr, de, it, pt, nl, ru, zh, ja, ko, ar, hi, tr, pl, sv, vi, th, id, uk. |
| Include timestamps | Toggle, default on | Controls `[start-end]` prefix in formatted lines (client-side formatting decision, not sent to the Python service). |
| Include speaker labels (diarize) | Toggle, default on | Hidden when channel-split is active. |
| Transcribe numbers as digits | Toggle | Inverse of `suppressNumerals`; default from server's `default_suppress_numerals`. |
| Number of speakers | Free-text numeric input | Placeholder "Auto (recommended)"; clamped client-side to server's `max_speakers` (default fallback 8); blank means fully automatic detection, a number means an exact known speaker count (`speakerCount`) — there is no min/max range, by design. Hidden when channel-split active. |
| "If speakers get mixed up" (grouping) | Dropdown, 3 presets → `clusteringThreshold` | "Merge similar voices" = 0.72, "Balanced" = unset (server default), "Tell voices apart more" = 0.48. Hidden when channel-split active. |

When channel-split was accepted, a note replaces the diarize/speaker-count/grouping controls: speakers come from the audio's separate channels automatically.

**Step 2 — hotwords/vocabulary:**
| Option | Control | Notes |
|---|---|---|
| Names, jargon, or terms to expect (`contextTerms`) | Chip-list editor | Type + Enter/Add to add a chip, ✕ to remove, "Clear all". Joined as a comma-separated string before sending. Server-suggested terms (`transcribeConfig.suggested_terms`) show as dashed "+ term" add-back chips and auto-seed the list on first open. |

### 3.4 Step 2 — Workspace (`Workspace.tsx` + `TranscriptPanel.tsx`)

Two-pane resizable split (`react-resizable-panels`): left pane is the **real, unmodified `ChatRoute`** (reused wholesale — the conversation already exists by render time); right pane is `TranscriptPanel` (transcript + audio player). Transcript pane hidden entirely below 767px width; capped at 70% max width; both panes have a 320px minimum. The audio player is portaled into a DOM node inside the chat pane (above `ChatRoute`) so its width tracks the resizable chat-pane width.

#### Transcript parsing
Fetched as plain-text file preview and parsed client-side with a regex matching `[start-end] Speaker N: text` per line. This regex (`LINE_PATTERN`) is a **hard contract** with the exact line format the Node backend writes (`formatLine` in `api/server/services/Transcription/index.js`) and must stay in sync with the equivalent parser used server-side for corrections (`packages/api/src/transcription/corrections.ts`).

#### Header actions
- **Define Speakers** → `SpeakerRosterModal` (bulk rename; shown once ≥1 speaker exists).
- **Re-transcribe** → reopens `TranscribeOptionsDialog` pre-seeded with the options that produced the current transcript; calls `useRetranscribeAudioMutation`. **Wipes all existing corrections server-side** (see §5.3) — a real data-loss trap worth calling out to users.
- **Export** dropdown → Plain text (.txt, client-side only), Interview transcript (.docx), Meeting minutes (.docx) — both docx formats round-trip to the server.

#### Transcript rows (`TranscriptRow.tsx`)
Per line: play/pause button (bounded to that line's own time span, uses `requestAnimationFrame` not the throttled `timeupdate` event, for precise stop), click-to-edit timestamp (tenths-of-a-second precision), speaker chip/dropdown (color keyed to speaker **id**, not display name, specifically so renames can't cause color collisions — duplicate names are actively blocked for the same reason), auto-resizing editable text (commits on blur).

**Insert missed dialogue**: right-click anywhere → "Insert dialogue above/below" → drops an editable draft row with a **fractional `lineIndex`** (e.g. `4.5` between lines 4 and 5) computed via `computeInsertionSlots`, so existing corrections never need renumbering. Blank drafts are silently discarded.

#### Corrections model (append-only, server-persisted, forensic-audit design)
All edits go through a `TTranscriptCorrection` log, replayed client-side (last-write-per-key-wins) into: speaker names, per-line speaker reassignment, per-line text, per-line time, inserted lines. Five typed mutations (`client/src/data-provider/AudioTranscriber/mutations.ts`): rename speaker, reassign segment, edit text, edit time, insert line. Explicitly backend-persisted with real user attribution (not device-local) because "a forensic reviewer's changes need to survive across devices and reviewers and carry a real who/when." **The original pipeline output is never mutated** — always recoverable underneath any correction.

#### `SpeakerRosterModal.tsx`
Bulk rename with per-speaker play-preview, duplicate-name blocking (case-insensitive), "Add New Speaker" for one the pipeline missed. Nothing sent to the server until "Save Changes".

#### Audio player (`TranscriptHeader.tsx`)
Fully custom transport around a real `<audio>` element: real client-decoded waveform (Web Audio API, 120 loudest-sample-per-bucket peaks, not RMS), click/drag-to-seek with hover tooltip, ±10s skip, speed menu (0.5×–2×), volume/mute, collapse toggle, global keyboard shortcuts (Space, ←/→, `[`/`]`, `0`) when focus isn't in an editable field. Any interaction with the main transport clears a row's single-line bounded-playback boundary.

#### Export flows
- **.txt** — fully client-side (`Blob` + `<a download>`), no server round-trip.
- **Interview transcript (.docx)** — two-step wizard: (1) per-speaker witness checkbox + last name + role-for-non-witnesses; (2) case name, interview type, location, date, time commenced/completed (validated commenced < completed). Server independently re-derives the corrected transcript from the correction log — never trusts client-sent text.
- **Meeting minutes (.docx)** — single screen: meeting title (pre-filled from conversation title) + date. Attendees are every named speaker, listed automatically server-side.

### 3.5 Panel states
Loading (spinner) · Convo error (retry button) · Transcript processing failed (shows server's `previewError`) · Empty ("No transcript yet") · Populated (row list).

### 3.6 Data-provider layer

**Queries** (`client/src/data-provider/AudioTranscriber/queries.ts`):
- `useTranscriptCorrectionsQuery(transcriptFileId, conversationId)` → `GET /api/transcript-corrections/:transcriptFileId?conversationId=...`
- `useTranscribeConfigQuery()` → `GET /api/transcribe/config`, `staleTime: Infinity`

**Mutations** (`.../mutations.ts`):
- `useTranscribeAudioMutation` → `POST /api/transcribe`
- `useRetranscribeAudioMutation` → `POST /api/transcribe/:conversationId/retranscribe`
- `useExportInterviewDocxMutation` → `POST /api/transcribe/:conversationId/interview-docx` (returns Blob)
- `useExportMeetingMinutesDocxMutation` → `POST /api/transcribe/:conversationId/meeting-minutes-docx` (returns Blob)
- `useRenameTranscriptSpeakerMutation` / `useReassignTranscriptSegmentMutation` / `useEditTranscriptTextMutation` / `useEditTranscriptTimeMutation` / `useInsertTranscriptLineMutation` → the five correction endpoints under `/api/transcript-corrections/:transcriptFileId/...`

### 3.7 Key shared types (`packages/data-provider/src/types/files.ts` and siblings)
- **`TTranscribeOptions`**: `includeTimestamps?`, `diarize?`, `speakerCount?`, `clusteringThreshold?`, `language?`, `contextTerms?`, `model?`, `suppressNumerals?`, `channelSplit?` — all optional; absence = server default.
- **`TTranscribeConfig`**: server's effective defaults (`models`, `default_model`, `default_language`, `default_suppress_numerals`, `default_clustering_threshold`, `hotwords_configured`, `suggested_terms`, `max_speakers`).
- **`TTranscribeResponse`**: `conversationId`, `segments` (stripped of forensic detail), `language`, `diagnostics`, `sourceFile`, `transcriptFile`, `diarizationDetailFile`.
- **`TTranscriptSegment`** (plain) vs the richer diarization-detail-only fields (`words`, `assignmentMethod`, `assignmentDistanceS`) — kept out of normal responses to keep payloads small.
- **`TSpeakerAssignmentMethod`**: `'overlap' | 'nearest' | 'unknown' | 'channel_split' | 'none'`.
- **`TTranscriptIndexStatus`**: `'not_indexed' | 'stale' | 'indexing' | 'indexed' | 'index_failed'` — RAG-embedding lifecycle for the transcript file.
- **`TTranscriptCorrection`**: the append-only correction record, `type` ∈ `speaker_rename | segment_reassign | text_edit | line_insert | time_edit`.
- **`FileContext`** additions: `transcript_rag` (source audio + transcript text, scoped to one conversation, deleted with it) and `transcript_diarization_detail` (forensic record — never embedded, never shown in UI).

### 3.8 Integration with normal chat UI (all gated by one Recoil flag, `isAudioTranscriberConvo`)
- `AudioTranscriberRedirectGuard` (mounted at app root in `Root.tsx`) prevents `ChatRoute`'s own hydration logic from silently navigating away from `/audio-transcriber/:id` to `/c/:id`, and is the mechanism that recognizes a returning visitor (reload/bookmark) as belonging to this feature by checking for a `-transcript`-suffixed file id on the conversation.
- `FileSearch.tsx` hides the file_search toggle for these conversations (force-enabled, not user-facing).
- `Header.tsx` hides ModelSelector, Presets, BookmarkMenu, etc.
- `ChatForm.tsx` relocates the model picker into the composer (header space too narrow, was truncating "Transcript Assistant").
- `ModelSelector.tsx` overrides the displayed value to "Transcript Assistant" instead of the raw backend model id.
- `MessagesView.tsx` suppresses the "Nothing found" empty-chat placeholder (a fresh transcriber conversation legitimately starts with zero messages).
- `useTextarea.ts` swaps the composer placeholder to "Ask a question about this transcript."

### 3.9 Notable UX gotchas
1. **Re-transcribe wipes all corrections** (line indices no longer address the new text).
2. **No progress signal for transcription/embedding** — only the upload leg has real percentage progress.
3. **Multi-channel detection is a client-side heuristic** on a possibly-truncated decoded chunk — can silently miss on large/undecodable files.
4. **Speaker color is bound to id, not name** — duplicate names are actively blocked.
5. **Export to .txt is client-side; both .docx exports are server-authoritative**, re-deriving corrected text from the stored correction log rather than trusting the client.
6. Switching model/agent from the chat header navigates away from the two-pane workspace to plain `/c/:id` chat (an accepted tradeoff — `file_search` stays forced on via persisted ephemeral-agent state).

---

## 4. Node/Express backend

### 4.1 Route inventory — `api/server/routes/transcribe.js`
Mounted at `/api/transcribe` (`api/server/index.js`). Every route requires `requireJwtAuth`; `configMiddleware` also runs (loads `req.config`/`req.file_id`). **No separate feature flag or interface-permission check** — the feature's only real on/off switch is whether `process.env.RAG_API_URL` is set.

| Route | Purpose |
|---|---|
| `GET /config` | Proxies the Python service's `GET /transcribe/config`. 503 if `RAG_API_URL` unset; 502 on upstream failure. |
| `POST /` | Main upload+transcribe: multer upload (audio/video mimetype filter, 512MB default limit), ffmpeg extracts just the audio track, saves it as a `File` (`context: transcript_rag`), calls `transcribeAndEmbed`, **only then** creates the `Conversation` row, saves transcript + diarization-detail files, attaches all 3 file ids to the conversation, responds with the transcript + file metadata. Full rollback (delete source file + conversation) on any failure; temp files always cleaned up. |
| `POST /:conversationId/retranscribe` | Re-runs against the already-stored source audio (no new upload). Finds the source file id by elimination (transcript id and diarization-detail id are known suffixes; whatever remains is the source — there's a regression test guarding this exact logic against file-array ordering). Reuses deterministic file ids so the transcript/detail records are overwritten, not duplicated. **Deletes existing corrections.** Logs `[RETRANSCRIBE] conversationId=... source=...` and `[RETRANSCRIBE] done conversationId=... segments=... model=...`. |
| `POST /:conversationId/interview-docx` | Generates a legal/forensic interview-format `.docx`. Body `{ form, speakers }`. Loads the corrected transcript server-side (base text + replayed correction log), never trusts client text. |
| `POST /:conversationId/meeting-minutes-docx` | Generates a meeting-minutes `.docx`. Body `{ form, speakers }`. Same server-authoritative correction replay. |

Every conversation-scoped route calls `db.getConvo(req.user.id, conversationId)`, which scopes by owner — a mismatched owner gets `null` back exactly like "not found," never someone else's data.

### 4.2 `api/server/services/Transcription/index.js` — Node → Python bridge

`transcribeAndEmbed({ req, file, sourceFileId, options })`:

**Option forwarding table** (Node option → Python multipart field → send condition):
| Node option | Form field | Sent when | Note |
|---|---|---|---|
| `diarize` | `diarize` | always | default `true` |
| `channelSplit` | `channel_split` | truthy only | disables clustering hints below |
| `speakerCount` | `speaker_count` | `diarize && !channelSplit && != null` | absent = fully automatic; a number = exact known count |
| `clusteringThreshold` | `clustering_threshold` | same | |
| `language` | `language` | truthy only | |
| `contextTerms` | `context_terms` | non-empty after trim | |
| `model` | `model` | truthy only | validated server-side against an allowlist |
| `suppressNumerals` | `suppress_numerals` | whenever not null/undefined, **including explicit `false`** | `false` is a real instruction, not "absent" |
| `includeTimestamps` | *(not sent)* | — | client-side formatting decision only |

- `Authorization: Bearer <short-lived per-request JWT>` (`generateShortLivedToken(req.user.id)`), `timeout: 15 minutes`, `maxBodyLength/maxContentLength: Infinity`.
- If `segments.length === 0` (silent audio): short-circuits with `transcriptFileId: null, embedded: false` — **no embed call made**.
- Otherwise formats each segment via `formatLine(segment, { includeTimestamps, diarize })` → `[mm:ss.t-mm:ss.t] Speaker N: text` (tenths-of-a-second precision, both prefixes independently toggleable), joins with `\n`, computes deterministic `transcriptFileId = ${sourceFileId}-transcript`, calls `embedTranscript`.

`embedTranscript({ req, file_id, filename, text })`:
- Writes text to a temp file, calls `uploadVectors()` → `POST {RAG_API_URL}/embed`.
- **Retries up to 3 attempts**, backoff `[500ms, 1500ms]`. Never throws — returns `false` after exhausting retries (a transient RAG hiccup shouldn't fail the whole request; only the `/transcribe` call itself has no retry — a single 15-minute-timeout request).
- Temp file always cleaned up, win or lose.

### 4.3 `api/server/routes/transcriptCorrections.js` — manual corrections API

Mounted at `/api/transcript-corrections`, `requireJwtAuth` only. Corrections are an **append-only event log**, never edits to the base transcript text — current state derived by chronological replay, last-write-per-key-wins, both client- and server-side.

| Route | Body | Effect |
|---|---|---|
| `GET /:transcriptFileId?conversationId=` | — | Full chronological correction list. |
| `POST /:id/speaker-rename` | `speakerId, fromName, toName` | Renames every line for that speaker id. |
| `POST /:id/segment-reassign` | `lineIndex, fromSpeakerId, toSpeakerId` | Reassigns one line to a different (existing or new) speaker. |
| `POST /:id/text-edit` | `lineIndex, fromText, toText` | Edits one line's text. |
| `POST /:id/time-edit` | `lineIndex, fromSeconds, fromEndSeconds, seconds, endSeconds` | Corrects one line's timing (`endSeconds > seconds` enforced). |
| `POST /:id/line-insert` | `lineIndex(fractional), speaker, text, seconds, endSeconds` | Inserts dialogue the pipeline missed, at a fractional index between neighbors. |
| `GET /:id/index-status?conversationId=` | — | `{ transcriptVersion, indexVersion, indexStatus }` — lets a client poll whether RAG has caught up. |
| `POST /:id/reindex` | `conversationId` | Manually retries a failed/stale re-embed; awaited (only route that blocks on the re-embed). |

Every correction-creating route: (1) appends the event (with real `user`/`tenantId` attribution), (2) marks the transcript `stale` (`transcriptVersion++`, `indexStatus: 'stale'`), (3) **enqueues but does not await** a re-embed (`reembedCorrectedTranscript`) — so a correction feels instant.

**Re-embed queue**: one in-flight re-embed per transcript, strictly chained via a `Map<transcriptFileId, Promise>` — guards against several rapid corrections (e.g. saving a whole speaker-roster rename) racing each other's `/embed` calls, where the *last* POST to land would otherwise win regardless of which read the freshest correction snapshot. On success: `embedded` flips false→true only, never reverts true→false on a later transient failure (an already-successful embed shouldn't retroactively look "gone").

### 4.4 Persistence helpers — `api/server/services/Files/process.js`
- `saveTranscriptFile(...)` — text-only `File` doc (no physical bytes; content lives on the Mongo doc directly), `filepath: transcript://${file_id}`, increments `transcriptVersion` on every save (including plain re-transcribes), advances `indexVersion` only if this save was actually embedded, `indexStatus: embedded ? 'indexed' : 'index_failed'`.
- `saveDiarizationDetailFile(...)` — `text = JSON.stringify(fullForensicDetail)`, `context: transcript_diarization_detail`, `embedded: false` always (never sent to RAG).
- The actual `/embed` POST lives in `api/server/services/Files/VectorDB/crud.js` (`uploadVectors`), called by `embedTranscript`.
- Deletion: `cleanupTranscriptFiles` (in `api/server/routes/convos.js`, not `process.js`) removes transcript-context files, called from the bulk "clear selected"/"delete all" conversation routes — **not confirmed** to run on the single-conversation delete path (worth verifying if that matters to you).

### 4.5 What's persisted where (see §6 for full schema detail)
- `Conversation.transcription` — the effective options/diagnostics used for the run (server-resolved model/suppressNumerals win over the request's, since the request can say "auto").
- `Conversation.files` — exactly 3 entries for a transcribed conversation: source audio, `${id}-transcript`, `${id}-diarization-detail`.
- `TranscriptCorrection` collection — the append-only edit log.

### 4.6 `packages/api/src/transcription/diarizationDetail.ts` — snake_case → camelCase translation layer
Converts the Python service's raw response into the app's typed shapes (`toWordSpan`, `toTranscriptSegment`, `toRecordingProfile`), and provides `stripSegmentDetail` (used before responding to the client — strips `words`/`assignmentMethod`/etc, kept only in the persisted diarization-detail file) and `buildDiarizationDetail` (assembles the full forensic record that gets JSON-stringified and saved, never embedded, never shown in the UI).

---

## 5. Transcription backend — now a standalone service, not `rag_server`

**This section previously documented an in-repo `transcription/` Python package (WhisperX + pyannote) that `rag_server/app.py` imported directly and served from its own `/transcribe` and `/transcribe/config` routes. That package has been removed from this repository.** `rag_server` no longer has any transcription code, routes, or dependencies (`whisperx`, `pyannote.audio`, `pandas`, `scipy` were dropped from `rag_server/requirements.txt`) — it now only serves `/health`, `/embed`, `/query`, `/documents`, `/guidance`, `/text`.

Transcription is served by a separate, standalone Transcription Pipeline service, reached via `TRANSCRIPTION_API_URL` (falling back to `RAG_API_URL` if unset — see `packages/api/src/transcription/endpoint.ts`). The Node bridge (`api/server/services/Transcription/index.js`) talks to it exactly the same way it used to talk to `rag_server`'s `/transcribe`: one synchronous, JWT-authenticated `POST {TRANSCRIPTION_API_URL}/transcribe`, so nothing in §§1-4 or §6 below changed. What that service implements internally (model config, diarization retry, hotwords budgeting, recording-profile heuristics, etc.) lives outside this repository now — its own docs are the source of truth, not this file. The contract it must satisfy from this repo's side is whatever `api/server/services/Transcription/index.js` reads off the response (`segments`, `language`, `diagnostics`, `diarization_turns`, `speaker_embeddings`, `recording_profile`) plus the `TranscriptionConfig` shape `TranscribeOptionsDialog.tsx` expects from `GET /transcribe/config`.

If you're looking for the deep internals this section used to have (diarization clustering retry thresholds, VAD tiers, prompt token budgeting, the speaker-label renumbering rules, recording-profile classification, offline-mode handling) — that's now the standalone service's own documentation, not this repo's.

---

## 6. MongoDB persistence — schema detail

### `Conversation.transcription` (`packages/data-schemas/src/schema/convo.ts`, type `ITranscriptionMeta`)
```ts
{
  model: string;              // server-resolved (diagnostics.model_used), not the request's possibly-"auto" value
  requestedModel: string;     // diagnostics.model_requested
  language: string;           // detected
  diarize: boolean;
  speakerCount: number;       // absent = fully automatic; a number = exact known count
  clusteringThreshold: number;
  includeTimestamps: boolean;
  contextTerms: string;
  suppressNumerals: boolean;  // server-resolved
  channelSplit: boolean;
  diarizationBackend: string; // diagnostics.diarization_backend
}
```
Lets a Re-transcribe start from the options actually used (not the dialog's own defaults) and lets the UI show which model produced the current transcript.

`Conversation.files: string[]` — exactly 3 entries for a transcribed conversation: source audio file id, `${sourceFileId}-transcript`, `${sourceFileId}-diarization-detail`.

### `File` schema additions
- `embedded: boolean` — true only once the transcript's RAG embed succeeds; always false for diarization-detail and source audio.
- `transcriptVersion: number` — increments on every save (plain re-transcribe or correction).
- `indexVersion: number` — the transcriptVersion that was actually successfully embedded; lags `transcriptVersion` while an embed is pending/failed.
- `indexStatus`: `'not_indexed' | 'stale' | 'indexing' | 'indexed' | 'index_failed'`.
- `context`: `transcript_rag` (source audio + transcript) or `transcript_diarization_detail` (forensic record).
- `filepath`: synthetic non-disk URIs for the two text-only records (`transcript://${file_id}`, `transcript-diarization-detail://${file_id}`); real storage path only for the source audio.
- `text`: holds the transcript's markdown body, or the JSON-stringified full diarization-detail object.

### `TranscriptCorrection` collection (`packages/data-schemas/src/schema/transcriptCorrection.ts`)
```ts
{
  transcriptFileId: string;
  conversationId: string;
  user: ObjectId;             // real attribution
  type: 'speaker_rename' | 'segment_reassign' | 'text_edit' | 'line_insert' | 'time_edit';
  // type-specific fields:
  speakerId?, fromName?, toName?;                     // speaker_rename
  lineIndex?, fromSpeakerId?, toSpeakerId?;            // segment_reassign
  fromText?, toText?;                                  // text_edit (+ lineIndex)
  speaker?, text?, seconds?, endSeconds?;              // line_insert (+ fractional lineIndex)
  fromSeconds?, fromEndSeconds?, seconds?, endSeconds?; // time_edit (+ lineIndex)
  tenantId?;
  createdAt; updatedAt;
}
```
Indexes: `{transcriptFileId, createdAt}` (chronological replay), `{conversationId, user, tenantId}`.
Methods: `createTranscriptCorrection` (append only), `getTranscriptCorrections` (sorted oldest-first), `deleteTranscriptCorrections(conversationIds[])` (bulk delete — used both by convo cleanup and by Re-transcribe).

### Correction replay logic (`packages/api/src/transcription/corrections.ts`)
`parseTranscriptText` (must stay byte-for-byte in sync with the client's own line-parsing regex) → `applyCorrectionsToLines` (reassign/text/time/insert, last-write-wins per lineIndex, re-sorts only if there were insertions) → `applySpeakerNames` (renames applied *last*, over whatever speaker id a line ends up with) → either `applyTranscriptCorrections` (plain string, sent to `/embed`) or `applyTranscriptCorrectionsStructured` (structured objects, used by the .docx builders since they need to distinguish speakers programmatically, not just by re-matching a "Speaker N" literal that a rename may have already changed).

---

## 7. Capability summary — what the feature can do

- Upload audio or video; video is demuxed to audio-only before transcription (precise scrubbing without keyframe snapping).
- Automatic language detection, or force one of 20 languages.
- Model choice from tiny to large-v3-turbo, or auto (server default).
- Speaker diarization (pyannote, community-1 model) with optional min/max speaker count hints and adjustable clustering "grouping" behavior (merge vs. split bias), including one automatic retry at a fixed alternate threshold when the recording is statistically flagged difficult.
- **Channel-split mode**: bypass diarization entirely for recordings where each speaker is on their own audio channel (e.g. call recordings) — client auto-detects this and offers it.
- Custom vocabulary/hotwords: per-recording confirmed terms (chips), layered with a deployment-wide glossary, all budget-managed against Whisper's prompt token limit and reported back diagnostically.
- Numeral handling toggle (spelled out vs. digits).
- Optional timestamps in the output text.
- Automatic RAG embedding of the transcript into the conversation, so the user can chat with an LLM about the recording's contents (`file_search`) in a real, full-featured LibreChat conversation alongside it.
- Full manual correction workflow: rename speakers, reassign lines, edit text/timing, insert missed dialogue — append-only, attributed, and automatically kept in sync with the RAG index (debounced/queued re-embed).
- Re-transcribe with previously-used (or new) options against the stored source audio, without re-uploading.
- Export to plain text, or to two structured `.docx` formats (interview transcript with witness/case metadata; meeting minutes with attendees) — both server-generated from the authoritative corrected transcript.
- Offline/air-gapped operation mode for the model-loading layer.
- Diagnostics on every run: what actually happened vs. what was requested (model, language, diarization backend, alignment gaps, hotword/context-term usage, speaker-hint adjustments, retry outcome) plus a purely descriptive "recording profile" (turn-taking statistics + a monologue/conversation/rapid_dialogue/difficult/insufficient_data classification) for QA/audit purposes.
- Offline evaluation tooling (DER scoring) exists for measuring diarization quality against hand-labelled ground truth — a dev/QA tool, not part of the live request path.

---

## 8. Key file index

**Frontend**: `client/src/components/AudioTranscriber/` (`AudioTranscriberPage.tsx`, `UploadStep.tsx`, `MultiChannelDialog.tsx`, `TranscribeOptionsDialog.tsx`, `Workspace.tsx`, `TranscriptPanel.tsx`, `TranscriptRow.tsx`, `TranscriptHeader.tsx`, `SpeakerRosterModal.tsx`, `InterviewTranscriptDialog.tsx`, `MeetingMinutesDialog.tsx`, `README.md`), `client/src/data-provider/AudioTranscriber/` (`queries.ts`, `mutations.ts`, `index.ts`), `client/src/store/agents.ts` (`isAudioTranscriberConvo`).

**Node backend**: `api/server/routes/transcribe.js`, `api/server/routes/transcriptCorrections.js`, `api/server/services/Transcription/index.js`, `api/server/services/Files/process.js` (`saveTranscriptFile`, `saveDiarizationDetailFile`), `api/server/services/Files/VectorDB/crud.js` (`uploadVectors`), `api/server/routes/convos.js` (`cleanupTranscriptFiles`).

**Shared types/logic**: `packages/data-provider/src/types/files.ts`, `interviewTranscript.ts`, `meetingMinutes.ts`, `api-endpoints.ts`, `data-service.ts`; `packages/api/src/transcription/diarizationDetail.ts`, `corrections.ts`, `interviewDocx.ts`, `meetingMinutesDocx.ts`; `packages/data-schemas/src/schema/convo.ts`, `transcriptCorrection.ts`, `file.ts`; `packages/data-schemas/src/methods/transcriptCorrection.ts`.

**Transcription microservice**: standalone service outside this repository, reached via `TRANSCRIPTION_API_URL` (see §5). `rag_server/app.py` only serves `/health`, `/embed`, `/query`, `/documents`, `/guidance`, `/text` now.
