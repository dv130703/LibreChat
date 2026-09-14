import { memo, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  Play,
  Pause,
  Check,
  Rewind,
  Volume2,
  VolumeX,
  ChevronDown,
  FastForward,
  AlertTriangle,
} from 'lucide-react';
import type { ChangeEvent, MouseEvent, RefObject, SyntheticEvent } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { computeAudioPeaks } from './audioPeaks';

interface TranscriptHeaderProps {
  audioSrc: string | undefined;
  audioRef: RefObject<HTMLAudioElement>;
  /** True once fetching a playable URL has definitively failed (react-query's
   *  own retries exhausted) - distinct from simply not having `audioSrc` yet
   *  because the fetch is still in flight. Drives a visible "couldn't load
   *  the audio - retry" row instead of this component silently rendering
   *  nothing with no way to recover, which is what it used to do (transcription/
   *  ARCHITECTURE.md §12 #13) - `return null` for *any* missing `audioSrc`,
   *  including a permanently failed one, left no trace the player was ever
   *  supposed to be there at all. */
  hasError?: boolean;
  /** Re-attempts fetching a playable URL - wired to the same query's
   *  `refetch`, exposed here so the retry row above can actually do
   *  something instead of just naming the problem. */
  onRetry?: () => void;
  /** `TranscriptPanel` arms a stop point when a transcript line is played
   *  bounded to just that line. This player's own controls (play, skip, the
   *  seek bar) have no notion of that and shouldn't inherit it - pressing
   *  play here should keep going, not silently cut off wherever some
   *  unrelated line used to end. Called right before any of them actually
   *  moves the playhead or resumes playback, so `TranscriptPanel` can retire
   *  a boundary that no longer applies. */
  onUnboundedPlaybackRequested: () => void;
  /** Fires once, right after this component's `<audio>` element has mounted.
   *  `TranscriptPanel` renders this component through `useChatHeaderSlot`,
   *  which lifts it into `ChatPanelHost`'s own state rather than mounting it
   *  directly - so on the render where `audioSrc` first becomes truthy, the
   *  `<audio>` node doesn't exist in the DOM yet, and any effect in
   *  `TranscriptPanel` that reads `audioRef.current` at that same moment
   *  finds it `null`. React attaches `ref={audioRef}` during commit, strictly
   *  before this component's own effects run, so by the time this fires,
   *  `audioRef.current` is guaranteed to be the real node - safe to use as
   *  the signal to (re-)attach listeners to it. */
  onAudioMounted?: () => void;
}

/** How far the skip buttons jump. Long enough to matter, short enough to undo. */
const SKIP_SECONDS = 10;

// Slow for catching a word, fast for skimming a long recording - the two
// things anyone actually does to speech they're reviewing.
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Enough bars to read as a real waveform without redrawing hundreds of DOM
 *  nodes on every playback tick. */
const WAVEFORM_BARS = 120;
const FLAT_PEAKS = new Array(WAVEFORM_BARS).fill(0.12);

/** Above this length, `computeAudioPeaks` is skipped entirely in favor of the
 *  flat placeholder. `decodeAudioData` has no partial/streaming mode - it
 *  always materializes the *entire* recording as raw Float32 PCM in memory
 *  (roughly 1.4MB per minute of mono 44.1kHz audio, double that for stereo
 *  or 48kHz) just to downsample it into 120 bars. A 3-hour recording was
 *  observed reliably crashing the tab outright ("Aw, Snap!") this way - a
 *  purely decorative waveform has no business risking that. 30 minutes is a
 *  conservative cutoff: even at 48kHz stereo (the worst realistic case) that
 *  caps the decoded buffer around ~700MB rather than several gigabytes. */
const MAX_WAVEFORM_DURATION_SECONDS = 30 * 60;

function formatPlayerTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) {
    return '0:00';
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

/** The 120 waveform bars, split out and memoized so they only re-render when
 *  `playedBars`/`hoverBars` actually change - which, since those are
 *  quantized to whole bars rather than the raw playback ratio, is far less
 *  often than the 4-10 `timeupdate` events/sec `TranscriptHeader` gets
 *  during playback. Inlined in the parent, this was diffing 120 elements
 *  (each with a freshly-allocated style object and transition string) on
 *  every one of those ticks, continuously, for as long as anything played -
 *  main-thread work competing with everything else in the player, including
 *  the click that opens the speed dropdown or toggles the collapse, for
 *  time on every single tick. */
const WaveformBars = memo(function WaveformBars({
  peaks,
  isLoadingPeaks,
  playedBars,
  hoverBars,
}: {
  peaks: number[];
  isLoadingPeaks: boolean;
  playedBars: number;
  hoverBars: number | null;
}) {
  return (
    <div className="flex h-full items-center gap-px">
      {peaks.map((amplitude, index) => {
        const isPlayed = index < playedBars;
        // Previews how far a click would seek - only meaningful ahead of
        // where playback actually is; behind it, the bars are already the
        // solid "played" color, so there's nothing extra to show.
        const isHoverPreview = !isPlayed && hoverBars != null && index < hoverBars;
        return (
          <div
            key={index}
            className={cn(
              'min-h-[3px] flex-1 rounded-full',
              isLoadingPeaks && 'animate-pulse',
              isPlayed && 'bg-blue-500 dark:bg-blue-400',
              !isPlayed && isHoverPreview && 'bg-blue-500/35 dark:bg-blue-400/35',
              !isPlayed && !isHoverPreview && 'bg-border-medium',
            )}
            style={{
              height: `${Math.max(6, amplitude * 100)}%`,
              // The height transition (with its per-bar stagger) is only for
              // the one-time reveal when real peaks replace the flat
              // placeholder. Color, which flips constantly during normal
              // playback and dragging, stays on its own fast, undelayed
              // transition - giving both a staggered height transition would
              // make the played/unplayed indicator visibly lag behind the
              // actual position on every move.
              transition: isLoadingPeaks
                ? undefined
                : `height 300ms ease-out ${index * 2}ms, background-color 100ms ease-out`,
            }}
          />
        );
      })}
    </div>
  );
});

/** The audio player, split out from `TranscriptPanel` into its own memoized
 *  component so `TranscriptPanel`'s frequent internal re-renders (every
 *  playback tick, every scroll) don't force React to re-evaluate it.
 *
 *  Renders the real `<audio>` element `TranscriptPanel` already drives
 *  (`audioRef`, playing/seeking segments) unstyled and hidden, and builds a
 *  themed transport around it - a native `<audio controls>` element can't be
 *  restyled to match the app at all, and none of this component's own state
 *  (seek/volume/speed) conflicts with `TranscriptPanel`'s separate listeners
 *  on the same element; DOM media elements support any number of them. */
function TranscriptHeader({
  audioSrc,
  audioRef,
  hasError,
  onRetry,
  onUnboundedPlaybackRequested,
  onAudioMounted,
}: TranscriptHeaderProps) {
  const localize = useLocalize();
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  /** Fraction (0-1) of the way across the waveform the pointer is currently
   *  hovering, or `null` when it isn't - drives the hover timestamp readout,
   *  the position line, and the "seek preview" tint on the bars ahead of the
   *  current position. */
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  /** While the seek bar is being dragged, `seekPreview` tracks where it's
   *  pointing purely for display - actually reassigning `audio.currentTime` on
   *  every drag tick (which the browser resolves by decoding to the nearest
   *  keyframe) is what made dragging feel like it was crawling. The real seek
   *  only happens once, on release. */
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const seekPreviewRef = useRef<number | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // A new file means a new `<audio>` element under the hood - reset the
  // transport display rather than showing the previous file's stale numbers
  // until the next event fires.
  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, [audioSrc]);

  // Tells `TranscriptPanel` the `<audio>` node behind `audioRef` genuinely
  // exists now - see `onAudioMounted`'s own doc comment for why it can't
  // just assume that from `audioSrc` becoming truthy on its own.
  useEffect(() => {
    if (audioRef.current) {
      onAudioMounted?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSrc]);

  // A real reading of the actual recording, not a placeholder shape - decoded
  // once per file and cached here for the life of this component. Falls back
  // to a flat line (rather than nothing) if decoding fails - some browsers or
  // formats don't support `decodeAudioData`, and seeking still has to work.
  // Gated on `duration` (from `handleLoadedMetadata`, a cheap `preload="metadata"`
  // read - no full download needed just to know how long the file is) so a
  // recording past `MAX_WAVEFORM_DURATION_SECONDS` skips the decode
  // altogether instead of ever attempting it.
  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    if (!audioSrc || !duration) {
      return;
    }
    if (duration > MAX_WAVEFORM_DURATION_SECONDS) {
      setPeaks(FLAT_PEAKS);
      return;
    }
    computeAudioPeaks(audioSrc, WAVEFORM_BARS)
      .then((result) => {
        if (!cancelled) {
          setPeaks(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPeaks(FLAT_PEAKS);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [audioSrc, duration]);

  // A freshly loaded element starts at 1x/full volume/unmuted, so whatever
  // this player is currently showing has to be pushed back onto it - otherwise
  // the controls sit there claiming a speed/volume the audio isn't actually at.
  function handleLoadedMetadata(event: SyntheticEvent<HTMLAudioElement>) {
    const el = event.currentTarget;
    setDuration(el.duration);
    el.playbackRate = speed;
    el.volume = volume;
    el.muted = isMuted;
  }

  function handleTimeUpdate(event: SyntheticEvent<HTMLAudioElement>) {
    setCurrentTime(event.currentTarget.currentTime);
  }

  function ratioFromEvent(event: MouseEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  function handleWaveformHover(event: MouseEvent<HTMLDivElement>) {
    setHoverRatio(ratioFromEvent(event));
  }

  // A native range input's own "click jumps to this position" behavior is
  // notoriously inconsistent across browsers (some only step by one tick per
  // click, or need an actual drag) - computing the seek target explicitly,
  // the same way the hover preview already does, means a click always lands
  // exactly where the preview said it would, everywhere, instead of relying
  // on the browser to get that right.
  function handleWaveformClick(event: MouseEvent<HTMLDivElement>) {
    const el = audioRef.current;
    if (!el || !duration) {
      return;
    }
    onUnboundedPlaybackRequested();
    const next = ratioFromEvent(event) * duration;
    el.currentTime = next;
    setCurrentTime(next);
  }

  function handleTogglePlay() {
    const el = audioRef.current;
    if (!el) {
      return;
    }
    if (el.paused) {
      onUnboundedPlaybackRequested();
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  function skipBy(seconds: number) {
    const el = audioRef.current;
    if (!el) {
      return;
    }
    onUnboundedPlaybackRequested();
    const next = Math.min(el.duration || 0, Math.max(0, el.currentTime + seconds));
    el.currentTime = next;
    setCurrentTime(next);
  }

  // While dragging, only the (cheap) preview state updates - the actual media
  // seek is deferred to release (see the effect below). A change with no drag
  // in progress (e.g. arrow-key stepping while focused) has no "release" to
  // wait for, so it commits immediately instead.
  function handleSeekInput(event: ChangeEvent<HTMLInputElement>) {
    const next = Number(event.target.value);
    if (isSeeking) {
      seekPreviewRef.current = next;
      setSeekPreview(next);
      return;
    }
    const el = audioRef.current;
    if (!el) {
      return;
    }
    onUnboundedPlaybackRequested();
    el.currentTime = next;
    setCurrentTime(next);
  }

  function handleSeekPointerDown() {
    setIsSeeking(true);
  }

  // Commits wherever the drag ended up to the actual `<audio>` element, once -
  // a `pointerup` on `window` (rather than just the input) so a drag that
  // ends outside the seek bar's bounds still commits instead of getting stuck
  // showing a preview position the audio never actually moved to.
  useEffect(() => {
    if (!isSeeking) {
      return;
    }
    function commitSeek() {
      const el = audioRef.current;
      if (el && seekPreviewRef.current != null) {
        onUnboundedPlaybackRequested();
        el.currentTime = seekPreviewRef.current;
        setCurrentTime(seekPreviewRef.current);
      }
      seekPreviewRef.current = null;
      setSeekPreview(null);
      setIsSeeking(false);
    }
    window.addEventListener('pointerup', commitSeek);
    return () => window.removeEventListener('pointerup', commitSeek);
  }, [isSeeking, audioRef, onUnboundedPlaybackRequested]);

  function handleVolumeChange(event: ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current;
    const next = Number(event.target.value);
    setVolume(next);
    setIsMuted(next === 0);
    if (el) {
      el.volume = next;
    }
  }

  function handleToggleMute() {
    const el = audioRef.current;
    if (!el) {
      return;
    }
    const next = !isMuted;
    el.muted = next;
    setIsMuted(next);
  }

  function pickSpeed(next: (typeof SPEEDS)[number]) {
    const el = audioRef.current;
    if (el) {
      el.playbackRate = next;
    }
    setSpeed(next);
    setSpeedOpen(false);
  }

  // Space/arrows/brackets act on the player from anywhere on the page - the
  // same convention YouTube and most media apps use - but only while focus
  // isn't inside one of this page's many editable fields (transcript text,
  // speaker names), where these keys need to type normally instead.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target) || !audioSrc) {
        return;
      }
      switch (event.code) {
        case 'Space':
          event.preventDefault();
          handleTogglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          skipBy(-SKIP_SECONDS);
          break;
        case 'ArrowRight':
          event.preventDefault();
          skipBy(SKIP_SECONDS);
          break;
        case 'BracketLeft':
          event.preventDefault();
          pickSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]);
          break;
        case 'BracketRight':
          event.preventDefault();
          pickSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]);
          break;
        case 'Digit0':
          event.preventDefault();
          pickSpeed(1);
          break;
        default:
          break;
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, audioSrc]);

  const displayedTime = seekPreview ?? currentTime;
  const playedRatio = duration ? Math.min(1, displayedTime / duration) : 0;
  const displayPeaks = peaks ?? FLAT_PEAKS;
  const isLoadingPeaks = peaks == null;
  const hoverTime = hoverRatio != null ? hoverRatio * duration : null;
  // Quantized to whole bars, not the raw ratio - passed to the memoized
  // `WaveformBars` below so it only re-renders on the ~120 ticks where a bar
  // actually flips, not on every one of the 4-10 `timeupdate` events/sec that
  // fire throughout playback (see the note on that component for why this
  // was worth doing).
  const playedBars = Math.round(playedRatio * displayPeaks.length);
  const hoverBars = hoverRatio != null ? Math.round(hoverRatio * displayPeaks.length) : null;

  if (!audioSrc) {
    // Still in flight (or has never been attempted) - nothing failed yet,
    // so nothing to show; matches the pre-existing behavior for this case.
    if (!hasError) {
      return null;
    }
    // A definitive failure - unlike the old blob-download approach this
    // replaced, this state is always recoverable: retrying costs nothing
    // more than another cheap token-mint request, not a full re-download.
    return (
      <div className="p-2">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border-medium bg-surface-primary px-3 py-2.5 shadow-sm">
          <div className="flex min-w-0 items-center gap-2 text-text-secondary">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />
            <span className="truncate text-sm">{localize('com_ui_transcript_audio_error')}</span>
          </div>
          <button
            type="button"
            onClick={() => onRetry?.()}
            className="shrink-0 whitespace-nowrap rounded-md border border-border-medium px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary"
          >
            {localize('com_ui_retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      >
        {localize('com_ui_audio_unsupported')}
      </audio>

      <div className="animate-fade-in overflow-hidden rounded-xl border border-border-medium bg-surface-primary shadow-sm">
        {/* Always rendered, never part of the collapsing section below - a
         *  small strip of the player's own surface that stays put whichever
         *  way `isCollapsed` goes, so there's always something here to click
         *  to bring the rest back, instead of the whole player vanishing
         *  with nothing left to say it's still there. */}
        <button
          type="button"
          onClick={() => setIsCollapsed((current) => !current)}
          aria-expanded={!isCollapsed}
          aria-label={localize(
            isCollapsed ? 'com_ui_transcript_player_expand' : 'com_ui_transcript_player_collapse',
          )}
          className="flex w-full items-center justify-center border-b border-border-medium bg-surface-tertiary py-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <ChevronDown
            className={cn(
              'h-4 w-4 transition-transform duration-300',
              !isCollapsed && 'rotate-180',
            )}
          />
        </button>

        {/* A plain `max-height` transition, not the fancier `0fr`/`1fr`
         *  grid-track animation this used at first - that relied on this
         *  wrapper's height being purely content-driven, which broke (the
         *  whole player rendering as collapsed to nothing, stuck) once it
         *  turned out something further up the tree constrains this
         *  component's height instead of leaving it to size to content. A
         *  fixed upper bound comfortably above the content's real height
         *  sidesteps that dependency entirely - it doesn't need to know the
         *  content's exact height, only that this one is bigger. */}
        <div
          className={cn(
            'overflow-hidden transition-[max-height] duration-300 ease-in-out',
            isCollapsed ? 'max-h-0' : 'max-h-[320px]',
          )}
        >
          <div className="p-3 pt-0">
            {/* Its own reserved row, not an overlay sitting on top of the bars -
             *  so the tooltip can never cover the one thing hovering is meant to
             *  reveal (exactly where the seek boundary falls), and never has to
             *  extend above its own box to get there (this player is portaled
             *  into a `react-resizable-panels` pane, whose wrapper clips anything
             *  that pokes outside its own bounds - the speed dropdown hit this
             *  exact issue earlier and needed a portal to escape it; a fixed row
             *  above the waveform sidesteps it entirely instead). */}
            <div aria-hidden="true" className="relative h-4">
              {hoverTime != null && (
                <div
                  className="absolute -translate-x-1/2 whitespace-nowrap rounded-md border border-border-medium bg-surface-primary px-2 py-0.5 text-xs font-medium tabular-nums text-text-primary shadow-md"
                  style={{ left: `${(hoverRatio ?? 0) * 100}%` }}
                >
                  {formatPlayerTime(hoverTime)}
                  {/* Caret - without it, "15:28" could be read as belonging to the
                   *  box's left edge, its center, or the line below; this pins it
                   *  unambiguously to one point. */}
                  <div className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-border-medium bg-surface-primary" />
                </div>
              )}
            </div>
            <div
              className="relative mt-1 h-10 select-none"
              onMouseMove={handleWaveformHover}
              onMouseLeave={() => setHoverRatio(null)}
              onClick={handleWaveformClick}
            >
              {hoverTime != null && (
                <div
                  aria-hidden="true"
                  className="bg-text-secondary/50 pointer-events-none absolute inset-y-0 z-10 w-px"
                  style={{ left: `${(hoverRatio ?? 0) * 100}%` }}
                />
              )}
              <WaveformBars
                peaks={displayPeaks}
                isLoadingPeaks={isLoadingPeaks}
                playedBars={playedBars}
                hoverBars={hoverBars}
              />
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.01}
                value={displayedTime}
                onChange={handleSeekInput}
                onPointerDown={handleSeekPointerDown}
                aria-label={localize('com_ui_transcript_seek')}
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
              />
            </div>

            {/* The outer columns share the leftover space equally while the
             *  center one sizes to its own content - so the primary transport
             *  (skip/play/skip) always sits at the bar's true optical center,
             *  the control someone reaches for constantly, instead of being
             *  squeezed by whatever's in the other two groups. */}
            <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <span className="justify-self-start whitespace-nowrap text-xs tabular-nums text-text-secondary">
                <span className="font-semibold text-text-primary">
                  {formatPlayerTime(displayedTime)}
                </span>
                {' / '}
                {formatPlayerTime(duration)}
              </span>

              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => skipBy(-SKIP_SECONDS)}
                  aria-label={localize('com_ui_transcript_skip_back', { seconds: SKIP_SECONDS })}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                >
                  <Rewind className="h-4 w-4" fill="currentColor" />
                </button>

                <button
                  type="button"
                  onClick={handleTogglePlay}
                  aria-label={localize(
                    isPlaying ? 'com_ui_transcript_pause' : 'com_ui_transcript_play',
                  )}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white transition-colors hover:bg-blue-600 dark:bg-blue-400 dark:hover:bg-blue-500"
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4" fill="currentColor" />
                  ) : (
                    <Play className="ml-0.5 h-4 w-4" fill="currentColor" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => skipBy(SKIP_SECONDS)}
                  aria-label={localize('com_ui_transcript_skip_forward', {
                    seconds: SKIP_SECONDS,
                  })}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                >
                  <FastForward className="h-4 w-4" fill="currentColor" />
                </button>
              </div>

              <div className="flex items-center gap-2 justify-self-end">
                <Popover.Root open={speedOpen} onOpenChange={setSpeedOpen}>
                  <Popover.Trigger asChild>
                    <button
                      type="button"
                      aria-label={localize('com_ui_transcript_playback_speed', {
                        speed: String(speed),
                      })}
                      className={cn(
                        'flex items-center gap-0.5 rounded-lg border border-border-medium px-2 py-1 text-xs font-semibold tabular-nums text-text-secondary transition-colors hover:border-border-heavy hover:text-text-primary',
                        speedOpen && 'border-blue-500 ring-2 ring-blue-500/20 dark:border-blue-400',
                      )}
                    >
                      {speed}×
                      <ChevronDown
                        className={cn('h-3 w-3 transition-transform', speedOpen && 'rotate-180')}
                      />
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      side="bottom"
                      align="end"
                      sideOffset={8}
                      collisionPadding={8}
                      className="z-50 w-24 rounded-lg border border-border-medium bg-surface-primary p-1 shadow-lg duration-150 animate-in fade-in-0 zoom-in-95"
                    >
                      {/* Ties the panel back to the button it belongs to - without
                       *  it, a panel this much wider than its trigger (needed to
                       *  avoid overflowing the edge of the player) reads as a
                       *  separate floating element rather than clearly this
                       *  button's own dropdown. */}
                      <Popover.Arrow className="fill-surface-primary" />
                      {SPEEDS.map((rate, index) => (
                        <button
                          key={rate}
                          type="button"
                          role="menuitemradio"
                          aria-checked={rate === speed}
                          onClick={() => pickSpeed(rate)}
                          style={{ animationDelay: `${index * 18 + 20}ms` }}
                          className={cn(
                            // Left-aligned, not centered: a stacked list of
                            // different-length numbers ("2×" vs "1.25×") reads
                            // fastest when every row starts at the same x - scanning
                            // down a shared left edge, not one that wanders with
                            // each label's width.
                            'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm tabular-nums transition-colors duration-150 ease-out animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both',
                            rate === speed
                              ? 'bg-blue-500/10 font-bold text-blue-600 dark:text-blue-300'
                              : 'text-text-primary hover:bg-surface-hover',
                          )}
                        >
                          <span>{rate}×</span>
                          {/* A checkmark backs up the color-coded selection state -
                           *  blue-on-highlight vs. white-on-black isn't a reliable
                           *  enough distinction on its own for everyone. */}
                          <Check
                            className={cn(
                              'h-3.5 w-3.5 shrink-0 transition-all',
                              rate === speed ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
                            )}
                            aria-hidden="true"
                          />
                        </button>
                      ))}
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>

                <button
                  type="button"
                  onClick={handleToggleMute}
                  aria-label={localize(
                    isMuted ? 'com_ui_transcript_unmute' : 'com_ui_transcript_mute',
                  )}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
                {/* A native range's fill/track coloring is unreliable across
                 *  browsers to begin with, and setting an explicit track
                 *  background (needed so the empty portion reads as a track at
                 *  all, not just bare page background) overrides the browser's
                 *  own "filled" rendering in some of them - leaving no visible
                 *  distinction between how much volume is set and how much room
                 *  is left. Drawing the fill explicitly, the same way the
                 *  waveform's own seek bar already does, makes the level
                 *  unambiguous regardless of browser. */}
                <div className="group relative h-1.5 w-16 shrink-0 rounded-full bg-border-medium">
                  <div
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 rounded-full bg-blue-500 transition-[width] duration-150 ease-out dark:bg-blue-400"
                    style={{ width: `${(isMuted ? 0 : volume) * 100}%` }}
                  />
                  {/* The knob itself - marks the exact level rather than leaving
                   *  someone to eyeball where the fill happens to stop, and grows
                   *  a little on hover/press so moving it feels responsive rather
                   *  than static. */}
                  <div
                    aria-hidden="true"
                    className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-90 rounded-full bg-blue-500 shadow-sm transition-[left,transform] duration-150 ease-out group-hover:scale-100 group-active:scale-125 dark:bg-blue-400"
                    style={{ left: `${(isMuted ? 0 : volume) * 100}%` }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    aria-label={localize('com_ui_transcript_volume')}
                    className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(TranscriptHeader);
