import { QueryKeys } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type {
  TConversation,
  TTranscribeOptions,
  TTranscribeQueuedResponse,
} from 'librechat-data-provider';
import type { TranscribeAudioVariables } from '~/data-provider';
import type { PendingTranscriptionUpload } from '~/store/families';

export interface BuildTranscribeFormDataArgs {
  targetConversationId: string;
  parentMessageId: string;
  originalFile: File;
  options: TTranscribeOptions;
  endpoint?: string;
  agentId?: string;
  /** Never sent before this field existed - the server-side conversation and
   *  file-retention writes both fell through to treating this as `false`
   *  regardless of the user's actual temporary-chat setting, so a recording
   *  attached in an incognito session (and its transcript) never expired.
   *  Matches `useFileHandling.ts`'s own `startUpload`, which already sends
   *  this for plain (non-transcribed) file attachments. */
  isTemporary?: boolean;
}

/** Builds the multipart body `POST /api/transcribe` expects. Factored out of
 *  `maybeInterceptAudioVideo` so the exact same upload attempt can be re-run
 *  by `TranscriptPanel`'s own "retry upload" affordance (for an upload that
 *  failed before any `sourceFile`/job existed server-side - the ordinary
 *  `POST /:sourceFileId/retry` endpoint doesn't apply there) without pulling
 *  in the composer's file-handling hook. */
export function buildTranscribeFormData({
  targetConversationId,
  parentMessageId,
  originalFile,
  options,
  endpoint,
  agentId,
  isTemporary,
}: BuildTranscribeFormDataArgs): FormData {
  const formData = new FormData();
  formData.append('file', originalFile);
  formData.append('conversationId', targetConversationId);
  formData.append('parentMessageId', parentMessageId);
  if (endpoint) {
    formData.append('endpoint', endpoint);
  }
  if (agentId) {
    formData.append('agent_id', agentId);
  }
  if (isTemporary) {
    formData.append('isTemporary', 'true');
  }
  formData.append('options', JSON.stringify(options));
  return formData;
}

export interface AttemptTranscribeUploadArgs
  extends Omit<BuildTranscribeFormDataArgs, 'parentMessageId'> {
  pendingId: string;
  /** A plain id, or a promise for one - lets a caller queue a second
   *  recording before the first attach's own message id is known yet
   *  (instant navigation fires this whole function without awaiting it),
   *  while still chaining the two as parent/child once it resolves. See
   *  `onQueued` below for the other half of that chain. */
  parentMessageId: string | Promise<string>;
  mutateAsync: (variables: TranscribeAudioVariables) => Promise<TTranscribeQueuedResponse>;
  queryClient: QueryClient;
  setPendingUploads: (
    conversationId: string,
    updater: (current: PendingTranscriptionUpload[]) => PendingTranscriptionUpload[],
  ) => void;
  /** Called once the upload succeeds, with the real `sourceFileId` - the
   *  caller is responsible for swapping its `?file=` search param from
   *  `pendingId` to this. */
  onUploaded: (sourceFileId: string) => void;
  /** Fired the instant the new message's real id is known - right after
   *  `mutateAsync` resolves, well before `onUploaded` (which waits on the
   *  conversation refetch below). A caller queuing several recordings in
   *  quick succession uses this to resolve the NEXT attach's own
   *  `parentMessageId` promise as soon as possible, without waiting for
   *  react-query's cache to catch up. */
  onQueued?: (messageId: string) => void;
  /** Fired with the just-created conversation's real, persisted data (after
   *  the conversation refetch below) - the caller merges this into the
   *  shared Recoil conversation atom `ChatRoute`/`ask()`/`MessagesView` all
   *  read from. That atom was seeded, before this upload even started, with
   *  a snapshot of the "brand-new, unsent draft" placeholder (`createdAt:
   *  ''`, etc. - see `useNewConvo.ts`), since nothing server-side existed
   *  yet to fetch. A normal first message clears that placeholder itself,
   *  via the SSE `final` event's own conversation payload
   *  (`useEventHandlers.ts`'s `finalHandler`) - this flow never goes
   *  through `ask()`/SSE at all, so without this callback the atom is stuck
   *  looking like an uncreated draft forever, and the next ordinary
   *  `ask()` send computes against it as if this conversation still didn't
   *  really exist. */
  onConversationRefreshed?: (conversation: TConversation) => void;
  /** Shown to the user as-is (already localized) if the upload fails -
   *  matches the previous behavior of a generic toast rather than
   *  surfacing the raw error. */
  fallbackErrorMessage: string;
}

/** Runs one `POST /api/transcribe` attempt and reconciles the shared pending
 *  record either way - success removes it (the ordinary `queued`/
 *  `transcribing` polling takes over from here), failure marks it
 *  `status: 'failed'` with `errorMessage` so a retry affordance has
 *  something to show and act on. Never throws - failure is reported through
 *  the pending record, not a rejected promise, since both callers
 *  (`maybeInterceptAudioVideo`'s initial attempt, and `TranscriptPanel`'s
 *  retry) run this after already having navigated/rendered on the strength
 *  of the pending record existing, with nothing further up their own call
 *  stack waiting on this promise. */
export async function attemptTranscribeUpload({
  pendingId,
  targetConversationId,
  parentMessageId,
  originalFile,
  options,
  endpoint,
  agentId,
  isTemporary,
  mutateAsync,
  queryClient,
  setPendingUploads,
  onUploaded,
  onQueued,
  onConversationRefreshed,
  fallbackErrorMessage,
}: AttemptTranscribeUploadArgs): Promise<void> {
  try {
    const formData = buildTranscribeFormData({
      targetConversationId,
      parentMessageId: await parentMessageId,
      originalFile,
      options,
      endpoint,
      agentId,
      isTemporary,
    });
    const data = await mutateAsync({ formData });
    if (data.messageId != null) {
      onQueued?.(data.messageId);
    }
    // Both awaited, not fire-and-forget - two separate reasons:
    //  - Conversation: `useTranscribeAudioMutation`'s own `onSuccess` already
    //    invalidates this key but doesn't wait for it. For a brand-new
    //    conversation, `TranscriptPanel` has been querying it since the
    //    instant it mounted (optimistic navigation, before this upload even
    //    started) and caching a 404 the whole time; its `isConvoError` state
    //    only clears once this refetch actually resolves. Removing the
    //    pending record before that happens hands the panel back to
    //    `isConvoError` for whatever's left of that window - a real, if
    //    brief, "Failed to load the transcript." flash right as the upload
    //    that just succeeded.
    //  - Messages: an ordinary `ask()` send right after this resolves reads
    //    `getMessages(targetConversationId)` (the same cache entry) to
    //    compute its `parentMessageId` - if that cache is still empty
    //    because this only ever *invalidated* it without waiting, the new
    //    message computes `Constants.NO_PARENT` (no known latest message)
    //    instead of chaining onto the one just created here, landing as a
    //    SIBLING of it. LibreChat's message list shows only the newest
    //    sibling by default, so the recording just uploaded would appear to
    //    vanish the moment the user sends anything else.
    // Neither's own failure (a network hiccup on these follow-up requests
    // specifically) is mistaken for the upload itself failing - the file is
    // already safely queued server-side by this point regardless.
    await Promise.all([
      queryClient.refetchQueries([QueryKeys.messages, targetConversationId]).catch(() => {}),
      queryClient.refetchQueries([QueryKeys.conversation, targetConversationId]).catch(() => {}),
    ]);
    const freshConversation = queryClient.getQueryData<TConversation>([
      QueryKeys.conversation,
      targetConversationId,
    ]);
    if (freshConversation) {
      onConversationRefreshed?.(freshConversation);
    }
    setPendingUploads(targetConversationId, (current) =>
      current.filter((entry) => entry.pendingId !== pendingId),
    );
    onUploaded(data.sourceFile.file_id);
  } catch (error) {
    console.error('transcribe upload error', error);
    setPendingUploads(targetConversationId, (current) =>
      current.map((entry) =>
        entry.pendingId === pendingId
          ? { ...entry, status: 'failed', errorMessage: fallbackErrorMessage }
          : entry,
      ),
    );
  }
}
