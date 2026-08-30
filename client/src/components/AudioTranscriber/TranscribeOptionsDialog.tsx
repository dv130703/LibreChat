import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Clock, Minus, Plus, Users, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import {
  OGDialog,
  OGDialogTemplate,
  Switch,
  Textarea,
  Label,
  Button,
  usePopoverZIndex,
} from '@librechat/client';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { cn } from '~/utils';

export interface TranscribeAudioOptions {
  includeTimestamps: boolean;
  diarize: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  /** Nudges how readily pyannote's clustering treats two voices as the same
   *  speaker - `undefined` leaves the server's own default in place. Higher
   *  merges more readily (fewer, broader speakers); lower splits more readily
   *  (more, finer speakers). See `SpeakerGroupingControl` for the values
   *  behind its three presets. */
  clusteringThreshold?: number;
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
  /** ISO 639-1 code (e.g. `'en'`), or `undefined` to let the server
   *  auto-detect from the first 30 seconds of audio - the right default for
   *  a single-language recording, but worth overriding for code-switched
   *  audio or anything whose opening seconds might mislead detection. */
  language?: string;
}

const DEFAULT_OPTIONS: TranscribeAudioOptions = {
  includeTimestamps: true,
  diarize: true,
};

const MIN_SPEAKER_COUNT = 1;
const MAX_SPEAKER_COUNT = 20;

type SpeakerGrouping = 'merge' | 'balanced' | 'split';

/** pyannote's own default is 0.6, with 0.5-0.8 being the range it was tuned
 *  over - these sit clearly off that default in either direction without
 *  leaving that range, so each preset produces a real, noticeably different
 *  result without landing on a value nobody has validated. `balanced` sends
 *  nothing at all, leaving the server's own configured default untouched. */
const CLUSTERING_THRESHOLD: Record<Exclude<SpeakerGrouping, 'balanced'>, number> = {
  merge: 0.72,
  split: 0.48,
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

/** Plain Whisper language codes (no regional variants - Whisper doesn't
 *  distinguish "en-US" from "en-GB", unlike a browser speech-recognition API).
 *  Curated to the languages a deployment is most likely to see, not
 *  Whisper's full ~99. `''` means "don't send a language at all" - the
 *  server auto-detects from the first 30 seconds of audio, which is the
 *  right default for a single-language recording but a real risk for
 *  code-switched audio or a confusing accent/opening silence - this picker
 *  exists so that risk has an escape hatch. */
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

/**
 * Same trigger/popover mechanics as `ModelPicker` (including its z-index
 * workaround for a Popover nested inside this modal Dialog), but single-line
 * options instead of label+hint pairs - a language's name doesn't need a
 * second line to explain it the way a model size's trade-off does. Scrollable
 * rather than paginated or searchable: ~20 options is short enough to scan,
 * long enough to need `max-h`.
 */
function LanguagePicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const zIndex = usePopoverZIndex();
  const selected = LANGUAGE_OPTIONS.find((option) => option.value === value) ?? LANGUAGE_OPTIONS[0];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          aria-label={localize('com_ui_transcribe_options_language_label')}
          className={cn(
            'flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border-medium bg-transparent px-3 text-sm text-text-primary transition-colors hover:border-border-heavy focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20',
            open && 'border-blue-500 ring-2 ring-blue-500/20 dark:border-blue-400',
          )}
        >
          <span className="min-w-0 truncate font-medium">{localize(selected.labelKey)}</span>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-text-secondary transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          style={{ zIndex, pointerEvents: 'auto' }}
          className="max-h-64 w-[var(--radix-popover-trigger-width)] min-w-[12rem] overflow-y-auto rounded-lg border border-border-medium bg-surface-primary p-1 shadow-lg duration-150 animate-in fade-in-0 zoom-in-95"
        >
          {LANGUAGE_OPTIONS.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value || 'auto'}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40',
                  isSelected
                    ? 'bg-blue-500/10 font-medium text-blue-600 dark:text-blue-300'
                    : 'text-text-primary hover:bg-surface-hover',
                )}
              >
                {localize(option.labelKey)}
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-blue-600 transition-all dark:text-blue-300',
                    isSelected ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
                  )}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Trigger + option list styled after the other custom dropdowns on this page
 * (`TranscriptHeader`'s playback-speed menu, `SpeakerDropdown`) instead of a
 * bare native `<select>`, so all three read as the same control. Each option
 * carries its own one-line description, the way a model switcher elsewhere
 * (e.g. this app's own model picker) shows trade-offs inline rather than
 * making you select-then-read.
 */
function ModelPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const zIndex = usePopoverZIndex();
  const selected =
    WHISPER_MODEL_OPTIONS.find((option) => option.value === value) ?? WHISPER_MODEL_OPTIONS[0];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          aria-label={localize('com_ui_transcribe_options_model_label')}
          className={cn(
            'flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border-medium bg-transparent px-3 text-sm text-text-primary transition-colors hover:border-border-heavy focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20',
            open && 'border-blue-500 ring-2 ring-blue-500/20 dark:border-blue-400',
          )}
        >
          <span className="min-w-0 truncate font-medium">{localize(selected.labelKey)}</span>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-text-secondary transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          // Radix's DismissableLayer disables pointer-events on body while a
          // modal Dialog is open and only re-enables the layer it considers
          // topmost; nested one level inside OGDialog, this Popover doesn't
          // get recognized as that layer, so it inherits `pointer-events:
          // none` from body and becomes unclickable without this override.
          style={{ zIndex, pointerEvents: 'auto' }}
          className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] rounded-lg border border-border-medium bg-surface-primary p-1 shadow-lg duration-150 animate-in fade-in-0 zoom-in-95"
        >
          {WHISPER_MODEL_OPTIONS.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={{ animationDelay: `${index * 18 + 20}ms` }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 ease-out animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40',
                  isSelected ? 'bg-blue-500/10' : 'hover:bg-surface-hover',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block text-sm font-medium',
                      isSelected ? 'text-blue-600 dark:text-blue-300' : 'text-text-primary',
                    )}
                  >
                    {localize(option.labelKey)}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-secondary">
                    {localize(option.hintKey)}
                  </span>
                </span>
                <Check
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 transition-all dark:text-blue-300',
                    isSelected ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
                  )}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A quantity stepper (-/value/+), the same shape as a cart or headcount
 * picker elsewhere on the web - familiar enough that "how do I change this
 * number" isn't a question. `undefined` reads as "Auto"; decrementing off of
 * `MIN_SPEAKER_COUNT` returns to Auto rather than going lower, so Auto is
 * reachable from the buttons alone, not just by clearing the field by hand.
 */
function SpeakerCountStepper({
  id,
  ariaLabel,
  value,
  onChange,
  floor = MIN_SPEAKER_COUNT,
  ceiling = MAX_SPEAKER_COUNT,
}: {
  id: string;
  ariaLabel: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  /** Lower bound - Min speakers stays fixed at 1; Max speakers uses the
   *  current Min so the pair can never cross (no invalid range to silently
   *  fix up after the fact, and no risk of the two fields fighting over
   *  each other's value on a fast run of clicks). */
  floor?: number;
  /** Upper bound - Max speakers stays fixed at MAX_SPEAKER_COUNT; Min
   *  speakers uses the current Max for the same reason. */
  ceiling?: number;
}) {
  const localize = useLocalize();

  const decrement = () => {
    if (value === undefined) {
      return;
    }
    onChange(value <= floor ? undefined : value - 1);
  };

  const increment = () => {
    onChange(value === undefined ? floor : Math.min(ceiling, value + 1));
  };

  const handleInputChange = (raw: string) => {
    if (!raw.trim()) {
      onChange(undefined);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      return;
    }
    onChange(Math.min(ceiling, Math.max(floor, parsed)));
  };

  return (
    <div className="flex h-10 items-stretch overflow-hidden rounded-lg border border-border-medium bg-transparent transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:focus-within:border-blue-400">
      <button
        type="button"
        onClick={decrement}
        disabled={value === undefined}
        aria-label={localize('com_ui_transcribe_options_speakers_decrease')}
        className="flex w-9 shrink-0 items-center justify-center text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 disabled:pointer-events-none disabled:opacity-30"
      >
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={value ?? ''}
        onChange={(e) => handleInputChange(e.target.value)}
        placeholder={localize('com_ui_transcribe_options_speakers_placeholder')}
        aria-label={ariaLabel}
        className="h-full min-w-0 flex-1 border-x border-border-medium bg-transparent text-center text-sm font-medium tabular-nums text-text-primary placeholder:font-normal placeholder:text-text-secondary focus-visible:outline-none"
      />
      <button
        type="button"
        onClick={increment}
        disabled={value !== undefined && value >= ceiling}
        aria-label={localize('com_ui_transcribe_options_speakers_increase')}
        className="flex w-9 shrink-0 items-center justify-center text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 disabled:pointer-events-none disabled:opacity-30"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

const SPEAKER_GROUPING_OPTIONS: {
  value: SpeakerGrouping;
  labelKey: TranslationKeys;
  hintKey: TranslationKeys;
}[] = [
  {
    value: 'merge',
    labelKey: 'com_ui_transcribe_options_grouping_merge',
    hintKey: 'com_ui_transcribe_options_grouping_merge_hint',
  },
  {
    value: 'balanced',
    labelKey: 'com_ui_transcribe_options_grouping_balanced',
    hintKey: 'com_ui_transcribe_options_grouping_balanced_hint',
  },
  {
    value: 'split',
    labelKey: 'com_ui_transcribe_options_grouping_split',
    hintKey: 'com_ui_transcribe_options_grouping_split_hint',
  },
];

/**
 * A 3-way segmented control rather than a raw slider or a "clustering
 * threshold" number field - the underlying knob is a distance threshold
 * pyannote's speaker clustering uses to decide whether two voices are the
 * same person, but nobody transcribing a meeting should need to know that.
 * Framed instead by the symptom it fixes: which way the transcript is
 * currently wrong. Only the active option's hint is shown, so this doesn't
 * cost three lines of text when it's rarely touched at all.
 */
function SpeakerGroupingControl({
  value,
  onChange,
}: {
  value: SpeakerGrouping;
  onChange: (value: SpeakerGrouping) => void;
}) {
  const localize = useLocalize();
  const active = SPEAKER_GROUPING_OPTIONS.find((option) => option.value === value);

  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-text-secondary">
        {localize('com_ui_transcribe_options_grouping_label')}
      </span>
      <div
        role="radiogroup"
        aria-label={localize('com_ui_transcribe_options_grouping_label')}
        className="grid grid-cols-3 gap-1 rounded-lg border border-border-medium bg-transparent p-1"
      >
        {SPEAKER_GROUPING_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              option.value === value
                ? 'bg-blue-500 text-white dark:bg-blue-400 dark:text-surface-primary'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
            )}
          >
            {localize(option.labelKey)}
          </button>
        ))}
      </div>
      {active && <p className="text-xs text-text-secondary">{localize(active.hintKey)}</p>}
    </div>
  );
}

/**
 * A chip/tag field: click "Add term" to open a slot, type a name, hit Enter
 * and it becomes a pill - the "Add term" trigger then reappears right next
 * to it so the next one is a click away. The same explicit add-one-at-a-time
 * shape as Notion's property tags or Trello's labels, rather than a
 * continuously-open field or a raw "separate with commas" textarea.
 */
function TagInput({
  id,
  ariaLabel,
  placeholder,
  addLabel,
  clearAllLabel,
  tags,
  onChange,
}: {
  id: string;
  ariaLabel: string;
  placeholder: string;
  addLabel: string;
  clearAllLabel: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const localize = useLocalize();
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // `autoFocus` trips the a11y lint rule (it also fires on initial mount,
  // which is the actual harmful case); this only runs when the user's own
  // click opens the slot, matching the same "focus follows a deliberate
  // action" rule the lint check is protecting.
  useEffect(() => {
    if (isAdding) {
      inputRef.current?.focus();
    }
  }, [isAdding]);

  const commitDraft = () => {
    const trimmed = draft.trim();
    setDraft('');
    setIsAdding(false);
    if (!trimmed) {
      return;
    }
    const isDuplicate = tags.some((tag) => tag.toLowerCase() === trimmed.toLowerCase());
    if (!isDuplicate) {
      onChange([...tags, trimmed]);
    }
  };

  const cancelAdding = () => {
    setDraft('');
    setIsAdding(false);
  };

  const removeTag = (index: number) => {
    onChange(tags.filter((_, i) => i !== index));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelAdding();
      return;
    }
    if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-border-medium bg-transparent px-2.5 py-1.5 transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
        {tags.map((tag, index) => (
          <span
            key={`${tag}-${index}`}
            className="flex items-center gap-1 rounded-full bg-blue-500/10 py-1 pl-2.5 pr-1.5 text-xs font-medium text-blue-600 dark:text-blue-300"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(index)}
              aria-label={localize('com_ui_transcribe_options_remove_term', { 0: tag })}
              className="rounded-full p-0.5 text-blue-600/70 transition-colors hover:bg-blue-500/20 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-blue-300/70 dark:hover:text-blue-200"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        {isAdding ? (
          <input
            ref={inputRef}
            id={id}
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitDraft}
            placeholder={placeholder}
            aria-label={ariaLabel}
            className="min-w-[8rem] flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-1 rounded-full border border-dashed border-border-medium px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-border-heavy hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {addLabel}
          </button>
        )}
      </div>
      {tags.length > 0 && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="self-end rounded text-xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          {clearAllLabel}
        </button>
      )}
    </div>
  );
}

/**
 * A toggle row wide enough to click anywhere on, not just the switch itself
 * (Fitts's Law - a bigger, closer target beats a precise one). The switch
 * still carries its own `aria-label` and stays independently focusable/
 * toggleable by keyboard; the wrapping `onClick` only adds a mouse-sized hit
 * area, and the inner stopPropagation keeps a click on the switch from
 * toggling twice.
 */
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
  const labelRef = useRef<HTMLLabelElement>(null);
  const switchWrapperRef = useRef<HTMLDivElement>(null);

  // The label and switch already toggle themselves (the label natively
  // forwards its click to the control it's `htmlFor`, and that forwarded
  // click bubbles back up here) - only the rest of the row's padding needs
  // this handler to do anything, otherwise a click on either one would
  // toggle twice and cancel itself out.
  const handleRowClick = (event: React.MouseEvent) => {
    const target = event.target as Node;
    if (labelRef.current?.contains(target) || switchWrapperRef.current?.contains(target)) {
      return;
    }
    onCheckedChange(!checked);
  };

  return (
    <div
      role="presentation"
      onClick={handleRowClick}
      className="-mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2"
    >
      <div className="flex items-center gap-2.5">
        <Icon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <Label ref={labelRef} htmlFor={id} className="cursor-pointer text-sm font-medium">
          {label}
        </Label>
      </div>
      <div ref={switchWrapperRef}>
        <Switch
          id={id}
          aria-label={label}
          checked={checked}
          onCheckedChange={onCheckedChange}
          className="focus-visible:ring-blue-500/40"
        />
      </div>
    </div>
  );
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
  const [language, setLanguage] = useState('');
  const [includeTimestamps, setIncludeTimestamps] = useState(DEFAULT_OPTIONS.includeTimestamps);
  const [diarize, setDiarize] = useState(DEFAULT_OPTIONS.diarize);
  const [speakerRange, setSpeakerRange] = useState<{ min?: number; max?: number }>({});
  const [speakerGrouping, setSpeakerGrouping] = useState<SpeakerGrouping>('balanced');
  const [context, setContext] = useState('');
  const [termTags, setTermTags] = useState<string[]>([]);

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setStep(1);
      setModel('');
      setLanguage('');
      setIncludeTimestamps(DEFAULT_OPTIONS.includeTimestamps);
      setDiarize(DEFAULT_OPTIONS.diarize);
      setSpeakerRange({});
      setSpeakerGrouping('balanced');
      setContext('');
      setTermTags([]);
    }
    onOpenChange(open);
  };

  // Each stepper is bounded by the other's current value (Min's ceiling is
  // Max, Max's floor is Min - see the SpeakerCountStepper props below), so
  // the pair can never describe an inverted range in the first place. No
  // cross-field "fix it up after the fact" logic needed here.
  const handleMinChange = (value: number | undefined) => {
    setSpeakerRange((prev) => ({ ...prev, min: value }));
  };

  const handleMaxChange = (value: number | undefined) => {
    setSpeakerRange((prev) => ({ ...prev, max: value }));
  };

  const handleConfirm = () => {
    onConfirm({
      includeTimestamps,
      diarize,
      minSpeakers: diarize ? speakerRange.min : undefined,
      maxSpeakers: diarize ? speakerRange.max : undefined,
      clusteringThreshold:
        diarize && speakerGrouping !== 'balanced'
          ? CLUSTERING_THRESHOLD[speakerGrouping]
          : undefined,
      contextTerms: termTags.length > 0 ? termTags.join(', ') : undefined,
      context: context.trim() || undefined,
      model: model || undefined,
      language: language || undefined,
    });
    onOpenChange(false);
  };

  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_transcribe_options_title')}
        description={localize(
          step === 1
            ? 'com_ui_transcribe_options_description'
            : 'com_ui_transcribe_options_context_description',
        )}
        className="w-11/12 sm:w-[28rem]"
        showCloseButton
        showCancelButton={false}
        main={
          <div className="flex w-full flex-col gap-4">
            {step === 1 ? (
              <>
                <div className="grid gap-1.5">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid min-w-0 gap-1.5">
                      <Label htmlFor="transcribe-option-model" className="text-sm font-medium">
                        {localize('com_ui_transcribe_options_model_label')}
                      </Label>
                      <ModelPicker id="transcribe-option-model" value={model} onChange={setModel} />
                    </div>
                    <div className="grid min-w-0 gap-1.5">
                      <Label htmlFor="transcribe-option-language" className="text-sm font-medium">
                        {localize('com_ui_transcribe_options_language_label')}
                      </Label>
                      <LanguagePicker
                        id="transcribe-option-language"
                        value={language}
                        onChange={setLanguage}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-text-secondary">
                    {localize('com_ui_transcribe_options_model_hint_note')}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {localize('com_ui_transcribe_options_language_hint')}
                  </p>
                </div>

                <div className="flex flex-col gap-1">
                  <ToggleRow
                    id="transcribe-option-timestamps"
                    icon={Clock}
                    label={localize('com_ui_transcribe_options_timestamps')}
                    checked={includeTimestamps}
                    onCheckedChange={setIncludeTimestamps}
                  />
                  <ToggleRow
                    id="transcribe-option-diarize"
                    icon={Users}
                    label={localize('com_ui_transcribe_options_diarize')}
                    checked={diarize}
                    onCheckedChange={setDiarize}
                  />
                </div>

                {diarize && (
                  <div className="grid gap-3 rounded-lg border border-border-light bg-surface-secondary p-3">
                    <p className="text-xs text-text-secondary">
                      {localize('com_ui_transcribe_options_speakers_hint')}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label
                          htmlFor="transcribe-option-min-speakers"
                          className="text-xs font-medium text-text-secondary"
                        >
                          {localize('com_ui_transcribe_options_min_speakers')}
                        </Label>
                        <SpeakerCountStepper
                          id="transcribe-option-min-speakers"
                          ariaLabel={localize('com_ui_transcribe_options_min_speakers')}
                          value={speakerRange.min}
                          onChange={handleMinChange}
                          ceiling={speakerRange.max}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label
                          htmlFor="transcribe-option-max-speakers"
                          className="text-xs font-medium text-text-secondary"
                        >
                          {localize('com_ui_transcribe_options_max_speakers')}
                        </Label>
                        <SpeakerCountStepper
                          id="transcribe-option-max-speakers"
                          ariaLabel={localize('com_ui_transcribe_options_max_speakers')}
                          value={speakerRange.max}
                          onChange={handleMaxChange}
                          floor={speakerRange.min}
                        />
                      </div>
                    </div>
                    <SpeakerGroupingControl value={speakerGrouping} onChange={setSpeakerGrouping} />
                  </div>
                )}
              </>
            ) : (
              <>
                <Textarea
                  id="transcribe-option-context"
                  rows={2}
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder={localize('com_ui_transcribe_options_context_placeholder')}
                  aria-label={localize('com_ui_transcribe_options_context_label')}
                  className="focus-visible:border-blue-500 focus-visible:ring-blue-500/20"
                />
                <TagInput
                  id="transcribe-option-terms"
                  ariaLabel={localize('com_ui_transcribe_options_terms_label')}
                  placeholder={localize('com_ui_transcribe_options_terms_placeholder')}
                  addLabel={localize('com_ui_transcribe_options_add_term')}
                  clearAllLabel={localize('com_ui_transcribe_options_clear_terms')}
                  tags={termTags}
                  onChange={setTermTags}
                />
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
