import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import worker from "../apps/api/src/worker.js";
import {
  BacktestJobs,
  handleBacktestJobs,
  runsPage,
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

test("every run is kept and listed a page at a time, newest first", async () => {
  // The user, 2026-11-05: "show me pagination of all my runs" (only the
  // latest 10 were kept before).
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const ids: string[] = [];
  for (let n = 1; n <= runsPage + 5; n++) {
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
  await jobs.create(parseJobSpec(spec), "other@x", 6000);
  const newest = [...ids].reverse();
  const call = (query: Record<string, unknown>) =>
    handleBacktestJobs({
      method: "GET",
      path: "/api/backtest-jobs",
      query: { bot: "main", ...query },
      body: undefined,
      owner: "me@x",
      jobs,
      start: async () => {},
    });
  type Page = {
    runs: { id: string }[];
    total: number;
    offset: number;
    limit: number;
  };
  const first = (await call({})).body as Page;
  assert.deepEqual(
    {
      ids: first.runs.map((r) => r.id),
      total: first.total,
      offset: first.offset,
      limit: first.limit,
    },
    {
      ids: newest.slice(0, runsPage),
      total: runsPage + 5,
      offset: 0,
      limit: runsPage,
    },
  );
  const second = (await call({ offset: String(runsPage) })).body as Page;
  assert.deepEqual(
    second.runs.map((r) => r.id),
    newest.slice(runsPage),
    "the older runs, none removed",
  );
  assert.ok(await jobs.view(ids[0]!), "the oldest run is still there");
  const small = (await call({ offset: "2", limit: "3" })).body as Page;
  assert.deepEqual(
    small.runs.map((r) => r.id),
    newest.slice(2, 5),
  );
  // Nonsense paging falls back to the first page, and a page is at most 50.
  const odd = (await call({ offset: "-4", limit: "500" })).body as Page;
  assert.equal(odd.offset, 0);
  assert.equal(odd.limit, 50);
  assert.equal((await jobs.list("me@x", "volume"))[0]!.id, volume);
  assert.equal(await jobs.count("me@x", "volume"), 1);
});

test("a run's result in short is kept and comes back in the list", async () => {
  const jobs = new BacktestJobs(new SqliteD1(":memory:"));
  const id = await jobs.create(parseJobSpec(spec), "me@x", 1000);
  const call = (owner: string, body: unknown) =>
    handleBacktestJobs({
      method: "POST",
      path: `/api/backtest-jobs/${id}/summary`,
      query: {},
      body,
      owner,
      jobs,
      start: async () => {},
    });
  assert.equal((await jobs.list("me@x", "main"))[0]!.summary, null);
  const summary = { v: 1, returnPct: 12.5, trades: 40 };
  assert.equal((await call("me@x", { summary })).status, 200);
  assert.deepEqual((await jobs.list("me@x", "main"))[0]!.summary, summary);
  // Only its owner keeps one, and only a small object.
  assert.equal((await call("other@x", { summary })).status, 404);
  assert.equal((await call("me@x", { summary: [1] })).status, 400);
  assert.equal(
    (await call("me@x", { summary: { x: "a".repeat(3000) } })).status,
    400,
  );
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

test("a failed table setup is tried again, not kept: the next request reads the runs", async () => {
  // The store is kept across a Worker's requests; it once kept the setup's
  // promise, so one failed or lost setup hung or failed every later request.
  class FlakyD1 extends SqliteD1 {
    failNext = true;
    override async batch(statements: Parameters<SqliteD1["batch"]>[0]) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("D1 overloaded");
      }
      return super.batch(statements);
    }
  }
  const jobs = new BacktestJobs(new FlakyD1(":memory:"));
  await assert.rejects(jobs.list("me@example.com", "main"), /overloaded/);
  assert.deepEqual(await jobs.list("me@example.com", "main"), []);
});
