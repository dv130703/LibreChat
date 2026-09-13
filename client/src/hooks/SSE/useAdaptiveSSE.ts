import type { TSubmission } from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import useResumableSSE from './useResumableSSE';
import useSSE from './useSSE';

type ChatHelpers = Pick<
  EventHandlerParams,
  'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
>;

/**
 * Adaptive SSE hook that uses resumable streams.
 *
 * Note: Both hooks are always called to comply with React's Rules of Hooks.
 * `useSSE` is passed a null submission since only the resumable path is active.
 */
export default function useAdaptiveSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  useSSE(null, chatHelpers, isAddedRequest, runIndex);

  const { streamId } = useResumableSSE(submission, chatHelpers, isAddedRequest, runIndex);

  return { streamId, resumableEnabled: true };
}
