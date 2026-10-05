import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

// Lab metrics for the perf budgets: counts that come out the same on every run
// of the same build, so a change that makes a flow do more work fails CI
// instead of waiting for someone to feel it. Timings are reported, never
// budgeted: they depend on the machine.

/** One `layout-shift` entry; Chromium only, so not in lib.dom. */
interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources: Array<{
    node: Node | null;
    previousRect: DOMRectReadOnly;
    currentRect: DOMRectReadOnly;
  }>;
}

interface Shift {
  at: number;
  value: number;
  sources: Array<string>;
}

interface PerfProbe {
  commits: Array<number>;
  shifts: Array<Shift>;
  composerAt: number | null;
}

declare global {
  interface Window {
    __perfProbe?: PerfProbe;
  }
}

/**
 * Count React commits through the hook React DevTools uses (production builds
 * report to it too) and record every layout shift with what moved. Must run
 * before the app's scripts, so it is an init script.
 */
export async function installPerfProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const probe: PerfProbe = { commits: [], shifts: [], composerAt: null };
    window.__perfProbe = probe;

    let rendererId = 0;
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: true,
      value: {
        supportsFiber: true,
        isDisabled: false,
        renderers: new Map<number, unknown>(),
        inject() {
          rendererId += 1;
          return rendererId;
        },
        onCommitFiberRoot() {
          probe.commits.push(performance.now());
        },
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        checkDCE() {},
      },
    });

    const describe = (node: Node | null): string => {
      if (!(node instanceof Element)) return node?.nodeName ?? "(gone)";
      const testId = node.getAttribute("data-testid");
      const label = node.getAttribute("aria-label");
      const text = node.textContent?.trim().slice(0, 40);
      return [
        node.tagName.toLowerCase(),
        testId ? `[data-testid=${testId}]` : "",
        label ? `[aria-label="${label}"]` : "",
        text ? ` "${text}"` : "",
      ].join("");
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<LayoutShiftEntry>) {
        probe.shifts.push({
          at: entry.startTime,
          value: entry.value,
          sources: entry.sources.map(
            (source) =>
              `${describe(source.node)} moved ` +
              `${Math.round(source.currentRect.x - source.previousRect.x)},` +
              `${Math.round(source.currentRect.y - source.previousRect.y)}px`,
          ),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });

    // When the composer first exists, painted or not, to compare against the
    // first commit (hydration) in the first-load report.
    const watchComposer = () => {
      if (document.querySelector('[data-testid="composer-editor"]')) {
        probe.composerAt = performance.now();
        return;
      }
      requestAnimationFrame(watchComposer);
    };
    requestAnimationFrame(watchComposer);
  });
}

/**
 * Hydration mismatches the page reports. One makes React throw the server's
 * markup away and render the page again on the client.
 */
export function watchHydrationErrors(page: Page): Array<string> {
  const errors: Array<string> = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydrat|Minified React error #(418|423|425)/i.test(message.text())
    )
      errors.push(message.text());
  });
  return errors;
}

const QUIET_MS = 750;

/**
 * Wait until nothing has committed or shifted for a while. Polls in the page
 * on animation frames, so the quiet window is measured where it happens.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    (quietMs) => {
      const probe = window.__perfProbe;
      // Nothing has rendered until React's first commit (hydration).
      if (!probe?.commits.length) return false;
      const last = Math.max(
        probe.commits.at(-1) ?? 0,
        probe.shifts.at(-1)?.at ?? 0,
      );
      return performance.now() - last >= quietMs;
    },
    QUIET_MS,
    { polling: "raf", timeout: 15_000 },
  );
}

export async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

export interface Recorded {
  commits: number;
  shifts: Array<Shift>;
}

/** Commits and shifts recorded since `from` (a page `performance.now()`). */
export async function since(page: Page, from: number): Promise<Recorded> {
  return page.evaluate((start) => {
    const probe = window.__perfProbe;
    if (!probe) throw new Error("perf probe is not installed");
    return {
      commits: probe.commits.filter((at) => at >= start).length,
      shifts: probe.shifts.filter((shift) => shift.at >= start),
    };
  }, from);
}

/** Requests for the thread transcript snapshot started since `from`. */
export async function transcriptRequestsSince(
  page: Page,
  from: number,
): Promise<number> {
  return page.evaluate(
    (start) =>
      performance
        .getEntriesByType("resource")
        .filter(
          (entry) =>
            entry.startTime >= start &&
            /\/threads\/[^/]+\/transcript(\?|$)/.test(entry.name),
        ).length,
    from,
  );
}

export interface LoadReport {
  /** Every script the page loaded until it settled. */
  scriptKB: number;
  /** Scripts requested before hydration: what the page waits on to work. */
  criticalScriptKB: number;
  styleKB: number;
  /** The biggest critical scripts, for finding what to split out. */
  largestScripts: Array<string>;
  firstContentfulPaintMs: number | null;
  composerInDomMs: number | null;
  firstCommitMs: number | null;
}

/** What the page downloaded and when it came alive, from a cold load. */
export async function loadReport(page: Page): Promise<LoadReport> {
  return page.evaluate(() => {
    const probe = window.__perfProbe;
    if (!probe) throw new Error("perf probe is not installed");
    const ownResources = (
      performance.getEntriesByType(
        "resource",
      ) as Array<PerformanceResourceTiming>
    ).filter((entry) => new URL(entry.name).origin === location.origin);
    const kilobytes = (entries: Array<PerformanceResourceTiming>) =>
      Math.round(
        entries.reduce((total, entry) => total + entry.decodedBodySize, 0) /
          1024,
      );
    const ofType = (pattern: RegExp) =>
      ownResources.filter((entry) =>
        pattern.test(new URL(entry.name).pathname),
      );
    const scripts = ofType(/\.m?js$/);
    const hydratedAt = probe.commits[0] ?? Infinity;
    const critical = scripts.filter((entry) => entry.startTime < hydratedAt);
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const round = (value: number | null | undefined) =>
      value == null ? null : Math.round(value);
    const largestScripts = critical
      .sort((a, b) => b.decodedBodySize - a.decodedBodySize)
      .slice(0, 10)
      .map(
        (entry) =>
          `${new URL(entry.name).pathname.split("/").pop()} ` +
          `${Math.round(entry.decodedBodySize / 1024)}KB`,
      );
    return {
      scriptKB: kilobytes(scripts),
      criticalScriptKB: kilobytes(critical),
      styleKB: kilobytes(ofType(/\.css$/)),
      largestScripts,
      firstContentfulPaintMs: round(fcp?.startTime),
      composerInDomMs: round(probe.composerAt),
      firstCommitMs: round(probe.commits[0]),
    };
  });
}

// Ceilings live in a file so raising one is a reviewed diff. A measurement
// under its ceiling passes; with E2E_PERF_RATCHET=1 the run also lowers every
// ceiling to what it measured (plus the metric's headroom), so a win stays won.
const BUDGETS_PATH = resolve(__dirname, "..", "..", "perf-budgets.json");

export type Metric =
  | "reactCommits"
  | "layoutShifts"
  | "transcriptRequests"
  | "scriptKB"
  | "criticalScriptKB"
  | "styleKB";

type Budgets = Record<string, Partial<Record<Metric, number>>>;

/**
 * Room above the best measurement before a run fails, as a fraction and a
 * floor. Commits move by up to three with the order responses arrive in, and
 * bundle size with every feature; shifts and requests are exact.
 */
const HEADROOM: Record<Metric, { fraction: number; floor: number }> = {
  reactCommits: { fraction: 0.1, floor: 4 },
  layoutShifts: { fraction: 0, floor: 0 },
  transcriptRequests: { fraction: 0, floor: 0 },
  scriptKB: { fraction: 0.02, floor: 0 },
  criticalScriptKB: { fraction: 0.02, floor: 0 },
  styleKB: { fraction: 0.02, floor: 0 },
};

function withHeadroom(metric: Metric, value: number): number {
  const { fraction, floor } = HEADROOM[metric];
  return Math.ceil(Math.max(value * (1 + fraction), value + floor));
}

function readBudgets(): Budgets {
  return JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as Budgets;
}

/** Lower each ceiling to the measurement plus its headroom, and save it. */
function ratchet(
  budgets: Budgets,
  flow: string,
  measured: Partial<Record<Metric, number>>,
): Partial<Record<Metric, number>> {
  const ceilings = { ...budgets[flow] };
  for (const [metric, value] of Object.entries(measured) as Array<
    [Metric, number]
  >) {
    const lowered = withHeadroom(metric, value);
    const current = ceilings[metric];
    if (current === undefined || lowered < current) ceilings[metric] = lowered;
  }
  writeFileSync(
    BUDGETS_PATH,
    `${JSON.stringify({ ...budgets, [flow]: ceilings }, null, 2)}\n`,
  );
  return ceilings;
}

export function expectWithinBudget(
  testInfo: TestInfo,
  flow: string,
  measured: Partial<Record<Metric, number>>,
  detail: Record<string, unknown> = {},
): void {
  const budgets = readBudgets();
  const ceilings = process.env.E2E_PERF_RATCHET
    ? ratchet(budgets, flow, measured)
    : (budgets[flow] ?? {});
  testInfo.annotations.push({
    type: "perf",
    description: JSON.stringify({ flow, measured, ceilings, ...detail }),
  });
  console.log(`[perf] ${flow}`, JSON.stringify({ measured, ...detail }));

  for (const [metric, value] of Object.entries(measured) as Array<
    [Metric, number]
  >) {
    const ceiling = ceilings[metric];
    expect(ceiling, `${flow}: no ceiling for ${metric}`).toBeDefined();
    expect(
      value,
      `${flow}: ${metric} went over its ceiling in tests/e2e/perf-budgets.json` +
        ` (${JSON.stringify(detail)})`,
    ).toBeLessThanOrEqual(ceiling as number);
  }
}
