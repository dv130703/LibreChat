import { memo, useEffect, useRef, useState } from 'react';
import { Play, Pause, Trash2 } from 'lucide-react';
import type { ChangeEvent, KeyboardEvent } from 'react';
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

  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) {
      return;
    }
    // Grows with content instead of exposing the browser's own resize grip,
    // which looks like stray chrome next to the rest of this styled row.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    setText(line.text);
  }, [line.text]);

  useEffect(() => {
    autoResize(textareaRef.current);
  }, [text]);

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

        {line.timestamp && (
          <span className="whitespace-nowrap text-xs tabular-nums text-text-secondary">
            {line.timestamp}
            {line.endSeconds != null && '–' + formatSeconds(line.endSeconds)}
          </span>
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
        className="w-28 min-w-0 border-none bg-transparent p-0 text-xs font-semibold tracking-tight text-text-primary outline-none"
      />
    </span>
  );
}

export default memo(TranscriptRow);
