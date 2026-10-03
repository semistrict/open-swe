import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { RunTracker } from "@/lib/perf/streaming"
import {
  runStartCommand,
  startRun as postRunStart,
} from "@/features/agents/lib/transcript/api"
import { setAgentThreadStatus } from "@/features/agents/lib/queries"
import {
  agentStatusOf,
  subagentMessages,
  subagentTask,
  subagentToolCalls,
} from "@/features/agents/lib/transcript/reducer"
import { useThreadTranscript } from "@/features/agents/lib/transcript/useThreadTranscript"
import { useCancelRun } from "./useCancelRun"
import type {
  SubagentToolCall,
  TranscriptToolCallState,
} from "@/features/agents/lib/transcript/reducer"
import type { AgentStatus, Message } from "@/features/agents/lib/types"
import type { ThreadRunInput, TranscriptThreadSource } from "./types"

/** The append-only transcript log, behind the source interface. */
export function useTranscriptSource(threadId: string): TranscriptThreadSource {
  const [runTracker] = useState(
    () => new RunTracker({ transport: "cloud", threadId })
  )
  useEffect(() => () => runTracker.dispose(), [runTracker])
  const transcript = useThreadTranscript(threadId, { runTracker })
  const stop = useCancelRun(threadId)

  const startRun = useCallback(
    async ({ message, configurable, enqueue }: ThreadRunInput) => {
      runTracker.submitted()
      await postRunStart(
        threadId,
        runStartCommand({ threadId, message, configurable, enqueue })
      )
      runTracker.created()
    },
    [runTracker, threadId]
  )

  const state = transcript.state
  const queryClient = useQueryClient()
  const status = state?.threadId === threadId ? agentStatusOf(state) : null
  const mirrored = useRef<{ threadId: string; status: AgentStatus } | null>(
    null
  )
  // The transcript is this thread's live truth: the sidebar and the composer
  // read the cached thread, whose server status only follows LangGraph's run
  // and would miss a message accepted before that run starts. The first load
  // passes on only "running"; the server's settled status carries viewed state.
  useEffect(() => {
    if (status === null) return
    const previous =
      mirrored.current?.threadId === threadId ? mirrored.current.status : null
    mirrored.current = { threadId, status }
    if (status === previous) return
    if (previous === null && status !== "running") return
    setAgentThreadStatus(queryClient, threadId, status)
  }, [queryClient, status, threadId])
  const contextTokens = state?.contextTokens ?? null
  const subagents = useCallback(
    (namespace: ReadonlyArray<string>): Array<SubagentToolCall> =>
      state ? subagentToolCalls(state, namespace) : [],
    [state]
  )
  const subagentTranscript = useCallback(
    (namespace: ReadonlyArray<string>): Array<Message> =>
      state ? subagentMessages(state, namespace) : [],
    [state]
  )
  const task = useCallback(
    (toolCallId: string): TranscriptToolCallState | null =>
      state ? subagentTask(state, toolCallId) : null,
    [state]
  )

  return useMemo(
    () => ({
      kind: "transcript",
      threadId,
      messages: transcript.messages,
      queued: transcript.queued,
      isRunning: transcript.isRunning,
      isHydrating: transcript.isHydrating,
      hydration: transcript.hydration,
      error: transcript.error,
      isOffloading: transcript.isOffloading,
      routed: transcript.routed,
      connection: transcript.connection,
      contextTokens,
      subagentToolCalls: subagents,
      subagentMessages: subagentTranscript,
      subagentTask: task,
      startRun,
      stop,
      hasOlder: transcript.hasOlder,
      isLoadingOlder: transcript.isLoadingOlder,
      loadOlder: transcript.loadOlder,
    }),
    [
      contextTokens,
      startRun,
      stop,
      subagents,
      subagentTranscript,
      task,
      threadId,
      transcript,
    ]
  )
}
