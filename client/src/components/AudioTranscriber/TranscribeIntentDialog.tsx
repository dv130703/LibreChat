import { FileAudio } from 'lucide-react';
import { OGDialog, OGDialogTemplate, Button } from '@librechat/client';
import useLocalize from '~/hooks/useLocalize';

interface TranscribeIntentDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  filename: string;
  /** Transcribe this recording - routes to `POST /api/transcribe` instead of
   *  the normal attachment upload; a `TranscriptCard` takes the file's place
   *  in the composer once queued. */
  onTranscribe: () => void;
  /** Attach as a plain file - the existing, unmodified upload path. */
  onAttach: () => void;
}

/**
 * Shown once, right after an audio/video file is dropped/pasted/picked into
 * the composer of an ongoing chat (Phase 4, transcription/ARCHITECTURE.md
 * §6.1/§6.4) - the fork between "transcribe this" and "just attach it like
 * any other file." Modeled on `MultiChannelDialog`.
 */
export default function TranscribeIntentDialog({
  isOpen,
  onOpenChange,
  filename,
  onTranscribe,
  onAttach,
}: TranscribeIntentDialogProps) {
  const localize = useLocalize();

  const handleTranscribe = () => {
    onTranscribe();
    onOpenChange(false);
  };

  const handleAttach = () => {
    onAttach();
    onOpenChange(false);
  };

  return (
    <OGDialog open={isOpen} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_transcribe_intent_dialog_title')}
        className="w-11/12 border border-solid border-border-medium bg-surface-tertiary sm:w-[26rem]"
        showCloseButton={false}
        showCancelButton={false}
        footerClassName="[&>*]:flex-1 [&>*]:justify-center"
        main={
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5">
              <FileAudio
                className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary"
                aria-hidden="true"
              />
              <p className="text-sm text-text-secondary">
                {localize('com_ui_transcribe_intent_dialog_description', { 0: filename })}
              </p>
            </div>
          </div>
        }
        buttons={
          <Button variant="outline" onClick={handleAttach}>
            {localize('com_ui_transcribe_intent_dialog_attach')}
          </Button>
        }
        selection={
          <Button variant="submit" onClick={handleTranscribe}>
            {localize('com_ui_transcribe_intent_dialog_transcribe')}
          </Button>
        }
      />
    </OGDialog>
  );
}
