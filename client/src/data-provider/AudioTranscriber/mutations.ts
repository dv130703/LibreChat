import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  TTranscribeOptions,
  TTranscribeResponse,
  TTranscriptCorrection,
  InterviewTranscriptForm,
  MeetingMinutesForm,
  NamedSpeaker,
  TSpeakerRenameRequest,
  TSegmentReassignRequest,
  TTextEditRequest,
  TLineInsertRequest,
  TTimeEditRequest,
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

export interface RetranscribeAudioVariables {
  conversationId: string;
  options: TTranscribeOptions;
}

/** Re-runs transcription on the audio already stored for a conversation,
 *  replacing that transcript in place. There is no upload leg and no progress
 *  signal, so callers show an indeterminate state for the whole run. */
export const useRetranscribeAudioMutation = (): UseMutationResult<
  TTranscribeResponse,
  unknown,
  RetranscribeAudioVariables,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.retranscribeAudio], {
    mutationFn: ({ conversationId, options }: RetranscribeAudioVariables) =>
      dataService.retranscribeAudio(conversationId, options),
    onSuccess: (data) => {
      // The transcript file keeps its id but its content is wholly replaced,
      // so the preview cache is the one thing guaranteed to be wrong here.
      // Corrections are cleared server-side (their line indices address text
      // that no longer exists), and the conversation carries the new model.
      queryClient.invalidateQueries([QueryKeys.conversation, data.conversationId]);
      queryClient.invalidateQueries([QueryKeys.filePreview, data.transcriptFile?.file_id]);
      queryClient.invalidateQueries([
        QueryKeys.transcriptCorrections,
        data.transcriptFile?.file_id,
      ]);
    },
  });
};

/** Renames a speaker - applies to every line from that speaker at once, since
 *  the name is a property of the speaker id, not any individual line. */
export interface ExportInterviewDocxVariables {
  conversationId: string;
  form: InterviewTranscriptForm;
  speakers: NamedSpeaker[];
}

/** The interview cover-sheet export - a real .docx from the server, not a
 *  client-built .txt approximation of one. No cache to invalidate: this
 *  produces a file, not a change to the conversation. */
export const useExportInterviewDocxMutation = (): UseMutationResult<
  Blob,
  unknown,
  ExportInterviewDocxVariables,
  unknown
> => {
  return useMutation([MutationKeys.exportInterviewDocx], {
    mutationFn: ({ conversationId, form, speakers }: ExportInterviewDocxVariables) =>
      dataService.exportInterviewDocx(conversationId, form, speakers),
  });
};

export interface ExportMeetingMinutesDocxVariables {
  conversationId: string;
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
    mutationFn: ({ conversationId, form, speakers }: ExportMeetingMinutesDocxVariables) =>
      dataService.exportMeetingMinutesDocx(conversationId, form, speakers),
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
