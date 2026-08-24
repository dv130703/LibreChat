// The audio intake step and the UI elements it is built from live together in
// ./audio-intake, one subfolder per component, so the whole thing can be
// exported as a unit; re-exported here so the rest of the app keeps a single
// import surface.
export {
  AudioPlayer,
  Icon,
  Waveform,
  UploadIntake,
  TranscriptionOptionsPanel,
  TranscriptActions,
  DEFAULT_TRANSCRIPTION_OPTIONS,
  describeTranscriptionOptions,
} from './audio-intake'
export type { AudioPlayerHandle, IconName, TranscriptionOptions } from './audio-intake'
export { Disclosure } from './disclosure'
export { TranscriptPanel } from './transcript-panel'
export type { AudioRef } from './transcript-panel'
export { TranscriptRow, NEW_SPEAKER_OPTION } from './transcript-row'
export { SpeakerLabel, SpeakerDropdown, speakerColor } from './speaker-label'
export { SummaryPanel } from './summary-panel'
export { SummaryOptions, STYLE_OPTIONS } from './summary-options'
export { SessionHistoryPanel } from './session-history-panel'
export { StageNav } from './stage-nav'
export type { Stage } from './stage-nav'
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
  probeMedia,
  useAudioConverter,
  cacheSessionAudio,
  getCachedSessionAudio,
  loadSessions,
  saveSession,
  deleteSession,
  countSpeakers,
  countWords,
  formatTimestamp,
  transcriptToPlainText,
  downloadTranscriptDocx,
  transcribeAudio,
  summaryToPlainText,
  listOllamaModels,
  summarizeTranscript,
  type ConversionResult,
  type AudioFormat,
  type MediaProbe,
  type SourceProperties,
  type ConversionStatus,
  type SessionRecord,
  type TranscriptSegment,
  type TranscribeOptions,
  type TranscribeResult,
  type SummaryLength,
  type SummaryResult,
  type SummaryStyle,
  type SummarizeOptions,
  type SummarizeResult,
} from './logic'
