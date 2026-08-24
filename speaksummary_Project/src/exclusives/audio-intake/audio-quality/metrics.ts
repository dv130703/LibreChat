export type MetricLevel = 'good' | 'warning' | 'error' | 'unknown'

/** Which preprocessing pass (if any) can address this metric. */
export type MetricFix = 'gain' | null

export interface Metric {
  key: string
  /** Short, human label used on the meter. */
  label: string
  /** Full technical name used in the measurements list. */
  detailLabel: string
  /** The one word the user actually reads. */
  status: string
  level: MetricLevel
  /** Filled segments, 0-3. Higher is always better, for every metric. */
  score: number
  value: string
  guide: string
  /** Plain-English effect on transcription accuracy. Empty when there's nothing wrong to explain. */
  impact: string
  /** Which fix applies when this metric isn't good, or null when nothing can be done after the fact. */
  fix: MetricFix
}

export function isNum(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function readLevel(lufs: number | null | undefined): Metric {
  const base = {
    key: 'level',
    label: 'Recording level',
    detailLabel: 'Integrated loudness',
    guide: 'Speech sits best between −23 and −16 LUFS',
  }
  if (!isNum(lufs)) {
    return { ...base, status: 'Not measured', level: 'unknown', score: 0, value: '—', impact: '', fix: null }
  }
  const value = `${lufs.toFixed(1)} LUFS`
  // Remove this branch if the backend never flags hot recordings.
  if (lufs >= -14)
    return {
      ...base,
      status: 'Too loud',
      level: 'warning',
      score: 2,
      value,
      impact: 'Audio this loud can clip and distort speech, which may garble or drop words at louder moments.',
      fix: 'gain',
    }
  if (lufs > -23) return { ...base, status: 'Good', level: 'good', score: 3, value, impact: '', fix: null }
  if (lufs > -28)
    return {
      ...base,
      status: 'Quiet',
      level: 'warning',
      score: 2,
      value,
      impact: 'Quiet audio is harder to pick out clearly, which can lead to missed or incorrect words.',
      fix: 'gain',
    }
  return {
    ...base,
    status: 'Very quiet',
    level: 'error',
    score: 1,
    value,
    impact: 'Very quiet audio will likely cause many words to be missed or transcribed incorrectly.',
    fix: 'gain',
  }
}

export function readClipping(clipping: number | null | undefined): Metric {
  const base = {
    key: 'clipping',
    label: 'Clipping',
    detailLabel: 'Clipped samples',
    guide: 'Clipped audio cannot be recovered',
  }
  if (!isNum(clipping)) {
    return { ...base, status: 'Not measured', level: 'unknown', score: 0, value: '—', impact: '', fix: null }
  }
  const value = `${clipping.toFixed(2)}%`
  if (clipping <= 0) return { ...base, status: 'None', level: 'good', score: 3, value, impact: '', fix: null }
  if (clipping <= 0.1)
    return {
      ...base,
      status: 'Minor',
      level: 'warning',
      score: 2,
      value,
      impact: 'A few short bursts of clipped audio may cause isolated word errors right at those moments.',
      fix: null,
    }
  return {
    ...base,
    status: 'Significant',
    level: 'error',
    score: 1,
    value,
    impact:
      "Clipped audio has permanently lost data at those peaks — expect gaps or errors there. It can't be fixed after recording; re-record if you can.",
    fix: null,
  }
}
