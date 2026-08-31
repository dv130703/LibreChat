import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type { TTranscribeConfig, TTranscriptCorrection } from 'librechat-data-provider';

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

/** This deployment's effective transcription defaults. Cached indefinitely -
 *  it only changes when the server is reconfigured and restarted - so the
 *  options dialog can name what each "auto" resolves to instead of hiding it. */
export const useTranscribeConfigQuery = (
  config?: UseQueryOptions<TTranscribeConfig>,
): QueryObserverResult<TTranscribeConfig> => {
  return useQuery<TTranscribeConfig>(
    [QueryKeys.transcribeConfig],
    () => dataService.getTranscribeConfig(),
    {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      ...config,
    },
  );
};
