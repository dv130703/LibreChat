import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type {
  TTranscribeConfig,
  TTranscriptCorrection,
  TTranscribeStatusResponse,
  TTranscribeAudioTokenResponse,
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

/** A ready-to-use, directly-streamable `<audio src>` URL for a source audio
 *  file (transcription/ARCHITECTURE.md §12 #13) - replaces the old
 *  `useFileDownload`-based approach (fetch the whole file into a `Blob`,
 *  cache one object URL forever with `retry: false`) with a URL the browser
 *  streams natively. Left at react-query's normal retry/backoff defaults
 *  (unlike that old approach) specifically so a transient failure to mint
 *  the token - the only thing that can fail here, since no file bytes move
 *  through this request at all - recovers on its own instead of leaving the
 *  player permanently blank for the rest of the session. `staleTime` sits
 *  comfortably under the token's real 6-hour server-side expiry so an
 *  unusually long-lived panel re-mints before the URL it's already using
 *  would start failing, not after. */
export const useTranscribeAudioTokenQuery = (
  sourceFileId: string | undefined,
  config?: UseQueryOptions<TTranscribeAudioTokenResponse>,
): QueryObserverResult<TTranscribeAudioTokenResponse> => {
  return useQuery<TTranscribeAudioTokenResponse>(
    [QueryKeys.transcribeAudioToken, sourceFileId],
    () => dataService.getTranscribeAudioToken(sourceFileId ?? ''),
    {
      staleTime: 5 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      ...config,
      enabled: !!sourceFileId && (config?.enabled ?? true),
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
