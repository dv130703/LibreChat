import { useState } from 'react';
import {
  OGDialog,
  OGDialogTemplate,
  Switch,
  Input,
  Textarea,
  Label,
  Button,
} from '@librechat/client';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks/useLocalize';

export interface TranscribeAudioOptions {
  includeTimestamps: boolean;
  diarize: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  /** Comma/semicolon/newline-separated names, jargon, or terms the model is
   *  likely to hear - packed directly into the transcription prompt, so
   *  these are the ones most likely to come out spelled correctly. */
  contextTerms?: string;
  /** Free-text description of the recording - never sent to the model
   *  verbatim (it would bias tone, not just spelling); only mined for
   *  additional proper nouns if `contextTerms` leaves room. Improves
   *  transcription only, not who-said-what: speaker separation is acoustic,
   *  not text-driven. */
  context?: string;
  /** A specific WhisperX model size, or `undefined` to use this server's own
   *  configured default (`WHISPERX_WHISPER_MODEL`). Validated again against
   *  an allow-list server-side (`rag_server/app.py`) - this list is only for
   *  what the picker offers, not the actual security boundary. */
  model?: string;
}

const DEFAULT_OPTIONS: TranscribeAudioOptions = {
  includeTimestamps: true,
  diarize: true,
};

/** Curated, not exhaustive - kept in sync by hand with the RAG server's own
 *  allow-list (`_ALLOWED_WHISPER_MODELS` in `rag_server/app.py`), which is
 *  the actual security boundary (letting a client name an arbitrary Hugging
 *  Face repo here would let a transcription request trigger an unbounded
 *  download of untrusted content). `''` means "don't send a model at all" -
 *  the server picks its own configured default. */
const WHISPER_MODEL_OPTIONS: Array<{
  value: string;
  labelKey: TranslationKeys;
  hintKey: TranslationKeys;
}> = [
  {
    value: '',
    labelKey: 'com_ui_transcribe_model_auto',
    hintKey: 'com_ui_transcribe_model_auto_hint',
  },
  {
    value: 'tiny',
    labelKey: 'com_ui_transcribe_model_tiny',
    hintKey: 'com_ui_transcribe_model_tiny_hint',
  },
  {
    value: 'small',
    labelKey: 'com_ui_transcribe_model_small',
    hintKey: 'com_ui_transcribe_model_small_hint',
  },
  {
    value: 'medium',
    labelKey: 'com_ui_transcribe_model_medium',
    hintKey: 'com_ui_transcribe_model_medium_hint',
  },
  {
    value: 'large-v3',
    labelKey: 'com_ui_transcribe_model_large',
    hintKey: 'com_ui_transcribe_model_large_hint',
  },
  {
    value: 'large-v3-turbo',
    labelKey: 'com_ui_transcribe_model_turbo',
    hintKey: 'com_ui_transcribe_model_turbo_hint',
  },
];

const TOTAL_STEPS = 2;

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
  const [step, setStep] = useState<1 | 2>(1);
  const [model, setModel] = useState('');
  const [includeTimestamps, setIncludeTimestamps] = useState(DEFAULT_OPTIONS.includeTimestamps);
  const [diarize, setDiarize] = useState(DEFAULT_OPTIONS.diarize);
  const [minSpeakers, setMinSpeakers] = useState('');
  const [maxSpeakers, setMaxSpeakers] = useState('');
  const [context, setContext] = useState('');
  const [contextTerms, setContextTerms] = useState('');

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setStep(1);
      setModel('');
      setIncludeTimestamps(DEFAULT_OPTIONS.includeTimestamps);
      setDiarize(DEFAULT_OPTIONS.diarize);
      setMinSpeakers('');
      setMaxSpeakers('');
      setContext('');
      setContextTerms('');
    }
    onOpenChange(open);
  };

  const handleConfirm = () => {
    onConfirm({
      includeTimestamps,
      diarize,
      minSpeakers: diarize ? parseSpeakerCount(minSpeakers) : undefined,
      maxSpeakers: diarize ? parseSpeakerCount(maxSpeakers) : undefined,
      contextTerms: contextTerms.trim() || undefined,
      context: context.trim() || undefined,
      model: model || undefined,
    });
    onOpenChange(false);
  };

  const selectedModel = WHISPER_MODEL_OPTIONS.find((option) => option.value === model);

  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_transcribe_options_title')}
        description={localize(
          step === 1
            ? 'com_ui_transcribe_options_description'
            : 'com_ui_transcribe_options_context_description',
        )}
        className="w-11/12 sm:w-96"
        main={
          <div className="flex w-full flex-col gap-4">
            <div className="flex items-center justify-center gap-1.5" aria-hidden="true">
              {Array.from({ length: TOTAL_STEPS }, (_, index) => (
                <span
                  key={index}
                  className={`h-1.5 rounded-full transition-all duration-150 ${
                    index + 1 === step ? 'w-4 bg-blue-500' : 'w-1.5 bg-border-medium'
                  }`}
                />
              ))}
            </div>

            {step === 1 ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="transcribe-option-model" className="text-sm font-medium">
                    {localize('com_ui_transcribe_options_model_label')}
                  </Label>
                  <select
                    id="transcribe-option-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    aria-label={localize('com_ui_transcribe_options_model_label')}
                    className="flex h-9 w-full rounded-lg border border-border-medium bg-transparent px-3 text-sm text-text-primary outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus-visible:!outline-none dark:focus:border-blue-400"
                  >
                    {WHISPER_MODEL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {localize(option.labelKey)}
                      </option>
                    ))}
                  </select>
                  {selectedModel && (
                    <p className="text-xs text-text-secondary">{localize(selectedModel.hintKey)}</p>
                  )}
                  <p className="text-xs text-text-secondary">
                    {localize('com_ui_transcribe_options_model_hint_note')}
                  </p>
                </div>
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
                      <Label
                        htmlFor="transcribe-option-min-speakers"
                        className="text-sm font-medium"
                      >
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
                      <Label
                        htmlFor="transcribe-option-max-speakers"
                        className="text-sm font-medium"
                      >
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
              </>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="transcribe-option-context" className="text-sm font-medium">
                    {localize('com_ui_transcribe_options_context_label')}
                  </Label>
                  <Textarea
                    id="transcribe-option-context"
                    rows={3}
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    placeholder={localize('com_ui_transcribe_options_context_placeholder')}
                    aria-label={localize('com_ui_transcribe_options_context_label')}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="transcribe-option-terms" className="text-sm font-medium">
                    {localize('com_ui_transcribe_options_terms_label')}
                  </Label>
                  <Textarea
                    id="transcribe-option-terms"
                    rows={2}
                    value={contextTerms}
                    onChange={(e) => setContextTerms(e.target.value)}
                    placeholder={localize('com_ui_transcribe_options_terms_placeholder')}
                    aria-label={localize('com_ui_transcribe_options_terms_label')}
                  />
                </div>
                <p className="text-xs text-text-secondary">
                  {localize('com_ui_transcribe_options_context_hint')}
                </p>
              </>
            )}
          </div>
        }
        leftButtons={
          step === 2 ? (
            <Button variant="outline" onClick={() => setStep(1)}>
              {localize('com_ui_back')}
            </Button>
          ) : undefined
        }
        buttons={
          step === 1 ? (
            <Button variant="submit" onClick={() => setStep(2)}>
              {localize('com_ui_next')}
            </Button>
          ) : undefined
        }
        selection={
          step === 2
            ? {
                selectHandler: handleConfirm,
                selectText: localize('com_ui_transcribe_options_confirm'),
              }
            : undefined
        }
      />
    </OGDialog>
  );
}
