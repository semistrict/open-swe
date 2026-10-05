import { agentThreadKeys } from "@/features/agents/lib/queries"
import { prefetchThreadTranscript } from "@/features/agents/lib/transcript/useThreadTranscript"
import { prefersStream } from "@/lib/streamPreference"
import type { QueryClient } from "@tanstack/react-query"
import type { AgentThread } from "@/features/agents/lib/types"

/**
 * Warm what `ThreadSourceProvider` will read for a thread, judged from the
 * detail the sidebar already cached. A thread with no cached detail is a direct
 * page load, which the document's API warmup script covers.
 */
export function prefetchThreadSource(
  queryClient: QueryClient,
  threadId: string
): void {
  const thread = queryClient.getQueryData<AgentThread>(
    agentThreadKeys.detail(threadId)
  )
  if (thread?.transcript === "v2" && !prefersStream())
    prefetchThreadTranscript(threadId)
}
