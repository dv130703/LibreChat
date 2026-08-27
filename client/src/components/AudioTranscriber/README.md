# Audio Transcriber

Self-contained feature: upload an audio/video file, get it transcribed (via the
RAG server's WhisperX endpoint) and RAG-embedded, then browse the transcript
next to a normal chat about it.

Not to be confused with the pre-existing Speech-to-Text (STT) voice-input
feature (`client/src/components/Chat/Input/AudioRecorder.tsx`,
`client/src/components/Nav/SettingsTabs/Speech/STT/`,
`api/server/services/Files/Audio/STTService.js`) - that's a different system
(live mic transcription into the composer) that happens to share the word
"transcribe". Grepping for `transcri` will catch both; grep for
`AudioTranscriber` / `Transcription` / `transcript_rag` to scope to just this
feature.

## Self-contained (safe to delete outright)

- `client/src/components/AudioTranscriber/` (this directory)
- `client/src/data-provider/AudioTranscriber/`
- `api/server/services/Transcription/`
- `api/server/routes/transcribe.js` + `api/server/routes/__tests__/transcribe.spec.js`

## External touch points (each a single, isolated removal)

| File | What to remove |
|---|---|
| `client/src/routes/Root.tsx` | `AudioTranscriberRedirectGuard` import + `<AudioTranscriberRedirectGuard />` mount |
| `client/src/routes/index.tsx` | `loadAudioTranscriberView` loader + its two `audio-transcriber*` route entries |
| `client/src/hooks/Nav/useSideNavLinks.ts` | the unconditional `links.push({ id: 'audio-transcriber', ... })` block |
| `client/src/store/agents.ts` | `isAudioTranscriberConvo` atom |
| `client/src/components/Chat/Input/FileSearch.tsx` | the `isTranscriberConvo` check (revert to just the `canUseFileSearch` guard) |
| `client/src/data-provider/index.ts` | `export * from './AudioTranscriber';` |
| `api/server/routes/index.js` | `transcribe` require + export |
| `api/server/index.js` | `app.use('/api/transcribe', routes.transcribe);` |
| `api/server/services/Files/process.js` | `saveTranscriptFile()` |
| `api/server/routes/convos.js` (+ its test files) | `cleanupTranscriptFiles()` and its call sites |
| `packages/data-schemas/src/methods/conversation.ts` (+ `.spec.ts`) | `addConvoFile()` |
| `packages/data-provider/src/{api-endpoints,data-service,keys,types/files}.ts` | `transcribe` endpoint, `transcribeAudio()`, `MutationKeys.transcribeAudio`, `TTranscribeResponse`/`TTranscriptSegment`, `FileContext.transcript_rag` |

## Do NOT remove these alongside the feature

They live in files this feature touched, but they're general fixes the rest of
the app now relies on - not part of the feature itself:

- `packages/data-schemas/.../mongoMeili.ts` - fixes a pre-existing Mongoose
  hook that never called `next()`; every model using this plugin needs it.
- `client/src/components/Chat/ChatView.tsx` - the `isNavigating`/`isFetching`
  change is a general fix so `ChatRoute` (reused here) doesn't spin forever on
  legitimately-empty conversations elsewhere too.
