import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  TTranscribeResponse,
  TTranscriptCorrection,
  TSpeakerRenameRequest,
  TSegmentReassignRequest,
  TTextEditRequest,
  TLineInsertRequest,
} from 'librechat-data-provider';

export interface TranscribeAudioVariables {
  formData: FormData;
  /** Real, byte-level progress for the upload leg only - see `transcribeAudio`
   *  in `data-service.ts`. There's no signal at all for the transcription/
   *  embedding leg that follows; callers show an indeterminate state for that. */
  onUploadProgress?: (percent: number) => void;
}

/** Uploads an audio/video file for transcription and RAG embedding, scoped to
 *  one conversation. A direct REST action (see `POST /api/transcribe`), not an
 *  agent tool call - real transcriptions take 30-90s+. */
export const useTranscribeAudioMutation = (): UseMutationResult<
  TTranscribeResponse,
  unknown,
  TranscribeAudioVariables,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.transcribeAudio], {
    mutationFn: ({ formData, onUploadProgress }: TranscribeAudioVariables) =>
      dataService.transcribeAudio(formData, null, onUploadProgress),
    onSuccess: (data) => {
      // The conversation is created by the route only once the transcript
      // exists, so the moment this resolves is the first moment it is real.
      // Nothing else will go looking for it: the sidebar list is an infinite
      // query that refetches on its own schedule, and `useGetConvoIdQuery`
      // reads that same cache first and is configured `refetchOnMount: false`.
      // Left uninvalidated, the finished conversation is simply absent from the
      // sidebar, and the one query that decides whether this is a transcriber
      // conversation at all answers from a cache written before it existed.
      queryClient.invalidateQueries([QueryKeys.allConversations]);
      queryClient.invalidateQueries([QueryKeys.conversation, data.conversationId]);
    },
  });
};

/** Renames a speaker - applies to every line from that speaker at once, since
 *  the name is a property of the speaker id, not any individual line. */
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
