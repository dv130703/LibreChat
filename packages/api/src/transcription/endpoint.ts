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

/**
 * Where content-based speaker identification sends its prompts, or
 * `undefined` when the feature is off.
 *
 * Opt-in by configuration: without `SPEAKER_ID_MODEL` nothing is ever
 * called, so an existing install behaves exactly as before.
 *
 * The default target is this instance's local Ollama rather than a cloud
 * API, and deliberately so - identification works by sending excerpts of the
 * recording's transcript to a model, and interview audio is usually the most
 * sensitive material in the system. Keeping the default local means turning
 * the feature on cannot, by itself, send a transcript off the machine.
 * Pointing `SPEAKER_ID_BASE_URL` at a hosted endpoint is a deliberate act.
 */
export function getSpeakerIdentificationConfig():
  | { baseURL: string; apiKey: string; model: string }
  | undefined {
  const model = process.env.SPEAKER_ID_MODEL;
  if (!model) {
    return undefined;
  }
  const ollama = process.env.OLLAMA_BASE_URL;
  const baseURL = process.env.SPEAKER_ID_BASE_URL || (ollama ? `${ollama}/v1` : undefined);
  if (!baseURL) {
    return undefined;
  }
  return {
    baseURL: baseURL.replace(/\/+$/, ''),
    apiKey: process.env.SPEAKER_ID_API_KEY || 'ollama',
    model,
  };
}
