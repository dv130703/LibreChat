import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToastContext } from '@librechat/client';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import useLocalize from '~/hooks/useLocalize';
import type {
  TTranscribeOptions,
  TTranscribeQueuedResponse,
  TTranscribeCancelResponse,
  TConversationTranscriptsResponse,
  TTranscriptCorrection,
  InterviewTranscriptForm,
  MeetingMinutesForm,
  NamedSpeaker,
  TSpeakerRenameRequest,
  TSegmentReassignRequest,
  TTextEditRequest,
  TLineInsertRequest,
  TLineDeleteRequest,
  TTimeEditRequest,
} from 'librechat-data-provider';

export interface TranscribeAudioVariables {
  formData: FormData;
  /** Real, byte-level progress for the upload leg only - see `transcribeAudio`
   *  in `data-service.ts`. There's no signal at all for the transcription/
   *  embedding leg that follows; callers poll `useTranscribeStatusQuery`
   *  (Phase 2, async job model) for that. */
  onUploadProgress?: (percent: number) => void;
}

/** Uploads an audio/video file for transcription and RAG embedding, scoped to
 *  one conversation. A direct REST action (see `POST /api/transcribe`), not an
 *  agent tool call. Resolves once the job is queued, not once it finishes -
 *  see `TTranscribeQueuedResponse`. */
export const useTranscribeAudioMutation = (): UseMutationResult<
  TTranscribeQueuedResponse,
  unknown,
  TranscribeAudioVariables,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.transcribeAudio], {
    mutationFn: ({ formData, onUploadProgress }: TranscribeAudioVariables) =>
      dataService.transcribeAudio(formData, null, onUploadProgress),
    onSuccess: (data) => {
      // The conversation is created the instant the job is queued (Phase 2 -
      // it no longer waits for transcription to finish), so the moment this
      // resolves is the first moment it is real. Nothing else will go
      // looking for it: the sidebar list is an infinite query that refetches
      // on its own schedule, and `useGetConvoIdQuery` reads that same cache
      // first and is configured `refetchOnMount: false`. Left uninvalidated,
      // the new conversation is simply absent from the sidebar, and the one
      // query that decides whether this is a transcriber conversation at all
      // answers from a cache written before it existed.
      queryClient.invalidateQueries([QueryKeys.allConversations]);
      queryClient.invalidateQueries([QueryKeys.conversation, data.conversationId]);
    },
  });
};

export interface RetranscribeAudioVariables {
  sourceFileId: string;
  options: TTranscribeOptions;
}

/** Re-runs transcription on the audio already stored for a source file,
 *  replacing its conversation's transcript in place - keyed by
 *  `sourceFileId`, not `conversationId` (a conversation may hold more than
 *  one recording). Resolves once the job is queued, not once it finishes. */
export const useRetranscribeAudioMutation = (): UseMutationResult<
  TTranscribeQueuedResponse,
  unknown,
  RetranscribeAudioVariables,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.retranscribeAudio], {
    mutationFn: ({ sourceFileId, options }: RetranscribeAudioVariables) =>
      dataService.retranscribeAudio(sourceFileId, options),
    onSuccess: (data) => {
      // `TranscriptPanel` reads job status from `useConversationTranscriptsQuery`
      // (`[QueryKeys.conversationTranscripts, conversationId]`), not from the
      // plain conversation document - without this invalidation, its cached
      // `jobStatus`/`unqueryableReason` stay whatever they were before this
      // request (already a terminal, queryable state from the prior run), so
      // its own `refetchInterval` - which only polls while some entry reads
      // `unqueryableReason: 'in_progress'` - never resumes, and the panel has
      // no way to learn a job is running again: no button busy-state, no
      // progress banner, indefinitely, until something unrelated happens to
      // refetch it (e.g. the panel being closed and reopened). This is the
      // fix for that: refetching immediately picks up the fresh `queued`
      // status this request just caused, which re-arms the 3s poll on its own
      // from there until the job reaches a terminal state again.
      queryClient.invalidateQueries([QueryKeys.conversationTranscripts, data.conversationId]);
      // Also still invalidated in case anything else reads transcription
      // metadata off the bare conversation document (e.g. `previousOptions` in
      // `TranscriptPanel`, sourced from `conversation?.transcription`).
      queryClient.invalidateQueries([QueryKeys.conversation, data.conversationId]);
      // Not `[QueryKeys.transcribeStatus, variables.sourceFileId]` - that
      // exact key only matches a query polling *this one* file in isolation.
      // `Files.tsx` polls every audio/video file on a message in a single
      // batched query keyed `[transcribeStatus, ...allFileIds]`; react-query's
      // partial-key matching requires each element to line up at the same
      // index, so a single-id invalidation only ever matches a batch where
      // this file happens to be first. For a message with more than one
      // recording, retrying/re-transcribing anything but the first silently
      // never refreshed the UI - it kept showing the stale status until the
      // next unrelated cache event. Invalidating the bare prefix matches
      // every batched or single-file poll regardless of composition or
      // order, at the cost of also refreshing unrelated conversations' polls
      // - a network no-op for anyone not actively viewing one.
      queryClient.invalidateQueries([QueryKeys.transcribeStatus]);
    },
  });
};

export interface RetryTranscriptionVariables {
  sourceFileId: string;
}

/** Re-enqueues a failed job with the options it originally ran with. Only
 *  valid when the job's current status is `'failed'`. */
export const useRetryTranscriptionMutation = (): UseMutationResult<
  TTranscribeQueuedResponse,
  unknown,
  RetryTranscriptionVariables,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.retryTranscription], {
    mutationFn: ({ sourceFileId }: RetryTranscriptionVariables) =>
      dataService.retryTranscription(sourceFileId),
    onSuccess: (_data, variables) => {
      // `TranscriptPanel` renders its queued/transcribing/failed state from
      // `useConversationTranscriptsQuery`, not from the status poll below,
      // and that query stops polling once a job reaches a terminal state -
      // which `'failed'` (what a cancel produces) is. Without this, hitting
      // Retry from the cancelled state re-queued the job on the server but
      // left the panel sitting on its stale pre-retry snapshot, showing no
      // sign the click did anything.
      //
      // Written into the cache directly, not just invalidated: an
      // invalidation alone leaves the old `failed` state rendered for the
      // whole round-trip of the refetch, so the error panel and its Retry
      // button visibly come back for a moment right after being clicked.
      // Patching first means the panel flips to the in-progress state on
      // the same tick the request succeeds. `unqueryableReason` matters as
      // much as `jobStatus` here - it is what that query's own
      // `refetchInterval` gates on, so setting it is what re-arms the 3s
      // poll immediately rather than only after the invalidation lands.
      queryClient.setQueriesData<TConversationTranscriptsResponse>(
        [QueryKeys.conversationTranscripts],
        (previous) => {
          if (!previous?.transcripts) {
            return previous;
          }
          return {
            ...previous,
            transcripts: previous.transcripts.map((entry) =>
              entry.sourceFileId === variables.sourceFileId
                ? {
                    ...entry,
                    jobStatus: 'queued',
                    jobError: null,
                    cancelled: false,
                    isQueryable: false,
                    unqueryableReason: 'in_progress',
                  }
                : entry,
            ),
          };
        },
      );
      // Still invalidated so the optimistic patch above is reconciled
      // against the server's own view rather than trusted indefinitely.
      // Bare prefix because this response carries no conversationId to
      // scope it with (unlike `useRetranscribeAudioMutation`, which does).
      queryClient.invalidateQueries([QueryKeys.conversationTranscripts]);
      // See the matching comment in `useRetranscribeAudioMutation` - a
      // single-id key here would miss any batched poll where this file
      // isn't first.
      queryClient.invalidateQueries([QueryKeys.transcribeStatus]);
    },
  });
};

export interface CancelTranscriptionVariables {
  sourceFileId: string;
}

/** Best-effort cancel of a job that's still `queued`/`transcribing` - drives
 *  the composer's stop-square while a transcription is in flight. */
export const useCancelTranscriptionMutation = (): UseMutationResult<
  TTranscribeCancelResponse,
  unknown,
  CancelTranscriptionVariables,
  unknown
> => {
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  return useMutation([MutationKeys.cancelTranscription], {
    mutationFn: ({ sourceFileId }: CancelTranscriptionVariables) =>
      dataService.cancelTranscription(sourceFileId),
    onSuccess: () => {
      // Same reasoning as `useRetryTranscriptionMutation` above - the panel
      // reads its state from the transcripts query, so a cancel that only
      // refreshed the status poll left the panel showing the job as still
      // running until something unrelated refetched it.
      queryClient.invalidateQueries([QueryKeys.conversationTranscripts]);
      queryClient.invalidateQueries([QueryKeys.transcribeStatus]);
    },
    onError: (error) => {
      const status =
        error && typeof error === 'object' && 'response' in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (status === 409) {
        // The job already reached `ready`/`failed` before this request
        // landed (a real, narrow window - the status poll can lag the
        // server by up to its own interval) - the user's intent ("stop it")
        // is already satisfied, so this isn't a failure worth alarming them
        // over. Just make sure the UI reflects the real, current state
        // instead of leaving the stop-square looking like the click did
        // nothing at all - which means the panel's own query too, not only
        // the status poll.
        queryClient.invalidateQueries([QueryKeys.conversationTranscripts]);
        queryClient.invalidateQueries([QueryKeys.transcribeStatus]);
        return;
      }
      showToast({
        message: localize('com_ui_transcribe_cancel_error'),
        status: 'error',
      });
    },
  });
};

/** Renames a speaker - applies to every line from that speaker at once, since
 *  the name is a property of the speaker id, not any individual line. */
export interface ExportInterviewDocxVariables {
  sourceFileId: string;
  form: InterviewTranscriptForm;
  speakers: NamedSpeaker[];
}

/** The interview cover-sheet export - a real .docx from the server, not a
 *  client-built .txt approximation of one. Keyed by `sourceFileId`, not
 *  `conversationId` (a conversation may hold more than one recording). No
 *  cache to invalidate: this produces a file, not a change to the
 *  conversation. */
export const useExportInterviewDocxMutation = (): UseMutationResult<
  Blob,
  unknown,
  ExportInterviewDocxVariables,
  unknown
> => {
  return useMutation([MutationKeys.exportInterviewDocx], {
    mutationFn: ({ sourceFileId, form, speakers }: ExportInterviewDocxVariables) =>
      dataService.exportInterviewDocx(sourceFileId, form, speakers),
  });
};

export interface ExportMeetingMinutesDocxVariables {
  sourceFileId: string;
  form: MeetingMinutesForm;
  speakers: NamedSpeaker[];
}

/** The meeting-minutes export - same shape as `useExportInterviewDocxMutation`,
 *  a real .docx from the server with no cache to invalidate. */
export const useExportMeetingMinutesDocxMutation = (): UseMutationResult<
  Blob,
  unknown,
  ExportMeetingMinutesDocxVariables,
  unknown
> => {
  return useMutation([MutationKeys.exportMeetingMinutesDocx], {
    mutationFn: ({ sourceFileId, form, speakers }: ExportMeetingMinutesDocxVariables) =>
      dataService.exportMeetingMinutesDocx(sourceFileId, form, speakers),
  });
};

export const useRenameTranscriptSpeakerMutation = (
  transcriptFileId: string,
): UseMutationResult<TTranscriptCorrection, unknown, TSpeakerRenameRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.renameTranscriptSpeaker, transcriptFileId], {
    mutationFn: (body: TSpeakerRenameRequest) =>
      dataService.renameTranscriptSpeaker(transcriptFileId, body),
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.transcriptCorrections, transcriptFileId]);
    },
  });
};

/** Reassigns one misattributed line to a different (existing or brand-new)
 *  speaker id. Only that one line moves. */
export const useReassignTranscriptSegmentMutation = (
  transcriptFileId: string,
): UseMutationResult<TTranscriptCorrection, unknown, TSegmentReassignRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.reassignTranscriptSegment, transcriptFileId], {
    mutationFn: (body: TSegmentReassignRequest) =>
      dataService.reassignTranscriptSegment(transcriptFileId, body),
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.transcriptCorrections, transcriptFileId]);
    },
  });
};

/** Edits one line's transcribed text. Only that one line's text changes. */
export const useEditTranscriptTextMutation = (
  transcriptFileId: string,
): UseMutationResult<TTranscriptCorrection, unknown, TTextEditRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.editTranscriptText, transcriptFileId], {
    mutationFn: (body: TTextEditRequest) => dataService.editTranscriptText(transcriptFileId, body),
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.transcriptCorrections, transcriptFileId]);
    },
  });
};

/** Corrects one line's start/end time. Only that line's timing changes. */
export const useEditTranscriptTimeMutation = (
  transcriptFileId: string,
): UseMutationResult<TTranscriptCorrection, unknown, TTimeEditRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.editTranscriptTime, transcriptFileId], {
    mutationFn: (body: TTimeEditRequest) => dataService.editTranscriptTime(transcriptFileId, body),
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.transcriptCorrections, transcriptFileId]);
    },
  });
};

/** Removes a line outright. The neighbouring `time_edit` that takes over its
 *  time range is written by the same request server-side, so invalidating the
 *  correction log once picks up both. */
export const useDeleteTranscriptLineMutation = (
  transcriptFileId: string,
): UseMutationResult<TTranscriptCorrection, unknown, TLineDeleteRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.deleteTranscriptLine, transcriptFileId], {
    mutationFn: (body: TLineDeleteRequest) =>
      dataService.deleteTranscriptLine(transcriptFileId, body),
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.transcriptCorrections, transcriptFileId]);
    },
  });
};

/** Inserts a line the pipeline missed entirely - a new dialogue line, not a
 *  correction to an existing one. */
export const useInsertTranscriptLineMutation = (
  transcriptFileId: string,
): UseMutationResult<TTranscriptCorrection, unknown, TLineInsertRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.insertTranscriptLine, transcriptFileId], {
    mutationFn: (body: TLineInsertRequest) =>
      dataService.insertTranscriptLine(transcriptFileId, body),
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.transcriptCorrections, transcriptFileId]);
    },
  });
};
