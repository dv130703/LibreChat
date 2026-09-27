import { memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TConversationTranscript } from 'librechat-data-provider';
import RecordingChip from '~/components/AudioTranscriber/RecordingChip';
import { STAGE_LABEL_KEYS, stageFraction } from '~/components/AudioTranscriber/jobProgress';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

/**
 * A recording attached to a message, rendered from the conversation's
 * transcripts read model rather than from the message's own file record.
 *
 * That matters for identity: the persisted file is the ffmpeg-extracted
 * audio track (`clip.m4a`), so labelling this from `file.filename` renamed
 * the recording the instant the real message replaced the upload
 * placeholder. `displayName` carries what the user actually chose.
 *
 * Clicking opens the transcript panel on this same `/c/:id` URL in every
 * state except `failed` - `TranscriptPanel` renders its own queued/
 * transcribing view, so there is no reason to make the user wait for
 * `ready` before they can see the audio player.
 */
const STATUS_LABEL_KEYS = {
  queued: 'com_ui_transcript_card_queued',
  transcribing: 'com_ui_transcript_card_transcribing',
  ready: 'com_ui_transcript_card_ready',
} as const satisfies Record<'queued' | 'transcribing' | 'ready', TranslationKeys>;

function TranscriptCard({ record }: { record: TConversationTranscript }) {
  const localize = useLocalize();
  const [, setSearchParams] = useSearchParams();

  const openTranscript = () => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('panel', 'transcript');
        next.set('file', record.sourceFileId);
        return next;
      },
      { replace: false },
    );
  };

  if (record.jobStatus === 'failed') {
    // Retry renders alongside the message's other hover actions rather than
    // in the chip - see `HoverButtons.tsx`.
    return (
      <RecordingChip
        displayName={record.displayName}
        state="failed"
        statusLabel={localize('com_ui_transcript_card_failed')}
        errorMessage={record.cancelled ? localize('com_ui_transcript_card_cancelled') : undefined}
      />
    );
  }

  /** A record with no job status yet reads as `queued` - the recording
   *  exists, its job just hasn't been stamped on it. */
  const state = record.jobStatus ?? 'queued';
  /** The job's phase when it has reported one, since `jobStatus` says
   *  `transcribing` for the whole run - including the speaker passes that
   *  happen minutes after the transcript itself is finished. */
  const statusLabel =
    state === 'transcribing' && record.jobStage != null
      ? localize(STAGE_LABEL_KEYS[record.jobStage])
      : localize(STATUS_LABEL_KEYS[state]);

  return (
    <RecordingChip
      displayName={record.displayName}
      state={state}
      statusLabel={statusLabel}
      progress={stageFraction(record.jobProgressSeconds, record.jobProgressTotalSeconds)}
      onClick={openTranscript}
    />
  );
}

export default memo(TranscriptCard);
