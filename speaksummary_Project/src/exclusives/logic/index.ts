export {
  convertAudio,
  getFFmpeg,
  loadFFmpeg,
  AUDIO_FORMATS,
  isLossless,
  getAvailableTargetFormats,
  estimateOutputBytes,
  estimateBitrateKbps,
  isVideoFile,
  isAcceptedMediaFile,
  probeMedia,
  EMPTY_PROBE,
  WAVE_BARS,
  useAudioConverter,
  useAudioQualityCheck,
  type ConversionResult,
  type AudioFormat,
  type FormatSizing,
  type SourceProperties,
  type MediaProbe,
  type ConversionStatus,
} from './audio'
export {
  countSpeakers,
  countWords,
  formatTimestamp,
  transcriptToPlainText,
  downloadTranscriptDocx,
  transcribeAudio,
  type TranscriptSegment,
  type TranscribeOptions,
  type TranscribeResult,
} from './transcript'
export {
  summaryToPlainText,
  buildSummaryMarkdown,
  listOllamaModels,
  summarizeTranscript,
  type SummaryLength,
  type SummaryResult,
  type SummaryStyle,
  type SummarizeOptions,
  type SummarizeResult,
} from './summary'
export {
  cacheSessionAudio,
  getCachedSessionAudio,
  loadSessions,
  saveSession,
  deleteSession,
  type SessionRecord,
} from './session'
export { parseMarkdown } from './markdown'
export { useRotatingMessage } from './useRotatingMessage'
// Tier 4b: Session API exports
export {
  createSession,
  getQuality,
  preprocessSession,
  transcribeSession,
  getResult,
  type SessionApiError,
} from './session/sessionApi'
export {
  useSessionQuality,
  useSessionPreprocess,
  useSessionTranscribe,
  type UseSessionQualityState,
  type UseSessionPreprocessState,
  type UseSessionTranscribeState,
} from './session/useSessionApi'
export type {
  WordToken,
  TranscriptSegment as SessionTranscriptSegment,
  TranscriptionDiagnostics,
  TranscriptionProvenance,
  TranscriptionResponse as SessionTranscriptionResponse,
  ChannelMode,
  AudioQualityMetrics,
  AudioQualityAssessment,
  Manifest,
} from './session/types'
