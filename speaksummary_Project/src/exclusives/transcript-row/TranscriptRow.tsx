import { memo } from 'react'
import { formatTimestamp, type TranscriptSegment } from '../logic'
import { SpeakerDropdown } from '../speaker-label'
import './TranscriptRow.css'

export const NEW_SPEAKER_OPTION = '__new_speaker__'

interface TranscriptRowProps {
  segment: TranscriptSegment
  isFollowed: boolean
  isPreviewing: boolean
  playbackRatio: number
  includeTimestamps: boolean
  diarize: boolean
  canPlay: boolean
  uniqueSpeakers: string[]
  isAddingSpeaker: boolean
  newSpeakerName: string
  onPlaySegment: (segment: TranscriptSegment) => void
  onTextChange: (id: string, text: string) => void
  onSpeakerSelectChange: (segmentId: string, value: string) => void
  onNewSpeakerNameChange: (value: string) => void
  onCommitNewSpeaker: (segmentId: string) => void
  onCancelNewSpeaker: () => void
}

export const TranscriptRow = memo(function TranscriptRow({
  segment,
  isFollowed,
  isPreviewing,
  playbackRatio,
  includeTimestamps,
  diarize,
  canPlay,
  uniqueSpeakers,
  isAddingSpeaker,
  newSpeakerName,
  onPlaySegment,
  onTextChange,
  onSpeakerSelectChange,
  onNewSpeakerNameChange,
  onCommitNewSpeaker,
  onCancelNewSpeaker,
}: TranscriptRowProps) {
  return (
    <div
      data-segment-id={segment.id}
      className={`transcript-row${isFollowed ? ' transcript-row--active' : ''}`}
    >
      <div className="transcript-row__meta">
        <button
          type="button"
          className="transcript-row__play"
          onClick={() => onPlaySegment(segment)}
          disabled={!canPlay}
          aria-label={isPreviewing ? 'Pause this line' : 'Play this line'}
          aria-pressed={isPreviewing}
        >
          {isPreviewing ? (
            <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="3" y="2" width="3.4" height="12" rx="1" />
              <rect x="9.6" y="2" width="3.4" height="12" rx="1" />
            </svg>
          ) : (
            <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4 2.5v11a1 1 0 0 0 1.53.848l8.6-5.5a1 1 0 0 0 0-1.696l-8.6-5.5A1 1 0 0 0 4 2.5Z" />
            </svg>
          )}
        </button>
        {includeTimestamps && (
          <span className="transcript-row__timestamp">
            {formatTimestamp(segment.start)}–{formatTimestamp(segment.end)}
          </span>
        )}
        {diarize && isAddingSpeaker && (
          <span className="transcript-row__speaker-field">
            <span className="transcript-row__speaker-field-dot" aria-hidden="true" />
            <input
              type="text"
              autoFocus
              placeholder="Speaker name"
              aria-label="New speaker name"
              value={newSpeakerName}
              onChange={(event) => onNewSpeakerNameChange(event.target.value)}
              onBlur={() => onCommitNewSpeaker(segment.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onCommitNewSpeaker(segment.id)
                if (event.key === 'Escape') onCancelNewSpeaker()
              }}
            />
          </span>
        )}
        {diarize && !isAddingSpeaker && (
          <SpeakerDropdown
            speaker={segment.speaker}
            uniqueSpeakers={uniqueSpeakers}
            onSelect={(speaker) => onSpeakerSelectChange(segment.id, speaker)}
            onAddSpeaker={() => onSpeakerSelectChange(segment.id, NEW_SPEAKER_OPTION)}
          />
        )}
      </div>
      <textarea
        className="transcript-row__text"
        value={segment.text}
        rows={2}
        aria-label={`Transcript text, ${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)}`}
        onChange={(event) => onTextChange(segment.id, event.target.value)}
      />
      {isPreviewing && (
        <div className="transcript-row__playbar">
          <div className="transcript-row__playbar-fill" style={{ transform: `scaleX(${playbackRatio})` }} />
        </div>
      )}
    </div>
  )
})
