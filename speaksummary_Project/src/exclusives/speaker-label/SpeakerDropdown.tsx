import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { speakerColor } from './speakerColor'
import './SpeakerDropdown.css'

interface SpeakerDropdownProps {
  /** The speaker currently assigned to this line; blank means unassigned. */
  speaker: string
  uniqueSpeakers: string[]
  onSelect: (speaker: string) => void
  /** The "Add speaker" row - the caller swaps in its own naming field. */
  onAddSpeaker: () => void
}

type VarStyle = CSSProperties & { '--i'?: number }

/**
 * Per-line speaker assignment. Every row is the same shape - swatch, name,
 * check - and the check slot is always reserved, so moving the selection never
 * shifts a name sideways. One sliding marker tracks the active row instead of
 * each row toggling its own background, and focus stays on the chip (the active
 * row is tracked with aria-activedescendant) so a blur can't close the panel
 * out from under a pointer still moving inside it.
 */
export function SpeakerDropdown({ speaker, uniqueSpeakers, onSelect, onAddSpeaker }: SpeakerDropdownProps) {
  const uid = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const markerRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<(HTMLDivElement | null)[]>([])
  const justOpenedRef = useRef(false)

  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  // The "Add speaker" row is the last option, so arrow keys walk onto it.
  const addIndex = uniqueSpeakers.length
  const assigned = speaker !== '' && uniqueSpeakers.includes(speaker)
  const optionId = (index: number) => `${uid}-opt-${index}`

  useLayoutEffect(() => {
    const marker = markerRef.current
    if (!marker) return
    if (!open) {
      marker.style.opacity = '0'
      return
    }
    const el = optionRefs.current[activeIndex]
    if (!el) return

    const instant = justOpenedRef.current
    justOpenedRef.current = false
    if (instant) marker.style.transition = 'none'
    marker.style.height = `${el.offsetHeight}px`
    marker.style.transform = `translateY(${el.offsetTop}px)`
    marker.style.opacity = '1'
    if (instant) {
      // Force layout so the "none" transition above is committed before it's cleared.
      void marker.offsetHeight
      marker.style.transition = ''
    }
  }, [open, activeIndex])

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  function openMenu() {
    if (open) return
    const trigger = triggerRef.current
    if (trigger) {
      const below = window.innerHeight - trigger.getBoundingClientRect().bottom
      setDropUp(below < 240)
    }
    justOpenedRef.current = true
    const selected = uniqueSpeakers.indexOf(speaker)
    setActiveIndex(selected < 0 ? 0 : selected)
    setOpen(true)
  }

  function choose(index: number) {
    setOpen(false)
    triggerRef.current?.focus()
    if (index === addIndex) onAddSpeaker()
    else onSelect(uniqueSpeakers[index])
  }

  function step(delta: number) {
    setActiveIndex((current) => Math.max(0, Math.min(addIndex, current + delta)))
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openMenu()
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        step(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        step(-1)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(addIndex)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div ref={rootRef} className={`spd${open ? ' spd--open' : ''}${dropUp ? ' spd--drop-up' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`spd-chip${assigned ? '' : ' spd-chip--empty'}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Speaker for this line"
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span
          className="spd-swatch"
          aria-hidden="true"
          style={assigned ? { background: speakerColor(speaker, uniqueSpeakers) } : undefined}
        />
        <span className="spd-chip-name">{assigned ? speaker : 'Speaker'}</span>
        <svg className="spd-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="spd-panel">
        <div className="spd-list" role="listbox" aria-label="Speaker for this line">
          <div className="spd-marker" ref={markerRef} />
          {uniqueSpeakers.map((name, index) => (
            <div
              key={name}
              id={optionId(index)}
              ref={(el) => {
                optionRefs.current[index] = el
              }}
              role="option"
              aria-selected={name === speaker}
              className="spd-opt"
              style={{ '--i': index } as VarStyle}
              onClick={() => choose(index)}
              onMouseMove={() => {
                if (activeIndex !== index) setActiveIndex(index)
              }}
            >
              <span className="spd-dot" style={{ background: speakerColor(name, uniqueSpeakers) }} />
              <span className="spd-name">{name}</span>
              <svg className="spd-check" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          ))}

          <div
            id={optionId(addIndex)}
            ref={(el) => {
              optionRefs.current[addIndex] = el
            }}
            role="option"
            aria-selected={false}
            className="spd-opt spd-opt--add"
            style={{ '--i': addIndex } as VarStyle}
            onClick={() => choose(addIndex)}
            onMouseMove={() => {
              if (activeIndex !== addIndex) setActiveIndex(addIndex)
            }}
          >
            <span className="spd-dot" />
            <span className="spd-name">Add speaker</span>
            <span className="spd-check" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}
