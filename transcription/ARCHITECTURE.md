# Audio Transcriber → Chat Convergence

A staged migration plan for merging the standalone `/audio-transcriber` workspace into the main chat interface.

**Status:** approved, Phase 0 in progress · **Audience:** current developer, future maintainers, reviewers

---

## 1. Why do this at all

The feature currently exists as a parallel universe beside chat: its own route, its own upload screen, its own split-pane shell, and eight conditional forks inside core chat components gated on a single Recoil flag (`isAudioTranscriberConvo`). Those forks live in `Header.tsx`, `ChatForm.tsx`, `ModelSelector.tsx`, `MessagesView.tsx`, `FileSearch.tsx`, `useTextarea.ts`, plus `AudioTranscriberRedirectGuard` mounted at app root.

Scattered conditionals inside upstream-owned files are the single biggest long-term liability in this codebase. They are invisible to anyone reading either the feature or the core component in isolation, and every upstream LibreChat merge risks silently dropping one. The convergence is worth doing primarily because it deletes them, not because the UX is nicer — though it is.

The end state is fewer moving parts, not more:

| Deleted | Replaced by |
|---|---|
| `/audio-transcriber` route + `AudioTranscriberPage.tsx` | normal `/c/:id` |
| `AudioTranscriberRedirectGuard` | nothing — no route to guard |
| `isAudioTranscriberConvo` + 8 consumers | nothing — it's a normal chat |
| `UploadStep.tsx` dropzone | existing composer file upload |
| `Workspace.tsx` bespoke split-pane | generic `ChatPanelHost` |
| source-file-by-elimination lookup + its regression test | explicit `sourceFileId` field |
| forced `file_search` on the ephemeral agent | per-request resource attachment |

---

## 2. Target architecture

```
User drops audio into the normal composer
        │
        ▼
TranscribeIntentDialog  ── "attach as file" ──► existing attachment path
        │ "transcribe"
        ▼
TranscribeOptionsDialog  (unchanged, reused verbatim)
        │
        ▼
POST /api/transcribe  ── returns immediately with a job ──► card renders "queued"
        │
        ▼
Node FIFO queue (max 1 in flight) ──► Python WhisperX service
        │
        ▼
Source File doc updated: status ready | failed
        │
        ▼
TranscriptCard in the message attachment strip
        │ click
        ▼
?panel=transcript&file=<sourceFileId>
        │
        ▼
ChatPanelHost renders TranscriptPanel (right) + audio player (docked above chat)
        │ ✕
        ▼
query params cleared, panel unmounts, full width returns
```

Three properties this buys:

1. The conversation is a normal conversation. No special-casing anywhere in chat.
2. Transcription outlives the request. Close the tab, come back tomorrow, the card is there.
3. The panel is generic. Adding a second panel type later costs a registry entry, not another split-pane.

---

## 3. Design decisions

Recorded here with rationale, because the reasoning is the part that gets lost.

### D1 — Multiple transcripts per conversation

**Decision:** a conversation may hold N recordings.

**Rationale:** once audio upload lives in the composer, the only way to enforce one-per-conversation is to block a second upload, which is confusing in a chat. Interview workflows also legitimately span multiple recordings (part 1 / part 2, or two interviewees in one case file). Designing for N costs one schema change now; retrofitting it later costs a migration on live forensic data.

**Cheaper alternative if you reject this:** enforce one-per-conversation, keep `Conversation.transcription` as-is, and skip §4.1 and §4.2 entirely. Everything else in this plan still applies. This roughly halves the backend work. It is a defensible choice, but it must be a deliberate one, enforced with a real error message, not an accident of the data model.

**Status: resolved 2026-09-03 — multiple recordings per conversation.** The full `File`-level schema in §4.1/§4.2 is built as documented.

### D2 — The card is an attachment, not a message

**Decision:** `TranscriptCard` renders in the attachment strip of the user message that carried the upload. It is never a synthetic assistant message.

**Rationale:** a real message row gets caught by edit, branch, regenerate, and delete, and it gets serialised into LLM context on every turn. Someone will spend a week in 2028 wondering why deleting a message deletes a transcript. Attachment-strip rendering derives from file metadata and has none of these interactions.

### D3 — Transcription state lives on the source audio File doc

**Decision:** job status, error, requested options, and effective options go on the source audio file. The transcript file is created only on success.

**Rationale:** the card must render the instant the upload lands, before any transcript exists, and must render a failure state where no transcript will ever exist. Anchoring to the source file is the only shape where the card always has something to read.

### D4 — Job state in Mongo; job dispatch matched to actual deployment topology

**Resolved 2026-09-03.** An earlier draft argued for a purely in-process job model on "avoid new infrastructure" grounds, then a revision argued the opposite — that this codebase's existing `packages/api/src/cluster/LeaderElection.ts` and Redis-backed job/stream layer (`RedisJobStore`, `RedisEventTransport`, `GenerationJobManager`) meant Redis was already a deployment requirement and the target was plausibly multi-instance.

Neither guess was reliable, because it isn't a fact derivable from the application code — `api/server/experimental.js`'s `CLUSTER_WORKERS` is a **test-only** entrypoint that simulates multi-pod behavior; it says nothing about production. Confirmed directly with the deployment owner instead: **this application is installed exclusively per user/organization — one Node process, one Python WhisperX service per installation. The only shared component across installations is the LLM.** There is no cluster to coordinate dispatch across.

**Decision:** split the two concerns, as originally proposed, but resolve dispatch to the simple case:

- **Job state** (status, error, options, heartbeat, timings) persists on the source `File` doc in Mongo. This is topology-independent and stays regardless: it's what makes a card survive a closed tab or a process restart, and it's cheap.
- **Job dispatch** is an in-process FIFO, capped at 1 concurrent job. See D5.

The Redis-job-store and leader-election routes considered in the intermediate draft are **not needed** and should not be built for this topology — they would add a new distributed-lock primitive (or a dependency on `LeaderElection` semantics) with no correctness benefit here, which is exactly the kind of unneeded complexity D4 was trying to avoid from the start.

**If this ever changes** — a future deployment mode that does run multiple Node instances against one shared Python service — this decision must be revisited before enabling that topology. The failure mode if it silently drifts: two instances each believe they're capping concurrency at 1, and both dispatch into the same Python singleton's locks at once, exactly as the intermediate draft diagnosed.

### D5 — Exactly one dispatcher, in-process

**Decision:** dispatch to the Python service is a single in-process FIFO (max 1 job in flight), matching D4's resolution.

**Rationale:** the Python service is a process-wide singleton with one resident ASR model and three locks (`_lock`, `_options_lock`, `_diarize_lock`). In a single-instance deployment, a per-process cap of 1 in flight already caps everything that needs capping — there is no second instance to also be capped. This is the original design, confirmed correct once the topology question (§11) was actually answered rather than assumed in either direction.

Still stamp an `instanceId` on the job record alongside the heartbeat, even though there is currently only ever one instance: it's nearly free, it keeps job records self-describing for log correlation, and it means a future move to a shared-service topology only requires re-adding the coordination layer, not re-deriving the schema.

### D6 — Replace the audio-player DOM portal with a layout slot

**Decision:** the player still docks above the chat pane as it does today, but via a declarative slot in the chat layout, not `createPortal` into a queried DOM node.

**Rationale:** portalling into a node rendered by a sibling component is mount-order dependent. It works today because `Workspace` controls both sides. In converged chat, the target node's existence is no longer guaranteed at the same tick.

---

## 4. Data model

### 4.1 Source audio File doc — new fields

```ts
transcription?: {
  status: 'queued' | 'transcribing' | 'ready' | 'failed';
  jobId: string;                     // uuid, for log correlation
  instanceId: string;                // which process holds it (see D5) — currently always the one instance
  heartbeatAt: Date;                 // updated while transcribing
  startedAt?: Date;
  completedAt?: Date;
  error?: string;                    // server diagnosis text, shown on the card
  requestedOptions: TTranscribeOptions;
  effectiveOptions?: ITranscriptionMeta;  // server-resolved; seeds Re-transcribe
  transcriptFileId?: string;
  diarizationDetailFileId?: string;
  durationS?: number;
  speakerCount?: number;
}
```

### 4.2 Transcript File doc — new field

```ts
sourceFileId: string;   // explicit back-reference; replaces by-elimination lookup
```

Deterministic ids stay as they are (`${sourceFileId}-transcript`, `${sourceFileId}-diarization-detail`) so Re-transcribe still overwrites rather than duplicating.

### 4.3 Deprecations

`Conversation.transcription` is marked `@deprecated` in Phase 1, dual-read for one release, dropped in Phase 6. `Conversation.files` loses its "exactly 3 entries" invariant.

### 4.4 Migration script

`api/migrations/2026-xx-transcription-to-file.js`

- Idempotent: skips any source file that already has `transcription.status`.
- Dry-run mode (`--dry-run`) printing counts before writing.
- For each conversation with `transcription` set: locate the source file via the existing elimination logic (still correct for legacy 3-file conversations), copy `Conversation.transcription` into `File.transcription.effectiveOptions`, set `status: 'ready'`, set `sourceFileId` on the transcript doc.
- Logs every conversation it could not resolve rather than guessing. Those get a manual list.
- Reversible: a `--rollback` path that clears the new fields, since the source of truth is untouched until Phase 6.
- Iterates tenant-scoped. `tenantId` appears throughout this schema family; a migration that iterates globally will either cross tenant boundaries or silently skip records in a tenant-filtered query, depending on which connection it borrows. Takes `--tenant` explicitly, defaults to all tenants, reports per-tenant counts so a partial run is legible.
- Runs as a one-shot job, not on application boot.

---

## 5. Backend changes

### 5.1 `POST /api/transcribe` becomes asynchronous

Current: multer → ffmpeg → save source file → `transcribeAndEmbed` (up to 15 min) → create conversation → respond.

Target:

1. multer → ffmpeg → save source file with `transcription.status = 'queued'`.
2. Respond immediately with `{ fileId, status: 'queued' }`.
3. Enqueue the job on the Node FIFO.
4. Worker sets `transcribing`, heartbeats every 30s, calls the Python service, then on success saves transcript + diarization-detail files, embeds, sets `ready`; on failure sets `failed` with the server's diagnosis text.

The rollback semantics change: there is no conversation to delete. Failure is a persisted state on the file, and the card offers Retry.

**Precise statement of the failure mode being fixed** (an earlier draft got this wrong): `embedTranscript` already retries three times with backoff and never throws. A failed embed is not the problem — it leaves `indexStatus: 'index_failed'` with the conversation, transcript, and source audio all intact. What discards the uploaded audio today is the route-level rollback block, which fires on any rejection out of `transcribeAndEmbed`: an ASR failure in the Python service, a network failure reaching it, a timeout, or a Mongo write failure while persisting the results. Those are the cases where a user waits fifteen minutes and gets back nothing, including their upload. Persisting the audio at upload time and making failure a retryable state fixes all of them.

### 5.2 New / changed routes

| Route | Change |
|---|---|
| `POST /api/transcribe` | returns immediately; no longer creates the conversation |
| `GET /api/transcribe/status?fileIds=a,b,c` | new — batch poll for cards in the open conversation |
| `POST /api/transcribe/:sourceFileId/retry` | new — re-enqueue a failed job with the same options |
| `POST /api/transcribe/:sourceFileId/retranscribe` | rekeyed from `:conversationId` |
| `POST /api/transcribe/:sourceFileId/interview-docx` | rekeyed from `:conversationId` |
| `POST /api/transcribe/:sourceFileId/meeting-minutes-docx` | rekeyed from `:conversationId` |
| `/api/transcript-corrections/*` | unchanged — already keyed by `transcriptFileId` |

Ownership scoping must move with the rekeying. Every rekeyed route now needs an explicit `file.user === req.user.id` **and tenant-scoped** check, because `db.getConvo(req.user.id, ...)` was previously doing that work implicitly, and `TranscriptCorrection` and siblings already carry `tenantId` behind `applyTenantIsolation` — the replacement check has to match that pattern or it's a downgrade. This is the highest-risk item in the whole plan. See R4.

### 5.3 Reconciliation sweep

```
find files where transcription.status == 'transcribing'
  and transcription.heartbeatAt < now - 3 minutes
→ set status 'failed', error: 'Transcription was interrupted. Retry to resume.'
```

Without this, a process restart mid-job leaves a card spinning forever with no recovery path.

Given the confirmed single-instance topology (D4), this is simpler than the cluster-aware version considered in an earlier draft: there is exactly one process, so there's no "which instance owns this job" ambiguity and no risk of two instances racing the same sweep. It still needs to run on an interval (not just at boot), because a process that has been up for days needs the same protection a freshly-restarted one does.

- Runs on a fixed 5-minute interval, in addition to once at boot (boot-time recovery matters here specifically because a restart is the main way a job gets orphaned).
- The heartbeat interval (30s) and the staleness threshold (3 min) stay at least 4× apart (currently 6×) so a GC pause or a slow write cannot orphan a live job. Assert this relationship in code rather than leaving it as two loose constants.
- If a future deployment mode reintroduces multiple instances, this sweep must be revisited alongside D4/D5 — it currently assumes single ownership of every in-flight job.

### 5.4 Cleanup consolidation

`cleanupTranscriptFiles` currently lives in `convos.js`. **Verified 2026-09-03 (R7):** there is only one conversation-delete route, `DELETE /api/convos` (`api/server/routes/convos.js:146-199`), keyed by `req.body.arg.conversationId` from the request body — the client's `deleteConversation()` call uses this same route for both a single conversation and bulk "clear selected." It already calls `cleanupTranscriptFiles` and `db.deleteTranscriptCorrections` unconditionally on every delete, single or bulk. There is no separate per-id route that bypasses it. The originally-suspected gap does not exist.

Given that, `deleteConversationCascade(userId, conversationId)` is now a pure consolidation/clarity refactor rather than a bug fix — worth doing anyway so the question "does every delete path clean up transcripts" is structurally unaskable in the future (one function, one test, used by both delete routes), but it is not blocking.

---

## 6. Frontend changes

### 6.1 Upload interception

In the composer's file handler: if mimetype matches `audio/*` or `video/*`, open `TranscribeIntentDialog` before the normal attachment path.

- If the current endpoint cannot accept audio as an attachment anyway, skip the fork and go straight to options.
- Mixed drops (2 audio + 1 PDF): non-audio proceeds normally; audio files queue one options dialog with an "apply to all N recordings" checkbox.

### 6.2 Server-side channel probe

Move the multi-channel detection off the client. It currently decodes a possibly-truncated 5MB chunk in `AudioContext` and can silently mis-detect on large files. `channels.py` already has `probe_channel_count` via ffprobe. Add `GET /api/transcribe/probe/:fileId` called after upload, before the options dialog resolves. Deterministic, no size ceiling, and it removes a chunk of browser code.

### 6.3 `ChatPanelHost`

```ts
const PANELS = { transcript: TranscriptPanel } as const;
type PanelType = keyof typeof PANELS;
```

- URL-driven: `?panel=transcript&file=<sourceFileId>`. Reload and shared links land in the same place.
- One panel open at a time. ✕ clears the query params.
- Resizable, 320px minimum both sides, panel capped at 70% (matching current behaviour).
- Below 767px the panel becomes a full-screen overlay, not hidden. Today the transcript pane vanishes entirely under 767px, meaning the feature silently does not exist on a phone. Fix this during the move rather than porting the bug.
- Unresolvable file param (deleted, failed, not owned) closes the panel with a toast instead of rendering an error state.

### 6.4 `TranscriptCard`

| Status | Card shows |
|---|---|
| queued | filename, "Waiting to transcribe · 2nd in queue" |
| transcribing | filename, elapsed seconds, model in use |
| failed | filename, server diagnosis text, Retry and Remove |
| ready | filename, duration, speaker count, model, Open transcript |

Polling: while any card in the open conversation is non-terminal, batch-poll `GET /api/transcribe/status` every 3s, backing off to 10s after two minutes. Stop entirely when the tab is hidden; resume on focus.

---

## 7. Risk register

Each risk carries a concrete mitigation and the phase that lands it.

| # | Risk | Impact | Mitigation | Phase |
|---|---|---|---|---|
| R1 | Line-format contract drift across the three parsers (`formatLine`, client `LINE_PATTERN`, `corrections.ts`) | Critical — silently corrupts every correction replay; forensic integrity claim fails | One canonical format module in `packages/data-provider`, imported by all three consumers instead of each defining its own regex; round-trip contract test | 0 |
| R2 | ~~Process restart mid-job leaves card spinning forever~~ — **done 2026-09-03.** Heartbeat + reconciliation sweep (§5.3), wrapped in `runAsSystem` per the `sweepOrphanedPreviews` precedent. | — | — | 2 |
| R3 | Re-transcribe wipes corrections | High — a chat may hold hours of correction work | Confirmation dialog naming the exact count to be lost; soft-delete corrections with `supersededAt` so they remain recoverable in the DB | 0 |
| R4 | ~~Ownership regression when routes rekey from `:conversationId` to `:sourceFileId`~~ — **done 2026-09-03**, with one honest caveat. `findOwnedSourceFile`/`assertOwnsSourceFile` (`transcribe.js`) are shared *helper functions*, not Express middleware as originally envisioned - functionally equivalent (one implementation, every rekeyed route goes through it) but worth knowing if you go looking for a middleware layer and don't find one. Tenant-scoping is inherited from `applyTenantIsolation` on the `File` model + ALS context, not a bespoke check here. 6 wrong-*user* negative tests were written and pass; a wrong-*tenant*-same-request test was **not** added (would need to simulate two ALS tenant contexts in one test) - that guarantee currently rests on `packages/data-schemas`'s own `tenantIsolation.spec.ts`/`tenantIsolation.coverage.spec.ts`, not on anything in this route's own suite. | — | — | 2 |
| R5 | ~~Concurrent jobs contend on the Python singleton's locks and time out~~ — **done 2026-09-03.** In-process FIFO, max 1 in flight (D5), plus the explicit tenant-context re-entry fix (see Phase 2 notes) for the cross-request execution model this uncovered. | — | — | 2 |
| R6 | `file_search` unavailable on the user's chosen endpoint | Medium — transcript silently unqueryable | **Moot for Phase 4's composer path** — see R14; the standalone page's flow (which does force `file_search` on) still carries this risk unmitigated. Capability check/banner remains open. | 4 |
| R7 | ~~Orphaned files on single-conversation delete~~ — **refuted 2026-09-03.** There is only one delete route and it already handles both cases. | — | No action needed. `deleteConversationCascade` (§5.4) proceeds anyway as a clarity refactor. | — |
| R8 | ~~Diarization-detail JSON approaches the 16MB BSON document limit on very long recordings~~ — **done 2026-09-03.** `saveDiarizationDetailFile` guards at 14MB, falls back to real file storage past that. | — | — | 1 |
| R9 | ~~Client channel-detection heuristic mis-fires~~ — **done 2026-09-03.** Server-side ffprobe (§6.2) for the channel *count*; the "does this look like separate speakers" content heuristic was removed rather than replicated server-side (ffprobe can't answer it from metadata, and it was the mis-firing part to begin with) — any `channelCount > 1` now asks the user directly. | — | — | 4 |
| R10 | ~~Panel file param points at a deleted file~~ — **done 2026-09-03.** `onUnresolvable` (§6.3) - a `?file=` mismatch closes the panel with a toast rather than an in-panel error. | — | — | 3 |
| R11 | Two tabs on one conversation show divergent correction state | Low — display only, no data loss (log is append-only) | Invalidate corrections query on window focus; compare `transcriptVersion` | 3 |
| R12 | ~~Migration run twice or partially~~ — **done 2026-09-03.** `config/migrate-transcription-to-file.js`: idempotent (tested), `--dry-run`, `--rollback` guarded by a migration-only sentinel. | — | — | 1 |
| R13 | ~~Upstream LibreChat merge drops a core-file fork~~ — **done 2026-09-03.** Convergence removed the special-casing in all 6 real core-chat consumers (Header, ModelSelector, ChatForm, MessagesView, useTextarea, FileSearch) - they now carry zero feature-specific code, so there is no fork left in them to drop. README touch-point index (§ this file) rewritten to match. | — | — | 5 |
| R14 | Mutating the user's persisted agent config to force `file_search` | Medium — surprises the user in unrelated chats | **Partially done 2026-09-03.** The composer path never calls `updateEphemeralAgent(..., { file_search: true })` at all, so the regression can't happen from this entry point — but that also means a composer-transcribed file isn't file-search-retrievable by default, a known accepted gap, not the originally-envisioned "attach as a per-request resource" fix. The standalone page's unconditional force-on is unchanged. | 4 |

---

## 8. Invariants and contract tests

These are the artifacts that make the system survive without a maintainer. Each is a test that fails loudly, named so the failure explains itself.

| # | Invariant | Test |
|---|---|---|
| I1 | Transcript line format round-trips identically through all three parsers | `transcript-line-format.contract.test.ts` — property test over generated segments incl. unicode names, colons in text, negative-adjacent timestamps |
| I2 | Original pipeline output is never mutated; corrections are additive only | `corrections-are-additive.test.ts` — apply every correction type, assert base `File.text` byte-identical |
| I3 | Every transcript file resolves to exactly one source file without inference | `transcript-source-link.test.ts` — incl. a conversation with 3 recordings and 2 unrelated attachments |
| I4 | Deleting a conversation removes all transcript-context files, on every path | `delete-cascade.test.ts` — parameterised over every delete route |
| I5 | `embedded` never transitions true → false | `embed-monotonic.test.ts` |
| I6 | Correction replay is deterministic regardless of arrival order | `replay-determinism.test.ts` — shuffle the log, assert identical output |
| I7 | Message history never contains synthetic transcript messages | `no-synthetic-messages.test.ts` — assert conversation payload sent to the LLM contains no card-derived content |
| I8 | A queued or transcribing job always reaches a terminal state | `job-terminality.test.ts` — kill the worker mid-job, run reconciliation, assert `failed` |

I1, I4, and I7 are the three that would cause silent, unrecoverable damage. Treat them as release blockers.

---

## 9. Phased rollout

Every phase is independently shippable and independently revertible. No phase leaves the system in a state that requires the next phase to be correct.

### Phase 0 — Safety net and fact-finding (no user-visible change) — **in progress**

Contract tests I1, I2, I5, I6. `deleteConversationCascade` + I4. Correction soft-delete. Re-transcribe confirmation dialog.

Two verification tasks that gated later phases:

- ✅ **Trace the single-conversation delete path (R7).** Refuted — see §5.4. No separate path exists.
- ✅ **Establish the deployment topology (D4/D5).** Resolved — single Node instance, single Python service per installation, confirmed directly with the deployment owner 2026-09-03. See §3 D4.

Ships alone. Improves the current system whether or not the rest of this plan happens.

### Phase 1 — Data model (no user-visible change) — **done 2026-09-03**

New `File` fields. Migration with dry-run. Dual-read (`File.transcription` first, fall back to `Conversation.transcription`). Diarization-detail size guard. Revert = stop reading the new fields. Old path still intact.

**Delivered:**
- `IFileTranscriptionJob` (`packages/data-schemas/src/types/file.ts`) + matching Mongoose sub-schema on `File` (`transcription`, `sourceFileId`) - additive, `Conversation.files`'s old "exactly 3 entries" invariant untouched.
- `Conversation.transcription`/`ITranscriptionMeta` marked `@deprecated` in both the type and the schema comment.
- Both write paths (`POST /api/transcribe`, `POST /:conversationId/retranscribe`) now dual-write: `transcription` state onto the source `File` (via `buildSourceFileTranscriptionState`) and `sourceFileId` onto the transcript `File` (via `saveTranscriptFile`'s new param), alongside the existing `Conversation.transcription` write - so every conversation transcribed from this point on already carries both fields, needing no backfill.
- `config/migrate-transcription-to-file.js` - backfills historical conversations. Idempotent, `--dry-run`, `--tenant=<id>` (via `tenantStorage`/`runAsSystem`, matching `migrate-orphaned-agent-files.js`'s established convention), `--rollback` (guarded by a `MIGRATION_INSTANCE_ID` sentinel so it only undoes what the migration itself wrote, never a live route's write). 7 tests, `config/__tests__/migrate-transcription-to-file.spec.js`.
- `resolveTranscriptionMeta` (`packages/api/src/transcription/meta.ts`) - the dual-read function itself, tested (5 tests) but **not yet wired into a live route** - that's Phase 2's "route rekeying" (§5.2).
- R8: `saveDiarizationDetailFile` now guards at 14MB and falls back to real file storage (the same strategy used for source audio) instead of the inline `text` field past that size.
- **Real finding, not anticipated in the original plan**: Mongoose's default `minimize` behavior silently strips an empty object (`{}`) from a `Schema.Types.Mixed` field before it's ever persisted - meaning the originally-specified `requestedOptions: {}` for migrated/no-options-requested records never actually survives a save. Fixed by making `requestedOptions` genuinely optional (both in the TS type and the schema, comment explains why) rather than fighting Mongoose to force an empty object to persist - "absent" and "explicitly nothing requested" are the same observable state here, and that's fine. Worth remembering for Phase 2: any other `Mixed`-typed field that might legitimately hold `{}` will have the same behavior.
- D1's own follow-on effect confirmed: since a conversation may now hold multiple recordings, `IFileTranscriptionJob` is deliberately per-source-file, never per-conversation - this was already the shape D3 called for, just confirmed correct in the actual schema.

### Phase 2 — Async job model — **done 2026-09-03**

Transcribe becomes a job. In-process FIFO, heartbeat, reconciliation sweep. Route rekeying with ownership middleware. The existing `/audio-transcriber` page is converted to poll. Landed while the old UI is still the only UI — one variable at a time.

**Delivered:**
- `api/server/services/Transcription/jobQueue.js` — the in-process FIFO from D5, confirmed-correct now that single-instance topology is settled. `enqueueTranscriptionJob`, `getQueueDepth`, `onIdle` (also a real graceful-shutdown drain primitive, not just a test seam). 9 tests.
- `api/server/services/Transcription/reconciliation.js` — `reconcileStaleTranscriptionJobs` (heartbeat/staleness ratio asserted ≥4x at module load) + `startTranscriptionReconciliation` (boot + 5-min interval), wired into `api/server/index.js`'s post-listen init. 5 tests.
- `POST /api/transcribe` rewritten async (§5.1): responds 202 the instant the source file is queued and the conversation exists, instead of blocking up to 15 minutes. `runTranscriptionCore` is the one job implementation shared by upload and retranscribe, transitioning `transcription.status` through `transcribing → ready | failed` via dot-notation `$set` updates so no stage clobbers another's fields.
- New routes: `GET /api/transcribe/status` (batch poll), `POST /:sourceFileId/retry` (re-enqueue a failed job without re-uploading).
- `/retranscribe`, `/interview-docx`, `/meeting-minutes-docx` rekeyed from `:conversationId` to `:sourceFileId` (§5.2), each behind `findOwnedSourceFile`/`assertOwnsSourceFile` — explicit `user`-scoped ownership checks (R4). 6 dedicated ownership-negative tests (wrong user → 404) plus the full happy-path suite; 19 tests total in `transcribe.spec.js`.
- Full regression sweep: 90 tests across `api`'s transcription/convos/corrections suites, 268 in `Files` services, 1378 in `data-provider` (one unrelated pre-existing failure in `balance.spec.ts` — billing date-rollover math, nothing to do with this feature), `packages/api` build clean.

**Real findings caught during implementation, not anticipated in the original plan:**
- **A genuine cross-tenant context leak risk**, caught by reasoning through the queue's execution model rather than by a test: `jobQueue.js`'s `while` loop processes jobs from *different* requests sequentially from one long-lived async chain, whose own `AsyncLocalStorage` context belongs to whichever request originally started the queue - not necessarily the job currently running. Fixed by having `runTranscriptionCore` explicitly re-enter `tenantStorage.run({tenantId, userId}, ...)` from the closed-over `req` before doing anything, rather than trusting ambient context. The callback passed to `tenantStorage.run` has to be declared `async` itself (not just Promise-returning) for the context to actually propagate - documented in place since it's exactly the kind of thing that looks correct and silently isn't.
- **A missing `runAsSystem` wrap** on the reconciliation sweep - found by comparing it against `sweepOrphanedPreviews` (an almost identical `File`-collection sweep already in `api/server/index.js`), whose own comment explains why: `File` is tenant-isolated, and `TENANT_ISOLATION_STRICT=true` rejects any unscoped query from a background task with no request context of its own. Without this, the sweep would have thrown on every run in a strict-mode deployment.
- **A missing `restoreTenantContextFromReq`** on `POST /api/transcribe`'s multer upload chain - the established pattern elsewhere in this codebase (`convos.js`'s `/import` route) for exactly this reason: a multipart parser can cross the async boundary ALS context relies on. Added for consistency and correctness, though the route's existing explicit `user`/`tenantId` params already limited the practical impact.
- **The client mirrored the exact bug the backend already fixed**: `fileIds.ts`'s `splitFileIds` only excluded the `-transcript` suffix, not `-diarization-detail` - with three files per conversation now, it could resolve `sourceFileId` to the diarization-detail file's id depending on array order. Fixed to match the server-side `assertOwnsSourceFile` logic, with a regression test.
- **A test-mock gap masking a real-path issue**: the original `getDownloadStream` mock in `transcribe.spec.js` did a naive `fs.createReadStream(filepath)`, which only worked for hand-seeded absolute-path fixtures. Exercising `/retry` against a file that went through the real upload path surfaced that the mock didn't replicate the real local-strategy's `/images/`-path resolution (against `req.config.paths.imageOutput`) - fixed the mock to match reality. In the process, surfaced a **separate, pre-existing, out-of-scope discrepancy** worth a follow-up: `saveSourceFile`'s local-storage branch (`transcribe.js`) writes under `localPaths.publicPath/images/`, while the real `getLocalFileStream` (`Local/crud.js`) resolves `/images/`-prefixed paths against `req.config.paths.imageOutput` - a different config value than `localPaths.publicPath`. These two are presumed to line up in real deployments but that's unverified; if they don't, `/retranscribe` and `/retry` against a locally-stored (non-S3) source file could fail in production. This predates Phase 2 (retranscribe already relied on the same resolution) - not fixed here, flagged for separate verification.
- **The Mongoose `minimize`/empty-object gotcha from Phase 1** turned out to matter again here: `requestedOptions` on a live-queued job is `options` straight from the request body, which is legitimately `{}` for a caller that requested every default - same "absence reads as no-options-requested" behavior as the migration's historical records, now confirmed to apply on the live write path too, not just the backfill.

**Confirmed not caused by this work**: `api/server/index.spec.js`'s `"Server Configuration"` describe block (which boots the real server against a `MongoMemoryServer`) hangs indefinitely in this sandbox. Isolated by temporarily disabling the reconciliation wiring and re-running - the hang persisted identically, so it predates and is unrelated to Phase 2. Every other Mongo-backed integration test in this session (many, including this same `MongoMemoryServer` pattern) ran in seconds, so it's specific to whatever else that describe block's full boot sequence needs - not investigated further, out of scope.

**Not done in this phase** (deliberately deferred): the actual `TranscriptCard` UI, composer-integrated upload, and `ChatPanelHost` are Phase 3/4 work. `UploadStep.tsx` was updated only enough to work correctly against the new async contract - it still polls from the upload screen and navigates once the job is ready/failed, preserving today's exact UX rather than building out an in-panel "job in progress" state, since `TranscriptPanel` has no such state yet and adding one now would be scope creep into Phase 3/4's actual job.

### Phase 3 — Panel host — **done 2026-09-03**

Build `ChatPanelHost`. Re-implement `Workspace` on top of it with identical UX. Player moves from portal to layout slot. Mobile overlay. Pure refactor. Visual diff should be near-zero.

**Delivered:**
- `client/src/components/AudioTranscriber/ChatPanelHost.tsx` - generic resizable side-panel host, built to the final `?panel=<type>&file=<id>` URL contract from the start even though `Workspace` (still mounted at `/audio-transcriber/:id`) is its only caller today. `PANELS` registry (`{ transcript: TranscriptPanel }`), unknown `?panel` values ignored rather than throwing.
- `client/src/components/AudioTranscriber/panelHostContext.ts` - `PanelComponentProps` and the header-slot context/hook, deliberately split out of `ChatPanelHost.tsx` to avoid a circular module dependency (`ChatPanelHost` imports `TranscriptPanel` for its registry; `TranscriptPanel` needed to import the slot hook back).
- **D6 delivered**: `useChatHeaderSlot` replaces the `createPortal`-into-a-DOM-ref mechanism entirely - a panel contributes its header content (the audio player) as a normal React element via context, not a raw DOM node handoff. No more mount-order dependency between `Workspace` and `TranscriptPanel`.
- **Mobile fix delivered**: below 767px the panel is a full-screen overlay (with a close button) instead of being omitted outright - before this phase the feature silently didn't exist on a phone.
- `Workspace.tsx` re-implemented on top of `ChatPanelHost`: the `hasSetConversation`/hydration-timing logic and the `isAudioTranscriberConvo`/`file_search` wiring (unrelated to panel hosting) are unchanged; the only new piece is a self-correcting effect that ensures `?panel=transcript` is always in the URL, since this route (unlike a future card click) has nowhere else to set it from.
- 25 tests: `ChatPanelHost.spec.tsx` (10), `Workspace.spec.tsx` (2, updated for the new mocking boundary), `fileIds.spec.ts` (3, new - see finding below), plus the pre-existing suite. Full client `tsc --noEmit` clean (one unrelated pre-existing error in `OllamaConfig.tsx`, same as every prior phase).

**Real findings caught during implementation:**
- **A genuine infinite render loop**, only surfaced by actually writing `ChatPanelHost.spec.tsx` and watching React's "Maximum update depth exceeded" fire: `useChatHeaderSlot`'s effect depends on the JSX node's identity, and an unmemoized panel re-render recreates that node every time, re-firing the effect, re-triggering the parent's `setHeaderSlot`, re-rendering the panel - forever. First fix attempt (`React.memo` on the panel component alone) did **not** resolve it, which surfaced a second, deeper issue: `react-router-dom`'s `setSearchParams` is not guaranteed referentially stable across renders, so `closePanel`/`handleResolved`/`handleUnresolvable` (each `useCallback`'d with `setSearchParams` in their deps) were silently recreated every render regardless of the memo, handing the "memoized" panel new props every time and defeating the optimization entirely. Fixed by reading `setSearchParams`/`showToast`/`localize`/`fileParam` through a ref updated on every render instead of closing over them directly, giving all three callbacks a genuinely stable identity for the component's whole lifetime. Documented in place on both `TranscriptPanel.tsx` and `ChatPanelHost.tsx` since it's exactly the kind of thing that looks correct and silently isn't - outside a test, this would have pegged a render loop with no visible symptom beyond battery drain and a warm laptop.
- **The client mirrored a second copy of the same "sourceFileId by elimination" bug** its own `fileIds.ts` docstring already claimed was fixed: `splitFileIds` only excluded the `-transcript` suffix, not `-diarization-detail`. Caught while reasoning through what `ChatPanelHost` needed from `Workspace`, not by a failing test - fixed with a regression test (`fileIds.spec.ts`) mirroring the exact scenario the server-side fix already covers.
- **The `README.md` touch-point index had already drifted**: it still named `TTranscribeResponse`, renamed to `TTranscribeQueuedResponse`/`TTranscribeStatusResponse` back in Phase 2. A small, easy-to-miss reminder of why §10's PR-template checkbox for this file exists.

### Phase 4 — Composer integration — **done 2026-09-03**

Intent dialog, server-side probe, `TranscriptCard`, panel opening from chat. Both entry points live simultaneously; internal users exercise the new one. First user-visible change. Old page still works as an escape hatch.

**Design decision resolved (see plan, `/home/daniel/.claude/plans/breezy-snacking-kahan.md`):** the card attaches via `message.files` (the same client-declared, set-once-at-send mechanism every normal attachment uses) with client-side polling of `useTranscribeStatusQuery`, not `message.attachments` + a backend retroactive-push. Simpler, no new backend primitive, and Phase 2 already built everything the polling side needs.

**Delivered — backend:**
- `packages/api/src/files/probeAudioChannels.ts` (new) — `ffprobe -select_streams a:0 -show_entries stream=channels`, mirrors `extractAudioTrack`'s `child_process.spawn` style and `channels.py`'s `probe_channel_count` fallback (unreadable/zero channels → `1`, never throws).
- `POST /api/transcribe/probe` (new route, `transcribe.js`) — multer-uploads to a temp path, probes, deletes the temp file, responds `{ channelCount }`. No File record, no job queued — deliberately outside the async job model.
- `POST /api/transcribe` — existing-conversation guard: checks `db.getConvo` before writing `title`/`endpoint`/`agent_id`; only a genuinely new conversation gets those written and `conversationCreated = true`. Fixes the real defect the plan flagged going in — unmodified, this route would have silently renamed an ongoing chat to the audio filename (and, on a prep-phase failure, `db.deleteConvos`'d it entirely).
- New types (`packages/data-provider`): `TAudioChannelProbeResponse`; `dataService.probeAudioChannels`, `endpoints.probeAudioChannels`.

**Delivered — frontend:**
- `UploadStep.tsx`'s client-side `probeMultiChannelAudio`/`looksLikeSeparateSpeakerChannels` (Web Audio API decode, a 5MB-chunk/150MB-full-decode size ceiling, an RMS-activity heuristic guessing "does this look like separate speakers") replaced with `probeChannelCount` (new, `AudioTranscriber/probeChannelCount.ts`) calling the server probe. **Behavior simplification, not just a relocation**: the old heuristic tried to distinguish "ordinary stereo mix" from "one speaker per channel" from decoded audio content — something `ffprobe` metadata genuinely cannot answer, and exactly the kind of guess R9 was written to eliminate. The new rule is `channelCount > 1` → always offer the split-by-channel dialog, letting the user (who actually knows their recording) answer the question the heuristic was approximating, with one click to decline for an ordinary stereo file. Removes the `AudioContext` decode path and both size-ceiling constants entirely.
- `TranscribeIntentDialog.tsx` (new) — the transcribe-vs-attach fork, modeled on `MultiChannelDialog.tsx`.
- `Providers/TranscribeIntentContext.tsx` (new) — `TranscribeIntentProvider`/`useTranscribeIntent`, mounted in `ChatView.tsx`. Sequences `TranscribeIntentDialog` → (if multi-channel) `MultiChannelDialog` → `TranscribeOptionsDialog`, resolving `interceptAudioVideo(file, canAttachNatively)` with `{action:'attach'|'cancel'|'transcribe', options?}`. `canAttachNatively=false` (endpoint can't take audio/video as a plain attachment) skips straight to options, per §6.1. Default context value (no provider mounted) resolves `'attach'` — the Builder file panels (`Knowledge.tsx`/`CodeFiles.tsx`, via `useFileHandlingNoChatContext`) never see this provider and degrade to normal attachment behavior rather than crashing.
- `useFileHandling.ts` — `handleFiles`' pre-existing `isImage` branch gained a sibling `maybeInterceptAudioVideo` check: `isAudioOrVideoMimeType(type) && conversation != null` (excludes only the Builder file panels, which have no chat at all — see §12) → asks the provider, and on `'transcribe'` calls `POST /api/transcribe`, either against the *current* conversation (existing chat - composer chip, becomes a `TranscriptCard` on send) or against a freshly minted id (brand-new draft - see §12, closed post-Phase-5).
- `Chat/Messages/Content/Parts/TranscriptCard.tsx` (new) — wraps `FileContainer` with a status-driven `subtitle` (queued/transcribing spinner, failed + Retry via `useRetryTranscriptionMutation`, ready + click-to-open). `Files.tsx` runs *one* batched `useTranscribeStatusQuery` for every audio/video file on the message and routes each to `TranscriptCard` only if it actually has a job (present in the status response) — a plain attached audio/video file (user declined transcription, or the endpoint took it natively) has no `transcription` field server-side and is correctly omitted from that response, so it falls through to the ordinary `FileContainer` branch instead of being misrouted by MIME type alone.
- `ChatPanelHost` mounting consolidated into `ChatRoute.tsx` (was `Workspace.tsx`-only) — `ChatRoute` is the shared component both `/c/:id` and `/audio-transcriber/:id` (via `Workspace`) render, so mounting the host there once, rather than in both `ChatView` and `Workspace`, gives `TranscriptCard`'s "Open transcript" a real `?panel=transcript&file=<id>` target on the plain chat route without double-nesting the resizable-panel host on the standalone page. `Workspace.tsx` no longer renders `ChatPanelHost` itself.

**Deliberately deferred (documented, not silently dropped):**
- §6.1's "mixed drop, apply options to all N recordings" checkbox — this phase handles one audio/video file's interception at a time.
- R3's soft-delete-corrections/confirmation-dialog mitigation — still open from Phase 0.
- R14 — the composer path does **not** call `updateEphemeralAgent(conversationId, { file_search: true })` at all (unlike the standalone page's `UploadStep.tsx`). This sidesteps the regression R14 warns about entirely (nothing gets mutated on an existing conversation's agent config) at the cost of the transcript not being file-search-retrievable by default from this entry point — a real, known functional gap, not an oversight. A tighter per-turn scoping (attach the transcript as a per-request resource rather than a persisted agent-config flag) is the real fix and remains open.
- R6 (file_search unavailable on the endpoint) is consequently moot for this entry point for the same reason.

**Real findings caught during implementation:**
- **Heavy transitive import chain into a load-bearing shared hook.** `useFileHandling.ts` (used by the chat composer, the agent-builder Knowledge/CodeFiles panels, and SharePoint) importing `useTranscribeIntent` pulled in `TranscribeIntentDialog`/`MultiChannelDialog`/`TranscribeOptionsDialog`, all three of which imported `useLocalize` from the `~/hooks` *barrel* rather than `~/hooks/useLocalize` directly. The barrel re-exports `Agents/useAgentToolPermissions` → `~/Providers` → `PromptGroupsContext` → the full `Prompts`/`Markdown`/`Citation` tree, which hit an unrelated `cn` mocking gap in `SourceHovercard.tsx` under Jest — 12 failures in `useFileHandling.test.ts` from a change that never touches rendering. Fixed at the root (all three dialogs now import `useLocalize` directly), not by patching the test's mocks around the symptom.
- **A real race in the dialog-sequencing state machine**, caught only by writing `TranscribeIntentContext.spec.tsx` against the *real* dialog components (not mocks) for the "user picks Transcribe" path: `choiceMadeRef` (distinguishing "a button was clicked" from "Radix dismissed this via Escape/backdrop") was being reset to `false` unconditionally inside the shared `onOpenChange` handler. Radix can invoke `onOpenChange(false)` more than once around a controlled dialog's teardown (the button handler's own state transition, then again as the portal unmounts) — the second, spurious call saw a freshly-cleared flag and wrongly resolved `'cancel'` after a real `'transcribe'` choice had already been made. Fixed by resetting the flag only when a *new* stage opens, not on every `onOpenChange` call.
- **MIME type alone is not enough to route `Files.tsx`'s new branch.** An audio/video file attached via the "Attach as file" decline path, or on an endpoint where `canAttachNatively` skips the fork, is a completely ordinary attachment with no transcription job behind it — routing every audio/video `message.files` entry to `TranscriptCard` by type would show a permanently-spinning "queued" card for a file that was never submitted to `POST /api/transcribe`. Fixed by using the batched `GET /api/transcribe/status` response itself as the routing signal (present → `TranscriptCard`; absent → plain `FileContainer`), accepting a brief self-correcting flash on the very first render while that query is in flight.

### Phase 5 — Cutover — **done 2026-09-03**

`/audio-transcriber/:id` becomes a client-side router redirect to `/c/:id?panel=transcript&file=<id>` — a `<Navigate replace>` in the route table, the same mechanism `AudioTranscriberRedirectGuard` uses today, not an HTTP 301. Delete `isAudioTranscriberConvo` and all 8 consumers, `UploadStep`, `Workspace`, `AudioTranscriberRedirectGuard`, the elimination lookup and its test. The payoff phase. Diff should be overwhelmingly red.

**Scope decision resolved before starting:** the bare `/audio-transcriber` route (no id) - `UploadStep`'s "start a fresh transcription with no conversation open yet" entry point - is dropped outright, not replaced with a composer-flow equivalent. Transcription now starts only from an existing chat's composer (Phase 4), matching how every other file type already works; there's no dedicated "upload a file to start a brand-new chat" affordance for anything else either.

**Delivered:**
- `/audio-transcriber/:conversationId` → `AudioTranscriberRedirect` (new, `routes/index.tsx`), a small component reading `useParams()` and rendering `<Navigate to={`/c/${conversationId}?panel=transcript`} replace>`. No `?file=` in the redirect target - `TranscriptPanel` already resolves it itself via `splitFileIds` for any bare `?panel=transcript` link, so nothing new was needed there.
- Bare `/audio-transcriber` route and its `loadAudioTranscriberView` lazy loader deleted, along with the always-visible "Audio Transcriber" sidebar link that pointed at it (`useSideNavLinks.ts`).
- Deleted outright: `AudioTranscriberPage.tsx`, `UploadStep.tsx`, `Workspace.tsx` (+ its spec), `RedirectGuard.tsx`, the `isAudioTranscriberConvo` atom and `useFlagAudioTranscriberConvo` hook (`store/agents.ts`).
- All 6 real UI consumers of `isAudioTranscriberConvo` had their special-casing removed, not just their imports: `Header.tsx` (model selector/presets/bookmarks/multi-convo/export-menu no longer hidden), `ModelSelector.tsx` (no more "Transcript Assistant" label override), `ChatForm.tsx` (no more composer-embedded model picker), `useTextarea.ts` (no more custom placeholder), `FileSearch.tsx` (toggle no longer force-hidden). Every conversation - including legacy ones created by the standalone page - now gets the exact same chat chrome; there is no more "locked-down transcript workspace" UI mode.
- `useNewConvo.ts`'s `/audio-transcriber/:id` pathname special-case (skipping the forced `/c/:id` navigate) deleted - unreachable now that route never renders `ChatRoute` itself, only redirects into it.
- Orphaned locale keys removed: the `com_ui_audio_transcriber_dropzone*`/`_upload*`/`_processing`/`_model`/`_try_again`/`_choose_different` group (all `UploadStep`-only), `com_ui_transcript_chat_placeholder`, `com_ui_transcript_model_label`.
- README touch-point index (`AudioTranscriber/README.md`) fully rewritten for the post-cutover shape - the six files above are called out as carrying *zero* feature-specific code now, not listed as removal instructions.

**Real findings caught during implementation - two corrections to this plan itself, made before executing it, not after:**
- **`RedirectGuard` did two unrelated things bundled into one component**, and the plan's "delete it" instruction was only correct for one of them. Reading it closely: (1) bounce `/c/:id` back to `/audio-transcriber/:id` - genuinely obsolete once `/c/:id` is canonical, safe to delete - but also (2) force `file_search: true` on for a *returning visitor* to a transcript conversation whose ephemeral agent state hadn't been set yet this session (it's not persisted, so every fresh session/reload needs this re-derived). Deleting the whole file would have silently broken RAG retrieval on next open for every transcript conversation that already exists, with no warning - a real regression against existing user data, not just a decision not to add the same behavior to new composer-created conversations (which was already an accepted, documented gap under R14). Fixed by keeping the second half as a small new component, `EnsureTranscriptFileSearch.tsx`, mounted in `Root.tsx` in `RedirectGuard`'s place - same detection logic (`splitFileIds` against the loaded conversation's files), no navigate, no atom.
- **`fileIds.ts`/`splitFileIds` is not standalone-page-specific and was not safe to delete**, despite the plan listing "the elimination lookup and its test" as a Phase 5 deletion target. That instruction predates Phase 3's actual implementation: `TranscriptPanel.tsx` (built to be generic from the start, transcription/ARCHITECTURE.md §6.3) uses it unconditionally, for *every* conversation opened via `?panel=transcript`, to resolve `sourceFileId`/`transcriptFileId` from the conversation's file list whenever the URL doesn't carry an explicit `?file=` - exactly the case a legacy bookmarked-link redirect now produces. Deleting it would have broken the transcript panel for every such redirect and for `EnsureTranscriptFileSearch`'s own detection. Kept as-is; the plan's own forward-looking text was simply out of date by the time this phase started, corrected here rather than followed blindly.
- **A pre-existing, unrelated bug shared the same "empty conversation" code path** as the transcript-specific carve-out it was hiding behind: `MessagesView.tsx` suppressed the "Nothing found" empty state only when `isAudioTranscriberConvo` was true, with a comment explaining that a real, REST-created, zero-message conversation is a legitimate starting state, not a failed search. That reasoning was never actually specific to transcription - `ChatView.tsx`'s own `isLandingPage` logic already guarantees any conversation reaching `MessagesView` with an empty tree is a real, persisted, non-draft one (a genuinely new draft renders `Landing` instead) - so the same fact holds for *any* REST-created conversation, not just this feature's. Generalized the check (`isRestCreatedEmptyStart`: real id, not `Constants.NEW_CONVO`) rather than deleting it outright, fixing a bug this feature happened to be the only thing exercising rather than reintroducing it as dead-narrow logic.
- Several in-place doc comments elsewhere in the feature (`ChatPanelHost.tsx`, `ChatRoute.tsx`, `TranscriptPanel.tsx`, `TranscribeOptionsDialog.tsx`, `fileIds.ts`) still described `Workspace`/`UploadStep` as live components or `RedirectGuard` as the identity-detection mechanism - updated in place rather than left to rot, since they're exactly the kind of stale-but-plausible-sounding comment that misleads the next reader.

### Phase 6 — Cleanup (one release later)

Drop `Conversation.transcription`, remove dual-read, remove the redirect.

---

## 10. Handover

Written on the assumption that the next person to open this code has no context and no one to ask.

- This file — the three-layer diagram, the request lifecycle, and D1–D6 with rationale intact. Decisions without rationale get reverted by the next person who finds them inconvenient.
- **Touch-point index** — the existing `AudioTranscriber/README.md` lists every core file the feature modifies. After Phase 5 this list should be short. A PR-template checkbox requires it to be updated in the same PR as any core-file change.
- **Uncalibrated constants** — `DIFFICULT_RETRY_CLUSTERING_THRESHOLD = 0.48`, the `_classify` thresholds, and the clustering presets (0.72 / 0.48) are the author's judgement, not measured. Commented as such at the definition site, pointing to `evaluate_diarization.py` as the tool for calibrating them properly against labelled data.
- **Environment surface** — every `WHISPERX_*` variable, `RAG_API_URL` as the feature's only on/off switch, the HF token requirement for diarization, and the offline-mode behaviour.
- The contract tests are the documentation that cannot go stale. Prose drifts; I1–I8 do not.

---

## 11. Open questions

1. ~~**Deployment topology.**~~ **Resolved 2026-09-03** — single Node instance, single Python WhisperX service, one exclusive installation per user/organization. Only the LLM is shared across installations. See D4.
2. ~~**D1 or its alternative?**~~ **Resolved 2026-09-03** — multiple recordings per conversation. See D1.
3. **Retention.** Does the organisation have a retention policy for source audio? If evidential audio must be preserved beyond conversation deletion, `deleteConversationCascade` needs an archive path rather than a delete, and that changes Phase 0.
4. Do existing transcriber conversations need to keep working during Phases 4–5, or can a maintenance window migrate them? Affects whether the redirect is temporary or permanent.

---

## 12. Post-Phase-5 hotfixes — 2026-09-03

Two real, user-reported production bugs surfaced immediately after Phase 5 shipped, both direct consequences of gaps this document had already flagged as deferred/deliberate. Documented here rather than folded silently back into the phase write-ups above, since they were found from actual usage, not from continuing the plan.

**1. Composer audio/video uploads could 415 through the OCR/RAG pipeline.** A file attached via the "Attach Files" menu item (formerly labelled "Upload to Provider," renamed to match `com_sidepanel_attach_files`'s existing tooltip text) on a provider without native audio/video support fell through to `EToolResources.context` (OCR/text/STT parsing) instead of a plain attachment — `parseText` choked on raw video bytes with a 415, then a second fallback path hit the 15MB extracted-text storage limit. Root cause: `AttachFileMenu.tsx`'s `fileTypeCapabilities` only granted audio/video picker access to Google/OpenRouter's variant (`image_document_video_audio`); every other provider's variant (`image_document`, `image_document_extended`) excluded it, both in the dynamic `getConfiguredMimeAccept` path and the static fallback `accept` strings used when no admin `supportedMimeTypes` override is configured (the common case). Fixed by adding `'audio', 'video'` to all three variants' categories - the server's default `supportedMimeTypes` already includes them, so this was purely a client-side gap. This button explicitly sets `tool_resource: undefined`, so widening it routes audio/video as a plain attachment, bypassing the OCR pipeline entirely regardless of provider.

**2. Dropping audio/video on a brand-new, not-yet-sent conversation silently never transcribed it at all** - Phase 4's §6.1 delivery note explicitly deferred this ("a brand-new draft has no real id yet... falls through to the ordinary attachment flow"), reasoned as an acceptable scope cut at the time. In practice, combined with fix #1 above, this meant: a user drops a video on a fresh chat, it uploads successfully as a plain attachment (no crash), and the model - Ollama, in the reported case, with zero multimodal audio/video support - receives a file it cannot read and responds as if nothing were attached. No error, no transcription, no signal anything was wrong; just a confused answer. Closed by extending `maybeInterceptAudioVideo` to mint a `uuidv4()` conversation id when `conversation.conversationId` is `Constants.NEW_CONVO` (mirroring exactly what the now-deleted `UploadStep.tsx` did for the standalone page's own fresh-upload case), call `POST /api/transcribe` against it, and `navigate('/c/<newId>?panel=transcript', { replace: true })` on success - landing the user directly in the new conversation with the transcript panel already open, rather than requiring a message to be sent first (unlike the existing-conversation path, where the file rides through as a normal composer chip). The interception's own gate changed from `conversation?.conversationId != null` to `conversation != null` - the Builder file panels (Knowledge/CodeFiles, via `useFileHandlingNoChatContext`) pass no `conversation` object at all, so they remain correctly excluded regardless of conversation id.

**Supporting fix**: `TranscriptPanel.tsx` previously had no way to show a still-in-progress job - it derives `transcriptFileId` from the conversation's file list (`splitFileIds`), which is only populated once transcription actually finishes, so navigating straight into `?panel=transcript` right after queuing (exactly what the fix above now does) would have shown a generic "No transcript yet" with no live update. Added a `useTranscribeStatusQuery` poll (enabled only while `sourceFileId` exists and `transcriptFileId` doesn't) with dedicated queued/transcribing/failed-with-Retry render states, and a `refetchConvo()` call once the poll reports `ready` so the panel picks up the newly-attached transcript file without a manual reload.

**Also fixed in passing**: `OGDialogTemplate.tsx`'s (`packages/client`, shared by every dialog's primary "select" button, not transcription-specific) selection button had a fixed `h-10` height with no accommodation for wrapped text - `MultiChannelDialog`'s "Use channels as speakers" label is long enough to wrap to two lines, and the fixed height clipped the second line. Changed to `min-h-10` (grows for wrapped text, unchanged for the common single-line case) plus `text-center`.

**3. "Nothing happens" after confirming through the multi-channel/options dialogs - a real, confirmed race, not user error.** Reported directly after fix #2 shipped: clicking "Use channels as speakers" (or its decline) silently ended the entire flow with no error, no upload, no dialog - the file's composer chip just vanished. Root cause, found by writing a test against the *real* `MultiChannelDialog`/`TranscribeOptionsDialog` components (not the stand-ins `TranscribeIntentContext.spec.tsx` uses - see new `TranscribeIntentContext.integration.spec.tsx`) and watching the DOM after the click: `TranscribeIntentContext.tsx`'s `openStage` reset `choiceMadeRef.current = false` *synchronously*, but `onAccept`/`onDecline` set it to `true` and then call `openStage` immediately after, all inside the same click handler that the dialog's own `handleAccept` then continues in with its own `onOpenChange(false)` call - which now saw a freshly-cleared flag and read it as "dismissed with no choice," silently resolving `cancel` right after a real choice had just been made. This is exactly the class of bug a fully-mocked dialog test suite structurally cannot catch (the mocks have no real open/close lifecycle to race). Fixed by moving the reset into a `useEffect` keyed on `stage`, so it can only run after the commit that swaps dialogs - strictly after every synchronous `onOpenChange` call from the same click.

**4. Dialog copy/sizing.** `MultiChannelDialog`'s description was jargon-dense ("splitting by channel identifies who's talking far more accurately than automatic speaker detection") and its two buttons rendered at visibly mismatched widths/heights (the longer-label button wrapped to a squarer, taller box next to the shorter one's single wide line) - `OGDialogFooter`'s layout doesn't give its children matched widths by default. Copy simplified (title, description, both button labels); both `MultiChannelDialog` and `TranscribeIntentDialog` now pass `footerClassName="[&>*]:flex-1 [&>*]:justify-center"` so their two choice buttons always render at equal width, addressed locally rather than in `OGDialogTemplate` itself to avoid a wider blast radius across every other dialog in the app.

**5. The new-conversation transcribe path (fix #2) landed the user in a conversation that never actually loaded - "Nothing found" in the chat pane, "Failed to load the transcript" in the panel, both from the same root cause.** After `navigate('/c/<mintedId>?panel=transcript', { replace: true })`, the URL changed but the chat pane kept rendering the *old* empty `new` draft's state, and `ChatPanelHost`'s `conversationId` prop (`conversation.conversationId ?? conversationId` in `ChatRoute.tsx`) fell back to the stale `"new"` value - so `TranscriptPanel` queried a conversation literally named `"new"`, which doesn't exist, hence the hard error. Root cause: `ChatRoute`'s own hydration effect only re-fetches/re-initializes a conversation when `!hasSetConversation.current` (a ref from `useSetConvoContext`, shared app-wide via `SetConvoProvider` in `Root.tsx`) - and that ref was already `true` from the draft the navigate was leaving, so the effect's guard condition (`!hasSetConversation.current || newConvoNeedsInit`, and `newConvoNeedsInit` is false once the id is a real, non-`NEW_CONVO` value) short-circuited to a no-op. This is the *exact* problem `Workspace.tsx`'s own `lastHydratedConversationId`/`hasSetConversation.current = false` reset existed to solve for the standalone page's equivalent navigate (§9 Phase 3) - deleting `Workspace.tsx` in Phase 5 removed that reset along with it, and the new composer-driven navigate (fix #2) needed the same reset but never had it, since it's a genuinely new call site, not a port of old code. Fixed by resetting `hasSetConversation.current = false` immediately before the `navigate()` call in `useFileHandling.ts`, mirroring `Workspace.tsx`'s exact mechanism.

**6. Fix #5's own remaining gap: even with the hydration reset, `ChatPanelHost`/`TranscriptPanel` could still receive a stale `conversationId` for the async window *between* the reset and the hydration effect's fetch actually resolving** - surfacing as "This transcript is no longer available" (`onUnresolvable`'s toast), a flicker on open, and the panel never opening automatically after the redirect. `conversation.conversationId` (the hydrated atom `ChatRoute` passed to `ChatPanelHost`) lags behind the URL by exactly one async round trip; during that window it can still hold whatever conversation was previously in the atom - not necessarily even the "new" placeholder, potentially a genuinely different, real, previously-viewed conversation with its own source file. `TranscriptPanel`'s own `useGetConvoIdQuery` for *that* wrong id can resolve successfully (no error) and call `onResolved` with *its* `sourceFileId`, writing a wrong `?file=` into the URL - then when the real conversation loads a render later, the *correct* `sourceFileId` no longer matches that now-stale `?file=` param, and the panel's own mismatch check reads that as "resolved to something that isn't the requested file," closing itself via `onUnresolvable`. Fixed by passing the URL's own `conversationId` (from `useParams()` in `ChatRoute.tsx`) to `ChatPanelHost` instead of the hydrating atom's value - the URL param is correct the instant `navigate()` runs, with no async gap to race, and `ChatPanelHost`/`TranscriptPanel` never need the full hydrated `conversation` object, only a correct id to query with.

**Proactive sweep after fix #6** (transcription/ARCHITECTURE.md #6 above), user asked directly for a broader audit given how many of these had surfaced in a row. Found by re-applying the same two lenses that caught #3/#5/#6 - stale/racing state during an async transition, and shared mutable state one caller can clobber for another - across the rest of the composer/panel code, not by waiting for the next report:

**7. Dropping more than one audio/video file on a brand-new conversation in the same batch could silently strand every file after the first.** `handleFiles`' per-file loop is sequential (`for...of` with `await`), so files never raced each other through the intercept dialog - but the *first* file's "transcribe" choice mints a conversation and calls `navigate()` (fix #2), which unmounts the entire `ChatView`/`TranscribeIntentProvider` tree this loop's closures belong to. The loop itself doesn't stop: `addFile`/`deleteFileById` for the second file would write into a Recoil atom nothing renders anymore, and its own `interceptAudioVideo` call would try to open a dialog inside a provider instance that no longer exists - which never resolves, since there's no one left to click through it. That file's upload state is stuck forever, invisible, with no way to finish or cancel it. Fixed by having `maybeInterceptAudioVideo` report back when it navigated, and having the loop `break` rather than `continue` when it does - matches how the plan already scoped "one recording's dialog flow at a time" (§6.1's deferred mixed-drop checkbox), just closing a gap in what happens to the *rest* of the batch rather than the first file's own flow.

**8. Retry and re-transcribe could silently never update the UI for a message with more than one audio/video attachment.** `useRetryTranscriptionMutation`/`useRetranscribeAudioMutation` invalidated `[QueryKeys.transcribeStatus, sourceFileId]` - a single-id key. `Files.tsx` polls every audio/video file on a message in one batched query keyed `[transcribeStatus, ...allFileIds]` (§6.4); react-query's default partial-key invalidation matches element-by-element at the same index, so a single-id key only ever matches a batch where that file happens to be listed *first*. Retrying (or re-transcribing) anything but the first recording on a multi-recording message re-queued the job server-side correctly but left the card showing the old "failed" state indefinitely - no error, just stale, since `failed` is a terminal status the batched poll had already stopped refetching on its own. Fixed by invalidating the bare `[QueryKeys.transcribeStatus]` prefix instead, which matches every batched or single-file poll regardless of composition or order.

**9. `EnsureTranscriptFileSearch` (fix #7 in Phase 5, above) could silently disable an unrelated ephemeral tool for the conversation it was trying to help.** `updateEphemeralAgent` (`store/agents.ts`) writes the *entire* ephemeral-agent atom for a conversation, not just the key it's given - by design, since other callers (`useApplyModelSpecAgents`, applying a fresh template to a new conversation) genuinely need a full replace. Calling it with only `{ file_search: true }`, as both this component and the `Workspace.tsx`/`RedirectGuard.tsx` code it replaced always did, would silently clear e.g. `execute_code` if that had also been active for the conversation - an unrelated tool disabled as a side effect of turning file_search on for a transcript. Fixed locally in this one caller (not by changing `updateEphemeralAgent`'s shared semantics, which other callers correctly rely on) - reads the current value via the existing `useGetEphemeralAgent()` and spreads it into the write, and skips the write entirely once `file_search` is already on, avoiding a redundant Recoil update on every render where `hasTranscriptFile` stays true.

All three (findings #7-#9) were previously untested surfaces - `EnsureTranscriptFileSearch.tsx` had no test file at all before this pass, and neither `useFileHandling.test.ts` nor the mutation hooks had multi-file-batch coverage. New tests for all three verify the fix and were confirmed to fail without it (temporarily reverted each fix, re-ran, restored) before being kept as permanent regression coverage.
