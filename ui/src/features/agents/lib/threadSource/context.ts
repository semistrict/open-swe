import { createContext, useContext } from "react"

import type { ThreadSource } from "./types"

/**
 * Kept apart from `ThreadSourceProvider`, which imports both backends, so UI
 * that only reads the source (the composer, on every page) doesn't load the
 * SDK stream client with it.
 */
export const ThreadSourceContext = createContext<ThreadSource | null>(null)

/**
 * The thread's transcript and run controls, whichever backend serves them.
 * Everything under a thread page reads the thread through this, so the two
 * backends differ in exactly one place: which provider the page mounts.
 */
export function useThreadSource(): ThreadSource {
  const source = useOptionalThreadSource()
  if (!source)
    throw new Error("useThreadSource requires a ThreadSourceProvider")
  return source
}

/** For UI shared with pages that mount no provider, such as local threads. */
export function useOptionalThreadSource(): ThreadSource | null {
  return useContext(ThreadSourceContext)
}
