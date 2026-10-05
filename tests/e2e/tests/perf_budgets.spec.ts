import { expect, test, type Page } from "@playwright/test";

import {
  SAME_USER,
  loginAs,
  openThreadViaSlackLink,
  threadIdFromUrl,
  waitForThreadIdle,
} from "./helpers/dashboard";
import {
  expectWithinBudget,
  installPerfProbe,
  loadReport,
  now,
  settle,
  since,
  transcriptRequestsSince,
  watchHydrationErrors,
} from "./helpers/perf";

// Per-flow work ceilings (tests/e2e/perf-budgets.json): how many times React
// commits, how often layout shifts, and what a cold load downloads. A flow
// that starts doing more fails here, with the shifted elements named, instead
// of shipping as jank someone has to notice first.

const FIRST_MESSAGE = "please add a greet() helper and open a PR (perf one)";
const SECOND_MESSAGE = "please add a greet() helper and open a PR (perf two)";
// Three sidebar polls (one every 2 s).
const IDLE_MS = 6_000;

test.describe("perf budgets", () => {
  test.describe.configure({ mode: "serial" });

  let first: string;
  let second: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await browser.newPage();
    await loginAs(page, SAME_USER);
    for (const message of [FIRST_MESSAGE, SECOND_MESSAGE]) {
      await openThreadViaSlackLink(page, { message: `<@U0BOT> ${message}` });
      const threadId = threadIdFromUrl(page);
      await waitForThreadIdle(page, threadId);
      if (message === FIRST_MESSAGE) first = threadId;
      else second = threadId;
    }
    await page.close();
  });

  async function openHome(page: Page) {
    await installPerfProbe(page);
    await loginAs(page, SAME_USER);
    await page.goto("/agents");
    await expect(page.getByTestId("composer-editor")).toBeVisible();
    await expect(sidebarLink(page, first)).toBeVisible();
    await expect(sidebarLink(page, second)).toBeVisible();
    await settle(page);
  }

  function sidebarLink(page: Page, threadId: string) {
    return page.locator(`a[href="/agents/${threadId}"]`).first();
  }

  // The bubble prefixes the bot mention, so match within it.
  function transcriptOf(page: Page, message: string) {
    return page.getByRole("main").getByText(message).first();
  }

  test("first load", async ({ page }, testInfo) => {
    // A client re-render after a mismatch would hide inside these counts.
    const hydrationErrors = watchHydrationErrors(page);
    await openHome(page);
    expect(hydrationErrors).toEqual([]);
    const load = await loadReport(page);
    const recorded = await since(page, 0);
    expectWithinBudget(
      testInfo,
      "first load",
      {
        reactCommits: recorded.commits,
        layoutShifts: recorded.shifts.length,
        scriptKB: load.scriptKB,
        criticalScriptKB: load.criticalScriptKB,
        styleKB: load.styleKB,
      },
      {
        shifts: recorded.shifts,
        firstContentfulPaintMs: load.firstContentfulPaintMs,
        composerInDomMs: load.composerInDomMs,
        firstCommitMs: load.firstCommitMs,
        largestScripts: load.largestScripts,
      },
    );
  });

  // What the browser remembered from a previous visit (cached repos, an open
  // work panel) is only known on the client; it must not make the server's
  // render disagree with hydration or move things once it applies.
  test("first load, returning", async ({ page }, testInfo) => {
    await openHome(page);
    await page.getByRole("button", { name: "Show panel" }).click();
    await expect(
      page.getByRole("button", { name: "Hide panel" }),
    ).toBeVisible();

    const hydrationErrors = watchHydrationErrors(page);
    await page.reload();
    await expect(page.getByTestId("composer-editor")).toBeVisible();
    await expect(sidebarLink(page, first)).toBeVisible();
    await settle(page);
    expect(hydrationErrors).toEqual([]);

    const recorded = await since(page, 0);
    expectWithinBudget(
      testInfo,
      "first load, returning",
      {
        reactCommits: recorded.commits,
        layoutShifts: recorded.shifts.length,
      },
      { shifts: recorded.shifts },
    );
  });

  test("open a hovered thread", async ({ page }, testInfo) => {
    await openHome(page);
    const prefetched = page.waitForResponse((response) =>
      response.url().endsWith(`/threads/${first}/transcript`),
    );
    await sidebarLink(page, first).hover();
    await prefetched;
    await settle(page);

    const clicked = await now(page);
    await sidebarLink(page, first).click();
    await expect(transcriptOf(page, FIRST_MESSAGE)).toBeVisible();
    await settle(page);

    const recorded = await since(page, clicked);
    expectWithinBudget(
      testInfo,
      "open a hovered thread",
      {
        reactCommits: recorded.commits,
        layoutShifts: recorded.shifts.length,
        transcriptRequests: await transcriptRequestsSince(page, clicked),
      },
      { shifts: recorded.shifts },
    );
  });

  // The sidebar and the thread poll in the background; a poll that brings
  // nothing new should not render anything.
  test("sit on a thread", async ({ page }, testInfo) => {
    await openHome(page);
    await sidebarLink(page, first).click();
    await expect(transcriptOf(page, FIRST_MESSAGE)).toBeVisible();
    await settle(page);

    const from = await now(page);
    await page.waitForFunction(
      ({ start, idleMs }) => performance.now() - start >= idleMs,
      { start: from, idleMs: IDLE_MS },
      { polling: 250, timeout: IDLE_MS * 2 },
    );
    const recorded = await since(page, from);
    expectWithinBudget(
      testInfo,
      "sit on a thread",
      {
        reactCommits: recorded.commits,
        layoutShifts: recorded.shifts.length,
      },
      { idleMs: IDLE_MS, shifts: recorded.shifts },
    );
  });

  test("switch threads", async ({ page }, testInfo) => {
    await openHome(page);
    await sidebarLink(page, first).click();
    await expect(transcriptOf(page, FIRST_MESSAGE)).toBeVisible();
    await settle(page);

    const clicked = await now(page);
    await sidebarLink(page, second).click();
    await expect(transcriptOf(page, SECOND_MESSAGE)).toBeVisible();
    await settle(page);

    const recorded = await since(page, clicked);
    expectWithinBudget(
      testInfo,
      "switch threads",
      {
        reactCommits: recorded.commits,
        layoutShifts: recorded.shifts.length,
      },
      { shifts: recorded.shifts },
    );
  });
});
