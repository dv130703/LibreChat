import { useRef, useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useNavigate } from 'react-router-dom';
import { Upload, FileAudio, FileVideo, AlertTriangle } from 'lucide-react';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useTranscribeAudioMutation, useGetEndpointsQuery } from '~/data-provider';
import { useUpdateEphemeralAgent, useFlagAudioTranscriberConvo } from '~/store';
import { cn, getLocalStorageItems } from '~/utils';
import getDefaultEndpoint from '~/utils/getDefaultEndpoint';
import TranscribeOptionsDialog from './TranscribeOptionsDialog';
import type { TranscribeAudioOptions } from './TranscribeOptionsDialog';

const ACCEPT = 'audio/*,video/*';
/** Recognizable examples, not an exhaustive list - `ACCEPT` takes any
 *  audio/video mime type the browser reports, this is just a visual cue for
 *  "yes, formats like these work" instead of a bare sentence promising it. */
const FORMAT_HINTS = ['MP3', 'WAV', 'M4A', 'MP4', 'MOV'];

function isAudioOrVideo(type: string): boolean {
  return type.startsWith('audio/') || type.startsWith('video/');
}

/** Whether every dragged item the browser will let us inspect mid-drag is a
 *  recognizable audio/video type. Browsers vary in whether `DataTransferItem.type`
 *  is populated before drop - when it isn't, this reports "unknown" rather than
 *  a false "invalid", since a wrong warning is worse than no warning yet. */
function getDragValidity(dataTransfer: DataTransfer | null): 'valid' | 'invalid' | 'unknown' {
  if (!dataTransfer) {
    return 'unknown';
  }
  const items = Array.from(dataTransfer.items).filter((item) => item.kind === 'file');
  if (items.length === 0 || items.some((item) => !item.type)) {
    return 'unknown';
  }
  return items.every((item) => isAudioOrVideo(item.type)) ? 'valid' : 'invalid';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** The backend's own diagnosis (e.g. "Diarization produced no speaker
 *  segments...") when there is one - a real cause beats a generic apology. */
function getUploadErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) {
      return response.data.error;
    }
  }
  return fallback;
}

type DropzoneCopyKey = 'title' | 'hint';
const DROPZONE_COPY: Record<
  'none' | 'valid' | 'invalid',
  Record<DropzoneCopyKey, TranslationKeys>
> = {
  none: {
    title: 'com_ui_audio_transcriber_dropzone',
    hint: 'com_ui_audio_transcriber_dropzone_hint',
  },
  valid: {
    title: 'com_ui_audio_transcriber_dropzone_active',
    hint: 'com_ui_audio_transcriber_dropzone_release',
  },
  invalid: {
    title: 'com_ui_audio_transcriber_dropzone_invalid',
    hint: 'com_ui_audio_transcriber_dropzone_invalid_hint',
  },
};

export default function UploadStep() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [lastOptions, setLastOptions] = useState<TranscribeAudioOptions | null>(null);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [dragState, setDragState] = useState<'none' | 'valid' | 'invalid'>('none');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const updateEphemeralAgent = useUpdateEphemeralAgent();
  const flagAudioTranscriberConvo = useFlagAudioTranscriberConvo();
  const mutation = useTranscribeAudioMutation();

  useEffect(() => {
    if (!mutation.isLoading) {
      setElapsedSeconds(0);
      return;
    }
    const interval = window.setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(interval);
  }, [mutation.isLoading]);

  const openOptionsFor = useCallback(
    (file: File) => {
      if (!isAudioOrVideo(file.type)) {
        setSelectionError(
          `${localize('com_ui_audio_transcriber_dropzone_invalid')} — ${localize('com_ui_audio_transcriber_dropzone_invalid_hint')}`,
        );
        return;
      }
      setSelectionError(null);
      mutation.reset();
      setPendingFile(file);
      setIsOptionsOpen(true);
    },
    // react-query's useMutation() returns a brand-new object every render;
    // only `.reset` itself is stable - see the same note on the mutation
    // hooks in `TranscriptPanel.tsx`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [localize, mutation.reset],
  );

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      openOptionsFor(file);
    }
    event.target.value = '';
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const validity = getDragValidity(event.dataTransfer);
    setDragState((current) => {
      if (validity !== 'unknown') {
        return validity;
      }
      // Can't tell yet (browser doesn't expose item types until drop) - default
      // to the active-but-neutral "valid" look rather than staying idle, but
      // don't clobber a validity this same drag already determined.
      return current === 'none' ? 'valid' : current;
    });
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    // Only clear when the pointer actually leaves the dropzone, not when it
    // crosses into a child element inside it - without this check, moving the
    // cursor over the icon/text/button flickers the active state off and on.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setDragState('none');
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragState('none');
    const file = event.dataTransfer.files?.[0];
    if (file) {
      openOptionsFor(file);
    }
  };

  const runTranscription = useCallback(
    (file: File, options: TranscribeAudioOptions) => {
      const conversationId = uuidv4();
      const { lastConversationSetup } = getLocalStorageItems();
      const endpoint =
        lastConversationSetup?.endpoint ??
        getDefaultEndpoint({ convoSetup: {}, endpointsConfig: endpointsConfig ?? {} });

      const formData = new FormData();
      formData.append('file', file);
      formData.append('conversationId', conversationId);
      if (endpoint) {
        formData.append('endpoint', endpoint);
      }
      if (lastConversationSetup?.agent_id) {
        formData.append('agent_id', lastConversationSetup.agent_id);
      }
      formData.append('options', JSON.stringify(options));

      setUploadProgress(0);
      mutation.mutate(
        { formData, onUploadProgress: setUploadProgress },
        {
          onSuccess: () => {
            // Both facts set before the navigate, not after: `ChatRoute` (mounted
            // by `Workspace`) hydrates by calling `newConversation()`, which
            // navigates straight to `/c/:conversationId`. `RedirectGuard` is what
            // snaps that back, and it answers from this flag first - so setting it
            // here is what keeps the plain chat view from showing up in between.
            flagAudioTranscriberConvo(conversationId);
            updateEphemeralAgent(conversationId, { file_search: true });
            navigate(`/audio-transcriber/${conversationId}`, { replace: true });
          },
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpointsConfig, mutation.mutate, flagAudioTranscriberConvo, updateEphemeralAgent, navigate],
  );

  const handleConfirm = (options: TranscribeAudioOptions) => {
    if (!pendingFile) {
      return;
    }
    setLastOptions(options);
    runTranscription(pendingFile, options);
  };

  const handleRetry = () => {
    if (!pendingFile || !lastOptions) {
      return;
    }
    mutation.reset();
    runTranscription(pendingFile, lastOptions);
  };

  const handleChooseDifferent = () => {
    mutation.reset();
    setPendingFile(null);
    setUploadProgress(null);
    inputRef.current?.click();
  };

  const isBusy = mutation.isLoading;
  const isProcessing = isBusy && (uploadProgress ?? 0) >= 100;
  const showFileCard = pendingFile != null && (isBusy || mutation.isError);

  let statusText = '';
  if (mutation.isError) {
    const reason = getUploadErrorMessage(
      mutation.error,
      localize('com_ui_audio_transcriber_error'),
    );
    statusText = `${localize('com_ui_audio_transcriber_upload_failed')}: ${reason}`;
  } else if (isProcessing) {
    statusText = localize('com_ui_audio_transcriber_processing', { 0: String(elapsedSeconds) });
  } else if (isBusy) {
    statusText = localize('com_ui_audio_transcriber_uploading', { 0: String(uploadProgress ?? 0) });
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      {/* Announced to screen readers on every phase change - the visual card
       *  below covers sighted users, this covers everyone else without
       *  needing focus to move anywhere. */}
      <p role="status" aria-live="polite" className="sr-only">
        {statusText}
      </p>

      {showFileCard && pendingFile ? (
        <FileProgressCard
          file={pendingFile}
          isProcessing={isProcessing}
          uploadProgress={uploadProgress ?? 0}
          elapsedSeconds={elapsedSeconds}
          isError={mutation.isError}
          errorMessage={getUploadErrorMessage(
            mutation.error,
            localize('com_ui_audio_transcriber_error'),
          )}
          onRetry={handleRetry}
          onChooseDifferent={handleChooseDifferent}
        />
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label={localize('com_ui_audio_transcriber_upload_label')}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragEnter={handleDragEnter}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'flex w-full max-w-md cursor-pointer flex-col items-center gap-2.5 rounded-xl border border-dashed p-6 text-center outline-none transition-colors duration-150 motion-reduce:transition-none',
            'focus-visible:!outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary',
            dragState === 'valid' && 'border-blue-500 bg-blue-500/5 dark:border-blue-400',
            dragState === 'invalid' && 'border-red-500 bg-red-500/5 dark:border-red-400',
            dragState === 'none' &&
              'border-border-medium bg-surface-secondary hover:border-border-heavy hover:bg-surface-hover',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors duration-150 motion-reduce:transition-none',
              dragState === 'valid' && 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
              dragState === 'invalid' && 'bg-red-500/10 text-red-600 dark:text-red-400',
              dragState === 'none' && 'bg-surface-tertiary text-text-secondary',
            )}
          >
            {dragState === 'invalid' ? (
              <AlertTriangle className="h-5 w-5" />
            ) : (
              <Upload className="h-5 w-5" />
            )}
          </span>

          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold text-text-primary">
              {localize(DROPZONE_COPY[dragState].title)}
            </p>
            <p className="text-xs text-text-secondary">{localize(DROPZONE_COPY[dragState].hint)}</p>
          </div>

          {dragState === 'none' && (
            <p className="text-[11px] text-text-secondary">{FORMAT_HINTS.join(' · ')}</p>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={handleFileChange}
      />
      {selectionError && (
        <p role="alert" className="max-w-md text-center text-xs text-red-500">
          {selectionError}
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

function FileProgressCard({
  file,
  isProcessing,
  uploadProgress,
  elapsedSeconds,
  isError,
  errorMessage,
  onRetry,
  onChooseDifferent,
}: {
  file: File;
  isProcessing: boolean;
  uploadProgress: number;
  elapsedSeconds: number;
  isError: boolean;
  errorMessage: string;
  onRetry: () => void;
  onChooseDifferent: () => void;
}) {
  const localize = useLocalize();
  const FileIcon = file.type.startsWith('video/') ? FileVideo : FileAudio;

  return (
    <div
      className={cn(
        'flex w-full max-w-md flex-col gap-3 rounded-xl border p-4 transition-colors duration-150 motion-reduce:transition-none',
        isError ? 'border-red-500/40 bg-red-500/5' : 'border-border-medium bg-surface-secondary',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            isError
              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
              : 'bg-surface-tertiary text-text-secondary',
          )}
        >
          {isError ? <AlertTriangle className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary" title={file.name}>
            {file.name}
          </p>
          <p className="text-xs text-text-secondary">{formatFileSize(file.size)}</p>
        </div>
      </div>

      {isError ? (
        <>
          <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-border-medium bg-surface-primary px-3 py-1.5 text-xs font-medium text-text-primary transition-colors duration-150 hover:bg-surface-hover motion-reduce:transition-none"
            >
              {localize('com_ui_audio_transcriber_try_again')}
            </button>
            <button
              type="button"
              onClick={onChooseDifferent}
              className="text-xs font-medium text-text-secondary underline-offset-2 transition-colors duration-150 hover:text-text-primary hover:underline motion-reduce:transition-none"
            >
              {localize('com_ui_audio_transcriber_choose_different')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
            <div
              className={cn(
                'h-full rounded-full bg-blue-500 transition-[width] duration-150 motion-reduce:transition-none',
                isProcessing && 'motion-safe:animate-pulse',
              )}
              style={{ width: `${isProcessing ? 100 : uploadProgress}%` }}
            />
          </div>
          <p className="text-xs text-text-secondary">
            {isProcessing
              ? localize('com_ui_audio_transcriber_processing', { 0: String(elapsedSeconds) })
              : localize('com_ui_audio_transcriber_uploading', { 0: String(uploadProgress) })}
          </p>
        </>
      )}
    </div>
  );
}
