import { memo } from 'react';
import { TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default memo(function StopButton({
  stop,
  setShowStopButton,
  label,
  disabled = false,
}: {
  stop: (e: React.MouseEvent<HTMLButtonElement>) => void;
  setShowStopButton: (value: boolean) => void;
  /** Overrides the tooltip/aria-label - the composer reuses this same
   *  square for a transcription job in flight (`useConversationTranscriptionStatus`),
   *  where "Stop generating" would be misleading since no LLM response is
   *  running. Defaults to the original LLM-streaming copy. */
  label?: string;
  /** Shows the square without a working click handler - the composer also
   *  reuses this square for a recording still uploading (before any real,
   *  cancellable job exists server-side yet): the busy state needs to be
   *  visible immediately, but there's nothing to cancel until the upload
   *  itself resolves into one. */
  disabled?: boolean;
}) {
  const localize = useLocalize();
  const resolvedLabel = label ?? localize('com_nav_stop_generating');

  return (
    <TooltipAnchor
      description={resolvedLabel}
      render={
        <button
          type="button"
          data-testid="stop-generation-button"
          disabled={disabled}
          className={cn(
            'rounded-full bg-text-primary p-1.5 text-text-primary outline-offset-4 transition-all duration-200 disabled:cursor-not-allowed disabled:text-text-secondary disabled:opacity-10',
          )}
          aria-label={resolvedLabel}
          onClick={(e) => {
            setShowStopButton(false);
            stop(e);
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="icon-lg text-surface-primary"
          >
            <rect x="7" y="7" width="10" height="10" rx="1.25" fill="currentColor"></rect>
          </svg>
        </button>
      }
    ></TooltipAnchor>
  );
});
