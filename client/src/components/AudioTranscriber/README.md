# Audio Transcriber

Upload an audio/video file from any chat's composer, get it transcribed (via
the RAG server's WhisperX endpoint) and RAG-embedded, then browse the
transcript in a resizable panel next to the normal chat about it. As of Phase
5 (transcription/ARCHITECTURE.md §9) there is no separate page for this
feature - `/c/:id` is the only place it lives; a bookmarked
`/audio-transcriber/:id` link redirects here.

Not to be confused with the pre-existing Speech-to-Text (STT) voice-input
feature (`client/src/components/Chat/Input/AudioRecorder.tsx`,
`client/src/components/Nav/SettingsTabs/Speech/STT/`,
`api/server/services/Files/Audio/STTService.js`) - that's a different system
(live mic transcription into the composer) that happens to share the word
"transcribe". Grepping for `transcri` will catch both; grep for
`AudioTranscriber` / `Transcription` / `transcript_rag` to scope to just this
feature.

## Self-contained (safe to delete outright)

- `client/src/components/AudioTranscriber/` (this directory) - dialogs
  (`TranscribeIntentDialog`, `MultiChannelDialog`, `TranscribeOptionsDialog`),
  the transcript panel and its supporting modules, `ChatPanelHost` (the
  generic resizable side-panel host - see the "not self-contained" caveat
  below), `probeChannelCount.ts`, `EnsureTranscriptFileSearch.tsx`,
  `fileIds.ts`.
- `client/src/data-provider/AudioTranscriber/`
- `client/src/Providers/TranscribeIntentContext.tsx`
- `client/src/components/Chat/Messages/Content/Parts/TranscriptCard.tsx`
- `packages/api/src/transcription/`
- `packages/api/src/files/probeAudioChannels.ts`
- `api/server/services/Transcription/`
- `api/server/routes/transcribe.js` + `api/server/routes/__tests__/transcribe.spec.js`

`ChatPanelHost` itself is written generically (it hosts any panel type via
its `PANELS` registry, not just `transcript`) and is mounted unconditionally
in `ChatRoute.tsx` for every conversation - deleting the whole
`AudioTranscriber/` directory removes its only registered panel, at which
point it renders as a no-op wrapper around `children`. Safe to leave in
place rather than unpicking it from `ChatRoute.tsx` if this feature is ever
removed piecemeal, though removing the mount too is the cleaner rollback.

## External touch points (each a single, isolated removal)

| File | What to remove |
|---|---|
| `client/src/routes/index.tsx` | `AudioTranscriberRedirect` component + `audio-transcriber/:conversationId` route entry |
| `client/src/routes/Root.tsx` | `EnsureTranscriptFileSearch` import + `<EnsureTranscriptFileSearch />` mount |
| `client/src/routes/ChatRoute.tsx` | `ChatPanelHost` import + its wrap around `<ChatView />` |
| `client/src/components/Chat/ChatView.tsx` | `TranscribeIntentProvider` import + its wrap around `<Presentation>` |
| `client/src/components/Chat/Messages/Content/Files.tsx` | the batched `useTranscribeStatusQuery` call, `transcribableFiles`/`audioVideoFiles` derivations, and the `TranscriptCard` render branch (revert `otherFiles` to its original filter) |
| `client/src/hooks/Files/useFileHandling.ts` | `useTranscribeIntent`/`useTranscribeAudioMutation` imports, `maybeInterceptAudioVideo`, and its call site in `handleFiles` |
| `client/src/utils/files.ts` | `isAudioOrVideoMimeType` |
| `client/src/data-provider/index.ts` | `export * from './AudioTranscriber';` |
| `packages/data-provider/src/{api-endpoints,data-service,keys,types/files}.ts` | `transcribe`/`probeAudioChannels` endpoints, `dataService.transcribeAudio()`/`probeAudioChannels()`, `MutationKeys.transcribeAudio`, `TTranscribeQueuedResponse`/`TTranscribeStatusResponse`/`TAudioChannelProbeResponse`, `FileContext.transcript_rag` |
| `api/server/routes/index.js` | `transcribe` require + export |
| `api/server/index.js` | `app.use('/api/transcribe', routes.transcribe);` + `startTranscriptionReconciliation()` |
| `api/server/services/Files/process.js` | `saveTranscriptFile()`, `saveDiarizationDetailFile()` |
| `api/server/routes/convos.js` (+ its test files) | `cleanupTranscriptFiles()`, `deleteConversationCascade()` and its call sites |
| `packages/data-schemas/src/methods/conversation.ts` (+ `.spec.ts`) | `addConvoFile()` |
| `packages/data-schemas/src/schema/file.ts`, `types/file.ts` | `transcription`/`sourceFileId` fields on the File model |
| `packages/data-schemas/src/schema/convo.ts`, `types/convo.ts` | the deprecated `Conversation.transcription` field (dual-read only - see Phase 6) |

As of Phase 5, `Header.tsx`, `ModelSelector.tsx`, `ChatForm.tsx`,
`MessagesView.tsx`, `useTextarea.ts`, `useNewConvo.ts`, and
`FileSearch.tsx` carry **no** feature-specific code anymore - the standalone
page's dedicated-workspace chrome (hidden model selector, forced
`file_search` toggle hiding, custom placeholder text, a URL-bounce guard)
was deleted along with the page itself, not ported forward. Nothing to
remove there if this feature is pulled later.

## Do NOT remove these alongside the feature

They live in files this feature touched, but they're general fixes the rest
of the app now relies on - not part of the feature itself:

- `packages/data-schemas/.../mongoMeili.ts` - fixes a pre-existing Mongoose
  hook that never called `next()`; every model using this plugin needs it.
- `client/src/components/Chat/Messages/MessagesView.tsx` - the
  `isRestCreatedEmptyStart` check (any real, persisted conversation with a
  currently-empty message tree, not specifically a transcript one) is a
  general fix for REST-created conversations, generalized during Phase 5
  from a transcript-only check into a general one.
- `client/src/components/Chat/ChatView.tsx` - the `isNavigating`/`isFetching`
  change is a general fix so `ChatRoute` (reused here) doesn't spin forever on
  legitimately-empty conversations elsewhere too.
