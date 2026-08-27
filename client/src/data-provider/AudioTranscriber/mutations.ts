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

/** Uploads an audio/video file for transcription and RAG embedding, scoped to
 *  one conversation. A direct REST action (see `POST /api/transcribe`), not an
 *  agent tool call - real transcriptions take 30-90s+. */
export const useTranscribeAudioMutation = (): UseMutationResult<
  TTranscribeResponse,
  unknown,
  FormData,
  unknown
> => {
  return useMutation([MutationKeys.transcribeAudio], {
    mutationFn: (body: FormData) => dataService.transcribeAudio(body),
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
