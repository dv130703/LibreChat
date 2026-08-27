/** A conversation created by the Audio Transcriber page always carries exactly
 *  two `transcript_rag`-context files: the source audio/video, and its
 *  transcript at a deterministic `${sourceFileId}-transcript` id - no filename
 *  lookup needed to tell them apart. Also doubles as the one place that can
 *  tell, from a conversation's persisted file list alone, whether it belongs
 *  to this feature at all - see `RedirectGuard`. */
export function splitFileIds(fileIds: string[]): {
  sourceFileId?: string;
  transcriptFileId?: string;
} {
  const transcriptFileId = fileIds.find((id) => id.endsWith('-transcript'));
  const sourceFileId = fileIds.find((id) => id !== transcriptFileId);
  return { sourceFileId, transcriptFileId };
}
