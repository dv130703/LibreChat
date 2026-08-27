import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface SpeakerLabelProps {
  name: string;
  dotColorClass: string;
  /** Rejects a rename that would collide with another speaker's current name -
   *  colors are assigned per speaker id, so two ids sharing a display name
   *  would show that name in two different colors. */
  isNameTaken: (candidateName: string) => boolean;
  onRename: (newName: string) => void;
}

/** The renameable roster entry for one speaker - the same chip shape
 *  `SpeakerDropdown`'s trigger uses, with an editable name where the
 *  dropdown has a chevron. Always a real, focusable `<input>` rather than a
 *  click-to-edit toggle, so there's no separate "edit mode" state that could
 *  auto-focus and steal scroll. Edits commit on blur/Enter (not per
 *  keystroke) so the audit log doesn't fill up with every intermediate
 *  keystroke as its own correction event. */
export default function SpeakerLabel({
  name,
  dotColorClass,
  isNameTaken,
  onRename,
}: SpeakerLabelProps) {
  const localize = useLocalize();
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) {
      setDraft(name);
      return;
    }
    if (isNameTaken(trimmed)) {
      setDraft(name);
      return;
    }
    onRename(trimmed);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      setDraft(name);
      event.currentTarget.blur();
    }
  };

  return (
    <label className="group inline-flex cursor-text items-center gap-2 rounded-md border border-border-medium bg-surface-primary px-2.5 py-1 transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 hover:border-border-heavy dark:focus-within:border-blue-400">
      <span aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', dotColorClass)} />
      <input
        type="text"
        value={draft}
        size={Math.max(6, draft.length)}
        aria-label={localize('com_ui_transcript_rename_speaker_input', { name })}
        onChange={handleChange}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className="min-w-0 max-w-[11rem] border-none bg-transparent p-0 text-xs font-semibold tracking-tight text-text-primary outline-none"
      />
      <Pencil className="h-2.5 w-2.5 shrink-0 text-text-secondary opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" />
    </label>
  );
}
