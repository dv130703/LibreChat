import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranscribeAudioMutation } from '~/data-provider';
import { attemptTranscribeUpload } from '~/hooks/Files/transcribeUpload';
import { useLocalize } from '~/hooks';
import store from '~/store';
import type { PendingTranscriptionUpload } from '~/store/families';

/** Re-runs the exact same upload attempt that failed - the ordinary
 *  `POST /:sourceFileId/retry` doesn't apply here, since an upload failure
 *  means no `sourceFileId`/job ever existed to retry in the first place.
 *  Shared by every surface that can show a failed pending upload
 *  (`TranscriptPanel`'s own failed state, and the message-list placeholder
 *  bubble `PendingTranscriptionMessages` renders while no real message
 *  exists yet) so the retry behavior can't drift between them. */
export function usePendingUploadRetry(
  pending: PendingTranscriptionUpload | undefined,
  setPendingUploads: (
    updater: (current: PendingTranscriptionUpload[]) => PendingTranscriptionUpload[],
  ) => void,
) {
  const localize = useLocalize();
  const transcribeAudioMutation = useTranscribeAudioMutation();
  const queryClient = useQueryClient();
  const [, setSearchParams] = useSearchParams();
  /** Index 0 (the main pane), matching the same scope this whole feature
   *  already assumes elsewhere (`useFileHandling`'s default export is bound
   *  to the main `ChatContext`, never the "Added Response" compare pane).
   *  Read directly off the Recoil atom, not `useChatContext()` - unlike
   *  `useFileHandling.ts`'s own composer call site, this hook is also used
   *  from `TranscriptPanel`, which `ChatPanelHost` renders as a SIBLING of
   *  `ChatView` (the component that actually sets up `ChatContext.Provider`),
   *  not a descendant of it - `useChatContext()` would throw there. */
  const { conversation, setConversation } = store.useCreateConversationAtom(0);

  return useCallback(() => {
    if (!pending) {
      return;
    }
    setPendingUploads((current) =>
      current.map((entry) =>
        entry.pendingId === pending.pendingId
          ? { ...entry, status: 'uploading', errorMessage: undefined }
          : entry,
      ),
    );
    void attemptTranscribeUpload({
      pendingId: pending.pendingId,
      targetConversationId: pending.conversationId,
      parentMessageId: pending.parentMessageId,
      originalFile: pending.file,
      options: pending.options,
      isTemporary: pending.isTemporary,
      mutateAsync: transcribeAudioMutation.mutateAsync,
      queryClient,
      setPendingUploads: (_conversationId, updater) => setPendingUploads(updater),
      fallbackErrorMessage: localize('com_ui_audio_transcriber_error'),
      // Same reasoning as `useFileHandling.ts`'s own call site: this retry
      // may be the attempt that FIRST actually creates the conversation
      // server-side (the original attach failed before that ever happened),
      // so the shared conversation atom needs the same "placeholder ->
      // real" merge, or it's left permanently looking like an unsent draft.
      onConversationRefreshed: (freshConversation) => {
        setConversation({ ...conversation, ...freshConversation });
      },
      onUploaded: (uploadedSourceFileId) => {
        setSearchParams(
          (prev) => {
            if (prev.get('file') !== pending.pendingId) {
              return prev;
            }
            const next = new URLSearchParams(prev);
            next.set('file', uploadedSourceFileId);
            return next;
          },
          { replace: true },
        );
      },
    });
  }, [
    pending,
    transcribeAudioMutation.mutateAsync,
    queryClient,
    setPendingUploads,
    localize,
    setSearchParams,
    conversation,
    setConversation,
  ]);
}
