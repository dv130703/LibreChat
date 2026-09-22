import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type { TVoiceProfile } from 'librechat-data-provider';

/** Enrolls a new speaker: a short audio sample plus who it is, so future
 *  transcription/diarization has something to attribute a voice to. */
export const useCreateVoiceProfileMutation = (): UseMutationResult<
  TVoiceProfile,
  unknown,
  FormData,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.createVoiceProfile], {
    mutationFn: (formData: FormData) => dataService.createVoiceProfile(formData),
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.voiceProfiles]);
    },
  });
};
