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

/** How long a loading indicator, once shown, stays up so it can be read. */
export const READABLE_MS = 500

/**
 * Whether to show the indicator for a wait that is `active`: only once it has
 * run long enough to notice, and then for long enough to read, even if the
 * wait ends sooner. For a component that outlives the wait, which
 * `useNoticeableWait` cannot hold on screen after it unmounts.
 */
export function useLoadingIndicator(active: boolean): boolean {
  const [shownAt, setShownAt] = useState<number | null>(null)
  useEffect(() => {
    if (active) {
      if (shownAt !== null) return
      const timer = window.setTimeout(
        () => setShownAt(Date.now()),
        NOTICEABLE_WAIT_MS
      )
      return () => window.clearTimeout(timer)
    }
    if (shownAt === null) return
    const timer = window.setTimeout(
      () => setShownAt(null),
      Math.max(0, shownAt + READABLE_MS - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [active, shownAt])
  return shownAt !== null
}
