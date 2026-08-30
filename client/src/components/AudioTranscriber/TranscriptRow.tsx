import { memo, useEffect, useRef, useState } from 'react';
import { Play, Pause, Trash2 } from 'lucide-react';
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import SpeakerDropdown from './SpeakerDropdown';
import type { ParsedLine, SpeakerOption } from './types';

interface TranscriptRowProps {
  line: ParsedLine;
  isFollowed: boolean;
  isPreviewing: boolean;
  /** 0-1 progress through this line while it's the one previewing. */
  playbackRatio: number;
  canPlay: boolean;
  speakerOptions: SpeakerOption[];
  isAddingSpeaker: boolean;
  newSpeakerName: string;
  onPlaySegment: (lineIndex: number) => void;
  onTextCommit: (lineIndex: number, text: string) => void;
  onTimeCommit: (lineIndex: number, seconds: number, endSeconds: number) => void;
  onSpeakerSelect: (lineIndex: number, speakerId: string) => void;
  onStartAddSpeaker: (lineIndex: number) => void;
  onNewSpeakerNameChange: (value: string) => void;
  onCommitNewSpeaker: (lineIndex: number) => void;
  onCancelNewSpeaker: () => void;
  /** A line just inserted from the right-click menu, not yet a real
   *  correction - typing text into it and moving on is what actually
   *  creates it (see `TranscriptPanel`'s `onTextCommit`); leaving it blank
   *  discards it the same way. Renders with a dashed border and a delete
   *  button rather than anything structurally different, since it's meant
   *  to feel like an ordinary row you're mid-way through filling in, not a
   *  separate mode. */
  isDraft?: boolean;
  onDeleteDraft?: () => void;
}

/** One transcript line: play/pause + timestamp + speaker assignment on top,
 *  the (editable) text below, and - while this exact line is the one
 *  previewing - a fill bar tracking playback through it.
 *  Memoized because the parent re-renders on every `audio.timeupdate` tick
 *  during playback - most rows' props don't change on a given tick, so this
 *  skips re-rendering them. */
function TranscriptRow({
  line,
  isFollowed,
  isPreviewing,
  playbackRatio,
  canPlay,
  speakerOptions,
  isAddingSpeaker,
  newSpeakerName,
  onPlaySegment,
  onTextCommit,
  onTimeCommit,
  onSpeakerSelect,
  onStartAddSpeaker,
  onNewSpeakerNameChange,
  onCommitNewSpeaker,
  onCancelNewSpeaker,
  isDraft = false,
  onDeleteDraft,
}: TranscriptRowProps) {
  const localize = useLocalize();
  const [text, setText] = useState(line.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [isEditingTime, setIsEditingTime] = useState(false);
  const [startInput, setStartInput] = useState(
    line.seconds != null ? formatSeconds(line.seconds) : '',
  );
  const [endInput, setEndInput] = useState(
    line.endSeconds != null ? formatSeconds(line.endSeconds) : '',
  );
  const startInputRef = useRef<HTMLInputElement>(null);
  /** Guards a single edit session against firing `onTimeCommit` more than
   *  once - Enter commits directly, and the blur that follows (native, once
   *  the input it fired from unmounts) would otherwise commit a second time;
   *  Escape/an invalid value need the same guard so that trailing blur is a
   *  no-op too. Reset to `'editing'` only by `openTimeEditor`, so it's scoped
   *  to exactly one open-to-close cycle. */
  const timeEditSessionRef = useRef<'editing' | 'settled'>('settled');

  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) {
      return;
    }
    // Grows with content instead of exposing the browser's own resize grip,
    // which looks like stray chrome next to the rest of this styled row.
    el.style.height = 'auto';
    // `scrollHeight` is border-exclusive; `height` isn't, under this
    // element's (Tailwind preflight default) `box-sizing: border-box`.
    // Assigning scrollHeight straight to height under-sizes the box by
    // exactly the border width, clipping a sliver off the last line.
    const borderHeight = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + borderHeight}px`;
  };

  useEffect(() => {
    setText(line.text);
  }, [line.text]);

  useEffect(() => {
    setStartInput(line.seconds != null ? formatSeconds(line.seconds) : '');
    setEndInput(line.endSeconds != null ? formatSeconds(line.endSeconds) : '');
  }, [line.seconds, line.endSeconds]);

  useEffect(() => {
    autoResize(textareaRef.current);
  }, [text]);

  useEffect(() => {
    if (isEditingTime) {
      startInputRef.current?.focus();
      startInputRef.current?.select();
    }
  }, [isEditingTime]);

  // Resizing the transcript panel is handled one level up, in
  // `TranscriptPanel` - not here. A `ResizeObserver` per row (one was tried)
  // means every row does its own read-write-read-write height dance on
  // every resize tick; with a transcript of any real length, that's
  // hundreds of forced synchronous reflows per frame while dragging, which
  // is exactly the kind of layout thrashing that tanks frame rate. The
  // panel-level observer instead resets every row's height in one pass,
  // reads every scrollHeight in a second pass, then writes every final
  // height in a third - one reflow total instead of one per row.

  // A draft appears with nothing to type over yet - jump straight into it
  // instead of making the user click first, since the whole point is typing
  // it in while the audio they just played is still fresh.
  useEffect(() => {
    if (isDraft) {
      textareaRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitText = () => {
    const trimmed = text;
    if (trimmed === line.text) {
      return;
    }
    onTextCommit(line.lineIndex, trimmed);
  };

  const openTimeEditor = () => {
    if (line.seconds == null || line.endSeconds == null) {
      return;
    }
    timeEditSessionRef.current = 'editing';
    setStartInput(formatSeconds(line.seconds));
    setEndInput(formatSeconds(line.endSeconds));
    setIsEditingTime(true);
  };

  const commitTime = () => {
    if (timeEditSessionRef.current !== 'editing') {
      return;
    }
    timeEditSessionRef.current = 'settled';
    setIsEditingTime(false);
    const seconds = parseTimeInput(startInput);
    const endSeconds = parseTimeInput(endInput);
    if (seconds == null || endSeconds == null || endSeconds <= seconds) {
      // Unusable input - just revert rather than leaving a bad value hanging.
      setStartInput(line.seconds != null ? formatSeconds(line.seconds) : '');
      setEndInput(line.endSeconds != null ? formatSeconds(line.endSeconds) : '');
      return;
    }
    if (seconds === line.seconds && endSeconds === line.endSeconds) {
      return;
    }
    onTimeCommit(line.lineIndex, seconds, endSeconds);
  };

  const cancelTimeEdit = () => {
    timeEditSessionRef.current = 'settled';
    setStartInput(line.seconds != null ? formatSeconds(line.seconds) : '');
    setEndInput(line.endSeconds != null ? formatSeconds(line.endSeconds) : '');
    setIsEditingTime(false);
  };

  return (
    <div
      data-line-index={line.lineIndex}
      className={cn(
        'rounded-lg border p-3 transition-colors',
        isDraft && 'border-dashed border-blue-500/40 bg-blue-500/5 dark:border-blue-400/40',
        !isDraft &&
          (isFollowed
            ? 'border-blue-500/30 bg-blue-500/5 dark:border-blue-400/30 dark:bg-blue-400/10'
            : 'border-transparent hover:bg-surface-hover'),
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onPlaySegment(line.lineIndex)}
          disabled={!canPlay || line.seconds == null}
          aria-pressed={isPreviewing}
          aria-label={localize(
            isPreviewing ? 'com_ui_transcript_pause_line' : 'com_ui_transcript_play_line_short',
          )}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-text-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            isPreviewing
              ? 'border-blue-500 bg-blue-500 text-white dark:border-blue-400 dark:bg-blue-400'
              : 'border-border-medium enabled:hover:border-blue-500 enabled:hover:text-blue-600 dark:enabled:hover:border-blue-400 dark:enabled:hover:text-blue-400',
          )}
        >
          {isPreviewing ? (
            <Pause className="h-2.5 w-2.5" fill="currentColor" />
          ) : (
            <Play className="ml-0.5 h-2.5 w-2.5" fill="currentColor" />
          )}
        </button>

        {isEditingTime ? (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-blue-500 bg-surface-primary px-1.5 py-0.5 text-xs tabular-nums ring-2 ring-blue-500/20 dark:border-blue-400"
            onBlur={(event) => {
              // Tabbing/clicking from the start field to the end field blurs
              // the first without the edit actually being done - only commit
              // once focus leaves both fields, not on every hop between them.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                commitTime();
              }
            }}
          >
            <TimeInput
              inputRef={startInputRef}
              value={startInput}
              onChange={setStartInput}
              onCommit={commitTime}
              onCancel={cancelTimeEdit}
              ariaLabel={localize('com_ui_transcript_edit_time_start')}
            />
            <span aria-hidden="true" className="text-text-secondary">
              –
            </span>
            <TimeInput
              value={endInput}
              onChange={setEndInput}
              onCommit={commitTime}
              onCancel={cancelTimeEdit}
              ariaLabel={localize('com_ui_transcript_edit_time_end')}
            />
          </span>
        ) : (
          line.timestamp && (
            <button
              type="button"
              onClick={openTimeEditor}
              disabled={line.seconds == null || line.endSeconds == null}
              aria-label={localize('com_ui_transcript_edit_time')}
              className="-mx-1 whitespace-nowrap rounded px-1 text-xs tabular-nums text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 enabled:hover:bg-surface-hover enabled:hover:text-text-primary disabled:cursor-default dark:focus-visible:ring-blue-400/40"
            >
              {line.timestamp}
              {line.endSeconds != null && '–' + formatSeconds(line.endSeconds)}
            </button>
          )
        )}

        {isAddingSpeaker ? (
          <NewSpeakerField
            value={newSpeakerName}
            onChange={onNewSpeakerNameChange}
            onCommit={() => onCommitNewSpeaker(line.lineIndex)}
            onCancel={onCancelNewSpeaker}
          />
        ) : (
          <SpeakerDropdown
            speakerId={line.speaker}
            speakerOptions={speakerOptions}
            onSelect={(speakerId) => onSpeakerSelect(line.lineIndex, speakerId)}
            onAddSpeaker={() => onStartAddSpeaker(line.lineIndex)}
          />
        )}

        {isDraft && onDeleteDraft && (
          <button
            type="button"
            onClick={onDeleteDraft}
            aria-label={localize('com_ui_transcript_insert_dialogue_remove_line')}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        aria-label={localize('com_ui_transcript_line_text', { timestamp: line.timestamp ?? '' })}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
        onBlur={commitText}
        placeholder={
          isDraft ? localize('com_ui_transcript_insert_dialogue_text_placeholder') : undefined
        }
        className="-mx-2 -my-1 w-[calc(100%+1rem)] resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-1 text-sm leading-relaxed text-text-primary transition-colors hover:border-border-medium hover:bg-surface-hover focus:border-blue-500 focus:bg-surface-primary focus:shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:focus:border-blue-400"
      />

      {isPreviewing && (
        <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-border-medium">
          <div
            className="h-full origin-left bg-blue-500 transition-transform duration-100 ease-linear dark:bg-blue-400"
            style={{ transform: `scaleX(${playbackRatio})` }}
          />
        </div>
      )}
    </div>
  );
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${seconds}`;
}

/** Inverts `formatSeconds` - "m:ss.s" (or plain seconds, "h:mm:ss.s", etc.) ->
 *  seconds. `undefined` for anything that isn't a clean run of `:`-separated
 *  numbers, so a still-mid-edit or garbled value never reaches a commit. */
function parseTimeInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(':');
  const numbers = parts.map(Number);
  if (numbers.some((part) => Number.isNaN(part))) {
    return undefined;
  }
  return numbers.reduce((total, part) => total * 60 + part, 0);
}

/** One half (start or end) of the inline timestamp editor - small, borderless,
 *  sized to its content rather than a fixed width, since "1:02.3" and
 *  "12:34.5" are meaningfully different lengths. */
function TimeInput({
  inputRef,
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
}: {
  inputRef?: RefObject<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  ariaLabel: string;
}) {
  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={value}
      aria-label={ariaLabel}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          onCommit();
        } else if (event.key === 'Escape') {
          onCancel();
        }
      }}
      className="w-12 min-w-0 border-none bg-transparent p-0 text-xs tabular-nums text-text-primary focus-visible:outline-none"
    />
  );
}

/** Swaps in for the dropdown while naming a brand-new speaker - same chip
 *  shell, so the row doesn't jump when the two trade places. */
export function NewSpeakerField({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-blue-500 bg-surface-primary px-2.5 py-1 ring-2 ring-blue-500/20 dark:border-blue-400">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-text-secondary"
      />
      <input
        ref={inputRef}
        type="text"
        placeholder={localize('com_ui_transcript_new_speaker_name_placeholder')}
        aria-label={localize('com_ui_transcript_new_speaker_name_placeholder')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') {
            onCommit();
          } else if (event.key === 'Escape') {
            onCancel();
          }
        }}
        className="w-28 min-w-0 border-none bg-transparent p-0 text-xs font-semibold tracking-tight text-text-primary focus-visible:outline-none"
      />
    </span>
  );
}

export default memo(TranscriptRow);
