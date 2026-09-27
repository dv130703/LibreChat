import { memo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Spinner } from '@librechat/client';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';

/**
 * The one chip a recording is rendered as, from the moment the user picks a
 * file through to a finished, searchable transcript.
 *
 * Defect 1 was that this was three components: an upload placeholder
 * (`PendingUploadRow`), a plain `FileContainer` for the brief window before
 * the job status resolved, and `TranscriptCard`. Handing off between them
 * visibly changed the recording's identity - the icon went from video to
 * waveform and the name from `clip.mp4` to `clip.m4a` - which reads as a
 * different entity appearing, not as one entity progressing.
 *
 * `overrideType` is pinned rather than taken from the file: ffmpeg extracts
 * every upload to an `audio/mp4` track, so a recording *is* audio the whole
 * way through regardless of what container it arrived in. Pinning it keeps
 * the icon still across the handoff instead of flipping once the extracted
 * artifact replaces the original in the data.
 */
const RECORDING_CHIP_TYPE = 'audio/mp4';

export interface RecordingChipProps {
  /** The name the user chose, stable across the whole lifecycle - never the
   *  extracted artifact's own filename. */
  displayName: string;
  bytes?: number;
  /** What this recording is doing right now. */
  state: 'uploading' | 'queued' | 'transcribing' | 'ready' | 'failed';
  /** Shown in place of the status line when `state` is `failed`. */
  errorMessage?: string;
  statusLabel: string;
  /** 0-1 through the current phase, when that phase measures a position.
   *  Absent leaves the spinner alone rather than drawing an empty bar,
   *  which would read as "stuck at 0%" instead of "not measurable". */
  progress?: number | null;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

function RecordingChip({
  displayName,
  bytes,
  state,
  errorMessage,
  statusLabel,
  progress,
  onClick,
}: RecordingChipProps) {
  const file = { filename: displayName, type: RECORDING_CHIP_TYPE, bytes };

  if (state === 'failed') {
    // No click target and no retry action inside the chip: `FileContainer`'s
    // subtitle slot lives inside its own `<button>`, and nesting one
    // interactive element in another is invalid HTML with undefined
    // click/focus behavior. Retry renders as a sibling at each call site.
    return (
      <FileContainer
        file={file}
        overrideType={RECORDING_CHIP_TYPE}
        displayName={displayName}
        subtitle={
          <span className="flex items-center gap-1 truncate text-red-500">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {errorMessage ?? statusLabel}
          </span>
        }
      />
    );
  }

  return (
    <FileContainer
      file={file}
      overrideType={RECORDING_CHIP_TYPE}
      displayName={displayName}
      onClick={onClick}
      subtitle={
        <div className="flex min-w-0 flex-col gap-1 text-text-secondary">
          <div className="flex items-center gap-1.5">
            {state !== 'ready' && <Spinner className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{statusLabel}</span>
          </div>
          {progress != null && (
            <div
              className="h-0.5 w-full overflow-hidden rounded-full bg-border-medium"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <div
                className="h-full rounded-full bg-green-500 transition-[width] duration-500 ease-out dark:bg-green-400"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          )}
        </div>
      }
    />
  );
}

export default memo(RecordingChip);
