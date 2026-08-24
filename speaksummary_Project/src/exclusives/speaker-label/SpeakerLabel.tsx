import type { ChangeEvent } from 'react'
import { speakerColor } from './speakerColor'
import './SpeakerLabel.css'

interface SpeakerLabelProps {
  speaker: string
  uniqueSpeakers: string[]
  onRename: (newName: string) => void
}

/** The renameable field for one speaker - the same chip shape the per-line
 *  dropdown uses, with an editable name where the dropdown has a caret. */
export function SpeakerLabel({ speaker, uniqueSpeakers, onRename }: SpeakerLabelProps) {
  return (
    <label className="speaker-label">
      <span
        className="speaker-label__dot"
        aria-hidden="true"
        style={{ background: speakerColor(speaker, uniqueSpeakers) }}
      />
      <input
        type="text"
        value={speaker}
        size={Math.max(6, speaker.length)}
        aria-label={`Name for ${speaker}`}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onRename(event.target.value)}
      />
      <svg className="speaker-label__pencil" width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </label>
  )
}
