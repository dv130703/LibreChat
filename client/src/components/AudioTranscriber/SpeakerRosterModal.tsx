import { useEffect, useMemo, useState } from 'react';
import { Pause, Play, Plus, Trash2 } from 'lucide-react';
import { Button, OGDialog, OGDialogTemplate } from '@librechat/client';
import type { ChangeEvent } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { createCustomSpeakerId } from './corrections';
import type { SpeakerOption } from './types';

interface PreviewClip {
  lineIndex: number;
  duration: number | null;
}

interface DraftRow {
  id: string;
  isNew: boolean;
  name: string;
  dotColorClass: string;
}

interface SpeakerRosterModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  speakerOptions: SpeakerOption[];
  /** Only speakers with an entry here have ever been given a real name - a
   *  speaker option's `name` otherwise falls back to its raw id, which isn't
   *  a name a user typed and shouldn't pre-fill the input as if it were. */
  speakerNames: Record<string, string>;
  isSpeakerNameTaken: (candidateName: string, excludeSpeakerId?: string) => boolean;
  onRename: (speakerId: string, newName: string) => void;
  onAddSpeaker: (speakerId: string, name: string) => void;
  preview: Map<string, PreviewClip>;
  canPlay: boolean;
  isPlaying: boolean;
  followedLineIndex: number;
  onTogglePreview: (lineIndex: number) => void;
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/**
 * The roster badge's destination - a blank-slate form that turns "Speaker 1,
 * Speaker 2, …" into real names in one pass instead of one rename-click per
 * line. Every edit here is a local draft; nothing reaches the backend until
 * "Save Changes" is pressed, so "Cancel" needs no revert logic of its own -
 * there's nothing committed yet to undo.
 *
 * Each row's play button previews that speaker's first line via the same
 * bounded-playback path the per-line rows use (`onTogglePreview`, threaded
 * down from `TranscriptPanel`) - the point is to listen, then type the name
 * you recognize, without leaving this dialog to do it.
 */
export default function SpeakerRosterModal({
  open,
  onOpenChange,
  speakerOptions,
  speakerNames,
  isSpeakerNameTaken,
  onRename,
  onAddSpeaker,
  preview,
  canPlay,
  isPlaying,
  followedLineIndex,
  onTogglePreview,
}: SpeakerRosterModalProps) {
  const localize = useLocalize();
  const [drafts, setDrafts] = useState<DraftRow[]>([]);

  // A fresh snapshot every time the dialog opens - not a live mirror of
  // `speakerOptions`, since edits here are local until Save is pressed and
  // shouldn't be disturbed by unrelated corrections landing mid-edit.
  useEffect(() => {
    if (!open) {
      return;
    }
    setDrafts(
      speakerOptions.map((option) => ({
        id: option.id,
        isNew: false,
        name: speakerNames[option.id] ?? '',
        dotColorClass: option.dotColorClass,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmedNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of drafts) {
      map.set(row.id, row.name.trim());
    }
    return map;
  }, [drafts]);

  function isDuplicate(rowId: string, trimmed: string): boolean {
    if (!trimmed) {
      return false;
    }
    const normalized = trimmed.toLowerCase();
    for (const [otherId, otherName] of trimmedNameById) {
      if (otherId !== rowId && otherName !== '' && otherName.toLowerCase() === normalized) {
        return true;
      }
    }
    return isSpeakerNameTaken(trimmed, rowId);
  }

  const hasDuplicate = drafts.some((row) => isDuplicate(row.id, row.name.trim()));

  function updateName(rowId: string, name: string) {
    setDrafts((current) => current.map((row) => (row.id === rowId ? { ...row, name } : row)));
  }

  function removeRow(rowId: string) {
    setDrafts((current) => current.filter((row) => row.id !== rowId));
  }

  function addSpeakerRow() {
    setDrafts((current) => [
      ...current,
      {
        id: createCustomSpeakerId(),
        isNew: true,
        name: '',
        dotColorClass: 'border border-dashed border-text-secondary',
      },
    ]);
  }

  function handleSave() {
    for (const row of drafts) {
      const trimmed = row.name.trim();
      if (!trimmed) {
        continue;
      }
      if (row.isNew) {
        onAddSpeaker(row.id, trimmed);
        continue;
      }
      if (trimmed !== (speakerNames[row.id] ?? '')) {
        onRename(row.id, trimmed);
      }
    }
    onOpenChange(false);
  }

  const namedCount = drafts.filter((row) => row.name.trim() !== '').length;

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_transcript_roster_title')}
        description={localize('com_ui_transcript_roster_description', { count: drafts.length })}
        className="w-full max-w-xl"
        main={
          <div className="flex flex-col gap-3">
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border-medium">
              <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border-medium bg-surface-primary px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                <span className="w-6 shrink-0 text-center">#</span>
                <span className="w-24 shrink-0">
                  {localize('com_ui_transcript_roster_preview_header')}
                </span>
                <span className="flex-1">
                  {localize('com_ui_transcript_roster_identity_header')}
                </span>
              </div>
              <div className="divide-y divide-border-medium">
                {drafts.map((row, index) => {
                  const trimmed = row.name.trim();
                  const duplicate = isDuplicate(row.id, trimmed);
                  const clip = preview.get(row.id);
                  const isRowPlaying =
                    isPlaying && clip != null && followedLineIndex === clip.lineIndex;
                  return (
                    <div key={row.id} className="flex items-start gap-3 px-3 py-2.5">
                      <span className="flex h-9 w-6 shrink-0 items-center justify-center text-sm font-medium tabular-nums text-text-secondary">
                        {index + 1}
                      </span>
                      <div className="flex h-9 w-24 shrink-0 items-center gap-2">
                        {clip ? (
                          <>
                            <button
                              type="button"
                              disabled={!canPlay}
                              onClick={() => onTogglePreview(clip.lineIndex)}
                              aria-label={localize(
                                isRowPlaying
                                  ? 'com_ui_transcript_pause_line'
                                  : 'com_ui_transcript_play_line_short',
                              )}
                              className={cn(
                                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-text-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                                isRowPlaying
                                  ? 'border-blue-500 bg-blue-500 text-white dark:border-blue-400 dark:bg-blue-400'
                                  : 'border-border-medium enabled:hover:border-blue-500 enabled:hover:text-blue-600 dark:enabled:hover:border-blue-400 dark:enabled:hover:text-blue-400',
                              )}
                            >
                              {isRowPlaying ? (
                                <Pause className="h-2.5 w-2.5" fill="currentColor" />
                              ) : (
                                <Play className="ml-0.5 h-2.5 w-2.5" fill="currentColor" />
                              )}
                            </button>
                            <span className="whitespace-nowrap text-xs tabular-nums text-text-secondary">
                              {clip.duration != null ? formatDuration(clip.duration) : '—'}
                            </span>
                          </>
                        ) : (
                          <span className="whitespace-nowrap text-[11px] leading-tight text-text-secondary">
                            {localize('com_ui_transcript_roster_no_preview')}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex h-9 items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={cn('h-2.5 w-2.5 shrink-0 rounded-full', row.dotColorClass)}
                          />
                          <input
                            type="text"
                            value={row.name}
                            placeholder={localize('com_ui_transcript_roster_name_placeholder')}
                            aria-label={localize('com_ui_transcript_roster_name_input_label', {
                              index: index + 1,
                            })}
                            onChange={(event: ChangeEvent<HTMLInputElement>) =>
                              updateName(row.id, event.target.value)
                            }
                            className={cn(
                              'placeholder:text-text-secondary/70 h-9 min-w-0 flex-1 rounded-md border bg-transparent px-3 text-sm text-text-primary outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:focus:border-blue-400',
                              duplicate ? 'border-red-500' : 'border-border-medium',
                            )}
                          />
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center">
                            {row.isNew && (
                              <button
                                type="button"
                                onClick={() => removeRow(row.id)}
                                aria-label={localize('com_ui_transcript_roster_remove_new_speaker')}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-red-500"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                        {duplicate && (
                          <p className="mt-1 text-xs text-red-500">
                            {localize('com_ui_transcript_roster_duplicate_name')}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={addSpeakerRow}
              className="flex items-center justify-center gap-1.5 self-start rounded-md border border-dashed border-border-medium px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {localize('com_ui_transcript_roster_add_speaker')}
            </button>
          </div>
        }
        buttons={
          <Button
            variant="submit"
            onClick={handleSave}
            disabled={hasDuplicate}
            aria-label={localize('com_ui_transcript_roster_save')}
          >
            {localize('com_ui_transcript_roster_save')}
            {namedCount > 0 && ` (${namedCount})`}
          </Button>
        }
      />
    </OGDialog>
  );
}
