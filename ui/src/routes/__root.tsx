import { Suspense, lazy, useEffect, useState } from "react"
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"

import appCss from "../styles.css?url"
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url"
import type { QueryClient } from "@tanstack/react-query"
import { AppCommandProvider } from "@/lib/appCommands"
import { resolveSessionOnServer } from "@/lib/session-ssr"
import { Toaster } from "@/components/ui/sonner"
import { VersionMismatchBanner } from "@/components/VersionMismatchBanner"
import { ThemeSync } from "@/lib/ThemeSync"
import { PageTracking } from "@/lib/PageTracking"
import { THEME_COLOR } from "@/lib/theme"
import { apiWarmupScript } from "@/features/agents/lib/apiWarmup"
import { isPerfHudEnabled } from "@/lib/perf/trace"

const PerfHud = lazy(() => import("@/lib/perf/PerfHud"))
// Dev builds only, so rrweb never reaches a production bundle.
const FlinchRecorder = import.meta.env.DEV
  ? lazy(() => import("@/lib/flinch/FlinchRecorder"))
  : null

/** Client-only: rrweb records the live DOM, which a server render does not have. */
function FlinchRecorderMount() {
  const [mounted, setMounted] = useState(false)
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => setMounted(true), [])
  if (!FlinchRecorder || !mounted) return null
  return (
    <Suspense fallback={null}>
      <FlinchRecorder />
    </Suspense>
  )
}

/** Client-only: the flag lives in localStorage, so the server render never shows it. */
function PerfHudMount() {
  const [enabled, setEnabled] = useState(false)
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => setEnabled(isPerfHudEnabled()), [])
  if (!enabled) return null
  return (
    <Suspense fallback={null}>
      <PerfHud />
    </Suspense>
  )
}

const themeInitScript = `(function(){try{var t=localStorage.getItem("open-swe-theme");var d=t==="dark"||((!t||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  beforeLoad: ({ context, location }) =>
    resolveSessionOnServer(context.queryClient, location.href),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, maximum-scale=1",
      },
      { name: "theme-color", content: THEME_COLOR.light },
      { title: "Open SWE" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Inter is `font-display: swap`, so text first painted before it loads
      // reflows when it arrives. Fetching it beside the stylesheet, rather
      // than once the stylesheet is parsed, has it ready for the first paint.
      {
        rel: "preload",
        href: interLatin,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "manifest",
        href: `${import.meta.env.BASE_URL}manifest.webmanifest`,
      },
      {
        rel: "icon",
        type: "image/png",
        href: `${import.meta.env.BASE_URL}favicon.png`,
      },
      {
        rel: "apple-touch-icon",
        href: `${import.meta.env.BASE_URL}apple-touch-icon.png`,
      },
    ],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1 className="text-2xl font-medium">404</h1>
      <p className="text-muted-foreground">
        The requested page could not be found.
      </p>
    </main>
  ),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { queryClient } = useRouter().options.context
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const warmupScript = apiWarmupScript(pathname)
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {warmupScript && (
          // Built from a function's source, which the server and client
          // bundles compile differently; only the server's copy ever runs.
          <script
            dangerouslySetInnerHTML={{ __html: warmupScript }}
            suppressHydrationWarning
          />
        )}
        <HeadContent />
      </head>
      <body>
        {typeof window !== "undefined" &&
          window.openSweDesktop && (
            // Rendered first so later no-drag elements carve out of it; the
            // desktop preload styles it. Preload-injected DOM would be cleared
            // when React takes over the document, so it lives here instead.
            <div aria-hidden data-desktop-drag-strip="" />
          )}
        <ThemeSync />
        <Toaster position="bottom-right" closeButton />
        <QueryClientProvider client={queryClient}>
          <PageTracking />
          <VersionMismatchBanner />
          <AppCommandProvider>{children ?? <Outlet />}</AppCommandProvider>
          <PerfHudMount />
          <FlinchRecorderMount />
          {import.meta.env.VITE_DEVTOOLS !== "false" && (
            <>
              <TanStackDevtools
                config={{ position: "bottom-right" }}
                plugins={[
                  {
                    name: "Tanstack Router",
                    render: <TanStackRouterDevtoolsPanel />,
                  },
                ]}
              />
              <ReactQueryDevtools initialIsOpen={false} />
            </>
          )}
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
