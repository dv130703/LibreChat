import { memo, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useSearchParams } from 'react-router-dom';
import { useRecoilState, useRecoilValue } from 'recoil';
import RecordingChip from '~/components/AudioTranscriber/RecordingChip';
import { usePendingUploadRetry } from '~/hooks/AudioTranscriber/usePendingUploadRetry';
import MessageTimestamp from '~/components/Chat/Messages/ui/MessageTimestamp';
import PlaceholderRow from '~/components/Chat/Messages/ui/PlaceholderRow';
import {
  MESSAGE_BODY_CLASSES,
  MESSAGE_CONTENT_CLASSES,
} from '~/components/Chat/Messages/ui/messageShell';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import { useAuthContext } from '~/hooks/AuthContext';
import { fontSizeAtom } from '~/store/fontSize';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';
import type { PendingTranscriptionUpload } from '~/store/families';

/** Same fixed icon data every row uses - every pending upload is the current
 *  user's own, and none of `MessageIcon`'s other fields (endpoint/model/
 *  avatar) apply to a placeholder that isn't a real message yet. Module-level
 *  so it isn't reconstructed (and doesn't defeat `MessageIcon`'s own memo)
 *  on every render. */
const USER_ICON_DATA = { isCreatedByUser: true };

/** One pending recording, rendered exactly where its real message bubble
 *  will appear once `POST /api/transcribe` resolves - renders the very same
 *  `RecordingChip` the real message will, so nothing about the recording's
 *  identity changes at the handoff. Distinct label ("Processing…")
 *  from `TranscriptCard`'s own `queued`/`transcribing` text: no job exists
 *  yet at this point - the file itself is still being uploaded/extracted -
 *  so "Transcribing" would describe work that hasn't started. */
function PendingUploadRow({
  pending,
  setPendingUploads,
}: {
  pending: PendingTranscriptionUpload;
  setPendingUploads: (
    updater: (current: PendingTranscriptionUpload[]) => PendingTranscriptionUpload[],
  ) => void;
}) {
  const localize = useLocalize();
  const fontSize = useAtomValue(fontSizeAtom);
  const [, setSearchParams] = useSearchParams();
  const retry = usePendingUploadRetry(pending, setPendingUploads);
  const { user } = useAuthContext();
  const usernameDisplay = useRecoilValue<boolean>(store.UsernameDisplay);
  // Same header name a real message would show once this upload resolves
  // (`useMessageActions.tsx`'s own `messageLabel` for `isCreatedByUser`) -
  // regression: hardcoding the generic "You" label here made this
  // placeholder's header visibly swap to the account's actual display name
  // the instant the real message replaced it.
  const messageLabel = usernameDisplay
    ? (user?.name ?? '') || user?.username
    : localize('com_user_message');

  const openPanel = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('panel', 'transcript');
        next.set('file', pending.pendingId);
        return next;
      },
      { replace: false },
    );
  }, [pending.pendingId, setSearchParams]);

  // The same chip the real message renders once this upload resolves - one
  // component, one display name, one icon, from pick to answer (defect 1).
  // Retry renders as a sibling rather than inside the chip's subtitle slot:
  // that slot lives inside `FileContainer`'s own `<button>`, and nesting one
  // interactive element in another is invalid HTML with undefined
  // click/focus behavior in some browsers.
  let content: React.ReactNode;
  if (pending.status === 'failed') {
    content = (
      <div className="inline-flex items-center gap-2">
        <RecordingChip
          displayName={pending.filename}
          bytes={pending.file.size}
          state="failed"
          statusLabel={localize('com_ui_transcript_upload_failed')}
          errorMessage={pending.errorMessage}
        />
        <button
          type="button"
          onClick={retry}
          className="text-text-link shrink-0 underline-offset-2 hover:underline"
        >
          {localize('com_ui_transcript_card_retry')}
        </button>
      </div>
    );
  } else {
    content = (
      <RecordingChip
        displayName={pending.filename}
        bytes={pending.file.size}
        state="uploading"
        statusLabel={localize('com_ui_transcript_card_processing')}
        onClick={openPanel}
      />
    );
  }

  // Mirrors `MessageRender.tsx`'s own message-row shell (icon + centered,
  // width-capped column, header, `PlaceholderRow` spacer) class-for-class -
  // regression: without this it rendered as a bare, unstyled chip flush to
  // the top-left of the message list, and even after an initial fix stayed
  // visibly shorter/differently spaced than the real message it hands off
  // to (no timestamp, no reserved action-row space, a stray extra 2px of
  // icon padding) - the layout visibly shifted the instant the real
  // message replaced this placeholder.
  return (
    <div className="w-full border-0 bg-transparent dark:border-0 dark:bg-transparent">
      <div className="m-auto justify-center p-4 py-2 md:gap-6">
        <div className="group mx-auto flex flex-1 transform-gpu gap-3 transition-all duration-300 md:max-w-[47rem] xl:max-w-[55rem]">
          <div className="relative flex flex-shrink-0 flex-col items-center">
            <div className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full">
              <MessageIcon iconData={USER_ICON_DATA} />
            </div>
          </div>
          <div className="user-turn relative flex w-11/12 flex-col">
            <h2 className={cn('select-none font-semibold', fontSize)}>
              {messageLabel}
              <MessageTimestamp value={pending.createdAt} />
            </h2>
            <div className="flex flex-col gap-1">
              {/* The real row nests these two wrappers (`MessageRender` ->
                  `MessageContent` -> `Container`); merging them here is what
                  previously dropped `items-start` and stretched this chip to
                  full width while the real message's hugged its content. */}
              <div className={MESSAGE_BODY_CLASSES}>
                <div className={MESSAGE_CONTENT_CLASSES}>{content}</div>
              </div>
              <PlaceholderRow />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Every audio/video attachment the transcribe flow has committed to
 *  uploading for this conversation but that has no real message yet -
 *  renders in the message list immediately (the composer's own instant
 *  navigation opens straight onto this, well before `POST /api/transcribe`
 *  resolves), so there's something to look at instead of an empty pane
 *  or "Nothing found" for however long the upload takes. Each entry is
 *  removed from `pendingTranscriptionUploadsByConvoId` the moment its real
 *  message lands (`attemptTranscribeUpload`), at which point the ordinary
 *  message tree (already carrying that real message, since the same flow
 *  awaits a messages refetch first) takes over with zero visible gap. */
function PendingTranscriptionMessages({ conversationId }: { conversationId: string }) {
  const [pendingUploads, setPendingUploads] = useRecoilState(
    store.pendingTranscriptionUploadsByConvoId(conversationId),
  );

  if (pendingUploads.length === 0) {
    return null;
  }

  return (
    <>
      {pendingUploads.map((pending) => (
        <PendingUploadRow
          key={pending.pendingId}
          pending={pending}
          setPendingUploads={setPendingUploads}
        />
      ))}
    </>
  );
}

export default memo(PendingTranscriptionMessages);
