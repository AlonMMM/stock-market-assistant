import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import worker from "../apps/api/src/worker.js";
import {
  BacktestJobs,
  keptRuns,
  handleBacktestJobs,
  parseJobSpec,
  runPart,
  runParts,
  staleClaimMs,
  type JobView,
  type PartCompute,
  type PartTask,
} from "../packages/market-data/src/backtest-jobs.js";

// Synthetic parts and results: no market data is read.
const spec = {
  bot: "main",
  parts: [
    { symbol: "aapl", from: "2026-01-02", to: "2026-03-31" },
    { symbol: "MSFT", from: "2026-01-02", to: "2026-03-31" },
    { symbol: "NVDA", from: "2026-01-02", to: "2026-03-31" },
  ],
  body: { rules: { x: 1 }, fillPct: 50 },
  meta: { version: "v2.9", tickers: ["AAPL", "MSFT", "NVDA"] },
};

const echo: PartCompute = async (bot, request) =>
  request.symbol === "NVDA"
    ? { status: 502, body: { error: "Alpaca said no" } }
    : { status: 200, body: { bot, symbol: request.symbol, trades: [1, 2] } };

test("parseJobSpec checks the run and upper-cases symbols", () => {
  const parsed = parseJobSpec(spec);
  assert.equal(parsed.parts[0]!.symbol, "AAPL");
  assert.throws(() => parseJobSpec({ ...spec, bot: "x" }), /bot must be/);
  assert.throws(() => parseJobSpec({ ...spec, parts: [] }), /non-empty/);
  assert.throws(
    () =>
      parseJobSpec({ ...spec, parts: [{ symbol: "A", from: "x", to: "y" }] }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () => parseJobSpec({ ...spec, body: { symbol: "A" } }),
    /may not set symbol/,
  );
});

test("a run's parts finish one by one and can be read while it runs", async () => {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const id = await jobs.create(parseJobSpec(spec), "me@x", 1000);
  assert.deepEqual(
    (await jobs.pending(id)).map((t) => t.index),
    [0, 1, 2],
  );

  assert.equal(
    await runPart(jobs, { job: id, index: 0 }, echo, () => 2000),
    "done",
  );
  let view = (await jobs.view(id))!;
  assert.equal(view.status, "running");
  assert.equal(view.done, 1);
  assert.equal(view.total, 3);
  assert.deepEqual(
    view.results.map((r) => r.body),
    [{ bot: "main", symbol: "AAPL", trades: [1, 2] }],
  );
  assert.deepEqual(view.meta, spec.meta);

  // A part already finished is not run again.
  assert.equal(await runPart(jobs, { job: id, index: 0 }, echo), "skipped");

  assert.equal(
    await runPart(jobs, { job: id, index: 2 }, echo, () => 3000),
    "failed",
  );
  assert.equal(
    await runPart(jobs, { job: id, index: 1 }, echo, () => 4000),
    "done",
  );
  view = (await jobs.view(id))!;
  assert.equal(view.status, "done");
  assert.equal(view.done, 3);
  assert.equal(view.lastDoneAt, 4000);
  assert.deepEqual(view.errors, [
    {
      index: 2,
      symbol: "NVDA",
      from: "2026-01-02",
      to: "2026-03-31",
      error: "Alpaca said no",
    },
  ]);

  // Polling with since: only the parts finished since then.
  const fresh = (await jobs.view(id, 3500))!;
  assert.deepEqual(
    fresh.results.map((r) => r.index),
    [1],
  );
  assert.equal(fresh.done, 3);
});

test("a stopped run starts no new part and keeps what finished", async () => {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const id = await jobs.create(parseJobSpec(spec), "", 1000);
  await runPart(jobs, { job: id, index: 0 }, echo);
  await jobs.stop(id, 5000);
  assert.equal(await runPart(jobs, { job: id, index: 1 }, echo), "skipped");
  const view = (await jobs.view(id))!;
  assert.equal(view.status, "stopped");
  assert.deepEqual(view.stopped, { done: 1, total: 3 });
  assert.equal(view.results.length, 1);
});

test("a part held by another worker is skipped until its claim is stale", async () => {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const id = await jobs.create(parseJobSpec(spec), "", 1000);
  const task: PartTask = { job: id, index: 0 };
  assert.ok(await jobs.claim(task, 10_000)); // a worker took it and died
  assert.equal(await runPart(jobs, task, echo, () => 11_000), "skipped");
  assert.deepEqual(await jobs.stalled(11_000), []);
  const later = 10_000 + staleClaimMs + 1;
  assert.deepEqual(await jobs.stalled(later), [task]);
  assert.equal(await runPart(jobs, task, echo, () => later), "done");
});

test("runs are their starter's; latest finds the starter's last run", async () => {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const started: PartTask[] = [];
  const call = (
    owner: string,
    method: string,
    path: string,
    body?: unknown,
    query = {},
  ) =>
    handleBacktestJobs({
      method,
      path,
      query,
      body,
      owner,
      jobs,
      start: async (tasks) => void started.push(...tasks),
    });
  const created = await call("me@x", "POST", "/api/backtest-jobs", spec);
  assert.equal(created.status, 201);
  const { id, total } = created.body as { id: string; total: number };
  assert.equal(total, 3);
  assert.equal(started.length, 3);

  assert.equal(
    (await call("me@x", "GET", `/api/backtest-jobs/${id}`)).status,
    200,
  );
  assert.equal(
    (await call("other@x", "GET", `/api/backtest-jobs/${id}`)).status,
    404,
  );
  assert.equal(
    (await call("other@x", "POST", `/api/backtest-jobs/${id}/stop`)).status,
    404,
  );

  const latest = await call(
    "me@x",
    "GET",
    "/api/backtest-jobs/latest",
    undefined,
    { bot: "main" },
  );
  assert.equal((latest.body as JobView).id, id);
  assert.equal(
    (
      await call("me@x", "GET", "/api/backtest-jobs/latest", undefined, {
        bot: "volume",
      })
    ).status,
    404,
  );

  const stopped = await call("me@x", "POST", `/api/backtest-jobs/${id}/stop`);
  assert.equal((stopped.body as JobView).status, "stopped");
  assert.equal(
    (await call("me@x", "POST", "/api/backtest-jobs", { bot: "main" })).status,
    400,
  );
  const listed = await call("me@x", "GET", "/api/backtest-jobs", undefined, {
    bot: "main",
  });
  assert.deepEqual(
    (listed.body as { runs: { id: string }[] }).runs.map((r) => r.id),
    [id],
  );
  const theirs = await call("other@x", "GET", "/api/backtest-jobs", undefined, {
    bot: "main",
  });
  assert.deepEqual((theirs.body as { runs: unknown[] }).runs, []);
  assert.equal(
    (await call("me@x", "GET", "/api/backtest-jobs", undefined, { bot: "x" }))
      .status,
    400,
  );
  assert.equal((await call("me@x", "PUT", "/api/backtest-jobs")).status, 405);
});

test("runParts runs every part, a few at a time", async () => {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const id = await jobs.create(parseJobSpec(spec), "", 1000);
  await runParts(jobs, await jobs.pending(id), echo, 2);
  const view = (await jobs.view(id))!;
  assert.equal(view.status, "done");
  assert.equal(view.results.length, 2);
  assert.equal(view.errors.length, 1);
});

test("the Worker puts a run's parts on the queue and its consumer runs them", async () => {
  const sent: { body: PartTask }[] = [];
  const env = {
    BARS_CACHE: new SqliteD1(":memory:"),
    BACKTEST_QUEUE: {
      sendBatch: async (m: { body: PartTask }[]) => void sent.push(...m),
    },
  };
  const created = await worker.fetch(
    new Request("https://app.test/api/backtest-jobs", {
      method: "POST",
      body: JSON.stringify(spec),
    }),
    env,
  );
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  assert.deepEqual(
    sent.map((m) => m.body.index),
    [0, 1, 2],
  );

  // No Alpaca keys here: each part fails as /api/bot-backtest would (503).
  let acked = 0;
  await worker.queue(
    { messages: sent.map((m) => ({ body: m.body, ack: () => void acked++ })) },
    env,
  );
  assert.equal(acked, 3);
  const read = await worker.fetch(
    new Request(`https://app.test/api/backtest-jobs/${id}`),
    env,
  );
  const view = (await read.json()) as JobView;
  assert.equal(view.status, "done");
  assert.equal(view.errors.length, 3);
  assert.match(view.errors[0]!.error, /credentials/);
});

test("the latest 10 runs of each bot are kept; a running one is never removed", async () => {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const first = await jobs.create(parseJobSpec(spec), "me@x", 1000); // stays running
  const ids: string[] = [];
  for (let n = 1; n <= keptRuns + 2; n++) {
    const id = await jobs.create(parseJobSpec(spec), "me@x", 1000 + n);
    await jobs.stop(id, 1000 + n);
    ids.push(id);
  }
  // Another bot's and another person's runs are counted on their own.
  const volume = await jobs.create(
    parseJobSpec({ ...spec, bot: "volume" }),
    "me@x",
    5000,
  );
  const list = await jobs.list("me@x", "main");
  assert.equal(list.length, keptRuns);
  assert.deepEqual(
    list.map((r) => r.id),
    ids.slice(-keptRuns).reverse(),
    "newest first",
  );
  assert.equal(list[0]!.status, "stopped");
  assert.deepEqual(list[0]!.meta, spec.meta);
  assert.ok(await jobs.view(first), "the running run is kept");
  assert.equal(
    await jobs.view(ids[0]!),
    undefined,
    "the oldest finished run is gone",
  );
  assert.equal((await jobs.list("me@x", "volume"))[0]!.id, volume);
});

test("a run's summary counts its finished and failed parts", async () => {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const id = await jobs.create(parseJobSpec(spec), "", 1000);
  await runPart(jobs, { job: id, index: 0 }, echo);
  await runPart(jobs, { job: id, index: 2 }, echo); // NVDA fails
  const [summary] = await jobs.list("", "main");
  assert.deepEqual(
    {
      status: summary!.status,
      total: summary!.total,
      done: summary!.done,
      failed: summary!.failed,
    },
    { status: "running", total: 3, done: 2, failed: 1 },
  );
});
