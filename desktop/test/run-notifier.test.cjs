const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRunNotifier,
  POLL_WHILE_IDLE_MS,
  POLL_WHILE_RUNNING_MS,
} = require("../build/run-notifier.cjs");

/** A notifier over scripted rounds of thread lists, driven one poll at a time. */
function scripted(rounds, { showing = () => false } = {}) {
  const notified = [];
  const delays = [];
  let pending = null;
  let round = 0;
  const notifier = createRunNotifier({
    listCloudThreads: async () => rounds[round]?.cloud ?? [],
    listLocalThreads: async () => rounds[round]?.local ?? [],
    isShowing: showing,
    notify: (run) => notified.push(`${run.location}:${run.id}:${run.outcome}`),
    now: () => (round + 1) * 10_000,
    setTimer: (callback, ms) => {
      delays.push(ms);
      pending = callback;
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    notified,
    delays,
    async start() {
      notifier.start();
      await settle();
    },
    async next() {
      round += 1;
      const callback = pending;
      pending = null;
      callback();
      await settle();
    },
    stop: () => notifier.stop(),
  };
}

const cloud = (id, status, extra = {}) => ({
  id,
  location: "cloud",
  title: id,
  status,
  ...extra,
});

test("a run that ends notifies once, and a thread first seen idle does not", async () => {
  const run = scripted([
    { cloud: [cloud("a", "running"), cloud("old", "finished")] },
    { cloud: [cloud("a", "finished"), cloud("old", "finished")] },
    { cloud: [cloud("a", "finished"), cloud("old", "finished")] },
  ]);
  await run.start();
  await run.next();
  await run.next();
  run.stop();

  assert.deepEqual(run.notified, ["cloud:a:finished"]);
});

test("Slack threads and the thread on screen end without a notification", async () => {
  const run = scripted(
    [
      {
        cloud: [
          cloud("slack", "running", { repliesInSlack: true }),
          cloud("viewed", "running"),
        ],
      },
      {
        cloud: [
          cloud("slack", "finished", { repliesInSlack: true }),
          cloud("viewed", "error"),
        ],
      },
    ],
    { showing: (ended) => ended.id === "viewed" },
  );
  await run.start();
  await run.next();
  run.stop();

  assert.deepEqual(run.notified, []);
});

test("a source that cannot be read is skipped, not taken for every run ending", async () => {
  const run = scripted([
    { cloud: [cloud("a", "running")] },
    { cloud: null },
    { cloud: [cloud("a", "running")] },
  ]);
  await run.start();
  await run.next();
  await run.next();
  run.stop();

  assert.deepEqual(run.notified, []);
});

test("polling quickens while a run is going and slows once nothing runs", async () => {
  const run = scripted([
    { local: [{ id: "l", location: "local", title: "l", status: "running" }] },
    { local: [{ id: "l", location: "local", title: "l", status: "idle" }] },
  ]);
  await run.start();
  await run.next();
  run.stop();

  assert.deepEqual(run.delays, [POLL_WHILE_RUNNING_MS, POLL_WHILE_IDLE_MS]);
  assert.deepEqual(run.notified, ["local:l:finished"]);
});

test("a run that starts and ends between two polls still notifies", async () => {
  const run = scripted([
    { cloud: [cloud("quick", "finished", { lastEndedAt: 1_000 })] },
    { cloud: [cloud("quick", "finished", { lastEndedAt: 2_000 })] },
    { cloud: [cloud("quick", "finished", { lastEndedAt: 2_000 })] },
  ]);
  await run.start();
  await run.next();
  await run.next();
  run.stop();

  assert.deepEqual(run.notified, ["cloud:quick:finished"]);
});

test("a thread that appears already finished notifies, unless it ended before the watcher started", async () => {
  const run = scripted([
    { cloud: [] },
    {
      cloud: [
        cloud("fresh", "finished", { lastEndedAt: 15_000 }),
        cloud("resurfaced", "finished", { lastEndedAt: 5_000 }),
      ],
    },
  ]);
  await run.start();
  await run.next();
  run.stop();

  assert.deepEqual(run.notified, ["cloud:fresh:finished"]);
});
