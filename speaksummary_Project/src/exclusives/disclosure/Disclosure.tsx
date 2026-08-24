import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import './Disclosure.css'

interface DisclosureProps {
  label: string
  summary?: string
  disabled?: boolean
  children: ReactNode
}

export function Disclosure({ label, summary, disabled, children }: DisclosureProps) {
  const [isOpen, setIsOpen] = useState(false)
  const panelId = useId()

  return (
    <div className="disclosure" data-open={isOpen}>
      <button
        type="button"
        className="disclosure__trigger"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        disabled={disabled}
      >
        <svg
          className="disclosure__chevron"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="disclosure__label">{label}</span>
        {summary && !isOpen && <span className="disclosure__summary">{summary}</span>}
      </button>
      {isOpen && (
        <div className="disclosure__panel" id={panelId}>
          {children}
        </div>
      )}
    </div>
  )
}
