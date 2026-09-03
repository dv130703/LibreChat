import { memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Spinner } from '@librechat/client';
import type { TFile, TTranscribeStatusEntry } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { useRetryTranscriptionMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

/**
 * Renders in place of the generic file chip for an audio/video attachment
 * queued for transcription from the composer (Phase 4, transcription/
 * ARCHITECTURE.md §6.1/§6.4) - `Files.tsx` routes here instead of the plain
 * `FileContainer` branch, and owns the single batched `useTranscribeStatusQuery`
 * poll for every audio/video file on the message (one request, not one per
 * card) - `jobStatus` is this file's entry from that poll. Clicking through
 * once the job is `ready` opens the transcript panel on this same `/c/:id`
 * URL via `ChatPanelHost` (mounted for every conversation as of this phase),
 * rather than navigating away to the standalone page.
 */
function TranscriptCard({
  file,
  jobStatus,
}: {
  file: Partial<TFile>;
  jobStatus: TTranscribeStatusEntry | undefined;
}) {
  const localize = useLocalize();
  const [, setSearchParams] = useSearchParams();
  const fileId = file.file_id ?? '';

  const retryMutation = useRetryTranscriptionMutation();
  const status = jobStatus?.status;

  const openTranscript = () => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('panel', 'transcript');
        next.set('file', fileId);
        return next;
      },
      { replace: false },
    );
  };

  const handleRetry: React.MouseEventHandler<HTMLButtonElement> = (event) => {
    event.stopPropagation();
    retryMutation.mutate({ sourceFileId: fileId });
  };

  if (status === 'failed') {
    // Retry renders as a sibling of `FileContainer`, not inside its
    // `subtitle` slot: that slot lives inside `FileContainer`'s own
    // clickable `<button>`, and nesting an interactive `<button>` inside
    // another is invalid HTML with undefined click/focus behavior in some
    // browsers - the same reason `FileContainer`'s own `RemoveFile` renders
    // as a sibling rather than inline content.
    return (
      <div className="inline-flex items-center gap-2">
        <FileContainer
          file={file}
          displayName={file.filename ?? localize('com_ui_audio_transcriber')}
          subtitle={
            <span className="flex items-center gap-1 truncate text-red-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {localize('com_ui_transcript_card_failed')}
            </span>
          }
        />
        <button
          type="button"
          onClick={handleRetry}
          disabled={retryMutation.isLoading}
          className="text-text-link shrink-0 underline-offset-2 hover:underline"
        >
          {localize('com_ui_transcript_card_retry')}
        </button>
      </div>
    );
  }

  let subtitle: React.ReactNode;
  let onClick: React.MouseEventHandler<HTMLButtonElement> | undefined;

  if (status === 'ready') {
    subtitle = (
      <div className="truncate text-text-secondary">{localize('com_ui_transcript_card_ready')}</div>
    );
    onClick = openTranscript;
  } else {
    const label =
      status === 'transcribing'
        ? localize('com_ui_transcript_card_transcribing')
        : localize('com_ui_transcript_card_queued');
    subtitle = (
      <div className="flex items-center gap-1.5 text-text-secondary">
        <Spinner className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
    );
  }

  return (
    <FileContainer
      file={file}
      displayName={file.filename ?? localize('com_ui_audio_transcriber')}
      subtitle={subtitle}
      onClick={onClick}
    />
  );
}

export default memo(TranscriptCard);
