import type { TranscriptSegment } from '../transcript/transcript'
import type { SummaryResult } from '../summary/summary'
import type { ConversionResult } from '../audio/convertAudio'

export interface SessionRecord {
  id: string
  fileName: string
  createdAt: number
  durationSeconds: number
  segments: TranscriptSegment[]
  summary: SummaryResult | null
}

const STORAGE_KEY = 'speak-summary:sessions'
const MAX_SESSIONS = 20

// Audio blobs can't be serialized into localStorage; this in-memory cache lets a
// reopened session still play back audio as long as the tab hasn't been reloaded.
const audioCache = new Map<string, ConversionResult>()

export function cacheSessionAudio(id: string, audio: ConversionResult) {
  audioCache.set(id, audio)
}

export function getCachedSessionAudio(id: string): ConversionResult | undefined {
  return audioCache.get(id)
}

export function loadSessions(): SessionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SessionRecord[]) : []
  } catch {
    return []
  }
}

export function saveSession(record: SessionRecord): SessionRecord[] {
  const existing = loadSessions().filter((session) => session.id !== record.id)
  const next = [record, ...existing].slice(0, MAX_SESSIONS)
  persist(next)
  return next
}

export function deleteSession(id: string): SessionRecord[] {
  const next = loadSessions().filter((session) => session.id !== id)
  persist(next)
  const cached = audioCache.get(id)
  if (cached) URL.revokeObjectURL(cached.url)
  audioCache.delete(id)
  return next
}

function persist(sessions: SessionRecord[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  } catch {
    // Storage can be full or unavailable (e.g. private browsing) - history just won't persist.
  }
}
