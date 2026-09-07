import { useMemo } from 'react';
import { useConversationTranscriptsQuery } from '~/data-provider';

const IN_PROGRESS_STATUSES = new Set(['queued', 'transcribing']);

/** Whether the given conversation has any transcription job currently in
 *  flight - drives the composer's send-arrow-becomes-stop-square affordance
 *  for transcription, the same way `isSubmitting`/`showStopButton` already
 *  do for LLM streaming (`ChatForm.tsx`), and `nonTerminalSourceFileIds` for
 *  its click handler to cancel.
 *
 *  Reads the conversation's transcripts read model, which already reports
 *  every recording and its job status and polls itself while any of them is
 *  still running. This used to derive the recording list from
 *  `Conversation.files` and then run a second status poll against it - two
 *  queries, and a list that was only as fresh as a conversation cache with
 *  no refetch on job completion. "Any" in-flight job in the conversation is
 *  enough to show the stop-square (not per-file) - the composer's button is
 *  one control for the whole conversation, the same granularity the LLM stop
 *  button already has, and the job queue only ever runs one job at a time
 *  regardless. */
export function useConversationTranscriptionStatus(conversationId: string) {
  const { data } = useConversationTranscriptsQuery(conversationId);

  const nonTerminalSourceFileIds = useMemo(
    () =>
      (data?.transcripts ?? [])
        .filter((entry) => entry.jobStatus != null && IN_PROGRESS_STATUSES.has(entry.jobStatus))
        .map((entry) => entry.sourceFileId),
    [data],
  );

  return {
    isTranscribing: nonTerminalSourceFileIds.length > 0,
    nonTerminalSourceFileIds,
  };
}
