import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type { TVoiceProfile } from 'librechat-data-provider';

export const useVoiceProfilesQuery = (
  config?: UseQueryOptions<TVoiceProfile[]>,
): QueryObserverResult<TVoiceProfile[]> => {
  return useQuery<TVoiceProfile[]>(
    [QueryKeys.voiceProfiles],
    () => dataService.getVoiceProfiles(),
    {
      ...config,
    },
  );
};
