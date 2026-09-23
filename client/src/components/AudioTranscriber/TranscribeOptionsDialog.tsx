import { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Clock, Fingerprint, Hash, Plus, Upload, Users, X } from 'lucide-react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import {
  OGDialog,
  OGDialogTemplate,
  Switch,
  Label,
  Button,
  usePopoverZIndex,
} from '@librechat/client';
import { useTranscribeConfigQuery } from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { cn } from '~/utils';

export interface TranscribeAudioOptions {
  includeTimestamps: boolean;
  diarize: boolean;
  speakerCount?: number;
  clusteringThreshold?: number;
  contextTerms?: string;
  /** Match each detected speaker against this user's enrolled voice profiles
   *  and name the ones it recognizes, before anything is read from the
   *  transcript itself. Off leaves naming entirely to what is said out loud. */
  voiceRecognition?: boolean;
  model?: string;
  suppressNumerals?: boolean;
  language?: string;
  /** Set by the caller (`TranscribeIntentContext.tsx`) after the multi-channel
   *  confirm dialog, not by this dialog itself - see `channelSplitEnabled`. */
  channelSplit?: boolean;
}

const DEFAULT_OPTIONS: TranscribeAudioOptions = {
  includeTimestamps: true,
  diarize: true,
};

// Kept in sync by hand with `ALLOWED_TRANSCRIPTION_MODELS` in the
// Transcription Pipeline's `config.py` (local-llm-server), the actual
// security boundary - this list is only what the picker offers.
const MODEL_OPTIONS: Array<{
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
  ariaLabel,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
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
              open && 'border-green-500 ring-2 ring-green-500/20 dark:border-green-400',
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
                    ? 'bg-green-500/10 font-bold text-green-600 dark:text-green-300'
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
    </div>
  );
}

/**
 * One labelled group of related controls.
 *
 * Every group in this dialog is a peer - how to transcribe, what to output,
 * who is speaking - so each gets the same treatment: a quiet heading and a
 * hairline above it. Previously the three were drawn three different ways
 * (a bare stack, a top border, and a filled card) which implied a hierarchy
 * that does not exist, and the card's fill happened to match the dialog's
 * own background, so it read as a stray rule rather than a container.
 */
function Section({
  title,
  first = false,
  grow = false,
  action,
  children,
}: {
  title: string;
  first?: boolean;
  /** Claim the leftover height of a fixed-height dialog. Without it a short
   *  section leaves the rest of the panel visibly empty, which is most of
   *  what made this form read as floating rather than laid out. */
  grow?: boolean;
  /** Control that acts on the whole section, sat opposite its heading. A
   *  "clear all" placed after a growing list instead gets shoved to the
   *  bottom of the panel, stranded far from the thing it clears. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-3',
        !first && 'border-t border-border-light pt-5',
        grow && 'min-h-0 flex-1',
      )}
    >
      <div className="flex min-h-5 items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-text-secondary">{title}</h3>
        {action}
      </div>
      <div className={cn('flex min-w-0 flex-col gap-3', grow && 'min-h-0 flex-1')}>{children}</div>
    </section>
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
    <div className="flex min-h-8 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <Label htmlFor={id} className="cursor-pointer truncate text-sm text-text-primary">
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
  // One bordered region in both states. Drawing the box only when empty made
  // the same area read as a deliberate container with no terms and as blank
  // space with one, which is the inconsistency that made this panel feel
  // unplanned.
  if (tags.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border-light px-6 py-8">
        <p className="max-w-xs text-center text-xs text-text-tertiary">{emptyLabel}</p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-wrap content-start gap-1.5 overflow-y-auto rounded-lg border border-dashed border-border-light p-3">
      {tags.map((tag, index) => (
        <span
          key={`${tag}-${index}`}
          className="flex items-center gap-1.5 rounded-full border border-green-500/20 bg-green-500/10 py-1 pl-3 pr-1.5 text-xs font-medium text-green-600 dark:border-green-400/20 dark:text-green-300"
        >
          {tag}
          <button
            type="button"
            onClick={() => onRemove(index)}
            aria-label={removeLabel(tag)}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-green-600/70 transition-colors hover:bg-green-500/20 hover:text-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/40 dark:text-green-300/70 dark:hover:text-green-200"
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
   *  the caller's own dialog sequence). Speakers are then a settled fact -
   *  one per channel - so the diarize toggle and speaker-count/grouping
   *  controls are replaced with a short note instead of asking a question
   *  that's already been answered. */
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
  const [voiceRecognition, setVoiceRecognition] = useState(
    DEFAULT_OPTIONS.voiceRecognition ?? true,
  );
  const [speakerCount, setSpeakerCount] = useState<number | undefined>(undefined);
  const [termTags, setTermTags] = useState<string[]>([]);
  const [termDraft, setTermDraft] = useState('');
  const termFileInputRef = useRef<HTMLInputElement>(null);
  const [emitNumerals, setEmitNumerals] = useState(false);
  const seededRef = useRef(false);
  // Set once the user works the language picker themselves, so a late-arriving
  // config can't overwrite a choice they already made - including a deliberate
  // "auto", which is indistinguishable from the unset default by value alone.
  const languageTouchedRef = useRef(false);
  const { data: transcribeConfig } = useTranscribeConfigQuery();
  const serverSuppressesNumerals = transcribeConfig?.default_suppress_numerals ?? true;
  const defaultLanguage = transcribeConfig?.default_language ?? '';
  // Falls back to the pyannote-accuracy-driven default the server itself
  // clamps to (see MAX_ALLOWED_SPEAKERS in speaker_count.py) - only used
  // before the config has loaded, so the input is never briefly unbounded.
  const maxSpeakerCount = transcribeConfig?.max_speakers ?? 8;

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setStep(1);
      setModel(initialOptions?.model ?? '');
      setLanguage(initialOptions?.language ?? defaultLanguage);
      languageTouchedRef.current = initialOptions?.language != null;
      setIncludeTimestamps(initialOptions?.includeTimestamps ?? DEFAULT_OPTIONS.includeTimestamps);
      setDiarize(initialOptions?.diarize ?? DEFAULT_OPTIONS.diarize);
      setVoiceRecognition(
        initialOptions?.voiceRecognition ?? DEFAULT_OPTIONS.voiceRecognition ?? true,
      );
      setSpeakerCount(initialOptions?.speakerCount);
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

  const handleLanguageChange = (value: string) => {
    languageTouchedRef.current = true;
    setLanguage(value);
  };

  const handleSpeakerCountChange = (raw: string) => {
    const digits = sanitizeSpeakerCountInput(raw, maxSpeakerCount);
    setSpeakerCount(digits === '' ? undefined : Number(digits));
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

  // The config query can resolve after the dialog is already open, which is how
  // the picker ended up showing "auto" on a deployment that had been set to a
  // language. Seeding again when it lands is what keeps the dialog honest about
  // what will actually run.
  useEffect(() => {
    if (!isOpen || languageTouchedRef.current) {
      return;
    }
    setLanguage(defaultLanguage);
  }, [isOpen, defaultLanguage]);

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

  const mergeTerms = (incoming: string[]) => {
    setTermTags((current) => {
      const seen = new Set(current.map((tag) => tag.toLowerCase()));
      const additions = incoming.filter((term) => {
        const key = term.toLowerCase();
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      return additions.length > 0 ? [...current, ...additions] : current;
    });
  };

  const handleTermFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    mergeTerms(parseTermTags(await file.text()));
  };

  const handleConfirm = () => {
    // Channel-split already answered "who's speaking" one step earlier -
    // pyannote's own toggle and its speaker-count/grouping hints are moot
    // once every speaker is already a settled channel.
    const effectiveDiarize = channelSplitEnabled ? true : diarize;
    onConfirm({
      includeTimestamps,
      diarize: effectiveDiarize,
      speakerCount: effectiveDiarize && !channelSplitEnabled ? speakerCount : undefined,
      contextTerms: termTags.length > 0 ? termTags.join(', ') : undefined,
      // Only meaningful alongside diarization - with one undivided speaker
      // there is nobody to tell apart, let alone recognize.
      voiceRecognition: effectiveDiarize ? voiceRecognition : false,
      model: model || undefined,
      language: language || undefined,
      suppressNumerals: !emitNumerals,
    });
    onOpenChange(false);
  };

  const modelOptions = useMemo<MenuOption[]>(
    () =>
      MODEL_OPTIONS.map((option) => ({
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
  // "Auto-detect" is a misnomer whenever the server carries a default language:
  // sending no language makes it apply that default, not detect one. Naming the
  // language it resolves to is the same treatment the model picker already gets.
  const languageOptions = useMemo<MenuOption[]>(() => {
    const resolvedLabelKey = LANGUAGE_OPTIONS.find(
      (option) => option.value !== '' && option.value === defaultLanguage,
    )?.labelKey;

    return LANGUAGE_OPTIONS.map((option) => ({
      value: option.value,
      label:
        option.value === '' && resolvedLabelKey != null
          ? localize('com_ui_transcribe_language_auto_resolved', {
              0: localize(resolvedLabelKey),
            })
          : localize(option.labelKey),
    }));
  }, [localize, defaultLanguage]);

  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_transcribe_options_title')}
        description={localize(
          step === 1
            ? 'com_ui_transcribe_options_description'
            : 'com_ui_transcribe_options_terms_description',
        )}
        className="w-11/12 border border-solid border-border-medium bg-surface-tertiary sm:w-[34rem]"
        mainClassName="min-w-0 h-[min(34rem,68vh)]"
        showCloseButton
        showCancelButton={false}
        main={
          <div className="flex h-full w-full min-w-0 flex-col gap-5">
            {/* Two segments rather than a numeral: the only thing worth
                showing is how far through a two-step form you are, and the
                Back/Next buttons already say which way you can move. */}
            <div className="flex items-center gap-1.5">
              <span className="h-0.5 flex-1 rounded-full bg-green-500 dark:bg-green-400" />
              <span
                className={cn(
                  'h-0.5 flex-1 rounded-full transition-colors',
                  step === 2 ? 'bg-green-500 dark:bg-green-400' : 'bg-border-medium',
                )}
              />
              <span className="sr-only">
                {localize('com_ui_transcribe_options_step_progress', { 0: String(step) })}
              </span>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
              {step === 1 ? (
                <>
                  <Section title={localize('com_ui_transcribe_options_section_engine')} first>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                      <DropdownField
                        id="transcribe-option-model"
                        label={localize('com_ui_transcribe_options_model_label')}
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
                        onChange={handleLanguageChange}
                      />
                    </div>
                  </Section>

                  <Section title={localize('com_ui_transcribe_options_section_output')}>
                    <ToggleRow
                      id="transcribe-option-timestamps"
                      icon={Clock}
                      label={localize('com_ui_transcribe_options_timestamps')}
                      checked={includeTimestamps}
                      onCheckedChange={setIncludeTimestamps}
                    />
                    <ToggleRow
                      id="transcribe-option-numerals"
                      icon={Hash}
                      label={localize('com_ui_transcribe_options_numerals')}
                      checked={emitNumerals}
                      onCheckedChange={setEmitNumerals}
                    />
                  </Section>

                  <Section title={localize('com_ui_transcribe_options_section_speakers')}>
                    {channelSplitEnabled ? (
                      <p className="flex items-start gap-2.5 text-xs text-text-secondary">
                        <Users className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{localize('com_ui_transcribe_options_channel_split_note')}</span>
                      </p>
                    ) : (
                      <ToggleRow
                        id="transcribe-option-diarize"
                        icon={Users}
                        label={localize('com_ui_transcribe_options_diarize')}
                        checked={diarize}
                        onCheckedChange={setDiarize}
                      />
                    )}
                    {/* Both depend on speakers being told apart, so they sit
                        inside this section and leave with it rather than
                        turning into an orphaned card elsewhere in the form. */}
                    {(channelSplitEnabled || diarize) && (
                      <>
                        <ToggleRow
                          id="transcribe-option-voice-recognition"
                          icon={Fingerprint}
                          label={localize('com_ui_transcribe_options_voice_recognition')}
                          checked={voiceRecognition}
                          onCheckedChange={setVoiceRecognition}
                        />
                        {!channelSplitEnabled && (
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
                              value={speakerCount != null ? String(speakerCount) : ''}
                              onChange={(event) => handleSpeakerCountChange(event.target.value)}
                              placeholder={localize('com_ui_transcribe_options_speaker_count_auto')}
                              aria-label={localize('com_ui_transcribe_options_speaker_count_label')}
                              className="h-10 w-full min-w-0 rounded-lg border border-border-medium bg-transparent px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus-visible:border-green-500 focus-visible:ring-2 focus-visible:ring-green-500/20"
                            />
                            <p className="text-xs text-text-secondary">
                              {localize('com_ui_transcribe_options_speakers_hint', {
                                0: String(maxSpeakerCount),
                              })}
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </Section>
                </>
              ) : (
                <>
                  <Section
                    title={localize('com_ui_transcribe_options_section_terms')}
                    first
                    grow
                    action={
                      termTags.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setTermTags([])}
                          className="text-xs font-medium text-text-secondary transition-colors hover:text-red-600 dark:hover:text-red-400"
                        >
                          {localize('com_ui_transcribe_options_clear_terms')}
                        </button>
                      ) : undefined
                    }
                  >
                    {/* Entry first, then what has been entered. The add row
                        and the upload button are one row of equal-height
                        controls so the left edge stays straight instead of
                        stepping in and out down the form. */}
                    <div className="flex min-w-0 gap-2">
                      <input
                        id="transcribe-option-terms"
                        type="text"
                        value={termDraft}
                        onChange={(event) => setTermDraft(event.target.value)}
                        onKeyDown={handleTermKeyDown}
                        placeholder={localize('com_ui_transcribe_options_terms_placeholder')}
                        aria-label={localize('com_ui_transcribe_options_terms_label')}
                        className="h-10 min-w-0 flex-1 rounded-lg border border-border-medium bg-transparent px-3 text-sm text-text-primary transition-colors placeholder:text-text-secondary focus-visible:border-green-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/20"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={commitTermDraft}
                        className="h-10 shrink-0"
                      >
                        {localize('com_ui_transcribe_options_add_term')}
                      </Button>
                      <input
                        ref={termFileInputRef}
                        type="file"
                        accept=".txt,text/plain"
                        onChange={handleTermFileChange}
                        className="hidden"
                        aria-label={localize('com_ui_transcribe_options_upload_terms')}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => termFileInputRef.current?.click()}
                        aria-label={localize('com_ui_transcribe_options_upload_terms')}
                        title={localize('com_ui_transcribe_options_upload_terms')}
                        className="h-10 w-10 shrink-0 p-0"
                      >
                        <Upload className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>

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
                  </Section>

                  {unusedSuggestions.length > 0 && (
                    <Section title={localize('com_ui_transcribe_options_suggestions_label')}>
                      <div className="flex flex-wrap gap-1.5">
                        {unusedSuggestions.map((term) => (
                          <button
                            key={term}
                            type="button"
                            onClick={() => addSuggestion(term)}
                            aria-label={localize('com_ui_transcribe_options_add_suggestion', {
                              0: term,
                            })}
                            className="flex items-center gap-1 rounded-full border border-dashed border-border-medium px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/40"
                          >
                            <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />
                            {term}
                          </button>
                        ))}
                      </div>
                    </Section>
                  )}
                </>
              )}
            </div>
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
          step === 2 ? (
            <Button variant="submit" onClick={handleConfirm}>
              {localize('com_ui_transcribe_options_confirm')}
            </Button>
          ) : undefined
        }
      />
    </OGDialog>
  );
}
