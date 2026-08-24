import { useState, useEffect, useRef, useCallback } from 'react'
import { type SessionRecord } from '../logic'
import './SessionHistoryPanel.css'

interface SessionHistoryPanelProps {
  sessions: SessionRecord[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, newName: string) => void
  onNewSession: () => void
}

interface Session {
  id: string
  fileName: string
  duration: string
  createdAt: number
  status: 'Processing' | 'Transcribed' | 'Summarised'
}

interface SessionItem extends Session {
  active: boolean
  entering: boolean
  removing: boolean
  statusColor: string
  dotClass: string
  statusAnimClass: string
  menuOpen: boolean
  starLabel: string
  deleteLabel: string
  confirmClass: string
  renaming: boolean
  notRenaming: boolean
  isStarredFlag: boolean
}

interface Group {
  label: string
  items: SessionItem[]
  dividerClass: string
}

interface StatusMeta {
  color: string
  dot: string
}

function statusMeta(status: 'Processing' | 'Transcribed' | 'Summarised'): StatusMeta {
  if (status === 'Summarised') return { color: 'var(--color-success)', dot: '' }
  if (status === 'Transcribed') return { color: 'var(--color-accent)', dot: '' }
  return { color: 'var(--color-warning)', dot: 'sh-item-meta--working' }
}

function bucketFor(timestamp: number): string {
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const age = startOfToday - new Date(timestamp).setHours(0, 0, 0, 0)
  if (age <= 0) return 'Today'
  if (age <= 86400000) return 'Yesterday'
  if (age <= 86400000 * 7) return 'Previous 7 days'
  return 'Older'
}


/** Empty until there is a transcript to measure - a session still being set up
 *  has no length to report, and "0:00" reads as one that does. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function getSessionStatus(record: SessionRecord): 'Processing' | 'Transcribed' | 'Summarised' {
  if (record.summary) return 'Summarised'
  if (record.segments.length > 0) return 'Transcribed'
  return 'Processing'
}

// Starring is sidebar-only presentation, not part of a session's own record, so
// it's kept in its own small localStorage entry rather than round-tripped
// through saveSession - but it still needs to survive a reload like everything
// else in this list.
const STARRED_STORAGE_KEY = 'speak-summary:starred'

function loadStarred(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STARRED_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function saveStarred(next: Record<string, boolean>) {
  try {
    localStorage.setItem(STARRED_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be full or unavailable (e.g. private browsing) - starring just won't persist.
  }
}

export function SessionHistoryPanel({ sessions: appSessions, activeId, onSelect, onDelete, onRename, onNewSession }: SessionHistoryPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [starred, setStarred] = useState<Record<string, boolean>>(loadStarred)
  const [prevStatuses, setPrevStatuses] = useState<Record<string, string>>({})
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncedSessionsRef = useRef<SessionRecord[] | null>(null)

  const toggleMenu = useCallback((id: string) => {
    setMenuId((current) => (current === id ? null : id))
  }, [])

  const toggleStar = useCallback((id: string) => {
    setStarred((current) => {
      const next = { ...current, [id]: !current[id] }
      saveStarred(next)
      return next
    })
    setMenuId(null)
  }, [])

  const startRename = useCallback((id: string) => {
    const s = appSessions.find((r) => r.id === id)
    if (s) {
      setRenamingId(id)
      setRenameValue(s.fileName)
      setMenuId(null)
    }
  }, [appSessions])

  const commitRename = useCallback(() => {
    if (!renamingId) return
    const trimmed = renameValue.trim()
    const current = appSessions.find((r) => r.id === renamingId)
    if (trimmed && current && trimmed !== current.fileName) {
      onRename(renamingId, trimmed)
    }
    setRenamingId(null)
  }, [renamingId, renameValue, appSessions, onRename])

  const deleteClick = useCallback((id: string) => {
    if (confirmId === id) {
      setConfirmId(null)
      setMenuId(null)
      setRemovingId(id)
      setStarred((current) => {
        if (!(id in current)) return current
        const next = { ...current }
        delete next[id]
        saveStarred(next)
        return next
      })
      setTimeout(() => {
        onDelete(id)
        setRemovingId(null)
      }, 180)
    } else {
      setConfirmId(id)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => setConfirmId(null), 2500)
    }
  }, [confirmId, onDelete])

  // Sync prevStatuses on session status changes (but not on initial render)
  useEffect(() => {
    if (syncedSessionsRef.current === null || syncedSessionsRef.current !== appSessions) {
      syncedSessionsRef.current = appSessions
      const nextPrev: Record<string, string> = {}
      appSessions.forEach((s) => {
        nextPrev[s.id] = getSessionStatus(s)
      })
      setTimeout(() => setPrevStatuses(nextPrev), 0)
    }
  }, [appSessions])

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  // Build groups and items
  const buckets = ['Today', 'Yesterday', 'Previous 7 days', 'Older']
  const prev = prevStatuses
  const items = appSessions.map((r) => {
    const status = getSessionStatus(r)
    const meta = statusMeta(status)
    const changed = prev[r.id] !== undefined && prev[r.id] !== status
    const isStarred = !!starred[r.id]
    const isConfirming = confirmId === r.id

    return {
      id: r.id,
      fileName: r.fileName,
      duration: formatDuration(r.durationSeconds),
      createdAt: r.createdAt,
      status,
      active: r.id === activeId,
      entering: false,
      removing: r.id === removingId,
      statusColor: meta.color,
      dotClass: meta.dot,
      statusAnimClass: changed ? 'sh-status-anim' : '',
      menuOpen: menuId === r.id,
      starLabel: isStarred ? 'Unstar' : 'Star',
      deleteLabel: isConfirming ? 'Confirm delete' : 'Delete',
      confirmClass: isConfirming ? 'sh-menu-item--confirming' : '',
      renaming: renamingId === r.id,
      notRenaming: renamingId !== r.id,
      isStarredFlag: isStarred,
    }
  })

  const starredItems = items.filter((it) => it.isStarredFlag)
  const rest = items.filter((it) => !it.isStarredFlag)

  const groups: Group[] = []
  if (starredItems.length > 0) groups.push({ label: 'Starred', items: starredItems, dividerClass: '' })
  buckets.forEach((label) => {
    const bucketItems = rest.filter((it) => bucketFor(it.createdAt) === label)
    if (bucketItems.length > 0) {
      groups.push({
        label,
        items: bucketItems,
        dividerClass: groups.length > 0 ? 'sh-group-divider' : '',
      })
    }
  })

  return (
    <>
      <div className="sh-topbar">
        <button
          type="button"
          className="sh-icon-btn sh-icon-btn--collapse"
          aria-label={collapsed ? 'Show session history' : 'Collapse session history'}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 4v16M4 4h16v16H4z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16v16H4zM9 4v16" />
            </svg>
          )}
        </button>
      </div>

      <div className="sh-body-wrap">
        <div className="sh-rail" data-hidden={!collapsed}>
          <button type="button" className="sh-btn-primary-rail" aria-label="New session" onClick={onNewSession}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        <div className="sh-panel-body" data-hidden={collapsed}>
          <button type="button" className="sh-btn-secondary" onClick={onNewSession}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New session
          </button>

          <div className="sh-head">
            <span className="eyebrow">Sessions</span>
            <span className="sh-count">{appSessions.length}</span>
          </div>

          <div className="sh-scroll">
            {groups.map((group) => (
              <div key={group.label} className={`sh-group ${group.dividerClass}`}>
                <p className="sh-group-label">{group.label}</p>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {group.items.map((item) => (
                    <li key={item.id} className="sh-row-wrap" data-entering={item.entering} data-removing={item.removing}>
                      <div className="sh-row">
                        {item.renaming ? (
                          <input
                            className="sh-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename()
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                            autoFocus
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              className="sh-item-btn"
                              data-active={item.active}
                              onClick={() => onSelect(item.id)}
                            >
                              <span className="sh-item-bar" aria-hidden="true" />
                              <span className="sh-item-body">
                                <span className="sh-item-name">{item.fileName}</span>
                                <span
                                  className={`sh-item-meta ${item.dotClass} ${item.statusAnimClass}`}
                                  style={{ color: item.statusColor }}
                                >
                                  {item.status.toUpperCase()}
                                  {item.duration ? ` · ${item.duration}` : ''}
                                </span>
                              </span>
                            </button>

                            <div className="sh-menu-wrap">
                              <button
                                type="button"
                                className="sh-icon-btn sh-kebab"
                                data-open={item.menuOpen}
                                aria-label="Options"
                                onClick={() => toggleMenu(item.id)}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                  <circle cx="12" cy="5" r="1.6" />
                                  <circle cx="12" cy="12" r="1.6" />
                                  <circle cx="12" cy="19" r="1.6" />
                                </svg>
                              </button>

                              {item.menuOpen && (
                                <div className="sh-menu">
                                  <button type="button" className="sh-menu-item" onClick={() => toggleStar(item.id)}>
                                    {item.starLabel}
                                  </button>
                                  <button type="button" className="sh-menu-item" onClick={() => startRename(item.id)}>
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    className={`sh-menu-item sh-menu-item--danger ${item.confirmClass}`}
                                    onClick={() => deleteClick(item.id)}
                                  >
                                    {item.deleteLabel}
                                  </button>
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="sh-foot">
            Click a session to open it. Press <kbd>⋯</kbd> on a row to star, rename or delete.
          </p>
        </div>
      </div>
    </>
  )
}
