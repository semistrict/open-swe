import { redirect } from "@tanstack/react-router"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestUrl } from "@tanstack/react-start/server"

import { api } from "./api"
import { isCrossOriginApiBase } from "./api-base"
import { sanitizeAuthRedirect } from "./auth-redirect-core"
import { dashboardRequestOrigin } from "./dashboard-fetch"
import { profileQueryOptions } from "./profile"
import { sessionQueryOptions } from "./session"
import type { QueryClient } from "@tanstack/react-query"

const PUBLIC_PATH_RE = /^\/(?:login|dashboard\/api|_serverFn)(?:[/?#]|$)/

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_RE.test(pathname)
}

/**
 * Resolves the session while rendering so a logged-out visitor is redirected
 * before the first byte and a logged-in one never refetches `me` on mount.
 *
 * Client-side this is a no-op: the desktop app serves the prerendered shell from
 * `open-swe://app` with no server at all, so the per-route `RequireLogin` gate
 * stays responsible for that case.
 */
export const resolveSessionOnServer = createIsomorphicFn()
  .client(async (_queryClient: QueryClient, _href: string) => {})
  .server(async (queryClient: QueryClient, href: string) => {
    // Prerendering the shell has no cookie, and its 401 must not become a
    // redirect — that would leave the build without a shell to write.
    if (process.env.TSS_PRERENDERING === "true") return

    // A cross-origin deployment's `osw_session` belongs to the API's origin, so
    // this request cannot carry it and `/me` would 401 for a signed-in user —
    // redirecting them to a login page that bounces them straight back. Auth
    // resolution stays client-side there.
    if (
      isCrossOriginApiBase(
        import.meta.env.VITE_DASHBOARD_API_BASE_URL,
        getRequestUrl().origin
      )
    ) {
      return
    }

    // Without DASHBOARD_API_URL (the Vite dev server behind `mise run dev-ui`)
    // a server render has no backend to call; every read would fail.
    if (!dashboardRequestOrigin()) return

    // The profile decides parts of the shell, such as whether the sidebar
    // lists Concierge, so it is resolved here too instead of after hydration,
    // when its arrival moves what is already on screen. It is fetched beside
    // the session rather than after it and stored under the session's login.
    const publicPath = isPublicPath(href)
    const [user, profile] = await Promise.all([
      queryClient.ensureQueryData(sessionQueryOptions).catch(() => undefined),
      publicPath
        ? undefined
        : api.profile().catch((error: unknown) => {
            // The client fetches it on mount instead.
            console.warn("Could not resolve the profile while rendering", error)
            return undefined
          }),
    ])
    if (user && profile) {
      queryClient.setQueryData(
        profileQueryOptions(user.login).queryKey,
        profile
      )
    }

    if (user !== null || publicPath) return
    throw redirect({
      to: "/login",
      search: { redirect: sanitizeAuthRedirect(href) },
    })
  })
