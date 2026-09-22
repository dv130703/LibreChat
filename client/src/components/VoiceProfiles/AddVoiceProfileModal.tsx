import { useCallback, useRef, useState } from 'react';
import { Mic, Upload } from 'lucide-react';
import {
  Input,
  Label,
  Button,
  Spinner,
  OGDialog,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import type { FormEvent } from 'react';
import { useCreateVoiceProfileMutation } from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';
import { cn } from '~/utils';

interface AddVoiceProfileModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AddVoiceProfileModal({ isOpen, onOpenChange }: AddVoiceProfileModalProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const createVoiceProfile = useCreateVoiceProfileMutation();

  const resetForm = useCallback(() => {
    setFullName('');
    setRole('');
    setAudioFile(null);
  }, []);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      resetForm();
    }
    onOpenChange(open);
  };

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('audio/')) {
      return;
    }
    setAudioFile(file);
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = fullName.trim();
    const trimmedRole = role.trim();
    if (!trimmedName || !trimmedRole || !audioFile) {
      showToast({ status: 'error', message: localize('com_ui_voice_profile_missing_fields') });
      return;
    }
    const formData = new FormData();
    formData.append('fullName', trimmedName);
    formData.append('role', trimmedRole);
    formData.append('file', audioFile, audioFile.name);
    createVoiceProfile.mutate(formData, {
      onSuccess: () => {
        showToast({ status: 'success', message: localize('com_ui_voice_profile_created') });
        handleOpenChange(false);
      },
      onError: (error: unknown) => {
        const errData = (error as { response?: { data?: { error?: string } } })?.response?.data;
        showToast({
          status: 'error',
          message: errData?.error ?? localize('com_ui_voice_profile_create_error'),
        });
      },
    });
  };

  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_voice_profile_add_title')}
        description={localize('com_ui_voice_profile_add_description')}
        className="w-11/12 sm:w-[26rem]"
        showCloseButton
        main={
          <form id="add-voice-profile-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="voice-profile-full-name">
                {localize('com_ui_voice_profile_full_name_label')}
              </Label>
              <Input
                id="voice-profile-full-name"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder={localize('com_ui_voice_profile_full_name_placeholder')}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="voice-profile-role">
                {localize('com_ui_voice_profile_role_label')}
              </Label>
              <Input
                id="voice-profile-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder={localize('com_ui_voice_profile_role_placeholder')}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="voice-profile-audio">
                {localize('com_ui_voice_profile_audio_label')}
              </Label>
              <button
                id="voice-profile-audio"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  const file = event.dataTransfer.files?.[0];
                  if (file) {
                    handleFile(file);
                  }
                }}
                className={cn(
                  'flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-sm text-text-secondary transition-colors',
                  isDragging
                    ? 'border-border-heavy bg-surface-hover'
                    : 'border-border-medium hover:bg-surface-hover',
                )}
              >
                {audioFile ? (
                  <>
                    <Mic className="h-5 w-5" aria-hidden="true" />
                    <span className="max-w-[90%] truncate font-medium text-text-primary">
                      {audioFile.name}
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="h-5 w-5" aria-hidden="true" />
                    {localize('com_ui_voice_profile_audio_drag')}
                  </>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    handleFile(file);
                  }
                  event.target.value = '';
                }}
              />
            </div>
          </form>
        }
        selection={
          <Button
            type="submit"
            form="add-voice-profile-form"
            variant="submit"
            disabled={createVoiceProfile.isLoading}
          >
            {createVoiceProfile.isLoading ? (
              <Spinner className="size-4" />
            ) : (
              localize('com_ui_voice_profile_save')
            )}
          </Button>
        }
      />
    </OGDialog>
  );
}
