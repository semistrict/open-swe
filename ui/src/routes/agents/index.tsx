import { createFileRoute } from "@tanstack/react-router"

import { AgentsHome } from "@/features/agents/components/AgentsHome"
import { PaneSkeleton } from "@/features/agents/components/PaneSkeleton"

interface AgentsIndexSearch {
  repo?: string
  localRepo?: string
  noRepo?: boolean
}

export const Route = createFileRoute("/agents/")({
  validateSearch: (search: Record<string, unknown>): AgentsIndexSearch => ({
    ...(typeof search.repo === "string" && search.repo.trim()
      ? { repo: search.repo.trim() }
      : {}),
    ...(typeof search.localRepo === "string" && search.localRepo.trim()
      ? { localRepo: search.localRepo.trim() }
      : {}),
    ...(search.noRepo === true || search.noRepo === "true"
      ? { noRepo: true }
      : {}),
  }),
  // The home page starts from what this browser remembered (the work panel,
  // cached repos, the last repo), which the server cannot know, so rendering
  // it there made a returning visitor's hydration disagree and React redo the
  // page. The server sends the pane skeleton; the client renders the rest.
  ssr: false,
  pendingComponent: PaneSkeleton,
  pendingMinMs: 0,
  component: AgentsIndexPage,
})

function AgentsIndexPage() {
  const { repo, localRepo, noRepo } = Route.useSearch()
  return (
    <AgentsHome
      key={`${repo ?? ""}:${localRepo ?? ""}:${noRepo ?? ""}`}
      initialRepo={repo}
      initialLocalRepo={localRepo}
      initialNoRepo={noRepo}
    />
  )
}
