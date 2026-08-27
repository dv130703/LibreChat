import { useRef, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { useTranscribeAudioMutation } from '~/data-provider';
import { useGetEndpointsQuery } from '~/data-provider';
import { useUpdateEphemeralAgent } from '~/store';
import { getLocalStorageItems } from '~/utils';
import getDefaultEndpoint from '~/utils/getDefaultEndpoint';
import TranscribeOptionsDialog from './TranscribeOptionsDialog';
import type { TranscribeAudioOptions } from './TranscribeOptionsDialog';

const ACCEPT = 'audio/*,video/*';

export default function UploadStep() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const updateEphemeralAgent = useUpdateEphemeralAgent();
  const mutation = useTranscribeAudioMutation();

  useEffect(() => {
    if (!mutation.isLoading) {
      setElapsedSeconds(0);
      return;
    }
    const interval = window.setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(interval);
  }, [mutation.isLoading]);

  const openOptionsFor = useCallback((file: File) => {
    setPendingFile(file);
    setIsOptionsOpen(true);
  }, []);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      openOptionsFor(file);
    }
    event.target.value = '';
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      openOptionsFor(file);
    }
  };

  const handleConfirm = (options: TranscribeAudioOptions) => {
    if (!pendingFile) {
      return;
    }
    const conversationId = crypto.randomUUID();
    const { lastConversationSetup } = getLocalStorageItems();
    const endpoint =
      lastConversationSetup?.endpoint ??
      getDefaultEndpoint({ convoSetup: {}, endpointsConfig: endpointsConfig ?? {} });

    const formData = new FormData();
    formData.append('file', pendingFile);
    formData.append('conversationId', conversationId);
    if (endpoint) {
      formData.append('endpoint', endpoint);
    }
    if (lastConversationSetup?.agent_id) {
      formData.append('agent_id', lastConversationSetup.agent_id);
    }
    formData.append('options', JSON.stringify(options));

    mutation.mutate(formData, {
      onSuccess: () => {
        updateEphemeralAgent(conversationId, { file_search: true });
        navigate(`/audio-transcriber/${conversationId}`, { replace: true });
      },
    });
    setPendingFile(null);
  };

  if (mutation.isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner className="text-text-primary" />
        <p className="text-sm text-text-secondary">
          {localize('com_ui_transcribing_elapsed', { 0: String(elapsedSeconds) })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragActive(true);
        }}
        onDragLeave={() => setIsDragActive(false)}
        onDrop={handleDrop}
        className={`flex w-full max-w-md cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          isDragActive ? 'border-primary bg-surface-hover' : 'border-border-medium'
        }`}
      >
        <p className="text-sm font-medium text-text-primary">
          {localize('com_ui_audio_transcriber_dropzone')}
        </p>
        <p className="text-xs text-text-secondary">
          {localize('com_ui_audio_transcriber_dropzone_hint')}
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={handleFileChange}
      />
      {mutation.isError && (
        <p role="alert" className="text-sm text-red-500">
          {localize('com_ui_audio_transcriber_error')}
        </p>
      )}
      <TranscribeOptionsDialog
        isOpen={isOptionsOpen}
        onOpenChange={setIsOptionsOpen}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
