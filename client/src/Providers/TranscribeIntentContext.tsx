import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import TranscribeIntentDialog from '~/components/AudioTranscriber/TranscribeIntentDialog';
import MultiChannelDialog from '~/components/AudioTranscriber/MultiChannelDialog';
import TranscribeOptionsDialog from '~/components/AudioTranscriber/TranscribeOptionsDialog';
import type { TranscribeAudioOptions } from '~/components/AudioTranscriber/TranscribeOptionsDialog';
import { probeChannelCount } from '~/components/AudioTranscriber/probeChannelCount';

export type TranscribeIntentResult =
  | { action: 'attach' }
  | { action: 'cancel' }
  | { action: 'transcribe'; options: TranscribeAudioOptions };

interface TranscribeIntentContextValue {
  /** Awaited by `useFileHandling`'s `handleFiles` at the point it would
   *  otherwise start a normal upload for an audio/video file (Phase 4,
   *  transcription/ARCHITECTURE.md §6.1/§6.4) - resolves once the user has
   *  picked "transcribe" (with the options they configured) or "attach," or
   *  dismissed every dialog in the sequence without choosing either.
   *  `canAttachNatively` skips straight past the transcribe-or-attach
   *  fork to the options dialog when the current endpoint can't accept
   *  audio/video as a plain attachment anyway. */
  interceptAudioVideo: (file: File, canAttachNatively: boolean) => Promise<TranscribeIntentResult>;
}

const defaultValue: TranscribeIntentContextValue = {
  interceptAudioVideo: async () => ({ action: 'attach' }),
};

const TranscribeIntentContext = createContext<TranscribeIntentContextValue>(defaultValue);

export function useTranscribeIntent() {
  return useContext(TranscribeIntentContext);
}

type Stage =
  | { name: 'intent'; file: File }
  | { name: 'multiChannel'; file: File; channelCount: number }
  | { name: 'options'; file: File; channelSplitEnabled: boolean };

export function TranscribeIntentProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage | null>(null);
  const resolveRef = useRef<((result: TranscribeIntentResult) => void) | null>(null);
  /** Distinguishes a real explicit choice (a button click, which sets this
   *  synchronously before the dialog calls `onOpenChange(false)` on itself)
   *  from an Escape/backdrop dismiss, which reaches the same `onOpenChange`
   *  callback with no prior choice made - the two need different outcomes
   *  (advance the flow vs. cancel it), but Radix reports them identically.
   *
   *  Reset in a `useEffect` keyed on `stage`, deliberately *not* synchronously
   *  inside `openStage` - a real bug this exact ordering caused: `onAccept`/
   *  `onDecline` set this to `true`, then synchronously call `openStage`,
   *  and the dialog's own `handleAccept` calls `onOpenChange(false)` right
   *  after (all in the same click handler, same tick). If `openStage` reset
   *  the flag immediately, that later `onOpenChange(false)` call - from the
   *  dialog now being replaced - would see a freshly-cleared flag and read
   *  as "dismissed with no choice," silently resolving `cancel` right after
   *  a real choice had just been made (the whole flow would end with no
   *  visible error - "nothing happens" from the user's side, since the
   *  cancel path just quietly removes the file). Deferring the reset to an
   *  effect guarantees it only runs after the commit that swaps dialogs -
   *  strictly after every synchronous `onOpenChange` call from the same
   *  click, including any duplicate Radix fires around the old dialog's own
   *  teardown - so it can never race the transition it belongs to. */
  const choiceMadeRef = useRef(false);

  const openStage = useCallback((next: Stage) => {
    setStage(next);
  }, []);

  useEffect(() => {
    choiceMadeRef.current = false;
  }, [stage]);

  const finish = useCallback((result: TranscribeIntentResult) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setStage(null);
    resolve?.(result);
  }, []);

  const runChannelCheck = useCallback(
    async (file: File) => {
      const channelCount = await probeChannelCount(file);
      if (channelCount != null && channelCount > 1) {
        openStage({ name: 'multiChannel', file, channelCount });
        return;
      }
      openStage({ name: 'options', file, channelSplitEnabled: false });
    },
    [openStage],
  );

  const interceptAudioVideo = useCallback(
    (file: File, canAttachNatively: boolean) => {
      return new Promise<TranscribeIntentResult>((resolve) => {
        resolveRef.current = resolve;
        if (!canAttachNatively) {
          void runChannelCheck(file);
          return;
        }
        openStage({ name: 'intent', file });
      });
    },
    [runChannelCheck, openStage],
  );

  const contextValue = useMemo<TranscribeIntentContextValue>(
    () => ({ interceptAudioVideo }),
    [interceptAudioVideo],
  );

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !choiceMadeRef.current) {
        choiceMadeRef.current = true;
        finish({ action: 'cancel' });
      }
    },
    [finish],
  );

  return (
    <TranscribeIntentContext.Provider value={contextValue}>
      {children}
      {stage?.name === 'intent' && (
        <TranscribeIntentDialog
          isOpen
          onOpenChange={handleDialogOpenChange}
          filename={stage.file.name}
          onTranscribe={() => {
            choiceMadeRef.current = true;
            void runChannelCheck(stage.file);
          }}
          onAttach={() => {
            choiceMadeRef.current = true;
            finish({ action: 'attach' });
          }}
        />
      )}
      {stage?.name === 'multiChannel' && (
        <MultiChannelDialog
          isOpen
          onOpenChange={handleDialogOpenChange}
          channelCount={stage.channelCount}
          onAccept={() => {
            choiceMadeRef.current = true;
            openStage({ name: 'options', file: stage.file, channelSplitEnabled: true });
          }}
          onDecline={() => {
            choiceMadeRef.current = true;
            openStage({ name: 'options', file: stage.file, channelSplitEnabled: false });
          }}
        />
      )}
      {stage?.name === 'options' && (
        <TranscribeOptionsDialog
          isOpen
          onOpenChange={handleDialogOpenChange}
          channelSplitEnabled={stage.channelSplitEnabled}
          onConfirm={(options) => {
            choiceMadeRef.current = true;
            finish({
              action: 'transcribe',
              options: { ...options, channelSplit: stage.channelSplitEnabled },
            });
          }}
        />
      )}
    </TranscribeIntentContext.Provider>
  );
}
