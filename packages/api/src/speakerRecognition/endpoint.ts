/**
 * Where the ECAPA-TDNN embedding/matching work is sent (the "Speaker
 * Recognition" service, port 4444 in a single-machine deployment) - same
 * shape as `getTranscriptionApiUrl`, a separate service with its own env var
 * rather than a fallback onto `RAG_API_URL`/`TRANSCRIPTION_API_URL`, since it
 * has nothing to do with WhisperX/RAG embedding and may not be running at
 * all on a deployment that never enrolls voice profiles.
 *
 * @returns Base URL with any trailing slashes removed, or `undefined` when
 *   speaker recognition is not configured on this server at all.
 */
export function getSpeakerRecognitionApiUrl(): string | undefined {
  const url = process.env.SPEAKER_RECOGNITION_API_URL;
  if (!url) {
    return undefined;
  }
  return url.replace(/\/+$/, '');
}
