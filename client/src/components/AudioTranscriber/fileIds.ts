/** A conversation with a transcribed recording (created via the standalone
 *  page, historically, or attached from an ongoing chat's composer as of
 *  Phase 4) carries exactly three related files for that recording: the
 *  source audio/video, its transcript at a deterministic
 *  `${sourceFileId}-transcript` id, and its forensic detail at
 *  `${sourceFileId}-diarization-detail` - no filename lookup needed to tell
 *  them apart. `TranscriptPanel` uses this to resolve `sourceFileId`/
 *  `transcriptFileId` from the conversation's file list whenever a
 *  `?panel=transcript` link doesn't carry an explicit `?file=` (a legacy
 *  `/audio-transcriber/:id` redirect, or a bare bookmarked link), and as a
 *  cross-check against `?file=` when it does. `EnsureTranscriptFileSearch`
 *  also uses it to detect a transcript-bearing conversation on load.
 *
 *  Excludes both derived-file suffixes explicitly, rather than "whatever
 *  isn't the transcript" - the same fix already applied server-side (see
 *  `api/server/routes/transcribe.js`'s `assertOwnsSourceFile` and
 *  transcription/ARCHITECTURE.md I3) - a looser check here could silently
 *  resolve `sourceFileId` to the diarization-detail file's id instead of the
 *  real source audio, depending on array order. */
export function splitFileIds(fileIds: string[]): {
  sourceFileId?: string;
  transcriptFileId?: string;
} {
  const transcriptFileId = fileIds.find((id) => id.endsWith('-transcript'));
  const diarizationDetailFileId = fileIds.find((id) => id.endsWith('-diarization-detail'));
  const sourceFileId = fileIds.find(
    (id) => id !== transcriptFileId && id !== diarizationDetailFileId,
  );
  return { sourceFileId, transcriptFileId };
}
