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
import MultiChannelDialog from './MultiChannelDialog';
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

// Enough header/data for virtually every common container (WAV, MP3, AAC/M4A,
// OGG) to report its real channel count without decoding the whole file.
const CHANNEL_PROBE_CHUNK_BYTES = 5 * 1024 * 1024;
// A handful of container formats (some MP4/MOV muxings) put the metadata a
// truncated chunk can't reach at the end of the file, not the start - this
// bounds the full-file fallback decode so a multi-hour, multi-hundred-MB
// recording can't balloon into gigabytes of decoded PCM in the tab's memory
// just to answer a channel-count question.
const CHANNEL_PROBE_MAX_FULL_DECODE_BYTES = 150 * 1024 * 1024;

// -36 dBFS - well above the noise floor/digital silence, well below normal
// speech level, so "active" means "someone is plausibly talking," not "any
// signal at all."
const CHANNEL_ACTIVE_RMS_THRESHOLD = 0.015;
const CHANNEL_ACTIVITY_FRAME_SECONDS = 0.2;

/** Stereo is the overwhelming common case for 2-channel audio - a normal
 *  stereo mix, a single mic recorded in stereo, a dual-mono re-encode - and
 *  none of those are "one speaker per channel." Only a 2-channel file where
 *  the two channels are actually independent (one active while the other is
 *  silent, not both moving together) looks like a real per-speaker split;
 *  anything else would fire this dialog on nearly every video upload. 3+
 *  channels has no such common "just a normal mix" case, so it's taken as
 *  independent without this check. */
function looksLikeSeparateSpeakerChannels(buffer: AudioBuffer): boolean {
  if (buffer.numberOfChannels !== 2) {
    return true;
  }

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const frameSize = Math.max(1, Math.floor(buffer.sampleRate * CHANNEL_ACTIVITY_FRAME_SECONDS));
  const frameCount = Math.floor(Math.min(left.length, right.length) / frameSize);
  if (frameCount < 10) {
    // Too little decoded audio (short file, or a truncated probe chunk that
    // barely decoded) to judge confidently - default to the far more common
    // case, an ordinary stereo mix, rather than guess.
    return false;
  }

  let bothActive = 0;
  let oneActiveOnly = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameSize;
    const end = start + frameSize;
    let sumLeft = 0;
    let sumRight = 0;
    for (let i = start; i < end; i++) {
      sumLeft += left[i] * left[i];
      sumRight += right[i] * right[i];
    }
    const activeLeft = Math.sqrt(sumLeft / frameSize) > CHANNEL_ACTIVE_RMS_THRESHOLD;
    const activeRight = Math.sqrt(sumRight / frameSize) > CHANNEL_ACTIVE_RMS_THRESHOLD;
    if (activeLeft && activeRight) {
      bothActive += 1;
    } else if (activeLeft || activeRight) {
      oneActiveOnly += 1;
    }
  }

  const activeFrames = bothActive + oneActiveOnly;
  // Separate speaker channels spend most of their "someone's talking" time
  // with only one channel active; an ordinary stereo mix (or dual-mono) has
  // both channels active together almost whenever either one is.
  return activeFrames > 0 && oneActiveOnly / activeFrames > 0.6;
}

interface MultiChannelProbeResult {
  channelCount: number;
  looksLikeSeparateSpeakers: boolean;
}

/** Decodes enough of the file to answer "does this look like one speaker per
 *  channel" - best-effort, not authoritative: some containers/codecs the
 *  browser can't decode at all, and very large files are deliberately not
 *  decoded in full (see `CHANNEL_PROBE_MAX_FULL_DECODE_BYTES`). `null` means
 *  "couldn't tell," treated the same as "doesn't look separated" - the
 *  multi-channel dialog only ever shows on a positive, confident detection. */
async function probeMultiChannelAudio(file: File): Promise<MultiChannelProbeResult | null> {
  const AudioContextCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }
  const context = new AudioContextCtor();
  try {
    const chunk = await file.slice(0, CHANNEL_PROBE_CHUNK_BYTES).arrayBuffer();
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(chunk);
    } catch {
      if (file.size > CHANNEL_PROBE_MAX_FULL_DECODE_BYTES) {
        return null;
      }
      const full = await file.arrayBuffer();
      buffer = await context.decodeAudioData(full);
    }
    return {
      channelCount: buffer.numberOfChannels,
      looksLikeSeparateSpeakers: looksLikeSeparateSpeakerChannels(buffer),
    };
  } catch {
    return null;
  } finally {
    void context.close();
  }
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
  const [isChannelDialogOpen, setIsChannelDialogOpen] = useState(false);
  const [detectedChannelCount, setDetectedChannelCount] = useState(0);
  const [channelSplitChoice, setChannelSplitChoice] = useState(false);
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
    async (file: File) => {
      if (!isAudioOrVideo(file.type)) {
        setSelectionError(
          `${localize('com_ui_audio_transcriber_dropzone_invalid')} — ${localize('com_ui_audio_transcriber_dropzone_invalid_hint')}`,
        );
        return;
      }
      setSelectionError(null);
      mutation.reset();
      setPendingFile(file);
      setChannelSplitChoice(false);

      const probeResult = await probeMultiChannelAudio(file);
      if (
        probeResult != null &&
        probeResult.channelCount > 1 &&
        probeResult.looksLikeSeparateSpeakers
      ) {
        setDetectedChannelCount(probeResult.channelCount);
        setIsChannelDialogOpen(true);
        return;
      }
      setIsOptionsOpen(true);
    },
    // react-query's useMutation() returns a brand-new object every render;
    // only `.reset` itself is stable - see the same note on the mutation
    // hooks in `TranscriptPanel.tsx`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [localize, mutation.reset],
  );

  const handleChannelSplitAccept = useCallback(() => {
    setChannelSplitChoice(true);
    setIsOptionsOpen(true);
  }, []);

  const handleChannelSplitDecline = useCallback(() => {
    setChannelSplitChoice(false);
    setIsOptionsOpen(true);
  }, []);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      void openOptionsFor(file);
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
      void openOptionsFor(file);
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
    const finalOptions: TranscribeAudioOptions = channelSplitChoice
      ? { ...options, channelSplit: true }
      : options;
    setLastOptions(finalOptions);
    runTranscription(pendingFile, finalOptions);
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
    setChannelSplitChoice(false);
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
          modelLabel={lastOptions?.model || localize('com_ui_transcribe_model_auto')}
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
      <MultiChannelDialog
        isOpen={isChannelDialogOpen}
        onOpenChange={setIsChannelDialogOpen}
        channelCount={detectedChannelCount}
        onAccept={handleChannelSplitAccept}
        onDecline={handleChannelSplitDecline}
      />
      <TranscribeOptionsDialog
        isOpen={isOptionsOpen}
        onOpenChange={setIsOptionsOpen}
        onConfirm={handleConfirm}
        initialOptions={lastOptions ?? undefined}
        channelSplitEnabled={channelSplitChoice}
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
  modelLabel,
  onRetry,
  onChooseDifferent,
}: {
  file: File;
  isProcessing: boolean;
  uploadProgress: number;
  elapsedSeconds: number;
  isError: boolean;
  errorMessage: string;
  modelLabel: string;
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
          <p className="text-xs text-text-secondary">
            {localize('com_ui_audio_transcriber_model', { 0: modelLabel })}
          </p>
        </>
      )}
    </div>
  );
}
