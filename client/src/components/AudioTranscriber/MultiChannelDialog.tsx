import { AudioLines } from 'lucide-react';
import { OGDialog, OGDialogTemplate, Button } from '@librechat/client';
import useLocalize from '~/hooks/useLocalize';

interface MultiChannelDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many channels were detected - shown so "why am I seeing this" has
   *  an immediate, concrete answer instead of a generic notice. */
  channelCount: number;
  /** Split by channel - each channel is transcribed and labelled as its own
   *  speaker, skipping pyannote's clustering entirely. */
  onAccept: () => void;
  /** Decline - fall back to the normal pyannote speaker-diarization path,
   *  as if this recording were mono. */
  onDecline: () => void;
}

/**
 * Shown once, right after a file is picked, only when the browser can tell
 * the recording has 3 or more audio channels - the common shape of a
 * multi-mic call recording or interview, where each channel already IS one
 * speaker. (2 channels is left alone, since that's ordinarily just stereo
 * rather than one speaker per channel.) Splitting by channel in that case
 * is more accurate than asking pyannote to guess who's who from a single
 * mixed-down stream, so this dialog exists to offer that shortcut rather
 * than assume it.
 */
export default function MultiChannelDialog({
  isOpen,
  onOpenChange,
  channelCount,
  onAccept,
  onDecline,
}: MultiChannelDialogProps) {
  const localize = useLocalize();

  const handleAccept = () => {
    onAccept();
    onOpenChange(false);
  };

  const handleDecline = () => {
    onDecline();
    onOpenChange(false);
  };

  return (
    <OGDialog open={isOpen} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_multi_channel_dialog_title')}
        className="w-11/12 border border-solid border-border-medium bg-surface-tertiary sm:w-[26rem]"
        showCloseButton={false}
        showCancelButton={false}
        footerClassName="[&>*]:flex-1 [&>*]:justify-center"
        main={
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5">
              <AudioLines
                className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary"
                aria-hidden="true"
              />
              <p className="text-sm text-text-secondary">
                {localize('com_ui_multi_channel_dialog_description', { 0: String(channelCount) })}
              </p>
            </div>
          </div>
        }
        buttons={
          <Button variant="outline" onClick={handleDecline}>
            {localize('com_ui_multi_channel_dialog_decline')}
          </Button>
        }
        selection={
          <Button variant="submit" onClick={handleAccept}>
            {localize('com_ui_multi_channel_dialog_accept')}
          </Button>
        }
      />
    </OGDialog>
  );
}
