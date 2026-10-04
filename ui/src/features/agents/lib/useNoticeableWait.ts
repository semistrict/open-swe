import { useEffect, useState } from "react"

/**
 * How long a wait runs before a person notices it. A loading indicator shown
 * sooner flashes on fast loads; one shown later leaves a slow load looking
 * stuck.
 */
export const NOTICEABLE_WAIT_MS = 300

/**
 * Whether the component has been mounted long enough for its wait to be
 * noticed. Render the indicator only once this is true, and hold its space
 * from the start, so a fast load shows nothing in between.
 */
export function useNoticeableWait(): boolean {
  const [noticeable, setNoticeable] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(
      () => setNoticeable(true),
      NOTICEABLE_WAIT_MS
    )
    return () => window.clearTimeout(timer)
  }, [])
  return noticeable
}
