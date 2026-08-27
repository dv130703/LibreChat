import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type { TTranscriptCorrection } from 'librechat-data-provider';

/** Every correction event recorded against a transcript, chronological - the
 *  component replays them (last write per key wins) to derive current
 *  speaker names and segment reassignments. */
export const useTranscriptCorrectionsQuery = (
  transcriptFileId: string | undefined,
  conversationId: string | undefined,
  config?: UseQueryOptions<TTranscriptCorrection[]>,
): QueryObserverResult<TTranscriptCorrection[]> => {
  return useQuery<TTranscriptCorrection[]>(
    [QueryKeys.transcriptCorrections, transcriptFileId],
    () => dataService.getTranscriptCorrections(transcriptFileId ?? '', conversationId ?? ''),
    {
      ...config,
      enabled: !!transcriptFileId && !!conversationId && (config?.enabled ?? true),
    },
  );
};
