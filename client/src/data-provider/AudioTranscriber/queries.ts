import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type {
  TTranscribeConfig,
  TTranscriptCorrection,
  TTranscribeStatusResponse,
} from 'librechat-data-provider';

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

const NON_TERMINAL_JOB_STATUSES = new Set(['queued', 'transcribing']);

/** Batch status poll for one or more source-audio file ids (Phase 2,
 *  transcription/ARCHITECTURE.md §5.1) - polls every 3s while any of them
 *  is still `queued`/`transcribing`, stopping once every one has reached a
 *  terminal state (`ready`/`failed`). Callers pass an empty array to stay
 *  dormant (`enabled` gates on `fileIds.length`, same convention as
 *  `useFilePreview` gating on `!!file_id`). */
export const useTranscribeStatusQuery = (
  fileIds: string[],
  config?: UseQueryOptions<TTranscribeStatusResponse>,
): QueryObserverResult<TTranscribeStatusResponse> => {
  return useQuery<TTranscribeStatusResponse>(
    [QueryKeys.transcribeStatus, ...fileIds],
    () => dataService.getTranscribeStatus(fileIds),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
      refetchInterval: (data) =>
        !data || data.files.some((file) => NON_TERMINAL_JOB_STATUSES.has(file.status))
          ? 3000
          : false,
      ...config,
      enabled: fileIds.length > 0 && (config?.enabled ?? true),
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
