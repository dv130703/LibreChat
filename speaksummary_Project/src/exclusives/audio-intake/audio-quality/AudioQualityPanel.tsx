import { useState } from 'react'
import { Icon, type IconName } from '../icon'
import { readLevel, readClipping, type Metric, type MetricFix, type MetricLevel } from './metrics'
import './AudioQualityPanel.css'

export interface AudioQuality {
  rating: 'good' | 'acceptable' | 'poor' | 'very_poor'
  description: string
  should_adjust_gain: boolean
  show_clipping_warning: boolean
  // Technical metrics that drive the rows below
  lufs_integrated?: number | null
  clipping_percentage?: number | null
}

const LEVEL_ICON: Record<MetricLevel, IconName> = {
  good: 'check',
  warning: 'warning',
  error: 'warning',
  unknown: 'check',
}

const FIX_LABEL: Record<Exclude<MetricFix, null>, string> = {
  gain: 'Normalise recording level',
}

interface AudioQualityPanelProps {
  quality: AudioQuality
  /** Run the one repair on offer - normalising the recording level. */
  onApplyPreprocessing?: () => void
  isProcessing?: boolean
  /** Why the last repair didn't happen. Shown instead of leaving the rows looking untouched for no stated reason. */
  error?: string | null
}

/**
 * Every metric shown plainly, all the time - good or not is visible without
 * hovering anything. Hovering a row that isn't good surfaces what it actually
 * does to transcription accuracy; a wrench next to it applies the one fix for
 * that specific problem.
 */
export function AudioQualityPanel({
  quality,
  onApplyPreprocessing,
  isProcessing = false,
  error = null,
}: AudioQualityPanelProps) {
  // Tracks which row's fix was clicked, so only that icon spins while the shared
  // isProcessing flag is true rather than every fixable row spinning at once.
  const [pendingFix, setPendingFix] = useState<MetricFix>(null)

  const metrics: Metric[] = [readLevel(quality.lufs_integrated), readClipping(quality.clipping_percentage)]

  function fix(kind: Exclude<MetricFix, null>) {
    if (isProcessing) return
    setPendingFix(kind)
    onApplyPreprocessing?.()
  }

  return (
    <div className="quality-rows">
      {error && (
        <p role="alert" className="quality-rows__error">
          <Icon name="warning" size={13} />
          {error}
        </p>
      )}
      {metrics.map((metric) => {
        const isBad = metric.level === 'warning' || metric.level === 'error'
        // Amber and red are reserved for readings the user can do something
        // about. A metric that is merely not ideal and has no fix (clipping
        // cannot be undone) states itself in a neutral pill instead.
        const isActionable = isBad && metric.fix !== null
        return (
          <div key={metric.key} className="quality-row" data-level={metric.level} data-actionable={isActionable}>
            <div
              className="quality-row__main"
              tabIndex={isBad ? 0 : undefined}
              aria-describedby={isBad ? `quality-row-tooltip-${metric.key}` : undefined}
            >
              <Icon name={LEVEL_ICON[metric.level]} size={16} className="quality-row__icon" aria-hidden="true" />
              <span className="quality-row__label">{metric.label}</span>
              <span className={`quality-row__status${isBad && !isActionable ? ' pill' : ''}`}>{metric.status}</span>
              {isBad && (
                <span className="quality-row__tooltip" role="tooltip" id={`quality-row-tooltip-${metric.key}`}>
                  {metric.impact}
                </span>
              )}
            </div>

            {isActionable && metric.fix && (
              <button
                type="button"
                className="quality-row__fix"
                disabled={isProcessing}
                onClick={() => fix(metric.fix as Exclude<MetricFix, null>)}
                aria-label={FIX_LABEL[metric.fix]}
                title={FIX_LABEL[metric.fix]}
              >
                {isProcessing && pendingFix === metric.fix ? (
                  <span className="quality-row__spinner" aria-hidden="true" />
                ) : (
                  <Icon name="fix" size={14} aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
