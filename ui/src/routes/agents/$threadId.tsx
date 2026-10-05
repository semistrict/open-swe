import { createFileRoute } from "@tanstack/react-router"

import { AgentThreadPage } from "@/features/agents/components/AgentThreadPage"
import { prefetchThreadSource } from "@/features/agents/lib/threadSource/prefetchThreadSource"

export const Route = createFileRoute("/agents/$threadId")({
  // `subagent` is the `task` call id of a subagent to view instead of the thread.
  validateSearch: (search: Record<string, unknown>): { subagent?: string } => {
    const subagent = search["subagent"]
    return typeof subagent === "string" && subagent ? { subagent } : {}
  },
  // Runs when a link to the thread is hovered (the router preloads on intent)
  // and again on navigation. It only starts the transcript request, never
  // awaits it, so the page still renders at once.
  loader: ({ context, params }) => {
    if (typeof window === "undefined") return
    prefetchThreadSource(context.queryClient, params.threadId)
  },
  component: AgentThreadRoute,
})

function AgentThreadRoute() {
  const { threadId } = Route.useParams()
  const { subagent } = Route.useSearch()
  return <AgentThreadPage threadId={threadId} subagentId={subagent} />
}
