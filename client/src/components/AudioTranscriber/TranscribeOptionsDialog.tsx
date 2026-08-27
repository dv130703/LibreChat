import { useState } from 'react';
import { OGDialog, OGDialogTemplate, Switch, Input, Label } from '@librechat/client';
import { useLocalize } from '~/hooks';

export interface TranscribeAudioOptions {
  includeTimestamps: boolean;
  diarize: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
}

const DEFAULT_OPTIONS: TranscribeAudioOptions = {
  includeTimestamps: true,
  diarize: true,
};

/** Blank or non-positive-integer input means "auto" (omit the hint entirely). */
function parseSpeakerCount(raw: string): number | undefined {
  const value = Number(raw.trim());
  if (!raw.trim() || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

interface TranscribeOptionsDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (options: TranscribeAudioOptions) => void;
}

export default function TranscribeOptionsDialog({
  isOpen,
  onOpenChange,
  onConfirm,
}: TranscribeOptionsDialogProps) {
  const localize = useLocalize();
  const [includeTimestamps, setIncludeTimestamps] = useState(DEFAULT_OPTIONS.includeTimestamps);
  const [diarize, setDiarize] = useState(DEFAULT_OPTIONS.diarize);
  const [minSpeakers, setMinSpeakers] = useState('');
  const [maxSpeakers, setMaxSpeakers] = useState('');

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setIncludeTimestamps(DEFAULT_OPTIONS.includeTimestamps);
      setDiarize(DEFAULT_OPTIONS.diarize);
      setMinSpeakers('');
      setMaxSpeakers('');
    }
    onOpenChange(open);
  };

  const handleConfirm = () => {
    onConfirm({
      includeTimestamps,
      diarize,
      minSpeakers: diarize ? parseSpeakerCount(minSpeakers) : undefined,
      maxSpeakers: diarize ? parseSpeakerCount(maxSpeakers) : undefined,
    });
    onOpenChange(false);
  };

  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_transcribe_options_title')}
        description={localize('com_ui_transcribe_options_description')}
        className="w-11/12 sm:w-96"
        main={
          <div className="flex w-full flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="transcribe-option-timestamps" className="text-sm font-medium">
                {localize('com_ui_transcribe_options_timestamps')}
              </Label>
              <Switch
                id="transcribe-option-timestamps"
                aria-label={localize('com_ui_transcribe_options_timestamps')}
                checked={includeTimestamps}
                onCheckedChange={setIncludeTimestamps}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="transcribe-option-diarize" className="text-sm font-medium">
                {localize('com_ui_transcribe_options_diarize')}
              </Label>
              <Switch
                id="transcribe-option-diarize"
                aria-label={localize('com_ui_transcribe_options_diarize')}
                checked={diarize}
                onCheckedChange={setDiarize}
              />
            </div>
            {diarize && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="transcribe-option-min-speakers" className="text-sm font-medium">
                    {localize('com_ui_transcribe_options_min_speakers')}
                  </Label>
                  <Input
                    id="transcribe-option-min-speakers"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={minSpeakers}
                    onChange={(e) => setMinSpeakers(e.target.value)}
                    placeholder={localize('com_ui_transcribe_options_speakers_placeholder')}
                    aria-label={localize('com_ui_transcribe_options_min_speakers')}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="transcribe-option-max-speakers" className="text-sm font-medium">
                    {localize('com_ui_transcribe_options_max_speakers')}
                  </Label>
                  <Input
                    id="transcribe-option-max-speakers"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={maxSpeakers}
                    onChange={(e) => setMaxSpeakers(e.target.value)}
                    placeholder={localize('com_ui_transcribe_options_speakers_placeholder')}
                    aria-label={localize('com_ui_transcribe_options_max_speakers')}
                  />
                </div>
              </div>
            )}
          </div>
        }
        selection={{
          selectHandler: handleConfirm,
          selectText: localize('com_ui_transcribe_options_confirm'),
        }}
      />
    </OGDialog>
  );
}
