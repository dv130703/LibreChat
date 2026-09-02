import { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Clock, Hash, Plus, Users, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import {
  OGDialog,
  OGDialogTemplate,
  Switch,
  Label,
  Button,
  usePopoverZIndex,
} from '@librechat/client';
import { useTranscribeConfigQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { cn } from '~/utils';

export interface TranscribeAudioOptions {
  includeTimestamps: boolean;
  diarize: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  clusteringThreshold?: number;
  contextTerms?: string;
  context?: string;
  model?: string;
  suppressNumerals?: boolean;
  language?: string;
  /** Set by `UploadStep` after the multi-channel confirm dialog, not by this
   *  dialog itself - see `channelSplitEnabled`. */
  channelSplit?: boolean;
}

const DEFAULT_OPTIONS: TranscribeAudioOptions = {
  includeTimestamps: true,
  diarize: true,
};

type SpeakerGrouping = 'merge' | 'balanced' | 'split';

const CLUSTERING_THRESHOLD: Record<Exclude<SpeakerGrouping, 'balanced'>, number> = {
  merge: 0.72,
  split: 0.48,
};

// Kept in sync by hand with `_ALLOWED_WHISPER_MODELS` in `rag_server/app.py`,
// the actual security boundary - this list is only what the picker offers.
const WHISPER_MODEL_OPTIONS: Array<{
  value: string;
  labelKey: TranslationKeys;
}> = [
  { value: '', labelKey: 'com_ui_transcribe_model_auto' },
  { value: 'tiny', labelKey: 'com_ui_transcribe_model_tiny' },
  { value: 'small', labelKey: 'com_ui_transcribe_model_small' },
  { value: 'medium', labelKey: 'com_ui_transcribe_model_medium' },
  { value: 'large-v2', labelKey: 'com_ui_transcribe_model_large_v2' },
  { value: 'large-v3', labelKey: 'com_ui_transcribe_model_large' },
  { value: 'large-v3-turbo', labelKey: 'com_ui_transcribe_model_turbo' },
];

const LANGUAGE_OPTIONS: Array<{ value: string; labelKey: TranslationKeys }> = [
  { value: '', labelKey: 'com_ui_transcribe_language_auto' },
  { value: 'en', labelKey: 'com_ui_transcribe_language_en' },
  { value: 'es', labelKey: 'com_ui_transcribe_language_es' },
  { value: 'fr', labelKey: 'com_ui_transcribe_language_fr' },
  { value: 'de', labelKey: 'com_ui_transcribe_language_de' },
  { value: 'it', labelKey: 'com_ui_transcribe_language_it' },
  { value: 'pt', labelKey: 'com_ui_transcribe_language_pt' },
  { value: 'nl', labelKey: 'com_ui_transcribe_language_nl' },
  { value: 'ru', labelKey: 'com_ui_transcribe_language_ru' },
  { value: 'zh', labelKey: 'com_ui_transcribe_language_zh' },
  { value: 'ja', labelKey: 'com_ui_transcribe_language_ja' },
  { value: 'ko', labelKey: 'com_ui_transcribe_language_ko' },
  { value: 'ar', labelKey: 'com_ui_transcribe_language_ar' },
  { value: 'hi', labelKey: 'com_ui_transcribe_language_hi' },
  { value: 'tr', labelKey: 'com_ui_transcribe_language_tr' },
  { value: 'pl', labelKey: 'com_ui_transcribe_language_pl' },
  { value: 'sv', labelKey: 'com_ui_transcribe_language_sv' },
  { value: 'vi', labelKey: 'com_ui_transcribe_language_vi' },
  { value: 'th', labelKey: 'com_ui_transcribe_language_th' },
  { value: 'id', labelKey: 'com_ui_transcribe_language_id' },
  { value: 'uk', labelKey: 'com_ui_transcribe_language_uk' },
];

const SPEAKER_GROUPING_OPTIONS: { value: SpeakerGrouping; labelKey: TranslationKeys }[] = [
  { value: 'merge', labelKey: 'com_ui_transcribe_options_grouping_merge' },
  { value: 'balanced', labelKey: 'com_ui_transcribe_options_grouping_balanced' },
  { value: 'split', labelKey: 'com_ui_transcribe_options_grouping_split' },
];

function groupingFromThreshold(threshold: number | undefined): SpeakerGrouping {
  if (threshold == null) {
    return 'balanced';
  }
  const match = (
    Object.keys(CLUSTERING_THRESHOLD) as Array<Exclude<SpeakerGrouping, 'balanced'>>
  ).find((key) => CLUSTERING_THRESHOLD[key] === threshold);
  return match ?? 'balanced';
}

interface MenuOption {
  value: string;
  label: string;
}

/**
 * Same trigger + popover pattern as the audio player's playback-speed menu
 * (`TranscriptHeader.tsx`) and the per-line `SpeakerDropdown` - a bordered
 * button that opens a Radix popover list with a sliding check mark, so every
 * dropdown in this feature looks and behaves the same way.
 */
function DropdownField({
  id,
  label,
  hint,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  ariaLabel: string;
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Radix's DismissableLayer disables pointer-events on body while a modal
  // Dialog is open and only re-enables the layer it considers topmost; this
  // popover, nested one level inside OGDialog, isn't recognized as that
  // layer without the zIndex/pointerEvents override below.
  const zIndex = usePopoverZIndex();
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-medium text-text-primary">
        {label}
      </Label>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            id={id}
            type="button"
            aria-label={ariaLabel}
            className={cn(
              'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border-medium px-3 text-xs font-semibold text-text-secondary transition-colors hover:border-border-heavy hover:text-text-primary',
              open && 'border-blue-500 ring-2 ring-blue-500/20 dark:border-blue-400',
            )}
          >
            <span className="truncate">{selected?.label}</span>
            <ChevronDown
              className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
            />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={8}
            collisionPadding={8}
            style={{ zIndex, pointerEvents: 'auto' }}
            className="max-h-64 w-[var(--radix-popover-trigger-width)] min-w-[10rem] overflow-y-auto rounded-lg border border-border-medium bg-surface-primary p-1 shadow-lg duration-150 animate-in fade-in-0 zoom-in-95"
            // OGDialog's scroll lock blocks native wheel scrolling on
            // anything outside its own DOM subtree - this popover is
            // portaled to <body> as a sibling of the dialog, not a
            // descendant, so it's caught by that lock. Driving scrollTop
            // directly here sidesteps it regardless of the native scroll
            // being blocked.
            onWheel={(event) => {
              event.currentTarget.scrollTop += event.deltaY;
            }}
          >
            <Popover.Arrow className="fill-surface-primary" />
            {options.map((option, index) => (
              <button
                key={option.value || 'auto'}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={{ animationDelay: `${index * 18 + 20}ms` }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors duration-150 ease-out animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both',
                  option.value === value
                    ? 'bg-blue-500/10 font-bold text-blue-600 dark:text-blue-300'
                    : 'text-text-primary hover:bg-surface-hover',
                )}
              >
                <span className="truncate">{option.label}</span>
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 transition-all',
                    option.value === value ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
                  )}
                  aria-hidden="true"
                />
              </button>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {hint != null && hint !== '' && <p className="text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  id,
  icon: Icon,
  label,
  checked,
  onCheckedChange,
}: {
  id: string;
  icon: typeof Clock;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <Icon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <Label htmlFor={id} className="text-sm font-medium text-text-primary">
          {label}
        </Label>
      </div>
      <Switch id={id} aria-label={label} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function TermChipList({
  tags,
  onRemove,
  removeLabel,
  emptyLabel,
}: {
  tags: string[];
  onRemove: (index: number) => void;
  removeLabel: (tag: string) => string;
  emptyLabel: string;
}) {
  if (tags.length === 0) {
    return <p className="text-xs italic text-text-tertiary">{emptyLabel}</p>;
  }
  return (
    <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto pr-1">
      {tags.map((tag, index) => (
        <span
          key={`${tag}-${index}`}
          className="flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 py-1 pl-3 pr-1.5 text-xs font-medium text-blue-600 dark:border-blue-400/20 dark:text-blue-300"
        >
          {tag}
          <button
            type="button"
            onClick={() => onRemove(index)}
            aria-label={removeLabel(tag)}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-blue-600/70 transition-colors hover:bg-blue-500/20 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-blue-300/70 dark:hover:text-blue-200"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}

interface TranscribeOptionsDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (options: TranscribeAudioOptions) => void;
  initialOptions?: TranscribeAudioOptions;
  /** Set once the user has already confirmed channel-based speaker
   *  separation for this file (see `MultiChannelDialog`, one step earlier in
   *  `UploadStep`). Speakers are then a settled fact - one per channel - so
   *  the diarize toggle and speaker-count/grouping controls are replaced
   *  with a short note instead of asking a question that's already been
   *  answered. */
  channelSplitEnabled?: boolean;
}

const NO_TERMS: string[] = [];

function parseTermTags(contextTerms: string | undefined): string[] {
  if (!contextTerms) {
    return [];
  }
  return contextTerms
    .split(/[,;\n]/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/** Digits only, no leading zeros, clamped to `max` - so what's on screen is
 *  always either empty or a plain positive integer no larger than what the
 *  diarizer will actually honor. Clamping here means the number the user
 *  sees typed is always the number that will be used, rather than a larger
 *  one the server would silently cut down after the fact. */
function sanitizeSpeakerCountInput(raw: string, max: number): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  if (digits === '') {
    return digits;
  }
  return String(Math.min(Number(digits), max));
}

export default function TranscribeOptionsDialog({
  isOpen,
  onOpenChange,
  onConfirm,
  initialOptions,
  channelSplitEnabled = false,
}: TranscribeOptionsDialogProps) {
  const localize = useLocalize();
  const [step, setStep] = useState<1 | 2>(1);
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState('');
  const [includeTimestamps, setIncludeTimestamps] = useState(DEFAULT_OPTIONS.includeTimestamps);
  const [diarize, setDiarize] = useState(DEFAULT_OPTIONS.diarize);
  const [speakerRange, setSpeakerRange] = useState<{ min?: number; max?: number }>({});
  const [speakerGrouping, setSpeakerGrouping] = useState<SpeakerGrouping>('balanced');
  const [termTags, setTermTags] = useState<string[]>([]);
  const [termDraft, setTermDraft] = useState('');
  const [emitNumerals, setEmitNumerals] = useState(false);
  const seededRef = useRef(false);
  const { data: transcribeConfig } = useTranscribeConfigQuery();
  const serverSuppressesNumerals = transcribeConfig?.default_suppress_numerals ?? true;
  // Falls back to the pyannote-accuracy-driven default the server itself
  // clamps to (see MAX_ALLOWED_SPEAKERS in speaker_bounds.py) - only used
  // before the config has loaded, so the input is never briefly unbounded.
  const maxSpeakerCount = transcribeConfig?.max_speakers ?? 8;

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setStep(1);
      setModel(initialOptions?.model ?? '');
      setLanguage(initialOptions?.language ?? '');
      setIncludeTimestamps(initialOptions?.includeTimestamps ?? DEFAULT_OPTIONS.includeTimestamps);
      setDiarize(initialOptions?.diarize ?? DEFAULT_OPTIONS.diarize);
      setSpeakerRange({ min: initialOptions?.minSpeakers, max: initialOptions?.maxSpeakers });
      setSpeakerGrouping(groupingFromThreshold(initialOptions?.clusteringThreshold));
      seededRef.current = initialOptions != null;
      setTermTags(parseTermTags(initialOptions?.contextTerms));
      setTermDraft('');
      setEmitNumerals(
        initialOptions?.suppressNumerals != null
          ? !initialOptions.suppressNumerals
          : !serverSuppressesNumerals,
      );
    }
    onOpenChange(open);
  };

  const handleSpeakerCountChange = (raw: string) => {
    const digits = sanitizeSpeakerCountInput(raw, maxSpeakerCount);
    if (digits === '') {
      setSpeakerRange({ min: undefined, max: undefined });
      return;
    }
    const parsed = Number(digits);
    setSpeakerRange({ min: parsed, max: parsed });
  };

  const suggestedTerms = transcribeConfig?.suggested_terms ?? NO_TERMS;
  const unusedSuggestions = suggestedTerms.filter(
    (term) => !termTags.some((tag) => tag.toLowerCase() === term.toLowerCase()),
  );

  useEffect(() => {
    if (!isOpen || seededRef.current || suggestedTerms.length === 0) {
      return;
    }
    seededRef.current = true;
    setTermTags((current) => (current.length === 0 ? suggestedTerms : current));
  }, [isOpen, suggestedTerms]);

  const addSuggestion = (term: string) => {
    setTermTags((current) =>
      current.some((tag) => tag.toLowerCase() === term.toLowerCase())
        ? current
        : [...current, term],
    );
  };

  const commitTermDraft = () => {
    const trimmed = termDraft.trim();
    setTermDraft('');
    if (!trimmed) {
      return;
    }
    setTermTags((current) =>
      current.some((tag) => tag.toLowerCase() === trimmed.toLowerCase())
        ? current
        : [...current, trimmed],
    );
  };

  const handleTermKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitTermDraft();
    }
  };

  const handleConfirm = () => {
    // Channel-split already answered "who's speaking" one step earlier -
    // pyannote's own toggle and its min/max/grouping hints are moot once
    // every speaker is already a settled channel.
    const effectiveDiarize = channelSplitEnabled ? true : diarize;
    onConfirm({
      includeTimestamps,
      diarize: effectiveDiarize,
      minSpeakers: effectiveDiarize && !channelSplitEnabled ? speakerRange.min : undefined,
      maxSpeakers: effectiveDiarize && !channelSplitEnabled ? speakerRange.max : undefined,
      clusteringThreshold:
        effectiveDiarize && !channelSplitEnabled && speakerGrouping !== 'balanced'
          ? CLUSTERING_THRESHOLD[speakerGrouping]
          : undefined,
      contextTerms: termTags.length > 0 ? termTags.join(', ') : undefined,
      model: model || undefined,
      language: language || undefined,
      suppressNumerals: !emitNumerals,
    });
    onOpenChange(false);
  };

  const modelOptions = useMemo<MenuOption[]>(
    () =>
      WHISPER_MODEL_OPTIONS.map((option) => ({
        value: option.value,
        label:
          option.value === '' && transcribeConfig?.default_model != null
            ? localize('com_ui_transcribe_model_auto_resolved', {
                0: transcribeConfig.default_model,
              })
            : localize(option.labelKey),
      })),
    [localize, transcribeConfig?.default_model],
  );
  const languageOptions = useMemo<MenuOption[]>(
    () =>
      LANGUAGE_OPTIONS.map((option) => ({ value: option.value, label: localize(option.labelKey) })),
    [localize],
  );
  const groupingOptions = useMemo<MenuOption[]>(
    () =>
      SPEAKER_GROUPING_OPTIONS.map((option) => ({
        value: option.value,
        label: localize(option.labelKey),
      })),
    [localize],
  );

  const modelHint =
    model === '' ? undefined : localize('com_ui_transcribe_options_model_hint_note');

  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_transcribe_options_title')}
        description={step === 1 ? localize('com_ui_transcribe_options_description') : ''}
        className="w-11/12 sm:w-[28rem]"
        mainClassName="min-w-0"
        showCloseButton
        showCancelButton={false}
        main={
          <div className="flex w-full min-w-0 flex-col gap-5">
            {step === 1 ? (
              <>
                <div className="flex flex-col gap-3">
                  <DropdownField
                    id="transcribe-option-model"
                    label={localize('com_ui_transcribe_options_model_label')}
                    hint={modelHint}
                    ariaLabel={localize('com_ui_transcribe_options_model_label')}
                    value={model}
                    options={modelOptions}
                    onChange={setModel}
                  />
                  <DropdownField
                    id="transcribe-option-language"
                    label={localize('com_ui_transcribe_options_language_label')}
                    ariaLabel={localize('com_ui_transcribe_options_language_label')}
                    value={language}
                    options={languageOptions}
                    onChange={setLanguage}
                  />
                </div>

                <div className="flex flex-col gap-4 border-t border-border-light pt-4">
                  <ToggleRow
                    id="transcribe-option-timestamps"
                    icon={Clock}
                    label={localize('com_ui_transcribe_options_timestamps')}
                    checked={includeTimestamps}
                    onCheckedChange={setIncludeTimestamps}
                  />
                  {!channelSplitEnabled && (
                    <ToggleRow
                      id="transcribe-option-diarize"
                      icon={Users}
                      label={localize('com_ui_transcribe_options_diarize')}
                      checked={diarize}
                      onCheckedChange={setDiarize}
                    />
                  )}
                  <ToggleRow
                    id="transcribe-option-numerals"
                    icon={Hash}
                    label={localize('com_ui_transcribe_options_numerals')}
                    checked={emitNumerals}
                    onCheckedChange={setEmitNumerals}
                  />
                </div>

                {channelSplitEnabled ? (
                  <div className="flex items-center gap-2.5 rounded-lg border border-border-light bg-surface-secondary p-3 text-xs text-text-secondary">
                    <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{localize('com_ui_transcribe_options_channel_split_note')}</span>
                  </div>
                ) : (
                  diarize && (
                    <div className="flex flex-col gap-3 rounded-lg border border-border-light bg-surface-secondary p-3">
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label
                          htmlFor="transcribe-option-speaker-count"
                          className="text-sm font-medium text-text-primary"
                        >
                          {localize('com_ui_transcribe_options_speaker_count_label')}
                        </Label>
                        <input
                          id="transcribe-option-speaker-count"
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={speakerRange.min != null ? String(speakerRange.min) : ''}
                          onChange={(event) => handleSpeakerCountChange(event.target.value)}
                          placeholder={localize('com_ui_transcribe_options_speaker_count_auto')}
                          aria-label={localize('com_ui_transcribe_options_speaker_count_label')}
                          className="h-10 w-full min-w-0 rounded-lg border border-border-medium bg-transparent px-3 text-sm text-text-primary outline-none placeholder:text-text-secondary focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/20"
                        />
                        <p className="text-xs text-text-secondary">
                          {localize('com_ui_transcribe_options_speakers_hint', {
                            0: String(maxSpeakerCount),
                          })}
                        </p>
                      </div>
                      <DropdownField
                        id="transcribe-option-grouping"
                        label={localize('com_ui_transcribe_options_grouping_label')}
                        ariaLabel={localize('com_ui_transcribe_options_grouping_label')}
                        value={speakerGrouping}
                        options={groupingOptions}
                        onChange={(value) => setSpeakerGrouping(value as SpeakerGrouping)}
                      />
                    </div>
                  )
                )}
              </>
            ) : (
              <>
                <div className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor="transcribe-option-terms" className="text-sm font-medium">
                    {localize('com_ui_transcribe_options_terms_label')}
                  </Label>
                  <TermChipList
                    tags={termTags}
                    onRemove={(index) =>
                      setTermTags((current) => current.filter((_, i) => i !== index))
                    }
                    removeLabel={(tag) =>
                      localize('com_ui_transcribe_options_remove_term', { 0: tag })
                    }
                    emptyLabel={localize('com_ui_transcribe_options_terms_empty')}
                  />
                  <div className="flex gap-2">
                    <input
                      id="transcribe-option-terms"
                      type="text"
                      value={termDraft}
                      onChange={(event) => setTermDraft(event.target.value)}
                      onKeyDown={handleTermKeyDown}
                      placeholder={localize('com_ui_transcribe_options_terms_placeholder')}
                      aria-label={localize('com_ui_transcribe_options_terms_label')}
                      className="h-10 min-w-0 flex-1 rounded-lg border border-border-medium bg-transparent px-3 text-sm text-text-primary transition-colors placeholder:text-text-secondary focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={commitTermDraft}
                      className="shrink-0"
                    >
                      {localize('com_ui_transcribe_options_add_term')}
                    </Button>
                  </div>
                </div>

                {unusedSuggestions.length > 0 && (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-text-secondary">
                      {localize('com_ui_transcribe_options_suggestions_label')}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {unusedSuggestions.map((term) => (
                        <button
                          key={term}
                          type="button"
                          onClick={() => addSuggestion(term)}
                          aria-label={localize('com_ui_transcribe_options_add_suggestion', {
                            0: term,
                          })}
                          className="flex items-center gap-1 rounded-full border border-dashed border-border-medium px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                          <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />
                          {term}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {termTags.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTermTags([])}
                    className="self-start text-xs font-medium text-text-tertiary transition-colors hover:text-text-secondary hover:underline"
                  >
                    {localize('com_ui_transcribe_options_clear_terms')}
                  </button>
                )}
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
