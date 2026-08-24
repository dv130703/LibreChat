import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import './Waveform.css'

interface WaveformProps {
  /** Normalised 0..1 peak per bar, or null when none could be read. */
  peaks: number[] | null
  /**
   * How far through the recording the playhead is, 0..1. Left undefined the
   * waveform is a picture of the file rather than a transport - every bar
   * reads at full strength and nothing is dimmed as "not yet played".
   */
  progress?: number
  /** Shown in place of the bars when there are no peaks to draw. */
  placeholder?: ReactNode
  className?: string
  /**
   * Makes the strip a scrub target. Called with a 0..1 position along the bars
   * on click and continuously while dragging.
   */
  onSeek?: (ratio: number) => void
  /** Turns a 0..1 position into the label shown under the pointer. */
  formatHover?: (ratio: number) => string
}

// Silence still gets a hairline rather than a gap, so the strip reads as one
// continuous recording instead of a row of islands.
const FLOOR = 0.06

// How much of the plate's height the loudest bar is allowed to claim. Well
// short of full: bars that touch the top and bottom edges read as a solid block
// with notches cut out of it rather than as a waveform sitting in space.
const AMPLITUDE = 0.72

// Roughly half the label's width. It is held this far in from either end so the
// tooltip never hangs off the plate at the very start or end of a recording.
const TIP_INSET = 30

/**
 * The one waveform in the app. The intake page draws the file it was handed and
 * the audio player draws the file it is playing, and because they are the same
 * bars on the same plate the two read as one component seen twice rather than
 * two takes on the same idea.
 *
 * Pointer-seeking here is a convenience on top of the player's real range
 * input, not a replacement for it - that slider is what keeps scrubbing
 * keyboard-operable and legible to a screen reader, so this stays hidden from
 * the accessibility tree rather than pretending to be a second slider.
 */
export function Waveform({ peaks, progress, placeholder, className, onSeek, formatHover }: WaveformProps) {
  const barsRef = useRef<HTMLDivElement>(null)
  // Held in pixels against the bar area rather than as a ratio, so the cursor
  // and its label can be placed without re-deriving the width for each.
  const [hover, setHover] = useState<{ x: number; width: number } | null>(null)
  const draggingRef = useRef(false)

  const seekable = !!onSeek
  const tracksPointer = seekable || !!formatHover

  /** Where along the bars the pointer is, clamped to the strip's own ends. */
  function positionOf(event: ReactPointerEvent<HTMLDivElement>) {
    const box = barsRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return null
    return { x: Math.min(box.width, Math.max(0, event.clientX - box.left)), width: box.width }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onSeek) return
    const at = positionOf(event)
    if (!at) return
    draggingRef.current = true
    // Capture so a drag that wanders off the plate keeps scrubbing, and so the
    // release still arrives here to end it.
    event.currentTarget.setPointerCapture(event.pointerId)
    setHover(at)
    onSeek(at.x / at.width)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const at = positionOf(event)
    if (!at) return
    setHover(at)
    if (draggingRef.current && onSeek) onSeek(at.x / at.width)
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handlePointerLeave() {
    // A drag that leaves the plate is still a drag - only a genuine hover ends.
    if (!draggingRef.current) setHover(null)
  }

  if (!peaks || peaks.length === 0) {
    return <div className={`waveform waveform--blank${className ? ` ${className}` : ''}`}>{placeholder}</div>
  }

  // A playhead sitting at zero is not a playhead - dimming every bar as "not
  // yet reached" would drain the whole strip before playback has even started,
  // which is the only state the intake panel is ever in.
  const hasPlayhead = progress !== undefined && progress > 0
  const hoverLabel = hover && formatHover ? formatHover(hover.x / hover.width) : null

  return (
    <div
      className={`waveform${seekable ? ' waveform--seekable' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      onPointerDown={seekable ? handlePointerDown : undefined}
      onPointerMove={tracksPointer ? handlePointerMove : undefined}
      onPointerUp={seekable ? handlePointerUp : undefined}
      onPointerCancel={seekable ? handlePointerUp : undefined}
      onPointerLeave={tracksPointer ? handlePointerLeave : undefined}
    >
      <span className="waveform__mid" />

      <div className="waveform__bars" ref={barsRef}>
        {peaks.map((peak, index) => (
          <span
            key={index}
            className="waveform__bar"
            // The bar's midpoint rather than its edge, so the colour flips as
            // the playhead passes through it instead of as it arrives.
            data-played={hasPlayhead ? (index + 0.5) / peaks.length <= progress : undefined}
            style={{
              height: `${((FLOOR + peak * (1 - FLOOR)) * AMPLITUDE * 100).toFixed(2)}%`,
              animationDelay: `${index * 7}ms`,
            }}
          />
        ))}

        {hover && (
          <>
            <span className="waveform__cursor" style={{ left: `${hover.x}px` }} />
            {hoverLabel && (
              <span
                className="waveform__tip"
                style={{ left: `${Math.min(hover.width - TIP_INSET, Math.max(TIP_INSET, hover.x))}px` }}
              >
                {hoverLabel}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
