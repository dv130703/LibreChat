import { useRef, useState } from 'react'
import './index.css'
import './App.css'
import {
  AudioPlayer,
  UploadIntake,
  TranscriptPanel,
  SummaryPanel,
  SessionHistoryPanel,
  StageNav,
  TranscriptionOptionsPanel,
  DEFAULT_TRANSCRIPTION_OPTIONS,
  cacheSessionAudio,
  getCachedSessionAudio,
  loadSessions,
  saveSession,
  deleteSession,
  type AudioPlayerHandle,
  type ConversionResult,
  type TranscriptSegment,
  type SummaryResult,
  type SessionRecord,
  type Stage,
  type TranscriptionOptions,
} from './exclusives'

// crypto.randomUUID() only exists in secure contexts (HTTPS or localhost); this
// app is also reached over a plain-HTTP LAN address, where it's silently
// undefined and throws. getRandomValues() has no such restriction.
function generateSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

function buildSessionRecord(
  sessionId: string,
  existing: SessionRecord | undefined,
  fileName: string,
  segments: TranscriptSegment[],
  summary: SummaryResult | null,
): SessionRecord {
  return {
    id: sessionId,
    fileName,
    createdAt: existing?.createdAt ?? Date.now(),
    durationSeconds: segments.length > 0 ? segments[segments.length - 1].end : (existing?.durationSeconds ?? 0),
    segments,
    summary,
  }
}

function initialStageFor(session: SessionRecord): Stage {
  if (session.summary) return 3
  if (session.segments !== null) return 2
  return 1
}

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [pickedFileName, setPickedFileName] = useState<string | null>(null)
  const [audio, setAudio] = useState<ConversionResult | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null)
  const [summary, setSummary] = useState<SummaryResult | null>(null)
  const [sessions, setSessions] = useState<SessionRecord[]>(() => loadSessions())
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [activeStage, setActiveStage] = useState<Stage>(1)
  // Raised by UploadIntake while ffmpeg is loading or converting, so stage 1's
  // Continue stays shut until there's a settled file to move on with.
  const [isConverting, setIsConverting] = useState(false)
  // How to transcribe. Decided on stage 1 next to the output format - both are
  // choices made about the file before anything is generated from it - and read
  // on stage 2, which runs the job. Held here because neither stage owns both
  // halves. `isTranscribing` travels the other way, so stage 1's options can't
  // be edited out from under a run that's already using them.
  const [transcription, setTranscription] = useState<TranscriptionOptions>(DEFAULT_TRANSCRIPTION_OPTIONS)
  const [isTranscribing, setIsTranscribing] = useState(false)
  // Bumped only when switching to a *different* session from the sidebar (new/reopen), so
  // UploadIntake remounts to a clean slate. Picking a file through UploadIntake's own dropzone
  // must NOT bump this - it already manages that transition internally.
  const [resetToken, setResetToken] = useState(0)
  // "name · 22:11 · 243.7 MB", assembled by the intake page from its own probe -
  // the top bar has no way to read duration or size for itself.
  const [fileLine, setFileLine] = useState<string | null>(null)
  // The recording's shape, so the transcript stage's player draws the same
  // waveform the intake panel did instead of probing the file again.
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const playerRef = useRef<AudioPlayerHandle>(null)

  function persistSession(nextSegments: TranscriptSegment[], nextSummary: SummaryResult | null) {
    if (!sessionId) return
    const existing = sessions.find((session) => session.id === sessionId)
    const record = buildSessionRecord(sessionId, existing, fileName ?? 'Untitled session', nextSegments, nextSummary)
    setSessions(saveSession(record))
  }

  function patchTranscription(patch: Partial<TranscriptionOptions>) {
    setTranscription((current) => ({ ...current, ...patch }))
  }

  function handleFileChange(file: File | null) {
    if (!file) return
    setSessionId(generateSessionId())
    setPickedFileName(file.name)
    setAudio(null)
    setSegments(null)
    setSummary(null)
    setCurrentTime(0)
    setActiveStage(1)
  }

  function handleConverted(result: ConversionResult | null) {
    setAudio(result)
    if (result && sessionId) {
      cacheSessionAudio(sessionId, result)
    }
  }

  function handleSegmentsChange(next: TranscriptSegment[] | null) {
    setSegments(next)
    if (next) persistSession(next, summary)
  }

  function handleSummaryChange(next: SummaryResult | null) {
    setSummary(next)
    if (segments) persistSession(segments, next)
  }

  function handleNewSession() {
    setSessionId(null)
    setPickedFileName(null)
    setAudio(null)
    setSegments(null)
    setSummary(null)
    setCurrentTime(0)
    setActiveStage(1)
    setResetToken((token) => token + 1)
  }

  function handleSelectSession(id: string) {
    const session = sessions.find((item) => item.id === id)
    if (!session) return
    setSessionId(id)
    setPickedFileName(session.fileName)
    setSegments(session.segments)
    setSummary(session.summary)
    setAudio(getCachedSessionAudio(id) ?? null)
    setCurrentTime(0)
    setActiveStage(initialStageFor(session))
    setResetToken((token) => token + 1)
  }

  function handleDeleteSession(id: string) {
    setSessions(deleteSession(id))
    if (id === sessionId) handleNewSession()
  }

  function handleRenameSession(id: string, newName: string) {
    const existing = sessions.find((session) => session.id === id)
    if (!existing) return
    setSessions(saveSession({ ...existing, fileName: newName }))
    if (id === sessionId) setPickedFileName(newName)
  }

  const activeSession = sessionId ? sessions.find((session) => session.id === sessionId) : undefined
  const fileName = audio?.fileName ?? pickedFileName ?? activeSession?.fileName ?? null
  const hasActiveSession = audio !== null || segments !== null
  const audioRef = audio ? { name: audio.fileName, url: audio.url, blob: audio.blob } : null
  const canGoToStage2 = audio !== null || segments !== null
  const canGoToStage3 = segments !== null

  const STAGE_META: Record<Stage, { title: string; step: string }> = {
    1: { title: 'Audio intake', step: 'Step 1 of 3' },
    2: { title: 'Transcript', step: 'Step 2 of 3' },
    3: { title: 'Summary', step: 'Step 3 of 3' },
  }
  const currentStageMeta = STAGE_META[hasActiveSession ? activeStage : 1]
  // The measured line while stage 1 has it; the bare name once the intake page
  // is no longer the one on screen and its probe is out of view.
  const headerSubtitle = (activeStage === 1 ? fileLine : null) ?? fileName ?? currentStageMeta.step

  return (
    <div id="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </span>
          <div className="sidebar__brand-text">
            <div className="sidebar__brand-name">Speak Summary</div>
            <div className="sidebar__brand-tagline">Transcribe &amp; summarise</div>
          </div>
        </div>

        <SessionHistoryPanel
          sessions={sessions}
          activeId={sessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onRename={handleRenameSession}
          onNewSession={handleNewSession}
        />
      </aside>

      <main className="workspace">
        <div className={`workspace__shell${hasActiveSession ? '' : ' workspace__shell--empty'}`}>
          <header className="workspace__header">
            <div className="workspace__header-title">
              <span className="workspace__header-mark" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M12 3v13M7 8l5-5 5 5" />
                </svg>
              </span>
              <div className="workspace__header-text">
                {/* The page's h1 - every stage's own headings sit below it. */}
                <h1 className="workspace__header-name">{currentStageMeta.title}</h1>
                <div className="workspace__header-file">{headerSubtitle}</div>
              </div>
            </div>

            {hasActiveSession && (
              <StageNav
                activeStage={activeStage}
                // Held shut mid-conversion: there is no settled file to move on
                // with until the encode lands, and the intake page's own button
                // is the one that knows to wait for it.
                stage1Done={canGoToStage2 && !isConverting}
                stage2Done={canGoToStage3}
                stage3Done={summary !== null}
                onSelect={setActiveStage}
              />
            )}
          </header>

          {/* UploadIntake keeps one stable position across renders - only its siblings/visibility
              vary - so a successful conversion never forces it to remount mid-flow. */}
          <div className={`workspace__inner${hasActiveSession ? '' : ' workspace__inner--empty'}`}>
            {!hasActiveSession && (
              <div className="workspace__empty-intro">
                {/* The page's h1 is the header above (`workspace__header-name`);
                    this hero restates it for the empty state, so it's an h2. */}
                <h2>Convert, Transcribe & Summarise</h2>
              </div>
            )}

            <div className="stage-section" hidden={hasActiveSession && activeStage !== 1}>
              <UploadIntake
                key={resetToken}
                onFileChange={handleFileChange}
                onConverted={handleConverted}
                onBusyChange={setIsConverting}
                onFileLineChange={setFileLine}
                onPeaksChange={setPeaks}
                // The intake page owns the whole "encode if needed, then move
                // on" action, so all it needs from here is where to go next.
                onContinue={() => setActiveStage(2)}
                transcription={transcription}
                optionsSlot={
                  <TranscriptionOptionsPanel
                    options={transcription}
                    onChange={patchTranscription}
                    disabled={isTranscribing}
                  />
                }
              />
            </div>

            {hasActiveSession && activeStage === 2 && (
              <div className="stage-section">
                <TranscriptPanel
                  fileName={fileName}
                  audio={audioRef}
                  segments={segments}
                  onSegmentsChange={handleSegmentsChange}
                  playerRef={playerRef}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  options={transcription}
                  onEditOptions={() => setActiveStage(1)}
                  onTranscribingChange={setIsTranscribing}
                  audioSlot={
                    audio ? (
                      <AudioPlayer
                        key={audio.url}
                        ref={playerRef}
                        src={audio.url}
                        title={fileName ?? audio.fileName}
                        peaks={peaks}
                        onTimeUpdate={setCurrentTime}
                        onPlayStateChange={setIsPlaying}
                      />
                    ) : (
                      <div className="card audio-unavailable">
                        <span className="audio-unavailable__title">Playback unavailable</span>
                        <span className="audio-unavailable__hint">
                          This saved session's audio isn't cached in this browser tab anymore — go back to Audio and
                          re-add the original file to listen or regenerate the transcript.
                        </span>
                      </div>
                    )
                  }
                />

                <div className="stage-actions">
                  <button type="button" className="button button--ghost" onClick={() => setActiveStage(1)}>
                    Back to audio
                  </button>
                  <button type="button" className="button button--primary" disabled={!canGoToStage3} onClick={() => setActiveStage(3)}>
                    Continue to summary
                  </button>
                </div>
              </div>
            )}

            {hasActiveSession && activeStage === 3 && (
              <div className="stage-section">
                <SummaryPanel
                  segments={segments}
                  summary={summary}
                  onSummaryChange={handleSummaryChange}
                  context={transcription.context}
                />

                <div className="stage-actions">
                  <button type="button" className="button button--ghost" onClick={() => setActiveStage(2)}>
                    Back to transcript
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
