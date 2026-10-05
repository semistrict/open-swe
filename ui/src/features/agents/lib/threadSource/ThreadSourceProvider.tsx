import { useStreamPreference } from "@/lib/streamPreference"

import { ThreadSourceContext } from "./context"
import { useAgentStreamSource } from "./useAgentStreamSource"
import { useTranscriptSource } from "./useTranscriptSource"
import type { ReactNode } from "react"

function StreamSource({
  threadId,
  children,
}: {
  threadId: string
  children: ReactNode
}) {
  const source = useAgentStreamSource(threadId)
  return (
    <ThreadSourceContext.Provider value={source}>
      {children}
    </ThreadSourceContext.Provider>
  )
}

function TranscriptSource({
  threadId,
  children,
}: {
  threadId: string
  children: ReactNode
}) {
  const source = useTranscriptSource(threadId)
  return (
    <ThreadSourceContext.Provider value={source}>
      {children}
    </ThreadSourceContext.Provider>
  )
}

/**
 * Picks the thread's source. The component identity differs per kind, so each
 * implementation owns its own hooks and neither runs for the other's threads:
 * a transcript thread never opens an SDK stream, because only `StreamSource`
 * mounts one and the page renders this once the thread detail has resolved.
 */
export function ThreadSourceProvider({
  threadId,
  transcript,
  children,
}: {
  threadId: string
  /** True for threads whose metadata says the event log serves them. */
  transcript: boolean
  children: ReactNode
}) {
  const preferStream = useStreamPreference()
  return transcript && !preferStream ? (
    <TranscriptSource threadId={threadId}>{children}</TranscriptSource>
  ) : (
    <StreamSource threadId={threadId}>{children}</StreamSource>
  )
}
