import { useState } from 'react';
import { Mic, Plus } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import AgentBuilderCard from '~/components/Agents/layouts/AgentBuilderCard';
import AddVoiceProfileModal from '~/components/VoiceProfiles/AddVoiceProfileModal';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { SidePanelGroup } from '~/components/SidePanel';
import { useVoiceProfilesQuery } from '~/data-provider';
import { useLocalize, useDocumentTitle } from '~/hooks';

export default function VoiceProfilesView() {
  const localize = useLocalize();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { data: voiceProfiles, isLoading } = useVoiceProfilesQuery();

  useDocumentTitle(`${localize('com_ui_voice_profiles_title')} | LibreChat`);

  return (
    <div className="relative flex w-full grow overflow-hidden bg-presentation">
      <SidePanelGroup>
        <main className="flex h-full flex-col overflow-hidden" role="main">
          <div className="scrollbar-gutter-stable mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto px-4 py-6 lg:px-6">
            <div className="flex items-center gap-2 md:hidden">
              <OpenSidebar />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold text-text-primary">
                  {localize('com_ui_voice_profiles_title')}
                </h1>
                <p className="text-sm text-text-secondary">
                  {localize('com_ui_voice_profiles_description')}
                </p>
              </div>
              <Button variant="submit" onClick={() => setIsModalOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {localize('com_ui_voice_profile_add')}
              </Button>
            </div>

            {isLoading && (
              <div className="flex justify-center py-8">
                <Spinner aria-label={localize('com_ui_loading')} />
              </div>
            )}

            {!isLoading && (voiceProfiles?.length ?? 0) === 0 && (
              <AgentBuilderCard className="flex flex-col items-center gap-2 py-10 text-center">
                <Mic className="h-6 w-6 text-text-secondary" aria-hidden="true" />
                <p className="text-sm text-text-secondary">
                  {localize('com_ui_voice_profiles_empty')}
                </p>
              </AgentBuilderCard>
            )}

            {!isLoading && voiceProfiles != null && voiceProfiles.length > 0 && (
              <div className="flex flex-col gap-3">
                {voiceProfiles.map((profile) => (
                  <AgentBuilderCard
                    key={profile._id}
                    className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-text-primary">{profile.fullName}</p>
                      <p className="truncate text-sm text-text-secondary">{profile.role}</p>
                    </div>
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <audio controls src={profile.audio.filepath} className="h-9 w-full sm:w-64" />
                  </AgentBuilderCard>
                ))}
              </div>
            )}
          </div>
        </main>
      </SidePanelGroup>
      <AddVoiceProfileModal isOpen={isModalOpen} onOpenChange={setIsModalOpen} />
    </div>
  );
}
