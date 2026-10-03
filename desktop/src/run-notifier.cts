/**
 * Native notifications for finished runs, from the main process.
 *
 * The dashboard page can notify too, but only while its window is open and on
 * screen: a hidden page stops polling the thread list, and a closed window has
 * no page at all. The main process lives as long as the app does, so it watches
 * the user's threads itself and tells them when a run ends, wherever they are.
 */

type RunOutcome = "finished" | "error" | "interrupted";

/** One thread as the watcher sees it: where it runs, and its current status. */
interface WatchedThread {
  id: string;
  location: "cloud" | "local";
  title: string;
  status: string;
  /**
   * When the thread's newest run ended, as epoch ms, where the source knows it.
   * A run that started and finished between two polls is never seen running;
   * this moving is how it is seen at all.
   */
  lastEndedAt?: number | null;
  /** A conversation that lives in Slack is answered there, which notifies already. */
  repliesInSlack?: boolean;
}

interface EndedRun {
  id: string;
  location: "cloud" | "local";
  title: string;
  outcome: RunOutcome;
}

const ENDED_STATUSES: Record<string, RunOutcome> = {
  finished: "finished",
  idle: "finished",
  error: "error",
  interrupted: "interrupted",
};

/**
 * Remembers each thread's last status and reports the runs that ended since.
 * A thread seen for the first time only sets the baseline: a run that ended
 * before the watcher started is not news.
 */
class RunWatcher {
  private readonly seen = new Map<
    string,
    { status: string; lastEndedAt: number | null }
  >();

  observe(threads: Iterable<WatchedThread>): Array<EndedRun> {
    const ended: Array<EndedRun> = [];
    for (const thread of threads) {
      const key = `${thread.location}:${thread.id}`;
      const previous = this.seen.get(key);
      const lastEndedAt = thread.lastEndedAt ?? null;
      this.seen.set(key, { status: thread.status, lastEndedAt });
      const outcome = ENDED_STATUSES[thread.status];
      if (!previous || !outcome || thread.repliesInSlack) continue;
      const caughtEnding = previous.status === "running";
      const endedBetweenPolls =
        lastEndedAt !== null && lastEndedAt > (previous.lastEndedAt ?? 0);
      if (caughtEnding || endedBetweenPolls) {
        ended.push({
          id: thread.id,
          location: thread.location,
          title: thread.title,
          outcome,
        });
      }
    }
    return ended;
  }

  /** Whether any thread it has seen is running now: polling speeds up then. */
  get anyRunning(): boolean {
    return [...this.seen.values()].some(({ status }) => status === "running");
  }
}

const OUTCOME_TEXT: Record<RunOutcome, string> = {
  finished: "Run finished.",
  error: "Run failed.",
  interrupted: "Run was stopped.",
};

/** The notification for a run that ended. */
function endedRunNotification(run: EndedRun): { title: string; body: string } {
  return {
    title: run.title || "Open SWE",
    body: OUTCOME_TEXT[run.outcome],
  };
}

/** Polling cadence: soon after a run is seen, and slowly while nothing runs. */
const POLL_WHILE_RUNNING_MS = 5_000;
const POLL_WHILE_IDLE_MS = 30_000;

interface RunNotifierDeps {
  /** The user's cloud threads, or null when they cannot be read right now. */
  listCloudThreads: () => Promise<Array<WatchedThread> | null>;
  /** This Mac's threads, or null when the local backend cannot be read. */
  listLocalThreads: () => Promise<Array<WatchedThread> | null>;
  /** Whether the thread is what the user is looking at, which needs no notice. */
  isShowing: (run: EndedRun) => boolean;
  notify: (run: EndedRun) => void;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

/**
 * Polls both thread sources and notifies for each run that ends. A source that
 * cannot be read is skipped for that round rather than reported as idle, so a
 * dropped connection never looks like every run finishing at once.
 */
function createRunNotifier(deps: RunNotifierDeps) {
  const watcher = new RunWatcher();
  let timer: unknown = null;
  let stopped = true;

  const poll = async () => {
    const [cloud, local] = await Promise.all([
      deps.listCloudThreads().catch((error) => {
        console.warn(
          "Could not read cloud threads for run notifications",
          error,
        );
        return null;
      }),
      deps.listLocalThreads().catch((error) => {
        console.warn(
          "Could not read local threads for run notifications",
          error,
        );
        return null;
      }),
    ]);
    const ended = watcher.observe([...(cloud ?? []), ...(local ?? [])]);
    for (const run of ended) {
      if (!deps.isShowing(run)) deps.notify(run);
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = deps.setTimer(
      () => {
        void poll().finally(schedule);
      },
      watcher.anyRunning ? POLL_WHILE_RUNNING_MS : POLL_WHILE_IDLE_MS,
    );
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void poll().finally(schedule);
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
  };
}

module.exports = {
  RunWatcher,
  createRunNotifier,
  endedRunNotification,
  POLL_WHILE_RUNNING_MS,
  POLL_WHILE_IDLE_MS,
};
