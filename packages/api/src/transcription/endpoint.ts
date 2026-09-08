/**
 * Where the WhisperX/pyannote work is sent. Defaults to the same RAG server
 * that handles embedding, which is how a single-machine deployment runs.
 *
 * `TRANSCRIPTION_API_URL` splits those apart. ASR and diarization are by far
 * the heaviest thing this stack does - minutes of CPU per recording on a
 * laptop, seconds on a GPU box - while embedding is cheap and wants to stay
 * next to the files it indexes. Pointing this at another machine's RAG server
 * offloads only the transcription: the transcript still comes back here to be
 * stored, so the job, its files and its messages stay in THIS instance's
 * database and nothing about the conversation moves with the compute.
 *
 * The target is the worker's RAG server (the Python service), not its
 * LibreChat server - posting to another instance's `/api/transcribe` would
 * create the recording over there instead of returning a transcript here.
 *
 * @returns Base URL with any trailing slashes removed, or `undefined` when
 *   transcription is not configured on this server at all.
 */
export function getTranscriptionApiUrl(): string | undefined {
  const url = process.env.TRANSCRIPTION_API_URL || process.env.RAG_API_URL;
  if (!url) {
    return undefined;
  }
  return url.replace(/\/+$/, '');
}
