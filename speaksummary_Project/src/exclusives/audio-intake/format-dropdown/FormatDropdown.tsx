import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import './FormatDropdown.css'

export interface FormatDropdownStop {
  key: string
  name: string
  /** Three or four words on why you'd take this one over its neighbours. */
  desc: string
  bytes: number | null
  bitrateKbps: number | null
  lossless: boolean
}

export interface FormatDropdownGroup {
  key: string
  label: string
  stops: FormatDropdownStop[]
}

interface FormatDropdownProps {
  groups: FormatDropdownGroup[]
  selectedId: string | null
  onSelect: (key: string) => void
  disabled?: boolean
  /** The largest file on offer (source or any encode) - what each row's bar is measured against. */
  laneBytes: number
  formatBytes: (bytes: number) => string
}

type VarStyle = CSSProperties & { '--i'?: number; '--w-ratio'?: number }

function bitrateLabel(stop: FormatDropdownStop): string {
  if (stop.lossless) return 'Lossless'
  if (stop.bitrateKbps === null) return ''
  return `${Math.round(stop.bitrateKbps)} kbps`
}

/** Counts the trigger's size readout up or down to its new value, unless the visitor asked for less motion. */
function useTweenedBytes(target: number | null, durationMs = 320): number | null {
  const [display, setDisplay] = useState(target)
  const fromRef = useRef(target)
  const rafRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const from = fromRef.current
    if (reduced || target === null || from === null || from === target) {
      setDisplay(target)
      fromRef.current = target
      return
    }
    const start = performance.now()
    function step(now: number) {
      const progress = Math.min(1, (now - start) / durationMs)
      const eased = 1 - (1 - progress) ** 3
      setDisplay(from! + (target! - from!) * eased)
      if (progress < 1) rafRef.current = requestAnimationFrame(step)
      else fromRef.current = target
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    }
  }, [target, durationMs])

  return display
}

/**
 * The output format picker. A single sliding highlight tracks the active row
 * instead of each row toggling its own background, and focus never leaves the
 * trigger - the active row is tracked with aria-activedescendant so a blur
 * can't close the panel out from under a pointer still moving inside it.
 */
export function FormatDropdown({ groups, selectedId, onSelect, disabled, laneBytes, formatBytes }: FormatDropdownProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const markerRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef(new Map<string, HTMLDivElement>())
  const justOpenedRef = useRef(false)

  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const ordered = groups.flatMap((group) => group.stops)
  const selected = ordered.find((stop) => stop.key === selectedId) ?? null
  const tweenedBytes = useTweenedBytes(selected?.bytes ?? null)

  useLayoutEffect(() => {
    const marker = markerRef.current
    if (!open || !activeKey) {
      if (marker) marker.style.opacity = '0'
      return
    }
    const el = optionRefs.current.get(activeKey)
    if (!marker || !el) return

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

    const list = listRef.current
    if (list) {
      const top = el.offsetTop
      const bottom = top + el.offsetHeight
      if (top < list.scrollTop) list.scrollTop = top - 4
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4
    }
  }, [open, activeKey])

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closeMenu()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  function openMenu() {
    if (open || disabled || ordered.length === 0) return
    const trigger = triggerRef.current
    if (trigger) {
      const below = window.innerHeight - trigger.getBoundingClientRect().bottom
      setDropUp(below < 300)
    }
    justOpenedRef.current = true
    setActiveKey(selected?.key ?? ordered[0].key)
    setOpen(true)
  }

  function closeMenu() {
    setOpen(false)
    setActiveKey(null)
  }

  function choose(key: string) {
    onSelect(key)
    closeMenu()
    triggerRef.current?.focus()
  }

  function step(delta: number) {
    const from = Math.max(0, ordered.findIndex((stop) => stop.key === activeKey))
    const next = Math.max(0, Math.min(ordered.length - 1, from + delta))
    setActiveKey(ordered[next].key)
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
        setActiveKey(ordered[0].key)
        break
      case 'End':
        event.preventDefault()
        setActiveKey(ordered[ordered.length - 1].key)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (activeKey) choose(activeKey)
        break
      case 'Escape':
        event.preventDefault()
        closeMenu()
        break
      case 'Tab':
        closeMenu()
        break
    }
  }

  let i = 0

  return (
    <div ref={rootRef} className={`fdd${open ? ' fdd--open' : ''}${dropUp ? ' fdd--drop-up' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="fdd-trigger"
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="format-dropdown-list"
        aria-activedescendant={open && activeKey ? `format-opt-${activeKey}` : undefined}
        aria-label="Output format"
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        {selected ? (
          <>
            <span className="fdd-value">
              <span className="fdd-main">
                <span className="fdd-name">{selected.name}</span>
                <span className={`fdd-tag${selected.lossless ? ' fdd-tag--lossless' : ''}`}>{bitrateLabel(selected)}</span>
              </span>
              <span className="fdd-sub">{selected.desc}</span>
            </span>
            {tweenedBytes !== null && <span className="fdd-size">{formatBytes(Math.round(tweenedBytes))}</span>}
          </>
        ) : (
          <span className="fdd-value fdd-value--empty">Select a format</span>
        )}
        <svg className="fdd-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="fdd-panel">
        <div className="fdd-list" id="format-dropdown-list" role="listbox" aria-label="Output format" ref={listRef} tabIndex={-1}>
          <div className="fdd-marker" ref={markerRef} />
          {groups.map((group) => (
            <div key={group.key}>
              <div className="fdd-group-label" style={{ '--i': i++ } as VarStyle} role="presentation">
                <span className="eyebrow">{group.label}</span>
              </div>
              {group.stops.map((stop) => {
                const isSelected = stop.key === selectedId
                const barPercent =
                  laneBytes > 0 && stop.bytes !== null ? Math.max(3, Math.min(100, (stop.bytes / laneBytes) * 100)) : 3
                return (
                  <div
                    key={stop.key}
                    id={`format-opt-${stop.key}`}
                    ref={(el) => {
                      if (el) optionRefs.current.set(stop.key, el)
                      else optionRefs.current.delete(stop.key)
                    }}
                    role="option"
                    aria-selected={isSelected}
                    className="fdd-opt"
                    style={{ '--i': i++, '--w-ratio': barPercent / 100 } as VarStyle}
                    onClick={() => choose(stop.key)}
                    onMouseMove={() => {
                      if (activeKey !== stop.key) setActiveKey(stop.key)
                    }}
                  >
                    <span className="fdd-opt-head">
                      <span className="fdd-opt-name">{stop.name}</span>
                      <span className={`fdd-tag${stop.lossless ? ' fdd-tag--lossless' : ''}`}>{bitrateLabel(stop)}</span>
                    </span>
                    {stop.bytes !== null && <span className="fdd-opt-size">{formatBytes(stop.bytes)}</span>}
                    <svg className="fdd-check" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="fdd-opt-desc">{stop.desc}</span>
                    <span className="fdd-opt-bar" aria-hidden="true">
                      <i />
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
