/**
 * The audio intake step, and every UI element it is built from, in one folder.
 *
 * Grouped for export rather than by kind: the panel, the controls it composes,
 * their styles and the design tokens they read all sit under this directory,
 * one subfolder per component, so it can be lifted into another project
 * without tracing imports back through a component tree.
 *
 * The one dependency that stays outside is `../logic` - conversion, probing and
 * the quality-check hook, which the transcript and summary steps share too and
 * which is data rather than UI.
 */

export { UploadIntake } from './upload-intake'

export { FormatDropdown } from './format-dropdown'
export type { FormatDropdownGroup, FormatDropdownStop } from './format-dropdown'

export { AudioQualityPanel, readLevel, readClipping, isNum } from './audio-quality'
export type { AudioQuality, Metric, MetricFix, MetricLevel } from './audio-quality'

export {
  TranscriptionOptionsPanel,
  TranscriptActions,
  DEFAULT_TRANSCRIPTION_OPTIONS,
  describeTranscriptionOptions,
  summariseTranscriptionOptions,
  effectiveTerms,
  speakerBound,
  speakerBoundsInverted,
  suggestTerms,
  containsTerm,
} from './transcript-options'
export type { TranscriptionOptions, PromptReport, SpeakerReport } from './transcript-options'

export { AudioPlayer } from './audio-player'
export type { AudioPlayerHandle } from './audio-player'

export { Waveform } from './waveform'

export { Icon } from './icon'
export type { IconName } from './icon'
