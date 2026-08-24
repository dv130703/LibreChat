import { useEffect, useState } from 'react'

/** Cycles through `messages` on an interval while `active`, resetting to the first
 *  one whenever `active` goes false so the next run starts from the top. Used for
 *  reassurance copy next to a progress bar during a long-running job that has no
 *  real progress signal to show instead. */
export function useRotatingMessage(messages: string[], active: boolean, intervalMs = 6000): string {
  const [index, setIndex] = useState(0)
  // Reset for the next run adjusted during render (React's recommended pattern for
  // deriving state from a prop change) rather than in the effect below, which only
  // owns starting/stopping the timer.
  const [wasActive, setWasActive] = useState(active)
  if (active !== wasActive) {
    setWasActive(active)
    if (!active) setIndex(0)
  }

  useEffect(() => {
    if (!active) return
    const intervalId = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % messages.length)
    }, intervalMs)
    return () => window.clearInterval(intervalId)
  }, [active, messages, intervalMs])

  return messages[index] ?? messages[0]
}
