import './StageNav.css'

export type Stage = 1 | 2 | 3

interface StageNavProps {
  activeStage: Stage
  stage1Done: boolean
  stage2Done: boolean
  stage3Done: boolean
  onSelect: (stage: Stage) => void
}

const STAGES: { id: Stage; label: string }[] = [
  { id: 1, label: 'Audio' },
  { id: 2, label: 'Transcript' },
  { id: 3, label: 'Summary' },
]

export function StageNav({ activeStage, stage1Done, stage2Done, stage3Done, onSelect }: StageNavProps) {
  const doneById: Record<Stage, boolean> = { 1: stage1Done, 2: stage2Done, 3: stage3Done }

  function isEnabled(stage: Stage): boolean {
    if (stage === 1) return true
    if (stage === 2) return stage1Done
    return stage2Done
  }

  // Furthest stage reached so far. Each step past the first draws the connector
  // leading into it, and fills that connector once progress has got this far.
  const furthestIndex = STAGES.reduce(
    (furthest, stage, index) => (doneById[stage.id] || stage.id === activeStage ? index : furthest),
    0,
  )

  return (
    <nav className="stage-nav" aria-label="Progress">
      <ol className="stage-nav__list">
        {STAGES.map((stage, index) => {
          const enabled = isEnabled(stage.id)
          const isDone = doneById[stage.id]
          const state = stage.id === activeStage ? 'active' : isDone ? 'done' : 'upcoming'

          return (
            <li key={stage.id} className="stage-nav__item" data-reached={index <= furthestIndex}>
              <button
                type="button"
                className="stage-nav__button"
                data-state={state}
                disabled={!enabled}
                aria-current={stage.id === activeStage ? 'step' : undefined}
                onClick={() => onSelect(stage.id)}
              >
                <span className="stage-nav__index">
                  {state === 'done' ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 8.5L6.2 11.5L13 4.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    stage.id
                  )}
                </span>
                <span className="stage-nav__label">{stage.label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
