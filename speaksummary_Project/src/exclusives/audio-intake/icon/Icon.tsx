import type { ReactNode } from 'react'
import './Icon.css'

/**
 * The app's icon set, drawn on Material Symbols' 24px grid and in its rounded,
 * single-weight outline idiom so they sit together as one family.
 *
 * These are inline SVG rather than the Material Symbols webfont on purpose: the
 * font ships thousands of glyphs in a multi-megabyte file and this interface
 * uses fourteen of them. Swapping to the real font later is a contained change -
 * every icon in the app comes through this component.
 */
export type IconName =
  | 'size'
  | 'duration'
  | 'encoding'
  | 'sampleRate'
  | 'channels'
  | 'video'
  | 'added'
  | 'compress'
  | 'lossless'
  | 'replace'
  | 'remove'
  | 'download'
  | 'convert'
  | 'check'
  | 'fix'
  | 'warning'

const PATHS: Record<IconName, ReactNode> = {
  size: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
      <path d="M4.5 6v6c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V6" />
      <path d="M4.5 12v6c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-6" />
    </>
  ),
  duration: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2V12l3.2 2" />
    </>
  ),
  encoding: (
    <>
      <path d="M4 7.5h9M19 7.5h1M4 16.5h3M13 16.5h7" />
      <circle cx="16" cy="7.5" r="2.4" />
      <circle cx="10" cy="16.5" r="2.4" />
    </>
  ),
  sampleRate: <path d="M5 9.5v5M9.5 5.5v13M14.5 7.5v9M19 10.5v3" />,
  channels: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="3" />
      <circle cx="12" cy="14.5" r="3.2" />
      <path d="M12 7h.01" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10.2 9.4 4.6 2.6-4.6 2.6z" />
    </>
  ),
  added: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3.2v3.6M16 3.2v3.6" />
    </>
  ),
  compress: (
    <>
      <path d="M4 12h16" />
      <path d="M12 8.4V3M9.6 6l2.4 2.4L14.4 6" />
      <path d="M12 15.6V21M9.6 18l2.4-2.4 2.4 2.4" />
    </>
  ),
  lossless: (
    <>
      <path d="M12 3.2 19 6v5.4c0 4.1-2.85 7.85-7 9.4-4.15-1.55-7-5.3-7-9.4V6z" />
      <path d="m9 12 2.2 2.2 4.3-4.6" />
    </>
  ),
  replace: (
    <>
      <path d="M19.8 10.6A8 8 0 0 0 6.2 6.3L4 8.2" />
      <path d="M3.6 4.4v4h4" />
      <path d="M4.2 13.4a8 8 0 0 0 13.6 4.3l2.2-1.9" />
      <path d="M20.4 19.6v-4h-4" />
    </>
  ),
  remove: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9.8 6.5V5.2A1.7 1.7 0 0 1 11.5 3.5h1a1.7 1.7 0 0 1 1.7 1.7v1.3" />
      <path d="m6.8 6.5.85 12.1a1.9 1.9 0 0 0 1.9 1.7h4.9a1.9 1.9 0 0 0 1.9-1.7l.85-12.1" />
      <path d="M10.4 10.4v6M13.6 10.4v6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.8v11.4" />
      <path d="m7.8 11 4.2 4.2 4.2-4.2" />
      <path d="M4.6 16.6v1.8a2.6 2.6 0 0 0 2.6 2.6h9.6a2.6 2.6 0 0 0 2.6-2.6v-1.8" />
    </>
  ),
  convert: <path d="M13.2 2.8 5.6 13.4h5.6l-.6 7.8 7.8-10.6h-5.6z" />,
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.4 12.2 2.5 2.5 4.7-5.2" />
    </>
  ),
  fix: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  warning: (
    <>
      <path d="M12 4.2 21 19.6H3z" />
      <path d="M12 10v4.2M12 17.2h.01" />
    </>
  ),
}

interface IconProps {
  name: IconName
  /** Rendered size in px. The grid is 24, so anything scales cleanly. */
  size?: number
  className?: string
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
