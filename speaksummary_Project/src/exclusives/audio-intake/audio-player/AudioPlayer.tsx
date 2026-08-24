import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, Ref, SyntheticEvent } from 'react'
import { formatTimestamp } from '../../logic'
import { Waveform } from '../waveform'
import './AudioPlayer.css'

export interface AudioPlayerHandle {
  seekTo: (time: number) => void
  play: () => void
  pause: () => void
}

interface AudioPlayerProps {
  ref?: Ref<AudioPlayerHandle>
  src: string
  title: string
  /**
   * The recording's shape, from the intake page's probe. Drawn above the
   * transport; omitted, the player is just the transport, which is what a
   * session reopened from history gets.
   */
  peaks?: number[] | null
  /**
   * `compact` drops the volume control and the card around it, for the player
   * that sits inside the intake page's file panel. `full` is the standalone one.
   */
  variant?: 'full' | 'compact'
  onTimeUpdate?: (time: number) => void
  onPlayStateChange?: (isPlaying: boolean) => void
}

/** How far the skip buttons jump. Long enough to matter, short enough to undo. */
const SKIP_SECONDS = 10

// Slow for catching a word, fast for skimming a long recording - the two things
// anyone actually does to speech they are transcribing.
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

export function AudioPlayer({
  ref,
  src,
  title,
  peaks = null,
  variant = 'full',
  onTimeUpdate,
  onPlayStateChange,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [bufferedEnd, setBufferedEnd] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [speedOpen, setSpeedOpen] = useState(false)

  const speedRef = useRef<HTMLDivElement>(null)
  const speedToggleRef = useRef<HTMLButtonElement>(null)
  const speedOptionRefs = useRef<(HTMLButtonElement | null)[]>([])

  // The menu is a popover, so it has to close on the two things that mean "not
  // that, then": a click elsewhere and Escape. Only listens while it is open.
  useEffect(() => {
    if (!speedOpen) return

    function handlePointerDown(event: MouseEvent) {
      if (!speedRef.current?.contains(event.target as Node)) setSpeedOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSpeedOpen(false)
        speedToggleRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [speedOpen])

  // A role="menu"/"menuitemradio" popup is expected to support arrow-key
  // navigation between its items, not just Tab - opening it moves focus to the
  // current speed so a keyboard user lands somewhere meaningful right away.
  useEffect(() => {
    if (!speedOpen) return
    const index = Math.max(0, SPEEDS.indexOf(speed))
    speedOptionRefs.current[index]?.focus()
  }, [speedOpen, speed])

  function handleSpeedMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const currentIndex = speedOptionRefs.current.findIndex((el) => el === document.activeElement)
    function focusIndex(next: number) {
      const wrapped = (next + SPEEDS.length) % SPEEDS.length
      speedOptionRefs.current[wrapped]?.focus()
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusIndex(currentIndex + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusIndex(currentIndex - 1)
        break
      case 'Home':
        event.preventDefault()
        focusIndex(0)
        break
      case 'End':
        event.preventDefault()
        focusIndex(SPEEDS.length - 1)
        break
      default:
        break
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      seekTo: (time: number) => {
        const el = audioRef.current
        if (!el) return
        el.currentTime = time
        setCurrentTime(time)
      },
      play: () => void audioRef.current?.play(),
      pause: () => audioRef.current?.pause(),
    }),
    [],
  )

  // A freshly loaded media element starts at 1x, full volume and unmuted, so
  // whatever the controls are currently showing has to be pushed back onto it -
  // otherwise they sit there claiming a speed the audio isn't playing at.
  function handleLoadedMetadata(event: SyntheticEvent<HTMLAudioElement>) {
    const el = event.currentTarget
    setDuration(el.duration)
    el.playbackRate = speed
    el.volume = volume
    el.muted = isMuted
  }

  function handleTimeUpdate() {
    const el = audioRef.current
    if (!el) return
    setCurrentTime(el.currentTime)
    onTimeUpdate?.(el.currentTime)
    if (el.buffered.length > 0) {
      setBufferedEnd(el.buffered.end(el.buffered.length - 1))
    }
  }

  function handleProgress() {
    const el = audioRef.current
    if (!el || el.buffered.length === 0) return
    setBufferedEnd(el.buffered.end(el.buffered.length - 1))
  }

  function setPlaying(next: boolean) {
    setIsPlaying(next)
    onPlayStateChange?.(next)
  }

  function handleTogglePlay() {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  function skipBy(seconds: number) {
    const el = audioRef.current
    if (!el) return
    const next = Math.min(el.duration || 0, Math.max(0, el.currentTime + seconds))
    el.currentTime = next
    setCurrentTime(next)
  }

  function seekTo(time: number) {
    const el = audioRef.current
    if (!el) return
    const next = Math.min(duration || 0, Math.max(0, time))
    el.currentTime = next
    setCurrentTime(next)
  }

  function handleSeek(event: ChangeEvent<HTMLInputElement>) {
    seekTo(Number(event.target.value))
  }

  function handleVolumeChange(event: ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current
    const next = Number(event.target.value)
    setVolume(next)
    setIsMuted(next === 0)
    if (el) el.volume = next
  }

  function handleToggleMute() {
    const el = audioRef.current
    if (!el) return
    const next = !isMuted
    el.muted = next
    setIsMuted(next)
  }

  function pickSpeed(next: number) {
    const el = audioRef.current
    if (el) el.playbackRate = next
    setSpeed(next)
    setSpeedOpen(false)
  }

  const playedRatio = duration ? Math.min(1, currentTime / duration) : 0
  const bufferedPercent = duration ? (bufferedEnd / duration) * 100 : 0
  const isCompact = variant === 'compact'

  return (
    <div className={`audio-player audio-player--${variant}${isCompact ? '' : ' card'}`}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onProgress={handleProgress}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      {/* Click or drag anywhere along it to seek, and hover to read the time
          under the pointer. The slider below stays the accessible control - this
          is the direct-manipulation shortcut on top of it, and it only becomes
          one once the duration is known and a position means something. */}
      {peaks && (
        <Waveform
          peaks={peaks}
          progress={playedRatio}
          className="audio-player__wave"
          onSeek={duration ? (ratio) => seekTo(ratio * duration) : undefined}
          formatHover={duration ? (ratio) => formatTimestamp(ratio * duration) : undefined}
        />
      )}

      <div className="audio-player__seek-row">
        <span className="audio-player__time">{formatTimestamp(currentTime)}</span>

        <div className="audio-player__scrubber">
          <div className="audio-player__track" />
          <div className="audio-player__buffered" style={{ width: `${bufferedPercent}%` }} />
          <div className="audio-player__played" style={{ width: `${playedRatio * 100}%` }} />
          <input
            type="range"
            className="audio-player__seek"
            min={0}
            max={duration || 0}
            step={0.01}
            value={currentTime}
            onChange={handleSeek}
            aria-label={`Seek within ${title}`}
          />
        </div>

        <span className="audio-player__time">{formatTimestamp(duration)}</span>
      </div>

      {/* Three columns so the transport stays centred whether or not there is a
          volume control sitting out to the right of it. */}
      <div className="audio-player__controls">
        <div className="audio-player__side">
          <div className="audio-player__speed" ref={speedRef}>
            <button
              ref={speedToggleRef}
              type="button"
              className="audio-player__speed-toggle"
              aria-haspopup="menu"
              aria-expanded={speedOpen}
              aria-label={`Playback speed, currently ${speed} times`}
              onClick={() => setSpeedOpen((open) => !open)}
            >
              {speed}×
            </button>

            {speedOpen && (
              <div className="audio-player__speed-menu" role="menu" onKeyDown={handleSpeedMenuKeyDown}>
                {SPEEDS.map((rate, index) => (
                  <button
                    key={rate}
                    ref={(el) => {
                      speedOptionRefs.current[index] = el
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={rate === speed}
                    className="audio-player__speed-option"
                    onClick={() => pickSpeed(rate)}
                  >
                    {rate}×
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="audio-player__transport">
          <button
            type="button"
            className="audio-player__skip"
            onClick={() => skipBy(-SKIP_SECONDS)}
            aria-label={`Back ${SKIP_SECONDS} seconds`}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M11.5 6.6v10.8a.8.8 0 0 1-1.24.67l-8.1-5.4a.8.8 0 0 1 0-1.34l8.1-5.4a.8.8 0 0 1 1.24.67Z" />
              <path d="M22 6.6v10.8a.8.8 0 0 1-1.24.67l-8.1-5.4a.8.8 0 0 1 0-1.34l8.1-5.4a.8.8 0 0 1 1.24.67Z" />
            </svg>
          </button>

          <button
            type="button"
            className="audio-player__toggle"
            onClick={handleTogglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <rect x="3" y="2" width="3.4" height="12" rx="1" />
                <rect x="9.6" y="2" width="3.4" height="12" rx="1" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ marginLeft: 2 }}>
                <path d="M4 2.5v11a1 1 0 0 0 1.53.848l8.6-5.5a1 1 0 0 0 0-1.696l-8.6-5.5A1 1 0 0 0 4 2.5Z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="audio-player__skip"
            onClick={() => skipBy(SKIP_SECONDS)}
            aria-label={`Forward ${SKIP_SECONDS} seconds`}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12.5 6.6v10.8a.8.8 0 0 0 1.24.67l8.1-5.4a.8.8 0 0 0 0-1.34l-8.1-5.4a.8.8 0 0 0-1.24.67Z" />
              <path d="M2 6.6v10.8a.8.8 0 0 0 1.24.67l8.1-5.4a.8.8 0 0 0 0-1.34l-8.1-5.4A.8.8 0 0 0 2 6.6Z" />
            </svg>
          </button>
        </div>

        <div className="audio-player__side audio-player__side--end">
          <div className="audio-player__volume">
            <button
              type="button"
              className="audio-player__mute"
              onClick={handleToggleMute}
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted || volume === 0 ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
                  <path d="m10.5 6 3.5 4M14 6l-3.5 4" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
                  <path d="M10.8 5.5a4 4 0 0 1 0 5" />
                  <path d="M12.6 4a6.5 6.5 0 0 1 0 8" />
                </svg>
              )}
            </button>
            <input
              type="range"
              className="audio-player__volume-range"
              // The filled portion is painted by the track's own gradient, which
              // needs the level as a length - a range input gives no way to
              // style "up to the thumb" on its own.
              style={{ ['--volume-fill' as string]: `${Math.round((isMuted ? 0 : volume) * 100)}%` }}
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              aria-label="Volume"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
