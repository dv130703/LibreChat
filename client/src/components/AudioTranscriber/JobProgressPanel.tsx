import { useEffect, useRef, useState } from 'react';
import {
  AlignLeft,
  AudioLines,
  AudioWaveform,
  Captions,
  ClipboardCheck,
  Fingerprint,
  Search,
  UserCheck,
  Users,
} from 'lucide-react';
import { Spinner } from '@librechat/client';
import type { LucideIcon } from 'lucide-react';
import type { TranscriptionStage } from 'librechat-data-provider';
import { useCancelTranscriptionMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import {
  STAGE_LABEL_KEYS,
  STAGE_ORDER,
  estimateRemainingSeconds,
  formatAudioClock,
  overallFraction,
  remainingParts,
  stageFraction,
  stageStep,
} from './jobProgress';
import type { RateSample } from './jobProgress';

/**
 * What a recording's job is doing right now, while it is doing it.
 *
 * Before this, a job showed one spinner and the word "Transcribing" from
 * acceptance to completion - including the speaker-identification and
 * attribution passes that run for minutes after the transcript already
 * exists. A reviewer had no way to tell a job three minutes into honest
 * work from one that had died, which on a forty-minute recording is a long
 * time to wonder.
 *
 * The four things a waiting user needs, in the order they ask for them: how
 * far along, how much longer, what it is doing, and how to stop it. An
 * earlier cut answered only the third, in a checklist of all eight phases
 * that read as a wall of work still to come.
 *
 * Liveness is deliberately not reported as a number. It was, as the age of
 * the worker's last heartbeat, and it announced a stopped job on runs that
 * were visibly still transcribing: that age subtracts a server-stamped
 * timestamp from the browser's own clock and re-renders off an interval
 * background tabs throttle, so it is evidence about those two things well
 * before it is evidence about the worker. The server already makes the call
 * with the clock that wrote the timestamp (`reconciliation.js`, arriving
 * here as the failed state). What replaces it is the sweep across the bar,
 * which says "running" without claiming to know anything it cannot.
 */

const STAGE_ICONS = {
  extracting: AudioWaveform,
  transcribing: Captions,
  aligning: AlignLeft,
  diarizing: Users,
  indexing: Search,
  matching_voices: Fingerprint,
  identifying_speakers: UserCheck,
  reviewing_attribution: ClipboardCheck,
} as const satisfies Record<TranscriptionStage, LucideIcon>;

/** A running job always shows some fill, even at a true zero position: the
 *  bar's job is to distinguish started from not-started before it is
 *  accurate to a percent, and a stage that renders as an empty track for
 *  its first hour (which is what a 2.5-hour transcription does) fails at
 *  exactly the moment it is being watched hardest. */
const MIN_VISIBLE_FILL = 1.5;

export default function JobProgressPanel({
  sourceFileId,
  displayName,
  stage,
  processedSeconds,
  totalSeconds,
  queued,
}: {
  sourceFileId: string | undefined;
  displayName: string | undefined;
  stage: TranscriptionStage | null;
  processedSeconds: number | null;
  totalSeconds: number | null;
  /** Accepted but not started - nothing is running yet, so there is no
   *  phase to highlight and no position to report. */
  queued: boolean;
}) {
  const localize = useLocalize();
  const cancelTranscription = useCancelTranscriptionMutation();

  const current = queued ? null : stage;
  const step = stageStep(current);
  const fraction = stageFraction(processedSeconds, totalSeconds);
  const overall = overallFraction(current, processedSeconds, totalSeconds);
  const StageIcon = current == null ? null : STAGE_ICONS[current];

  /** First position seen in the current stage, which the estimate below
   *  measures against. Reset whenever the stage changes, since the next
   *  one's pace says nothing about the last one's. */
  const sample = useRef<{ stage: TranscriptionStage; value: RateSample } | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (current == null || processedSeconds == null || totalSeconds == null) {
      sample.current = null;
      setRemaining(null);
      return;
    }
    const seen = sample.current;
    if (seen == null || seen.stage !== current || processedSeconds < seen.value.processedSeconds) {
      sample.current = { stage: current, value: { processedSeconds, at: Date.now() } };
      setRemaining(null);
      return;
    }
    setRemaining(estimateRemainingSeconds(seen.value, processedSeconds, totalSeconds));
  }, [current, processedSeconds, totalSeconds]);

  /** ponytail: this is the measured stage's estimate shown against the whole
   *  run's percentage, which is close enough only because transcription
   *  dominates wall clock. If the speaker passes ever grow to rival it, this
   *  has to become a sum over the remaining stages, not one stage's tail. */
  const remainingLabel = (() => {
    if (remaining == null) {
      return null;
    }
    const { hours, minutes } = remainingParts(remaining);
    if (hours > 0) {
      return localize('com_ui_transcript_progress_left_hours', {
        0: String(hours),
        1: String(minutes),
      });
    }
    if (minutes > 0) {
      return localize('com_ui_transcript_progress_left_minutes', { 0: String(minutes) });
    }
    return localize('com_ui_transcript_progress_left_soon');
  })();

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-xl border border-border-medium bg-surface-secondary p-8">
        <div className="flex items-center gap-2.5 border-b border-border-light pb-5">
          <AudioLines aria-hidden="true" className="h-5 w-5 shrink-0 text-text-secondary" />
          <span className="truncate text-base font-medium text-text-primary">
            {displayName ?? localize('com_ui_transcript_progress_title')}
          </span>
        </div>

        <div className="flex items-end justify-between gap-3 pt-6">
          <span className="text-5xl font-semibold tabular-nums text-text-primary">
            {Math.round(overall * 100)}%
          </span>
          {remainingLabel != null && (
            <span className="pb-1.5 text-base tabular-nums text-text-secondary duration-300 animate-in fade-in">
              {remainingLabel}
            </span>
          )}
        </div>

        <div
          className="relative mt-4 h-2.5 w-full overflow-hidden rounded-full bg-surface-tertiary"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(overall * 100)}
        >
          <div
            className="h-full rounded-full bg-blue-500 transition-[width] duration-700 ease-out dark:bg-blue-400"
            style={{
              width: current == null ? '0%' : `${Math.max(overall * 100, MIN_VISIBLE_FILL)}%`,
            }}
          />
          {/* The one thing on screen that keeps moving when nothing else
              does. Six of the eight phases report no position at all, and
              they are exactly the phases where a still bar reads as a dead
              job. */}
          <div
            aria-hidden="true"
            className="via-text-primary/20 absolute inset-y-0 left-0 w-1/4 animate-shimmer bg-gradient-to-r from-transparent to-transparent"
          />
        </div>

        <div className="flex items-start justify-between gap-3 pt-5">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center">
              {StageIcon == null ? (
                <Spinner className="h-5 w-5 text-text-secondary" />
              ) : (
                <StageIcon
                  key={current}
                  className="h-5 w-5 text-text-primary duration-300 animate-in fade-in"
                />
              )}
            </span>
            <span
              key={current ?? 'queued'}
              aria-live="polite"
              className="truncate text-base text-text-primary duration-300 animate-in fade-in"
            >
              {current == null
                ? localize('com_ui_transcript_card_queued')
                : localize(STAGE_LABEL_KEYS[current])}
            </span>
          </div>
          {step != null && (
            <span className="shrink-0 text-sm tabular-nums text-text-secondary">
              {localize('com_ui_transcript_progress_step', {
                0: String(step),
                1: String(STAGE_ORDER.length),
              })}
            </span>
          )}
        </div>

        {fraction != null && processedSeconds != null && totalSeconds != null && (
          <p className="pl-8 pt-1.5 text-sm tabular-nums text-text-secondary duration-300 animate-in fade-in">
            {localize('com_ui_transcript_progress_of', {
              0: formatAudioClock(processedSeconds),
              1: formatAudioClock(totalSeconds),
            })}
          </p>
        )}

        {sourceFileId != null && (
          <div className="mt-6 border-t border-border-light pt-5">
            <button
              type="button"
              disabled={cancelTranscription.isLoading}
              onClick={() => cancelTranscription.mutate({ sourceFileId })}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-medium px-4 py-2.5 text-base font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelTranscription.isLoading && <Spinner className="h-4 w-4 shrink-0" />}
              {localize('com_ui_stop')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
