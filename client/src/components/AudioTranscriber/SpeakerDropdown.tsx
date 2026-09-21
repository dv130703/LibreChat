import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import type { SpeakerOption } from './types';

interface SpeakerDropdownProps {
  /** The speaker id currently assigned to this line; `undefined` means unassigned. */
  speakerId: string | undefined;
  speakerOptions: SpeakerOption[];
  onSelect: (speakerId: string) => void;
  /** The "Add speaker" row - the caller swaps in its own naming field. */
  onAddSpeaker: () => void;
  /** Trigger shows just the color swatch instead of swatch+name+chevron -
   *  for a line whose speaker is already named on the line above it (see
   *  TranscriptRow's `isContinuation`), so a run of short same-speaker
   *  segments doesn't repeat an identical "Speaker 1" label on every one.
   *  Still the exact same popover, still fully reassignable - only the
   *  closed trigger's size changes, and its aria-label keeps naming the
   *  selected speaker even though the label text is hidden. */
  compact?: boolean;
}

/**
 * Per-line speaker assignment. Every row is the same shape - swatch, name,
 * check - and the check slot is always reserved, so moving the selection
 * never shifts a name sideways. One sliding marker tracks the active row
 * instead of each row toggling its own background.
 *
 * The popup portals via Radix - the same fix already used for the audio
 * player's speed menu earlier in this feature. A row's trigger can end up
 * anywhere a caller chooses to render one, including inside a scrollable
 * dialog (`InsertDialogueDialog`), and any ancestor with its own
 * `overflow-y-auto`/`overflow-hidden` (the transcript list, a dialog shell)
 * clips a non-portaled `position: absolute` popup the moment it needs to
 * render past that ancestor's own edge - which reads as "the dropdown is
 * empty," not "clipped," since there's nothing visibly wrong with the
 * trigger itself. Radix's `Popover.Content` also handles flipping
 * above/below and staying on-screen on its own, so the manual
 * `getBoundingClientRect` collision check this used to do isn't needed
 * anymore either.
 *
 * A search field owns the popup's keyboard/ARIA combobox role once it's
 * open - typing filters the list live, and the trigger button becomes a
 * plain "open this" button rather than the combobox itself, since typing
 * to search only makes sense once a real transcript can carry dozens of
 * speakers and scrolling to find one by eye stops being quick.
 */
export default function SpeakerDropdown({
  speakerId,
  speakerOptions,
  onSelect,
  onAddSpeaker,
  compact = false,
}: SpeakerDropdownProps) {
  const localize = useLocalize();
  const uid = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const justOpenedRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [query, setQuery] = useState('');

  const selected = speakerOptions.find((option) => option.id === speakerId);

  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return speakerOptions;
    }
    return speakerOptions.filter((option) => option.name.toLowerCase().includes(normalized));
  }, [speakerOptions, query]);

  // The "Add speaker" row is the first option - pinned there rather than
  // after every real speaker, so it's never something you have to scroll
  // past a long roster to reach. Real speakers shift down one slot to make
  // room for it (index 0 is always "Add speaker"; a filtered option at
  // array position `i` sits at activeIndex `i + 1`).
  const addIndex = 0;
  const lastIndex = filteredOptions.length;
  const optionId = (index: number) => `${uid}-opt-${index}`;

  useLayoutEffect(() => {
    const marker = markerRef.current;
    if (!marker) {
      return;
    }
    if (!open) {
      marker.style.opacity = '0';
      return;
    }
    const el = optionRefs.current[activeIndex];
    if (!el) {
      marker.style.opacity = '0';
      return;
    }
    const instant = justOpenedRef.current;
    justOpenedRef.current = false;
    if (instant) {
      marker.style.transitionDuration = '0ms';
    }
    marker.style.height = `${el.offsetHeight}px`;
    marker.style.transform = `translateY(${el.offsetTop}px)`;
    marker.style.opacity = '1';
    if (instant) {
      void marker.offsetHeight;
      marker.style.transitionDuration = '';
    }
  }, [open, activeIndex, query]);

  // A fresh search every time the popup opens, rather than whatever was
  // typed the last time it was open for a different line.
  function openMenu() {
    justOpenedRef.current = true;
    setQuery('');
    const index = speakerOptions.findIndex((option) => option.id === speakerId);
    setActiveIndex(index < 0 ? addIndex : index + 1);
    setOpen(true);
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      openMenu();
    } else {
      setOpen(false);
    }
  }

  function choose(index: number) {
    setOpen(false);
    triggerRef.current?.focus();
    if (index === addIndex) {
      onAddSpeaker();
    } else if (filteredOptions[index - 1]) {
      onSelect(filteredOptions[index - 1].id);
    }
  }

  function step(delta: number) {
    setActiveIndex((current) => Math.max(addIndex, Math.min(lastIndex, current + delta)));
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && !open) {
      event.preventDefault();
      openMenu();
    }
  }

  // Only the keys that don't collide with normal single-line text editing
  // are intercepted here - Home/End in particular stay native (move the
  // caret in the search text) now that this lives on a real text input
  // instead of the old plain trigger button.
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        break;
      case 'Enter':
        event.preventDefault();
        choose(activeIndex);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={
            compact && selected
              ? localize('com_ui_transcript_speaker_for_line_named', { name: selected.name })
              : localize('com_ui_transcript_speaker_for_line')
          }
          onKeyDown={handleTriggerKeyDown}
          className={cn(
            'flex items-center whitespace-nowrap rounded-md border transition-colors',
            compact ? 'gap-1 p-1' : 'gap-2 px-2.5 py-1 text-xs font-semibold tracking-tight',
            selected
              ? 'border-border-medium bg-surface-primary text-text-primary hover:border-border-heavy'
              : 'border-dashed border-border-medium bg-surface-primary text-text-secondary hover:border-border-heavy',
            open && 'border-blue-500 ring-2 ring-blue-500/20 dark:border-blue-400',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-2.5 w-2.5 shrink-0 rounded-sm',
              selected ? selected.dotColorClass : 'border border-dashed border-text-secondary',
            )}
          />
          {!compact && (
            <span>
              {selected ? selected.name : localize('com_ui_transcript_unassigned_speaker')}
            </span>
          )}
          <ChevronDown
            className={cn(
              'shrink-0 text-text-secondary transition-transform',
              compact ? 'h-2.5 w-2.5' : 'h-3 w-3',
              open && 'rotate-180',
            )}
          />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            // Focus the search field, not whatever Radix would default to -
            // typing immediately should filter, not require an extra click.
            event.preventDefault();
            searchInputRef.current?.focus();
          }}
          className="z-50 flex min-w-[13rem] max-w-[17rem] flex-col overflow-hidden rounded-lg border border-border-medium bg-surface-primary shadow-lg duration-150 animate-in fade-in-0 zoom-in-95"
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border-medium px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              role="combobox"
              aria-expanded={open}
              aria-controls={`${uid}-listbox`}
              aria-activedescendant={optionId(activeIndex)}
              aria-label={localize('com_ui_transcript_search_speakers')}
              placeholder={localize('com_ui_transcript_search_speakers')}
              value={query}
              onChange={(event) => {
                // Reset here, not in an effect keyed on `query` - `openMenu`
                // also resets `query` (to start each open with a clean search),
                // and an effect would fire for that too, stomping the "jump to
                // the current selection" index it sets in the same breath.
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-secondary focus:outline-none"
            />
          </div>

          <div
            id={`${uid}-listbox`}
            role="listbox"
            aria-label={localize('com_ui_transcript_speaker_for_line')}
            className="relative max-h-[min(44vh,18rem)] overflow-y-auto p-1"
          >
            <div
              ref={markerRef}
              className="absolute inset-x-1 top-0 h-0 rounded-md bg-blue-500/10 opacity-0 transition-[transform,height,opacity] duration-200"
            />
            <div
              id={optionId(addIndex)}
              ref={(el) => {
                optionRefs.current[addIndex] = el;
              }}
              role="option"
              aria-selected={false}
              className="relative z-[1] mb-1 flex cursor-pointer items-center gap-2 rounded-md border-b border-border-medium px-2 pb-1 pt-1.5 text-text-secondary duration-150 ease-out animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both"
              onClick={() => choose(addIndex)}
              onMouseMove={() => activeIndex !== addIndex && setActiveIndex(addIndex)}
            >
              <Plus className="h-3 w-3 shrink-0" />
              <span className="flex-1 text-xs font-medium">
                {localize('com_ui_transcript_new_speaker')}
              </span>
              <span className="h-3.5 w-3.5 shrink-0" />
            </div>

            {filteredOptions.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-text-secondary">
                {localize('com_ui_transcript_no_speakers_found')}
              </div>
            )}
            {filteredOptions.map((option, arrayIndex) => {
              const index = arrayIndex + 1;
              return (
                <div
                  key={option.id}
                  id={optionId(index)}
                  ref={(el) => {
                    optionRefs.current[index] = el;
                  }}
                  role="option"
                  aria-selected={option.id === speakerId}
                  style={{ animationDelay: `${index * 18 + 20}ms` }}
                  className="relative z-[1] flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 duration-150 ease-out animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both"
                  onClick={() => choose(index)}
                  onMouseMove={() => activeIndex !== index && setActiveIndex(index)}
                >
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', option.dotColorClass)} />
                  <span className="flex-1 truncate text-xs font-medium text-text-primary">
                    {option.name}
                  </span>
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-blue-600 transition-all dark:text-blue-400',
                      option.id === speakerId ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
                    )}
                  />
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
