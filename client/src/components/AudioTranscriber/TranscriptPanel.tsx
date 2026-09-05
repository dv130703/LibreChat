import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popover from '@radix-ui/react-popover';
import { isEqual } from 'lodash';
import {
  X,
  Mic,
  FileText,
  Download,
  RotateCcw,
  AlertCircle,
  ArrowUpToLine,
  ArrowDownToLine,
  ChevronDown,
} from 'lucide-react';
import { Spinner, usePopoverZIndex } from '@librechat/client';
import {
  useGetConvoIdQuery,
  useFilePreview,
  useTranscriptCorrectionsQuery,
  useRenameTranscriptSpeakerMutation,
  useReassignTranscriptSegmentMutation,
  useEditTranscriptTextMutation,
  useEditTranscriptTimeMutation,
  useInsertTranscriptLineMutation,
  useRetranscribeAudioMutation,
  useExportInterviewDocxMutation,
  useExportMeetingMinutesDocxMutation,
  useTranscribeStatusQuery,
  useRetryTranscriptionMutation,
  useTranscribeAudioTokenQuery,
} from '~/data-provider';
import { parseTranscriptText } from 'librechat-data-provider';
import type { InterviewTranscriptForm, MeetingMinutesForm } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { cn } from '~/utils';
import type { MouseEvent } from 'react';
import type { ParsedLine, SpeakerOption } from './types';
import { useChatHeaderSlot } from './panelHostContext';
import type { PanelComponentProps } from './panelHostContext';
import { computeInsertionSlots, formatSlotTimestamp } from './lineInsert';
import { reduceCorrections, createCustomSpeakerId } from './corrections';
import { getSpeakerDotColor } from './speakerColors';
import TranscribeOptionsDialog from './TranscribeOptionsDialog';
import type { TranscribeAudioOptions } from './TranscribeOptionsDialog';
import InterviewTranscriptDialog from './InterviewTranscriptDialog';
import MeetingMinutesDialog from './MeetingMinutesDialog';
import TranscriptHeader from './TranscriptHeader';
import TranscriptRow from './TranscriptRow';
import { splitFileIds } from './fileIds';
import SpeakerRosterModal from './SpeakerRosterModal';

/** How far short of a bounded-playback boundary to stop, so the next line
 *  never gets a chance to register as "currently playing." */
const BOUNDARY_BACKOFF_SECONDS = 0.15;

/** Rough, fixed estimate of the row context menu's own footprint rather than
 *  measuring it - two lines of text, so the size barely varies, and this
 *  only needs to keep it from hanging off the viewport edge, not be exact. */
const CONTEXT_MENU_WIDTH = 192;
const CONTEXT_MENU_HEIGHT = 76;

function downloadTextFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Below this width, hide a button's text label - always leaving its icon
 *  and `aria-label` behind, so the action stays both visible and
 *  screen-reader-identifiable with no visible text at all.
 *
 *  Read as a shed order, widest threshold first: the export menu's dropdown
 *  chevron goes first (the menu still opens on click with no chevron - only
 *  the visual hint is gone), then Re-transcribe (occasional, and the longest
 *  label), then the speaker roster, and Export keeps its label longest because
 *  it is the most-used action here. Values allow for three labelled buttons -
 *  they were originally tuned for two, so adding Re-transcribe raised them
 *  all rather than just adding a fourth constant. */
const EXPORT_CHEVRON_MIN_WIDTH = 540;
const RETRANSCRIBE_LABEL_MIN_WIDTH = 470;
const SPEAKERS_LABEL_MIN_WIDTH = 400;
const EXPORT_LABEL_MIN_WIDTH = 330;

/** This header lives in a user-resizable split pane (`ChatPanelHost.tsx`,
 *  minSize 320px with no upper bound), not a fixed viewport, so a CSS media
 *  query would never fire just from the user dragging the divider - it
 *  needs to answer to its own measured width instead. A `ResizeObserver` on
 *  the row itself stands in for a container query (the Tailwind version
 *  here doesn't have that plugin installed), and button labels shed
 *  least-essential-first as the row narrows.
 */
function TranscriptPanelHeader({
  lineCount,
  speakerCount,
  modelUsed,
  isRetranscribing,
  isExportingInterview,
  isExportingMeetingMinutes,
  showActions,
  onOpenRoster,
  onExportTxt,
  onExportInterview,
  onExportMeetingMinutes,
  onRetranscribe,
  onClose,
}: {
  lineCount: number;
  speakerCount: number;
  modelUsed?: string;
  isRetranscribing: boolean;
  isExportingInterview: boolean;
  isExportingMeetingMinutes: boolean;
  /** False while there's no transcript yet to act on (loading/queued/
   *  transcribing/failed) - the roster/retranscribe/export actions all
   *  operate on a transcript that doesn't exist yet, so only the title and
   *  close button render then. The header itself is otherwise always
   *  present, not gated on this - the user needs to be able to close the
   *  panel in every one of those states too, not just once it's ready. */
  showActions: boolean;
  onOpenRoster: () => void;
  onExportTxt: () => void;
  onExportInterview: () => void;
  onExportMeetingMinutes: () => void;
  onRetranscribe: () => void;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const rowRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Full labels until the first real measurement lands, rather than
  // collapsing to icons for one frame on every mount.
  const showSpeakersLabel = width === null || width >= SPEAKERS_LABEL_MIN_WIDTH;
  const showExportLabel = width === null || width >= EXPORT_LABEL_MIN_WIDTH;
  const showExportChevron = width === null || width >= EXPORT_CHEVRON_MIN_WIDTH;
  const showRetranscribeLabel = width === null || width >= RETRANSCRIBE_LABEL_MIN_WIDTH;
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuZIndex = usePopoverZIndex();

  const speakersLabel = localize('com_ui_transcript_define_speakers');

  return (
    <div
      ref={rowRef}
      className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border-medium px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400"
        >
          <FileText className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-sm font-semibold leading-tight text-text-primary">
            {localize('com_ui_transcript')}
          </h2>
          {showActions && (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs text-text-secondary">
                {localize('com_ui_transcript_line_count', { count: lineCount })}
              </span>
              {modelUsed != null && modelUsed !== '' && (
                <span
                  title={localize('com_ui_transcript_model', { 0: modelUsed })}
                  aria-label={localize('com_ui_transcript_model', { 0: modelUsed })}
                  className="shrink-0 whitespace-nowrap rounded border border-border-medium px-1.5 py-px font-mono text-[10px] leading-4 text-text-secondary"
                >
                  {modelUsed}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {showActions && (
          <>
            {speakerCount > 0 && (
              <button
                type="button"
                onClick={onOpenRoster}
                aria-label={speakersLabel}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-medium px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary"
              >
                <Mic className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {showSpeakersLabel && <span>{speakersLabel}</span>}
              </button>
            )}
            <button
              type="button"
              onClick={onRetranscribe}
              disabled={isRetranscribing}
              aria-label={localize('com_ui_transcript_retranscribe')}
              title={localize('com_ui_transcript_retranscribe_hint')}
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-medium px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRetranscribing ? (
                <Spinner className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              {showRetranscribeLabel && <span>{localize('com_ui_transcript_retranscribe')}</span>}
            </button>
            <Popover.Root open={exportMenuOpen} onOpenChange={setExportMenuOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label={localize('com_ui_transcript_export')}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-medium px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary"
                >
                  {isExportingInterview || isExportingMeetingMinutes ? (
                    <Spinner className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {showExportLabel && <span>{localize('com_ui_transcript_export')}</span>}
                  {showExportChevron && (
                    <ChevronDown
                      className={cn(
                        'h-3 w-3 shrink-0 text-text-secondary transition-transform',
                        exportMenuOpen && 'rotate-180',
                      )}
                      aria-hidden="true"
                    />
                  )}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="bottom"
                  align="end"
                  sideOffset={4}
                  style={{ zIndex: exportMenuZIndex }}
                  className="w-56 rounded-lg border border-border-medium bg-surface-primary p-1 shadow-lg"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      onExportTxt();
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm text-text-primary hover:bg-surface-hover"
                  >
                    {localize('com_ui_transcript_export_format_txt')}
                    <span className="text-xs text-text-secondary">
                      {localize('com_ui_transcript_export_txt')}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      onExportInterview();
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm text-text-primary hover:bg-surface-hover"
                  >
                    {localize('com_ui_transcript_export_format_interview')}
                    <span className="text-xs text-text-secondary">
                      {localize('com_ui_transcript_export_docx')}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      onExportMeetingMinutes();
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm text-text-primary hover:bg-surface-hover"
                  >
                    {localize('com_ui_transcript_export_format_meeting_minutes')}
                    <span className="text-xs text-text-secondary">
                      {localize('com_ui_transcript_export_docx')}
                    </span>
                  </button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={localize('com_ui_close')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Memoized: `ChatPanelHost` re-rendering (e.g. from `useChatHeaderSlot`'s own
 * `setHeaderSlot` call below settling) must not cascade into re-executing
 * this component's body when its actual props haven't changed - `onResolved`/
 * `onUnresolvable` are stable (`useCallback`'d in `ChatPanelHost`), so a
 * shallow prop comparison correctly bails out. Without this, every
 * `setHeaderSlot` call re-renders the panel, which recreates the header JSX
 * node it passes to `useChatHeaderSlot`, whose effect dependency on that
 * node's identity re-fires `setHeaderSlot` again - an infinite loop that
 * only `act()`'s "Maximum update depth exceeded" in tests makes obvious;
 * outside a test it just pegs a render loop silently.
 */
function TranscriptPanel({
  conversationId,
  fileId,
  onResolved,
  onUnresolvable,
  onClose,
}: PanelComponentProps) {
  const localize = useLocalize();
  const { isAuthenticated } = useAuthContext();
  const {
    data: conversation,
    isLoading: isConvoLoading,
    isError: isConvoError,
    refetch: refetchConvo,
  } = useGetConvoIdQuery(conversationId, { enabled: isAuthenticated });
  const { sourceFileId, transcriptFileId } = useMemo(
    () => splitFileIds((conversation as { files?: string[] } | undefined)?.files ?? []),
    [conversation],
  );

  /** A source file with no transcript yet is either mid-job or landed here
   *  before the job even had a chance to be picked up (e.g. navigating
   *  straight into `?panel=transcript` right after queuing a brand-new
   *  conversation's transcription - the composer's "transcribe this?" flow
   *  does exactly that, rather than waiting out the whole job before the
   *  user sees anything). Polls the same status endpoint `TranscriptCard`
   *  does; once it reports `ready`, the transcript file itself has been
   *  attached to the conversation server-side, so refetching picks up the
   *  now-real `transcriptFileId` from `splitFileIds` above. */
  const { data: jobStatusData } = useTranscribeStatusQuery(sourceFileId ? [sourceFileId] : [], {
    enabled: sourceFileId != null && transcriptFileId == null,
  });
  const jobStatus = jobStatusData?.files.find((entry) => entry.file_id === sourceFileId);
  const retryTranscription = useRetryTranscriptionMutation();

  useEffect(() => {
    if (jobStatus?.status === 'ready') {
      refetchConvo();
    }
  }, [jobStatus?.status, refetchConvo]);

  /** Reports this panel's real target back to `ChatPanelHost` once the
   *  conversation has loaded - `fileId` (from the `?file=` URL param, if
   *  present) not matching what the conversation actually resolves to is
   *  treated as "this specific target doesn't exist for this viewer"
   *  (closed with a toast, ChatPanelHost §6.3), distinct from a query error
   *  (transient, retryable, handled by the existing `isConvoError` state
   *  below). Waits for a definite load outcome rather than firing on every
   *  intermediate render, so a briefly-stale cache read can't misfire this. */
  useEffect(() => {
    if (isConvoLoading || isConvoError || !sourceFileId) {
      return;
    }
    if (fileId != null && fileId !== sourceFileId) {
      onUnresolvable();
      return;
    }
    onResolved(sourceFileId);
  }, [isConvoLoading, isConvoError, sourceFileId, fileId, onResolved, onUnresolvable]);

  const { data: preview, isLoading: isPreviewLoading } = useFilePreview(transcriptFileId);
  const lines = useMemo(
    () => (preview?.text ? parseTranscriptText(preview.text) : []),
    [preview?.text],
  );

  const { data: corrections } = useTranscriptCorrectionsQuery(transcriptFileId, conversationId);
  const [retranscribeOpen, setRetranscribeOpen] = useState(false);
  const retranscribe = useRetranscribeAudioMutation();

  /** The option set that produced the current transcript, so re-running starts
   *  from what was actually used rather than from the dialog's defaults. */
  const previousOptions = useMemo<TranscribeAudioOptions | undefined>(() => {
    const meta = conversation?.transcription;
    if (!meta) {
      return undefined;
    }
    return {
      includeTimestamps: meta.includeTimestamps ?? true,
      diarize: meta.diarize ?? true,
      minSpeakers: meta.minSpeakers,
      maxSpeakers: meta.maxSpeakers,
      clusteringThreshold: meta.clusteringThreshold,
      contextTerms: meta.contextTerms,
      context: meta.context,
      model: meta.requestedModel,
      language: meta.language,
      suppressNumerals: meta.suppressNumerals,
    };
  }, [conversation?.transcription]);

  const handleRetranscribe = useCallback(
    (options: TranscribeAudioOptions) => {
      if (!sourceFileId) {
        return;
      }
      retranscribe.mutate({ sourceFileId, options });
    },
    [sourceFileId, retranscribe],
  );
  const { speakerNames, segmentReassignments, textEdits, timeEdits, insertedLines } = useMemo(
    () => reduceCorrections(corrections ?? []),
    [corrections],
  );

  /** `reduceCorrections` builds brand-new objects every time `corrections`
   *  changes at all - including for a plain text-edit correction, which
   *  never touches speaker data. Passing those straight through would give
   *  `speakerOrder`/`speakerOptions` below a new reference on every single
   *  edit of any kind, which - since `speakerOptions` is a prop on every
   *  row - would defeat `TranscriptRow`'s `memo()` for the entire
   *  (unvirtualized) list on every commit, not just the one row that
   *  changed. Freezing these three to their previous reference when the
   *  values are actually unchanged keeps that cascade scoped to edits that
   *  actually touch speaker data (renames, reassignments, and inserted
   *  lines, which carry a speaker of their own). */
  const stableSpeakerDataRef = useRef({ speakerNames, segmentReassignments, insertedLines });
  if (
    !isEqual(stableSpeakerDataRef.current.speakerNames, speakerNames) ||
    !isEqual(stableSpeakerDataRef.current.segmentReassignments, segmentReassignments) ||
    !isEqual(stableSpeakerDataRef.current.insertedLines, insertedLines)
  ) {
    stableSpeakerDataRef.current = { speakerNames, segmentReassignments, insertedLines };
  }
  const stableSpeakerNames = stableSpeakerDataRef.current.speakerNames;
  const stableSegmentReassignments = stableSpeakerDataRef.current.segmentReassignments;
  const stableInsertedLines = stableSpeakerDataRef.current.insertedLines;

  const effectiveLines = useMemo(() => {
    const insertedList = Object.values(stableInsertedLines);
    const baseLines = insertedList.length === 0 ? lines : [...lines, ...insertedList];
    const hasOverlay =
      Object.keys(stableSegmentReassignments).length > 0 ||
      Object.keys(textEdits).length > 0 ||
      Object.keys(timeEdits).length > 0;
    const overlaid = !hasOverlay
      ? baseLines
      : baseLines.map((line) => {
          const reassignedTo = stableSegmentReassignments[line.lineIndex];
          const editedText = textEdits[line.lineIndex];
          const editedTime = timeEdits[line.lineIndex];
          if (reassignedTo == null && editedText == null && editedTime == null) {
            return line;
          }
          return {
            ...line,
            speaker: reassignedTo ?? line.speaker,
            text: editedText ?? line.text,
            timestamp: editedTime ? formatSlotTimestamp(editedTime.seconds) : line.timestamp,
            seconds: editedTime?.seconds ?? line.seconds,
            endSeconds: editedTime?.endSeconds ?? line.endSeconds,
          };
        });
    // Original lines already come out of `parseTranscript` in time order;
    // only re-sort once an inserted line's fractional index needs merging in.
    return insertedList.length === 0
      ? overlaid
      : overlaid.sort((a, b) => a.lineIndex - b.lineIndex);
  }, [lines, stableSegmentReassignments, textEdits, timeEdits, stableInsertedLines]);

  /** `effectiveLines` gets a new array reference on every single correction
   *  (any edit, on any line, of any type) - the fast path a few lines up
   *  only keeps individual *untouched* line objects stable, not the array
   *  itself. Reading through this ref instead of closing over `effectiveLines`
   *  directly is what lets the callbacks below skip it as a dependency, so
   *  they don't churn - and defeat every `TranscriptRow`'s `memo()` for the
   *  entire (unvirtualized) list - on every commit, the exact same class of
   *  bug `stableSpeakerDataRef` above exists to prevent for `speakerOptions`. */
  const effectiveLinesRef = useRef(effectiveLines);
  effectiveLinesRef.current = effectiveLines;

  /** `lineIndex` is a stable identity, not an array position, once inserted
   *  lines exist between the original integer ones - every lookup by
   *  `lineIndex` alone (as opposed to `togglePlaySegment`'s, which also needs
   *  the *next* line and so tracks array position itself) goes through this. */
  const findEffectiveLine = useCallback(
    (lineIndex: number) => effectiveLinesRef.current.find((line) => line.lineIndex === lineIndex),
    [],
  );

  /** A line just inserted from the right-click menu, rendered and playable
   *  in place immediately - not yet a real correction, since typing text
   *  into it (or leaving it blank) is what actually decides whether it
   *  becomes one (see `onTextCommit`). Purely local state; never sent
   *  anywhere until it's committed. */
  const [drafts, setDrafts] = useState<ParsedLine[]>([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // Once a draft's own `line_insert` correction has actually round-tripped
  // and shows up in `insertedLines`, the local draft that stood in for it is
  // done its job - dropping it here (rather than the moment the mutation is
  // fired) avoids a flash of the row briefly disappearing before the real
  // one takes its place.
  useEffect(() => {
    setDrafts((current) => current.filter((draft) => !(draft.lineIndex in stableInsertedLines)));
  }, [stableInsertedLines]);

  /** What actually renders - real lines plus any still-uncommitted drafts,
   *  in time order. Playback (`togglePlaySegment`) also looks lines up
   *  through this, not `effectiveLines` alone, so a draft's play button
   *  works immediately - re-hearing the exact gap being filled in is the
   *  entire point of not doing this as a modal. */
  const displayLines = useMemo(() => {
    if (drafts.length === 0) {
      return effectiveLines;
    }
    return [...effectiveLines, ...drafts].sort((a, b) => a.lineIndex - b.lineIndex);
  }, [effectiveLines, drafts]);

  const displayLinesRef = useRef(displayLines);
  displayLinesRef.current = displayLines;

  const deleteDraft = useCallback((lineIndex: number) => {
    setDrafts((current) => current.filter((draft) => draft.lineIndex !== lineIndex));
  }, []);

  // Derived from the raw parsed `lines` (+ inserted lines) + reassignments
  // directly, not from `effectiveLines` - that array gets a new reference on
  // every text edit too (see above), which would recompute this (and
  // everything chained off it) for edits that never touch which speakers
  // exist at all.
  const speakerOrder = useMemo(() => {
    const order = new Map<string, number>();
    for (const line of lines) {
      const speaker = stableSegmentReassignments[line.lineIndex] ?? line.speaker;
      if (speaker != null && !order.has(speaker)) {
        order.set(speaker, order.size);
      }
    }
    for (const line of Object.values(stableInsertedLines)) {
      const speaker = stableSegmentReassignments[line.lineIndex] ?? line.speaker;
      if (speaker != null && !order.has(speaker)) {
        order.set(speaker, order.size);
      }
    }
    // A speaker named ahead of any line being assigned to them (via the
    // roster modal's "Add New Speaker") still belongs in the roster and the
    // per-line picker - otherwise a name typed in there would have nowhere
    // to attach to until some other line happened to get reassigned to it.
    for (const speakerId of Object.keys(stableSpeakerNames)) {
      if (!order.has(speakerId)) {
        order.set(speakerId, order.size);
      }
    }
    return order;
  }, [lines, stableSegmentReassignments, stableInsertedLines, stableSpeakerNames]);

  const getDisplayName = useCallback(
    (speakerId: string) => stableSpeakerNames[speakerId] ?? speakerId,
    [stableSpeakerNames],
  );

  /* Colors are assigned per speaker ID (deterministic, order-of-first-
   * appearance), never per display name - so two IDs that end up sharing a
   * display name (e.g. a custom speaker renamed to something an existing
   * speaker is already called) would show that same name with two different
   * colors, breaking the "recognize by color" guarantee. Rather than key
   * color off the name instead (which would make color jump around as
   * speakers get renamed), renames are blocked from creating the collision
   * in the first place. */
  const isSpeakerNameTaken = useCallback(
    (candidateName: string, excludeSpeakerId?: string) => {
      const normalized = candidateName.trim().toLowerCase();
      for (const id of speakerOrder.keys()) {
        if (id !== excludeSpeakerId && getDisplayName(id).trim().toLowerCase() === normalized) {
          return true;
        }
      }
      return false;
    },
    [speakerOrder, getDisplayName],
  );

  const uniqueSpeakerIds = useMemo(() => Array.from(speakerOrder.keys()), [speakerOrder]);

  const speakerOptions: SpeakerOption[] = useMemo(
    () =>
      uniqueSpeakerIds.map((id) => ({
        id,
        name: getDisplayName(id),
        dotColorClass: getSpeakerDotColor(speakerOrder.get(id) ?? 0),
      })),
    [uniqueSpeakerIds, speakerOrder, getDisplayName],
  );

  /** A representative clip for each speaker - their first line - so the
   *  roster modal's play button can answer "whose voice is this" without
   *  leaving the dialog. Keyed off `effectiveLines` (post-reassignment), so
   *  the clip always belongs to whichever speaker id it's filed under now. */
  const speakerPreview = useMemo(() => {
    const map = new Map<string, { lineIndex: number; duration: number | null }>();
    for (const line of effectiveLines) {
      if (line.speaker == null || map.has(line.speaker) || line.seconds == null) {
        continue;
      }
      map.set(line.speaker, {
        lineIndex: line.lineIndex,
        duration: line.endSeconds != null ? line.endSeconds - line.seconds : null,
      });
    }
    return map;
  }, [effectiveLines]);

  const [rosterModalOpen, setRosterModalOpen] = useState(false);

  // A direct, streamable URL (transcription/ARCHITECTURE.md §12 #13) - not a
  // blob fetched into memory and cached forever. `useTranscribeAudioTokenQuery`
  // uses react-query's normal retry/backoff, so a transient failure (the only
  // thing that can fail here - minting a token moves no file bytes) recovers
  // on its own; `audioQuery.refetch` below is still exposed for the header's
  // own manual retry affordance on a harder failure.
  const audioQuery = useTranscribeAudioTokenQuery(sourceFileId);
  const audioSrc = audioQuery.data?.url;

  const audioRef = useRef<HTMLAudioElement>(null);
  /** Bumped once `TranscriptHeader` reports its `<audio>` node has actually
   *  mounted (`onAudioMounted` below), purely to give the listener-attachment
   *  effect further down a dependency that reflects when `audioRef.current`
   *  becomes non-null - see that effect's comment for why `[audioSrc]` alone
   *  isn't enough. */
  const [audioElVersion, setAudioElVersion] = useState(0);
  const handleAudioMounted = useCallback(() => {
    setAudioElVersion((version) => version + 1);
  }, []);
  const rowsContainerRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  /** A boundary (in seconds) past which playback auto-pauses - set whenever
   *  playback was started bounded to a single line, so it stops right where
   *  that line ends instead of continuing into the next. Watched by a
   *  `requestAnimationFrame` loop (~60 times a second) rather than the
   *  `timeupdate` event (throttled to ~4 times a second by browsers) -
   *  `timeupdate` is fine for tracking the playhead for highlighting, but far
   *  too coarse to catch a stop point before audio has already played past
   *  it and come out of the speakers. */
  const playUntilRef = useRef<number | null>(null);
  const boundaryRafRef = useRef<number | null>(null);
  /** Which line the current boundary belongs to (null when nothing's
   *  bounded) - and which line last reached its boundary on its own. This is
   *  what lets a chunk's play button tell "you paused this partway through"
   *  (should resume right there, like any ordinary player) apart from "this
   *  already played to the end" (nothing left to resume - pressing play
   *  again should start over), instead of treating every pause the same way. */
  const boundaryLineIndexRef = useRef<number | null>(null);
  const finishedLineIndexRef = useRef<number | null>(null);

  const stopBoundaryWatch = useCallback(() => {
    if (boundaryRafRef.current != null) {
      cancelAnimationFrame(boundaryRafRef.current);
      boundaryRafRef.current = null;
    }
  }, []);

  /** Retires whatever bounded-playback was in flight - called by the main
   *  player's own controls (play/skip/seek), which have no notion of "stop at
   *  this line's end" and shouldn't inherit one left over from a chunk button.
   *  Deliberately NOT called on every pause: pausing a chunk with its own
   *  button and pressing that same button again needs the boundary to still
   *  be there to resume into, not silently gone. */
  const clearBoundary = useCallback(() => {
    playUntilRef.current = null;
    boundaryLineIndexRef.current = null;
    stopBoundaryWatch();
  }, [stopBoundaryWatch]);

  // Contributes the audio player into the chat pane's header region - see
  // `useChatHeaderSlot`'s own comment on why this replaced a DOM portal.
  useChatHeaderSlot(
    <TranscriptHeader
      audioSrc={audioSrc}
      audioRef={audioRef}
      hasError={audioQuery.isError}
      onRetry={audioQuery.refetch}
      onUnboundedPlaybackRequested={clearBoundary}
      onAudioMounted={handleAudioMounted}
    />,
  );

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) {
      return;
    }
    /**
     * `<audio>` itself is rendered by `TranscriptHeader`, which
     * `useChatHeaderSlot` lifts into `ChatPanelHost`'s own state (a header
     * region this component doesn't render directly) - so on the render
     * where `audioSrc` first becomes truthy, that DOM node doesn't exist
     * yet; it only mounts once `ChatPanelHost` re-renders with the new
     * header-slot content, one commit later. An effect keyed on `[audioSrc]`
     * alone runs too early, finds `audioRef.current` still `null`, and -
     * since `audioSrc` doesn't change again - never gets a second chance to
     * attach these listeners: audio keeps playing (the header's own inline
     * JSX handlers on the same element are unaffected), but this
     * component's `currentTime`/`isPlaying` never update, so segment
     * highlighting/tracking silently never starts. `audioElVersion`
     * (bumped by `setAudioEl`, the callback ref actually attached to the
     * node) re-runs this effect the moment the node really exists.
     */
    // Boundary enforcement for bounded playback lives in the rAF loop below,
    // not here - `timeupdate` only fires a few times a second (browsers
    // commonly throttle it to ~250ms), so by the time it would notice we'd
    // crossed a stop point, that much audio has already come out of the
    // speakers. This handler just tracks the playhead for highlighting.
    const handleTimeUpdate = () => setCurrentTime(audioEl.currentTime);
    const handlePlay = () => setIsPlaying(true);
    // A pause (from anywhere) just means "not playing right now" - it does
    // NOT retire the boundary, since resuming the exact same chunk needs it
    // to still be armed. Stopping the watch loop here is just housekeeping
    // (nothing to poll for while paused); it re-arms on resume.
    const handlePause = () => {
      setIsPlaying(false);
      stopBoundaryWatch();
    };
    audioEl.addEventListener('timeupdate', handleTimeUpdate);
    audioEl.addEventListener('play', handlePlay);
    audioEl.addEventListener('pause', handlePause);
    return () => {
      audioEl.removeEventListener('timeupdate', handleTimeUpdate);
      audioEl.removeEventListener('play', handlePlay);
      audioEl.removeEventListener('pause', handlePause);
    };
  }, [audioSrc, audioElVersion, stopBoundaryWatch]);

  /** Whichever line the playhead currently falls within - drives both the
   *  "follow along" highlight/auto-scroll and, while `isPlaying`, doubles as
   *  the previewing line's live position for its progress bar. */
  const followedLineIndex = useMemo(() => {
    for (let i = displayLines.length - 1; i >= 0; i--) {
      const line = displayLines[i];
      if (
        line.seconds != null &&
        currentTime >= line.seconds &&
        (line.endSeconds == null || currentTime < line.endSeconds)
      ) {
        return line.lineIndex;
      }
    }
    return -1;
  }, [displayLines, currentTime]);

  // Same reasoning as `effectiveLinesRef` above: `togglePlaySegment` needs
  // the current value of both at call time, not at the time it was created -
  // reading them by ref instead of closing over them keeps every row's
  // `onPlaySegment` prop identity stable through ordinary playback ticks
  // (`isPlaying`/`followedLineIndex` change up to ~4x/sec while anything is
  // playing), instead of re-rendering the whole list that often.
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const followedLineIndexRef = useRef(followedLineIndex);
  followedLineIndexRef.current = followedLineIndex;

  useEffect(() => {
    if (followedLineIndex < 0) {
      return;
    }
    const container = rowsContainerRef.current;
    const row = document.querySelector(`[data-line-index="${followedLineIndex}"]`);
    if (!container || !row) {
      return;
    }
    // Only follow the playhead when it's actually leaving view - re-centering
    // on every single line, including ones already comfortably on screen,
    // would yank whatever's under the mouse (often the play/pause button just
    // clicked) away on every line change, forcing a hunt for it mid-playback.
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const isFullyVisible =
      rowRect.top >= containerRect.top && rowRect.bottom <= containerRect.bottom;
    if (isFullyVisible) {
      return;
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [followedLineIndex]);

  const startBoundaryWatch = useCallback(() => {
    if (boundaryRafRef.current != null) {
      return;
    }
    const tick = () => {
      const audioEl = audioRef.current;
      const boundary = playUntilRef.current;
      if (!audioEl || boundary == null) {
        boundaryRafRef.current = null;
        return;
      }
      if (audioEl.currentTime >= boundary) {
        // Stop just short of the boundary, not on top of it - landing
        // exactly on the next line's start would make it read as
        // "currently playing" even though we deliberately never played into
        // it, and the backoff also absorbs whatever tiny overshoot still
        // slipped through this frame.
        const stopAt = Math.max(0, boundary - BOUNDARY_BACKOFF_SECONDS);
        audioEl.pause();
        audioEl.currentTime = stopAt;
        playUntilRef.current = null;
        finishedLineIndexRef.current = boundaryLineIndexRef.current;
        boundaryLineIndexRef.current = null;
        setCurrentTime(stopAt);
        boundaryRafRef.current = null;
        return;
      }
      boundaryRafRef.current = requestAnimationFrame(tick);
    };
    boundaryRafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => stopBoundaryWatch, [stopBoundaryWatch]);

  /** Seeking before the element has loaded metadata (`readyState === 0`) is
   *  unreliable across browsers - the assignment can be silently ignored or
   *  reset once metadata does load, which would play from wherever the
   *  element happened to be (often the very start) instead of where we
   *  asked, while still applying our stop boundary - i.e. exactly "plays the
   *  wrong content, bounded to the wrong window." Deferring the seek until
   *  `loadedmetadata` (or immediately, if already loaded) closes that gap. */
  const seekAndPlayBounded = useCallback(
    (startSeconds: number, boundarySeconds: number | null) => {
      const audioEl = audioRef.current;
      if (!audioEl) {
        return;
      }
      const run = () => {
        audioEl.currentTime = startSeconds;
        playUntilRef.current = boundarySeconds;
        audioEl.play().catch(() => {});
        startBoundaryWatch();
      };
      if (audioEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
        run();
      } else {
        audioEl.addEventListener('loadedmetadata', run, { once: true });
      }
    },
    [startBoundaryWatch],
  );

  /** Plays just this one line, stopping at its own real end time - not the
   *  next line's start, which can sit noticeably later than where this
   *  line's speech actually stops (letting the next speaker bleed in).
   *  Same rule as any ordinary player:
   *  - playing this line right now -> pause in place (nothing finished, so a
   *    later press should pick back up from here)
   *  - paused partway through this exact line (you stopped it, it didn't
   *    reach the end on its own) -> resume right where it is
   *  - anything else - never started, a different line, or this one
   *    genuinely already played to its end - -> (re)start from the top,
   *    since there's nothing left to resume */
  const togglePlaySegment = useCallback(
    (lineIndex: number) => {
      const audioEl = audioRef.current;
      // Drafts too, not just committed lines - a draft's play button needs
      // to work immediately, since re-hearing the exact gap being filled in
      // is the reason this isn't a modal that would take the audio away.
      const currentLines = displayLinesRef.current;
      // `lineIndex` is a stable identity, not an array position, once
      // inserted lines exist between the original integer ones - looked up
      // by value, with the surrounding array position (not `lineIndex + 1`)
      // giving the real next line for the end-of-segment boundary below.
      const position = currentLines.findIndex((candidate) => candidate.lineIndex === lineIndex);
      const line = position === -1 ? undefined : currentLines[position];
      if (!audioEl || line?.seconds == null) {
        return;
      }
      const isThisLineCurrent = followedLineIndexRef.current === lineIndex;
      if (isPlayingRef.current && isThisLineCurrent) {
        audioEl.pause();
        return;
      }

      if (
        isThisLineCurrent &&
        boundaryLineIndexRef.current === lineIndex &&
        finishedLineIndexRef.current !== lineIndex &&
        playUntilRef.current != null
      ) {
        audioEl.play().catch(() => {});
        startBoundaryWatch();
        return;
      }

      const boundary = line.endSeconds ?? currentLines[position + 1]?.seconds ?? null;
      finishedLineIndexRef.current = null;
      boundaryLineIndexRef.current = lineIndex;
      seekAndPlayBounded(line.seconds, boundary);
    },
    [seekAndPlayBounded, startBoundaryWatch],
  );

  /* Corrections - backend-persisted with real user attribution (an
   * append-only `TranscriptCorrection` log), not device-local, since a
   * forensic reviewer's changes need to survive across devices and
   * reviewers and carry a real "who changed this, when." */
  const renameSpeakerMutation = useRenameTranscriptSpeakerMutation(transcriptFileId ?? '');
  const reassignSegmentMutation = useReassignTranscriptSegmentMutation(transcriptFileId ?? '');
  const editTextMutation = useEditTranscriptTextMutation(transcriptFileId ?? '');
  const editTimeMutation = useEditTranscriptTimeMutation(transcriptFileId ?? '');
  const insertLineMutation = useInsertTranscriptLineMutation(transcriptFileId ?? '');

  const renameSpeaker = useCallback(
    (speakerId: string, newName: string) => {
      if (!conversationId) {
        return;
      }
      renameSpeakerMutation.mutate({
        conversationId,
        speakerId,
        fromName: getDisplayName(speakerId),
        toName: newName,
      });
    },
    // react-query's useMutation() returns a brand-new object every render;
    // only `.mutate` itself is stable (bound once on the MutationObserver
    // instance), so listing the whole mutation object here would make this
    // callback - and every TranscriptRow it's passed to - churn on each of
    // the ~4/sec `timeupdate` re-renders during playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, getDisplayName, renameSpeakerMutation.mutate],
  );

  const reassignSegment = useCallback(
    (lineIndex: number, toSpeakerId: string) => {
      // A draft has no correction to reassign yet - just remember the pick
      // locally until it's actually committed (see `onTextCommit`).
      if (draftsRef.current.some((draft) => draft.lineIndex === lineIndex)) {
        setDrafts((current) =>
          current.map((draft) =>
            draft.lineIndex === lineIndex ? { ...draft, speaker: toSpeakerId } : draft,
          ),
        );
        return;
      }
      if (!conversationId) {
        return;
      }
      const fromSpeakerId = findEffectiveLine(lineIndex)?.speaker;
      reassignSegmentMutation.mutate({ conversationId, lineIndex, fromSpeakerId, toSpeakerId });
    },
    // See the eslint-disable note on `renameSpeaker` above - same reasoning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, findEffectiveLine, reassignSegmentMutation.mutate],
  );

  const onTextCommit = useCallback(
    (lineIndex: number, toText: string) => {
      const draft = draftsRef.current.find((candidate) => candidate.lineIndex === lineIndex);
      if (draft) {
        const trimmed = toText.trim();
        if (!trimmed) {
          // Never actually typed into - discard, same as if the context
          // menu had never been used at all.
          setDrafts((current) => current.filter((candidate) => candidate.lineIndex !== lineIndex));
          return;
        }
        if (!conversationId || draft.seconds == null || draft.endSeconds == null) {
          return;
        }
        insertLineMutation.mutate({
          conversationId,
          lineIndex: draft.lineIndex,
          speaker: draft.speaker,
          text: trimmed,
          seconds: draft.seconds,
          endSeconds: draft.endSeconds,
        });
        return;
      }
      if (!conversationId) {
        return;
      }
      editTextMutation.mutate({
        conversationId,
        lineIndex,
        fromText: findEffectiveLine(lineIndex)?.text,
        toText,
      });
    },
    // See the eslint-disable note on `renameSpeaker` above - same reasoning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, findEffectiveLine, editTextMutation.mutate, insertLineMutation.mutate],
  );

  const onTimeCommit = useCallback(
    (lineIndex: number, seconds: number, endSeconds: number) => {
      // A draft's timing hasn't been committed as a correction yet either -
      // same local-only treatment as `reassignSegment` gives a draft's speaker,
      // so retiming a not-yet-saved line never fires a network request for a
      // correction that doesn't exist.
      if (draftsRef.current.some((draft) => draft.lineIndex === lineIndex)) {
        setDrafts((current) =>
          current.map((draft) =>
            draft.lineIndex === lineIndex
              ? { ...draft, timestamp: formatSlotTimestamp(seconds), seconds, endSeconds }
              : draft,
          ),
        );
        return;
      }
      if (!conversationId) {
        return;
      }
      const effective = findEffectiveLine(lineIndex);
      editTimeMutation.mutate({
        conversationId,
        lineIndex,
        fromSeconds: effective?.seconds,
        fromEndSeconds: effective?.endSeconds,
        seconds,
        endSeconds,
      });
    },
    // See the eslint-disable note on `renameSpeaker` above - same reasoning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, findEffectiveLine, editTimeMutation.mutate],
  );

  /* Adding a brand-new speaker the pipeline missed - the naming field lives
   * on the row being reassigned, so this state (which line, and the name
   * being typed) is lifted here rather than kept per-row. */
  const [addingSpeakerForLine, setAddingSpeakerForLine] = useState<number | null>(null);
  const [newSpeakerName, setNewSpeakerName] = useState('');

  const startAddSpeaker = useCallback((lineIndex: number) => {
    setAddingSpeakerForLine(lineIndex);
    setNewSpeakerName('');
  }, []);

  const cancelNewSpeaker = useCallback(() => {
    setAddingSpeakerForLine(null);
    setNewSpeakerName('');
  }, []);

  const commitNewSpeaker = useCallback(
    (lineIndex: number) => {
      setAddingSpeakerForLine(null);
      const trimmed = newSpeakerName.trim();
      setNewSpeakerName('');
      if (!trimmed || !conversationId) {
        return;
      }
      if (isSpeakerNameTaken(trimmed)) {
        window.alert(localize('com_ui_transcript_duplicate_speaker_name'));
        return;
      }
      const newSpeakerId = createCustomSpeakerId();
      // Naming the speaker is real either way; only *attributing* an
      // existing line to it needs the reassign correction below - a draft
      // has no line to reassign yet, so it just remembers the pick locally.
      if (draftsRef.current.some((draft) => draft.lineIndex === lineIndex)) {
        setDrafts((current) =>
          current.map((draft) =>
            draft.lineIndex === lineIndex ? { ...draft, speaker: newSpeakerId } : draft,
          ),
        );
        renameSpeakerMutation.mutate({ conversationId, speakerId: newSpeakerId, toName: trimmed });
        return;
      }
      const fromSpeakerId = findEffectiveLine(lineIndex)?.speaker;
      reassignSegmentMutation.mutate(
        { conversationId, lineIndex, fromSpeakerId, toSpeakerId: newSpeakerId },
        {
          onSuccess: () => {
            renameSpeakerMutation.mutate({
              conversationId,
              speakerId: newSpeakerId,
              toName: trimmed,
            });
          },
        },
      );
    },
    // See the eslint-disable note on `renameSpeaker` above - same reasoning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      newSpeakerName,
      conversationId,
      isSpeakerNameTaken,
      localize,
      findEffectiveLine,
      reassignSegmentMutation.mutate,
      renameSpeakerMutation.mutate,
    ],
  );

  /* Inserting a line the pipeline missed entirely - right-click a row for a
   * two-item context menu ("insert dialogue above/below"), which drops a new,
   * immediately-editable draft row right there, in place - not a dialog,
   * since filling one in is meant to happen while re-listening to the audio
   * right there, not after closing something that took it away. The
   * browser's own context menu is suppressed for the whole transcript panel,
   * not just rows, so there's never a jarring "menu sometimes appears,
   * sometimes doesn't" depending on exactly where the right-click landed.
   * Right-clicking a draft itself works the same way and inserts above/below
   * it, which is how another missing line gets added next to one just
   * created. */
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    lineIndex: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // One observer for the whole list, not one per row (that was tried - see
  // the note in TranscriptRow - and thrashes badly on a real transcript):
  // resetting every row's height before reading any of them, and reading
  // every scrollHeight before writing any of them, means the browser only
  // has to recompute layout once per resize tick instead of once per row.
  useEffect(() => {
    const container = rowsContainerRef.current;
    if (!container) {
      return;
    }
    const resizeAllRows = () => {
      const textareas = Array.from(container.querySelectorAll('textarea'));
      textareas.forEach((el) => {
        el.style.height = 'auto';
      });
      const targetHeights = textareas.map(
        (el) => el.scrollHeight + (el.offsetHeight - el.clientHeight),
      );
      textareas.forEach((el, index) => {
        el.style.height = `${targetHeights[index]}px`;
      });
    };
    const observer = new ResizeObserver(resizeAllRows);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const handleRowContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>('[data-line-index]');
    if (!rowEl?.dataset.lineIndex) {
      return;
    }
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - 8),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - 8),
      lineIndex: Number(rowEl.dataset.lineIndex),
    });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  /** Drops one new draft row into the gap directly above or below whichever
   *  row the context menu was opened on - a real `ParsedLine` (computed via
   *  the same slot-splitting a real correction uses), just not sent anywhere
   *  until its text is actually committed. "Above" the very first line or
   *  "below" the very last has no real neighbor on that side;
   *  `computeInsertionSlots` falls back to a fixed duration there instead of
   *  an unbounded range. */
  const handleInsertDraftLine = useCallback(
    (direction: 'above' | 'below') => {
      const anchorLineIndex = contextMenu?.lineIndex;
      closeContextMenu();
      if (anchorLineIndex == null) {
        return;
      }
      const currentLines = displayLinesRef.current;
      const position = currentLines.findIndex((line) => line.lineIndex === anchorLineIndex);
      if (position === -1) {
        return;
      }
      const anchorLine = currentLines[position];
      const prevLine = direction === 'below' ? anchorLine : (currentLines[position - 1] ?? null);
      const nextLine = direction === 'below' ? (currentLines[position + 1] ?? null) : anchorLine;
      const [slot] = computeInsertionSlots(prevLine, nextLine, 1);
      setDrafts((current) => [
        ...current,
        {
          lineIndex: slot.lineIndex,
          timestamp: formatSlotTimestamp(slot.seconds),
          seconds: slot.seconds,
          endSeconds: slot.endSeconds,
          speaker: undefined,
          text: '',
        },
      ]);
    },
    [contextMenu, closeContextMenu],
  );

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    function handleDismiss(event: PointerEvent | KeyboardEvent) {
      if (event.type === 'keydown') {
        if ((event as KeyboardEvent).key === 'Escape') {
          closeContextMenu();
        }
        return;
      }
      // Excludes clicks inside the menu itself - without this, pressing the
      // "insert dialogue" item would close the menu on `pointerdown` (which
      // fires before `click`) and unmount it before its own `onClick` ever
      // got a chance to run, silently eating the click.
      if (!contextMenuRef.current?.contains(event.target as Node)) {
        closeContextMenu();
      }
    }
    document.addEventListener('pointerdown', handleDismiss);
    document.addEventListener('keydown', handleDismiss);
    return () => {
      document.removeEventListener('pointerdown', handleDismiss);
      document.removeEventListener('keydown', handleDismiss);
    };
  }, [contextMenu, closeContextMenu]);

  /** Shared by both export formats - the interview cover sheet changes only
   *  what gets prepended, never how the dialogue itself is rendered (per
   *  spec: "the transcript body itself is unaffected"). */
  const buildTranscriptBody = useCallback(
    () =>
      effectiveLines
        .map((line) => {
          const speaker = line.speaker != null ? `${getDisplayName(line.speaker)}: ` : '';
          const time = line.timestamp ? `[${line.timestamp}] ` : '';
          return `${time}${speaker}${line.text}`;
        })
        .join('\n'),
    [effectiveLines, getDisplayName],
  );

  const handleExportTxt = useCallback(() => {
    const title = conversation?.title ?? 'transcript';
    downloadTextFile(buildTranscriptBody(), `${title}-transcript.txt`);
  }, [conversation?.title, buildTranscriptBody]);

  const [interviewDialogOpen, setInterviewDialogOpen] = useState(false);
  const exportInterviewDocx = useExportInterviewDocxMutation();

  const handleExportInterview = useCallback(
    (form: InterviewTranscriptForm) => {
      if (!sourceFileId) {
        return;
      }
      const title = conversation?.title ?? 'transcript';
      exportInterviewDocx.mutate(
        { sourceFileId, form, speakers: speakerOptions },
        {
          onSuccess: (blob) => {
            const safeTitle = title.replace(/[/:*?"<>|]/g, '_');
            downloadBlob(blob, `${safeTitle}-interview.docx`);
          },
        },
      );
    },
    [sourceFileId, conversation?.title, speakerOptions, exportInterviewDocx],
  );

  const [meetingMinutesDialogOpen, setMeetingMinutesDialogOpen] = useState(false);
  const exportMeetingMinutesDocx = useExportMeetingMinutesDocxMutation();

  const handleExportMeetingMinutes = useCallback(
    (form: MeetingMinutesForm) => {
      if (!sourceFileId) {
        return;
      }
      const title = conversation?.title ?? 'transcript';
      exportMeetingMinutesDocx.mutate(
        { sourceFileId, form, speakers: speakerOptions },
        {
          onSuccess: (blob) => {
            const safeTitle = title.replace(/[/:*?"<>|]/g, '_');
            downloadBlob(blob, `${safeTitle}-meeting-minutes.docx`);
          },
        },
      );
    },
    [sourceFileId, conversation?.title, speakerOptions, exportMeetingMinutesDocx],
  );

  const isLoading =
    !isConvoError && (isConvoLoading || (transcriptFileId != null && isPreviewLoading));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TranscriptPanelHeader
        lineCount={lines.length}
        speakerCount={uniqueSpeakerIds.length}
        modelUsed={conversation?.transcription?.model}
        isRetranscribing={retranscribe.isLoading}
        isExportingInterview={exportInterviewDocx.isLoading}
        isExportingMeetingMinutes={exportMeetingMinutesDocx.isLoading}
        showActions={!isLoading && lines.length > 0}
        onOpenRoster={() => setRosterModalOpen(true)}
        onExportTxt={handleExportTxt}
        onExportInterview={() => setInterviewDialogOpen(true)}
        onExportMeetingMinutes={() => setMeetingMinutesDialogOpen(true)}
        onRetranscribe={() => setRetranscribeOpen(true)}
        onClose={onClose}
      />
      <div
        ref={rowsContainerRef}
        className="flex-1 overflow-y-auto p-3"
        onContextMenu={(event) => {
          // Suppressed everywhere in this pane, not just on rows - a native
          // menu with nothing this feature can act on (cut/paste/inspect)
          // showing up on some parts of the panel but not others would be a
          // worse experience than just never showing it here at all.
          event.preventDefault();
          handleRowContextMenu(event);
        }}
      >
        {isLoading && (
          <div className="flex h-full items-center justify-center">
            <Spinner className="text-text-primary" />
          </div>
        )}
        {!isLoading && isConvoError && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 text-red-500"
            >
              <AlertCircle className="h-5 w-5" />
            </span>
            <p role="alert" className="text-sm text-red-500">
              {localize('com_ui_transcript_error')}
            </p>
            <button
              type="button"
              onClick={() => refetchConvo()}
              className="rounded-md border border-border-medium px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary"
            >
              {localize('com_ui_retry')}
            </button>
          </div>
        )}
        {!isLoading && !isConvoError && preview?.status === 'failed' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 text-red-500"
            >
              <AlertCircle className="h-5 w-5" />
            </span>
            <p role="alert" className="max-w-xs text-sm text-red-500">
              {preview.previewError ?? localize('com_ui_transcript_error')}
            </p>
          </div>
        )}
        {!isLoading &&
          !isConvoError &&
          transcriptFileId == null &&
          (jobStatus?.status === 'queued' || jobStatus?.status === 'transcribing') && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Spinner className="text-text-primary" />
              <p className="text-sm font-medium text-text-primary">
                {jobStatus.status === 'transcribing'
                  ? localize('com_ui_transcript_card_transcribing')
                  : localize('com_ui_transcript_card_queued')}
              </p>
            </div>
          )}
        {!isLoading &&
          !isConvoError &&
          transcriptFileId == null &&
          jobStatus?.status === 'failed' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <span
                aria-hidden="true"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 text-red-500"
              >
                <AlertCircle className="h-5 w-5" />
              </span>
              <p role="alert" className="max-w-xs text-sm text-red-500">
                {jobStatus.error ?? localize('com_ui_transcript_error')}
              </p>
              {sourceFileId && (
                <button
                  type="button"
                  onClick={() => retryTranscription.mutate({ sourceFileId })}
                  disabled={retryTranscription.isLoading}
                  className="rounded-md border border-border-medium px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary"
                >
                  {localize('com_ui_transcript_card_retry')}
                </button>
              )}
            </div>
          )}
        {!isLoading &&
          !isConvoError &&
          lines.length === 0 &&
          preview?.status !== 'failed' &&
          jobStatus?.status !== 'queued' &&
          jobStatus?.status !== 'transcribing' &&
          jobStatus?.status !== 'failed' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <span
                aria-hidden="true"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-hover text-text-secondary"
              >
                <FileText className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-text-primary">
                {localize('com_ui_transcript_empty_title')}
              </p>
              <p className="max-w-xs text-xs text-text-secondary">
                {localize('com_ui_transcript_empty')}
              </p>
            </div>
          )}
        {!isLoading && lines.length > 0 && (
          <>
            <div className="flex flex-col gap-1">
              {displayLines.map((line) => {
                const isDraft = draftsRef.current.some(
                  (draft) => draft.lineIndex === line.lineIndex,
                );
                const isPreviewing = isPlaying && followedLineIndex === line.lineIndex;
                const duration =
                  line.endSeconds != null && line.seconds != null
                    ? line.endSeconds - line.seconds
                    : 0;
                const playbackRatio =
                  isPreviewing && duration > 0 && line.seconds != null
                    ? Math.min(1, Math.max(0, (currentTime - line.seconds) / duration))
                    : 0;
                return (
                  <TranscriptRow
                    key={line.lineIndex}
                    line={line}
                    isFollowed={followedLineIndex === line.lineIndex}
                    isPreviewing={isPreviewing}
                    playbackRatio={playbackRatio}
                    canPlay={audioSrc != null}
                    speakerOptions={speakerOptions}
                    isAddingSpeaker={addingSpeakerForLine === line.lineIndex}
                    newSpeakerName={newSpeakerName}
                    onPlaySegment={togglePlaySegment}
                    onTextCommit={onTextCommit}
                    onTimeCommit={onTimeCommit}
                    onSpeakerSelect={reassignSegment}
                    onStartAddSpeaker={startAddSpeaker}
                    onNewSpeakerNameChange={setNewSpeakerName}
                    onCommitNewSpeaker={commitNewSpeaker}
                    onCancelNewSpeaker={cancelNewSpeaker}
                    isDraft={isDraft}
                    onDeleteDraft={isDraft ? () => deleteDraft(line.lineIndex) : undefined}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
      {contextMenu &&
        createPortal(
          <div
            ref={contextMenuRef}
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            className="fixed z-50 min-w-[12rem] rounded-lg border border-border-medium bg-surface-primary p-1 shadow-lg duration-100 animate-in fade-in-0 zoom-in-95"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => handleInsertDraftLine('above')}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-hover"
            >
              <ArrowUpToLine className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
              {localize('com_ui_transcript_context_menu_insert_above')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleInsertDraftLine('below')}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-hover"
            >
              <ArrowDownToLine
                className="h-4 w-4 shrink-0 text-text-secondary"
                aria-hidden="true"
              />
              {localize('com_ui_transcript_context_menu_insert_below')}
            </button>
          </div>,
          document.body,
        )}
      <TranscribeOptionsDialog
        isOpen={retranscribeOpen}
        onOpenChange={setRetranscribeOpen}
        onConfirm={handleRetranscribe}
        initialOptions={previousOptions}
      />
      <InterviewTranscriptDialog
        isOpen={interviewDialogOpen}
        onOpenChange={setInterviewDialogOpen}
        speakerOptions={speakerOptions}
        onConfirm={handleExportInterview}
      />
      <MeetingMinutesDialog
        isOpen={meetingMinutesDialogOpen}
        onOpenChange={setMeetingMinutesDialogOpen}
        initialTitle={conversation?.title ?? ''}
        onConfirm={handleExportMeetingMinutes}
      />
      <SpeakerRosterModal
        open={rosterModalOpen}
        onOpenChange={setRosterModalOpen}
        speakerOptions={speakerOptions}
        speakerNames={stableSpeakerNames}
        isSpeakerNameTaken={isSpeakerNameTaken}
        onRename={renameSpeaker}
        onAddSpeaker={renameSpeaker}
        preview={speakerPreview}
        canPlay={audioSrc != null}
        isPlaying={isPlaying}
        followedLineIndex={followedLineIndex}
        onTogglePreview={togglePlaySegment}
      />
    </div>
  );
}

export default memo(TranscriptPanel);
