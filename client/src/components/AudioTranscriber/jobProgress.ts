import type { TranscriptionStage } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/**
 * Turning a job's raw phase and position into something a reviewer can read.
 *
 * The problem this exists for: `jobStatus` says `transcribing` from the
 * moment a file is accepted until everything is finished, including the
 * speaker-identification and attribution passes that run for minutes after
 * the transcript already exists. One label for the whole run, no position,
 * and a spinner that looks identical whether the job is working or wedged.
 */

/** In the order they run, which is also the order they are listed. */
export const STAGE_ORDER: TranscriptionStage[] = [
  'extracting',
  'transcribing',
  'aligning',
  'diarizing',
  'indexing',
  'matching_voices',
  'identifying_speakers',
  'reviewing_attribution',
];

export const STAGE_LABEL_KEYS = {
  extracting: 'com_ui_transcript_stage_extracting',
  transcribing: 'com_ui_transcript_stage_transcribing',
  aligning: 'com_ui_transcript_stage_aligning',
  diarizing: 'com_ui_transcript_stage_diarizing',
  indexing: 'com_ui_transcript_stage_indexing',
  matching_voices: 'com_ui_transcript_stage_matching_voices',
  identifying_speakers: 'com_ui_transcript_stage_identifying_speakers',
  reviewing_attribution: 'com_ui_transcript_stage_reviewing_attribution',
} as const satisfies Record<TranscriptionStage, TranslationKeys>;

export type StageState = 'done' | 'active' | 'pending';

/** Where each stage stands relative to the one running now. A stage the
 *  pipeline skipped (alignment when `align=false`) still reads as done once
 *  the run has moved past it - it is behind us either way, and showing it
 *  as pending forever would be worse than slightly overstating it. */
export function stageStates(current: TranscriptionStage | null): Record<string, StageState> {
  const currentIndex = current == null ? -1 : STAGE_ORDER.indexOf(current);
  const states: Record<string, StageState> = {};
  for (let index = 0; index < STAGE_ORDER.length; index++) {
    if (currentIndex === -1 || index > currentIndex) {
      states[STAGE_ORDER[index]] = 'pending';
      continue;
    }
    states[STAGE_ORDER[index]] = index === currentIndex ? 'active' : 'done';
  }
  return states;
}

/**
 * Fraction of the transcription phase completed, 0-1, or null when there is
 * nothing real to report.
 *
 * Null rather than 0 on purpose: only the transcription phase measures a
 * position, and every other phase would otherwise render an empty bar that
 * looks like no progress at all rather than like a phase that cannot be
 * measured.
 */
export function stageFraction(
  processedSeconds: number | null | undefined,
  totalSeconds: number | null | undefined,
): number | null {
  if (
    processedSeconds == null ||
    totalSeconds == null ||
    !Number.isFinite(processedSeconds) ||
    !Number.isFinite(totalSeconds) ||
    totalSeconds <= 0
  ) {
    return null;
  }
  return Math.min(1, Math.max(0, processedSeconds / totalSeconds));
}

/** Audio position as `m:ss`, or `h:mm:ss` once there are hours to show.
 *  A two-and-a-half hour recording rendered as `151:50` is readable only if
 *  you stop and divide, which is not what a glance at a progress readout
 *  is for. */
export function formatAudioClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0:00';
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const paddedSeconds = String(seconds).padStart(2, '0');
  if (hours === 0) {
    return `${minutes}:${paddedSeconds}`;
  }
  return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
}

/** Position of `stage` in the run, 1-based, or null when none is reported. */
export function stageStep(stage: TranscriptionStage | null | undefined): number | null {
  if (stage == null) {
    return null;
  }
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? null : index + 1;
}

/**
 * Fraction of the whole run completed, 0-1 - the one readout that has to
 * cover every phase rather than only the measurable one.
 *
 * ponytail: every stage counts the same, so this advances in even eighths
 * while transcription - which dominates wall clock on a long recording - is
 * only one of them. Weight the stages by measured typical duration if the
 * pacing ever reads as dishonest.
 */
export function overallFraction(
  stage: TranscriptionStage | null | undefined,
  processedSeconds: number | null | undefined,
  totalSeconds: number | null | undefined,
): number {
  const step = stageStep(stage);
  if (step == null) {
    return 0;
  }
  const within = stageFraction(processedSeconds, totalSeconds) ?? 0;
  return Math.min(1, (step - 1 + within) / STAGE_ORDER.length);
}

/** Too short a window and one lumpy batch of audio sets the rate for the
 *  whole run, which is how an estimate ends up swinging between "2 min" and
 *  "40 min" on consecutive polls. */
const MIN_SAMPLE_MS = 20 * 1000;

export interface RateSample {
  /** Audio position when this stage was first observed. */
  processedSeconds: number;
  /** `Date.now()` at that moment. Browser clock throughout - the server's
   *  clock never enters this calculation, so the two cannot disagree. */
  at: number;
}

/**
 * Seconds of wall clock left in the measured stage, or null while there is
 * not yet enough evidence to say.
 *
 * Derived from how fast this run has actually been moving rather than from
 * any nominal speed: a 30-minute recording on a busy GPU and the same file
 * on an idle one are not the same wait, and the only honest source for the
 * difference is the two positions this session has watched go by.
 */
export function estimateRemainingSeconds(
  sample: RateSample,
  processedSeconds: number,
  totalSeconds: number,
  now: number = Date.now(),
): number | null {
  const elapsedMs = now - sample.at;
  const advanced = processedSeconds - sample.processedSeconds;
  if (elapsedMs < MIN_SAMPLE_MS || advanced <= 0 || totalSeconds <= processedSeconds) {
    return null;
  }
  const secondsOfAudioPerSecond = advanced / (elapsedMs / 1000);
  return (totalSeconds - processedSeconds) / secondsOfAudioPerSecond;
}

/** Split for display, rounded to the minute. Under a minute reports zero of
 *  both, which the caller renders as "less than a minute" rather than as a
 *  countdown ticking through the last few seconds. */
export function remainingParts(seconds: number): { hours: number; minutes: number } {
  const totalMinutes = Math.round(seconds / 60);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/**
 * Whether `stage` is one the run reaches only after the transcript itself
 * exists and is already on screen.
 *
 * The panel swaps from the progress view to the transcript the moment a
 * transcript file is saved, which is three stages before the job is done:
 * voice matching, speaker identification and the attribution review all run
 * afterwards and all write speaker corrections into the transcript being
 * read. Without a way to name that, those stages were invisible - the
 * reviewer saw a finished-looking transcript quietly relabelling itself.
 */
export function isPostTranscriptStage(stage: TranscriptionStage | null | undefined): boolean {
  if (stage == null) {
    return false;
  }
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf('indexing');
}
