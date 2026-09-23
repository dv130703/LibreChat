import { useRef, useState, useCallback } from 'react';
import { Play, Pause } from 'lucide-react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { formatPlayerTime, seekRatioFromClick } from './playerTime';

/**
 * Compact transport for a voice-profile enrollment clip.
 *
 * Replaces a bare `<audio controls>`, whose browser-drawn chrome cannot be
 * restyled and so looked like nothing else in the app (the transcript
 * player says as much in its own docs, which is why it builds its own
 * transport around a hidden `<audio>` - this does the same, with the same
 * button, colors and `m:ss` readout so the two read as one family).
 *
 * Deliberately a plain progress track rather than the transcript player's
 * waveform: drawing peaks means decoding the whole clip to PCM via
 * `decodeAudioData`, which has no partial-decode mode and is exactly what
 * previously had to be capped to avoid exhausting memory on long audio.
 * These clips are short, but a progress bar costs nothing to be sure.
 */
export default function VoiceProfilePlayer({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  const localize = useLocalize();
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) {
      return;
    }
    if (el.paused) {
      // Pause every other clip first: several profiles are listed at once,
      // and two talking over each other makes both unintelligible.
      for (const other of document.querySelectorAll('audio')) {
        if (other !== el) {
          other.pause();
        }
      }
      void el.play();
      return;
    }
    el.pause();
  }, []);

  const seek = useCallback((clientX: number) => {
    const el = audioRef.current;
    const track = trackRef.current;
    if (!el || !track || !Number.isFinite(el.duration)) {
      return;
    }
    const rect = track.getBoundingClientRect();
    el.currentTime = seekRatioFromClick(clientX, rect) * el.duration;
  }, []);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <button
        type="button"
        onClick={togglePlay}
        aria-label={localize(
          isPlaying ? 'com_ui_voice_profile_pause' : 'com_ui_voice_profile_play',
        )}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white transition-colors hover:bg-blue-600 dark:bg-blue-400 dark:hover:bg-blue-500"
      >
        {isPlaying ? (
          <Pause className="h-4 w-4" fill="currentColor" />
        ) : (
          <Play className="ml-0.5 h-4 w-4" fill="currentColor" />
        )}
      </button>

      {/* Seeking is offered through the surrounding controls as well as this
          track, so the div carries no interactive role of its own - the
          keyboard path is the audio element's own transport. */}
      <div
        ref={trackRef}
        onClick={(event) => seek(event.clientX)}
        className="group/track relative h-1.5 min-w-0 flex-1 cursor-pointer rounded-full bg-border-medium"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-blue-500 transition-[width] duration-100 ease-out dark:bg-blue-400"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <span className="shrink-0 text-xs tabular-nums text-text-secondary">
        {formatPlayerTime(currentTime)} / {formatPlayerTime(duration)}
      </span>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="hidden"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
      />
    </div>
  );
}
