// Backtest runs kept and run on the server (the user, 2026-11-04: on the phone,
// leaving the Backtest page cancelled the run; "but I do want to see progress
// and trades during the run"). The page used to send every part of a run (a
// stock and a part of the period) itself, so a phone that put the page to
// sleep stopped the run. Now the page hands the whole run over once; the
// server runs its parts on its own (a Cloudflare Queue on the site, in-process
// locally) and keeps each part's result as it finishes. The page polls the
// job with `since` and gets the progress and the new parts' trades while the
// run goes on, and the whole job when it comes back.
//
// Tables (D1, a local SQLite file standing in for it):
//   backtest_jobs        one row a run: who, which bot, its setup, its state
//   backtest_job_parts   one row a part: its request, state, error, times
//   backtest_job_results each finished part's response (gzipped, D1Blobs)
//   backtest_job_summaries a finished run's result in short, as the page
//                        worked it out, for its History row
import type { D1Like } from "./bar-cache.js";
import { D1Blobs } from "./result-cache.js";

export type JobBot = "main" | "volume";
export const jobBots: readonly JobBot[] = ["main", "volume"];

/** One part of a run: a stock and a part of the period. */
export interface JobPartInput {
  symbol: string;
  from: string;
  to: string;
}

export interface JobSpec {
  bot: JobBot;
  parts: JobPartInput[];
  // Sent with every part ({ rules, fillPct } or { settings, fillPct }).
  body: Record<string, unknown>;
  // The page's own record of the run (the stocks, period, version label),
  // returned as is so a reload can show what was run.
  meta: unknown;
}

export type JobStatus = "running" | "done" | "stopped";
export type PartState = "pending" | "done" | "failed";

export interface JobResult {
  index: number;
  doneAt: number;
  body: unknown;
}
export interface JobError extends JobPartInput {
  index: number;
  error: string;
}

/** One run in the list of the latest runs (GET /api/backtest-jobs). */
export interface JobSummary {
  id: string;
  bot: JobBot;
  status: JobStatus;
  total: number;
  done: number; // parts finished, failed ones included
  failed: number;
  createdAt: number;
  updatedAt: number;
  meta: unknown;
  // The result in short, saved by the page once it read the run (null before).
  summary: unknown;
}

/** What GET /api/backtest-jobs/:id returns. */
export interface JobView {
  id: string;
  bot: JobBot;
  status: JobStatus;
  total: number;
  done: number; // parts finished, failed ones included
  createdAt: number;
  updatedAt: number;
  lastDoneAt: number | null;
  meta: unknown;
  // Finished parts' responses with doneAt >= since (all with since 0), in
  // part order; the page adds them to what it has, by index.
  results: JobResult[];
  errors: JobError[]; // every failed part
  // Set when stopped: the parts finished by then.
  stopped: { done: number; total: number } | null;
}

export const maxJobParts = 1000;
const maxMetaChars = 64_000;
const maxBodyChars = 64_000;
const maxSummaryChars = 2_000;
// A part claimed this long ago and not finished is taken to be lost (its
// worker died) and is sent again; a queue consumer may run 15 minutes.
export const staleClaimMs = 16 * 60_000;
// Every run is kept (the user, 2026-11-05: "show me pagination of all my
// runs"; before, only the latest 10 were). The list is read a page at a time.
export const runsPage = 10;
export const maxRunsPage = 50;

export class JobInputError extends Error {}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const symbolPattern = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** The run asked for, checked; throws JobInputError. */
export function parseJobSpec(input: unknown): JobSpec {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new JobInputError("Expected a JSON object");
  const o = input as Record<string, unknown>;
  if (!jobBots.includes(o.bot as JobBot))
    throw new JobInputError(`bot must be one of ${jobBots.join(", ")}`);
  if (!Array.isArray(o.parts) || o.parts.length === 0)
    throw new JobInputError("parts must be a non-empty list");
  if (o.parts.length > maxJobParts)
    throw new JobInputError(`At most ${maxJobParts} parts a run`);
  const parts = o.parts.map((p, i): JobPartInput => {
    const part = (p ?? {}) as Record<string, unknown>;
    const symbol =
      typeof part.symbol === "string" ? part.symbol.trim().toUpperCase() : "";
    if (!symbolPattern.test(symbol))
      throw new JobInputError(`parts[${i}].symbol is not a symbol`);
    for (const k of ["from", "to"] as const)
      if (typeof part[k] !== "string" || !datePattern.test(part[k]))
        throw new JobInputError(`parts[${i}].${k} must be YYYY-MM-DD`);
    return { symbol, from: part.from as string, to: part.to as string };
  });
  const body = o.body ?? {};
  if (typeof body !== "object" || Array.isArray(body))
    throw new JobInputError("body must be an object");
  if (JSON.stringify(body).length > maxBodyChars)
    throw new JobInputError("body is too large");
  for (const k of ["symbol", "from", "to"])
    if (k in body) throw new JobInputError(`body may not set ${k}`);
  const meta = o.meta ?? null;
  if (JSON.stringify(meta).length > maxMetaChars)
    throw new JobInputError("meta is too large");
  return {
    bot: o.bot as JobBot,
    parts,
    body: body as Record<string, unknown>,
    meta,
  };
}

interface JobRow {
  id: string;
  owner: string;
  bot: JobBot;
  status: JobStatus;
  total: number;
  body: string;
  meta: string;
  created_at: number;
  updated_at: number;
  stopped_done: number | null;
}
interface PartRow {
  idx: number;
  symbol: string;
  from_date: string;
  to_date: string;
  state: PartState;
  error: string | null;
  done_at: number | null;
}

/** A part to run: its job, index and the request body for its bot. */
export interface PartTask {
  job: string;
  index: number;
}

/** The runs, in D1. */
export class BacktestJobs {
  // True once the table exists. Never the promise itself: on Workers a D1
  // call started by one request hangs forever when another awaits it.
  private ready = false;
  readonly results: D1Blobs;
  constructor(private readonly db: D1Like) {
    this.results = new D1Blobs(db, "backtest_job_results", ["job"]);
  }

  private async init() {
    if (this.ready) return;
    await this.db.batch([
      this.db.prepare(
        "CREATE TABLE IF NOT EXISTS backtest_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, " +
          "bot TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL, body TEXT NOT NULL, " +
          "meta TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
          "stopped_done INTEGER)",
      ),
      this.db.prepare(
        "CREATE INDEX IF NOT EXISTS backtest_jobs_owner ON backtest_jobs (owner, bot, created_at)",
      ),
      this.db.prepare(
        "CREATE TABLE IF NOT EXISTS backtest_job_parts (job_id TEXT NOT NULL, idx INTEGER NOT NULL, " +
          "symbol TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, " +
          "state TEXT NOT NULL, error TEXT, claimed_at INTEGER, done_at INTEGER, " +
          "PRIMARY KEY (job_id, idx))",
      ),
      this.db.prepare(
        "CREATE TABLE IF NOT EXISTS backtest_job_summaries (job TEXT PRIMARY KEY, " +
          "summary TEXT NOT NULL, stored_at INTEGER NOT NULL)",
      ),
    ]);
    this.ready = true;
  }

  /** Stores a new run; returns its id. */
  async create(
    spec: JobSpec,
    owner: string,
    now = Date.now(),
  ): Promise<string> {
    await this.init();
    const id = crypto.randomUUID();
    const statements = [
      this.db
        .prepare(
          "INSERT INTO backtest_jobs (id, owner, bot, status, total, body, meta, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          owner,
          spec.bot,
          spec.parts.length,
          JSON.stringify(spec.body),
          JSON.stringify(spec.meta),
          now,
          now,
        ),
      ...spec.parts.map((p, i) =>
        this.db
          .prepare(
            "INSERT INTO backtest_job_parts (job_id, idx, symbol, from_date, to_date, state) " +
              "VALUES (?, ?, ?, ?, ?, 'pending')",
          )
          .bind(id, i, p.symbol, p.from, p.to),
      ),
    ];
    // A run of many parts goes in batches of 100 statements.
    for (let i = 0; i < statements.length; i += 100)
      await this.db.batch(statements.slice(i, i + 100));
    return id;
  }

  private async row(id: string): Promise<JobRow | undefined> {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT * FROM backtest_jobs WHERE id = ?")
      .bind(id)
      .all<JobRow>();
    return results[0];
  }

  /** The owner of a run, or undefined when there is no such run. */
  async owner(id: string) {
    return (await this.row(id))?.owner;
  }

  /** The run with the parts finished since `since` (ms). */
  async view(id: string, since = 0): Promise<JobView | undefined> {
    const job = await this.row(id);
    if (!job) return undefined;
    const { results: parts } = await this.db
      .prepare(
        "SELECT idx, symbol, from_date, to_date, state, error, done_at FROM backtest_job_parts " +
          "WHERE job_id = ? ORDER BY idx",
      )
      .bind(id)
      .all<PartRow>();
    const finished = parts.filter((p) => p.state !== "pending");
    const fresh = finished.filter(
      (p) => p.state === "done" && Number(p.done_at) >= since,
    );
    const texts = await this.results.get(
      fresh.map((p) => resultKey(id, p.idx)),
    );
    const results: JobResult[] = [];
    for (const p of fresh) {
      const text = texts.get(resultKey(id, p.idx));
      if (text !== undefined)
        results.push({
          index: Number(p.idx),
          doneAt: Number(p.done_at),
          body: JSON.parse(text),
        });
    }
    const doneTimes = finished.map((p) => Number(p.done_at));
    return {
      id,
      bot: job.bot,
      status: job.status,
      total: Number(job.total),
      done: finished.length,
      createdAt: Number(job.created_at),
      updatedAt: Number(job.updated_at),
      lastDoneAt: doneTimes.length ? Math.max(...doneTimes) : null,
      meta: JSON.parse(job.meta),
      results,
      errors: parts
        .filter((p) => p.state === "failed")
        .map((p) => ({
          index: Number(p.idx),
          symbol: p.symbol,
          from: p.from_date,
          to: p.to_date,
          error: p.error ?? "failed",
        })),
      stopped:
        job.status === "stopped"
          ? { done: Number(job.stopped_done ?? 0), total: Number(job.total) }
          : null,
    };
  }

  /** A page of the person's runs of a bot, newest first. */
  async list(
    owner: string,
    bot: JobBot,
    offset = 0,
    limit = runsPage,
  ): Promise<JobSummary[]> {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT j.id, j.bot, j.status, j.total, j.meta, j.created_at, j.updated_at, s.summary, " +
          "(SELECT COUNT(*) FROM backtest_job_parts p WHERE p.job_id = j.id AND p.state != 'pending') AS done, " +
          "(SELECT COUNT(*) FROM backtest_job_parts p WHERE p.job_id = j.id AND p.state = 'failed') AS failed " +
          "FROM backtest_jobs j LEFT JOIN backtest_job_summaries s ON s.job = j.id " +
          "WHERE j.owner = ? AND j.bot = ? ORDER BY j.created_at DESC LIMIT ? OFFSET ?",
      )
      .bind(owner, bot, limit, offset)
      .all<{
        id: string;
        bot: JobBot;
        status: JobStatus;
        total: number;
        meta: string;
        created_at: number;
        updated_at: number;
        summary: string | null;
        done: number;
        failed: number;
      }>();
    return results.map((r) => ({
      id: r.id,
      bot: r.bot,
      status: r.status,
      total: Number(r.total),
      done: Number(r.done),
      failed: Number(r.failed),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      meta: JSON.parse(r.meta),
      summary: r.summary ? JSON.parse(r.summary) : null,
    }));
  }

  /** Keeps a run's result in short (the page works it out from the run). */
  async saveSummary(id: string, summary: unknown, now = Date.now()) {
    await this.init();
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO backtest_job_summaries (job, summary, stored_at) VALUES (?, ?, ?)",
      )
      .bind(id, JSON.stringify(summary), now)
      .run();
  }

  /** How many runs of a bot the person has. */
  async count(owner: string, bot: JobBot): Promise<number> {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM backtest_jobs WHERE owner = ? AND bot = ?",
      )
      .bind(owner, bot)
      .all<{ n: number }>();
    return Number(results[0]?.n ?? 0);
  }

  /** The owner's latest run of a bot, if any. */
  async latest(owner: string, bot: JobBot): Promise<string | undefined> {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT id FROM backtest_jobs WHERE owner = ? AND bot = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(owner, bot)
      .all<{ id: string }>();
    return results[0]?.id;
  }

  /** Stops a running run: no new part starts; finished parts stay. */
  async stop(id: string, now = Date.now()) {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM backtest_job_parts WHERE job_id = ? AND state != 'pending'",
      )
      .bind(id)
      .all<{ n: number }>();
    await this.db
      .prepare(
        "UPDATE backtest_jobs SET status = 'stopped', stopped_done = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'running'",
      )
      .bind(Number(results[0]?.n ?? 0), now, id)
      .run();
  }

  /** Every pending part of a run (to send to the runner). */
  async pending(id: string): Promise<PartTask[]> {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT idx FROM backtest_job_parts WHERE job_id = ? AND state = 'pending' ORDER BY idx",
      )
      .bind(id)
      .all<{ idx: number }>();
    return results.map((r) => ({ job: id, index: Number(r.idx) }));
  }

  /** Pending parts of running runs whose worker was lost (claimed long ago). */
  async stalled(now = Date.now(), limit = 50): Promise<PartTask[]> {
    await this.init();
    const { results } = await this.db
      .prepare(
        "SELECT p.job_id, p.idx FROM backtest_job_parts p JOIN backtest_jobs j ON j.id = p.job_id " +
          "WHERE j.status = 'running' AND p.state = 'pending' AND p.claimed_at IS NOT NULL " +
          "AND p.claimed_at < ? ORDER BY j.created_at, p.idx LIMIT ?",
      )
      .bind(now - staleClaimMs, limit)
      .all<{ job_id: string; idx: number }>();
    return results.map((r) => ({ job: r.job_id, index: Number(r.idx) }));
  }

  /**
   * Takes a part to run: its bot and request, or null when it is not to be
   * run (finished, its run stopped, or another worker has it).
   */
  async claim(
    task: PartTask,
    now = Date.now(),
  ): Promise<{ bot: JobBot; request: Record<string, unknown> } | null> {
    const job = await this.row(task.job);
    if (!job || job.status !== "running") return null;
    const { results } = await this.db
      .prepare(
        "UPDATE backtest_job_parts SET claimed_at = ? WHERE job_id = ? AND idx = ? " +
          "AND state = 'pending' AND (claimed_at IS NULL OR claimed_at < ?) " +
          "RETURNING symbol, from_date, to_date",
      )
      .bind(now, task.job, task.index, now - staleClaimMs)
      .all<{ symbol: string; from_date: string; to_date: string }>();
    const part = results[0];
    if (!part) return null;
    return {
      bot: job.bot,
      request: {
        ...(JSON.parse(job.body) as Record<string, unknown>),
        symbol: part.symbol,
        from: part.from_date,
        to: part.to_date,
      },
    };
  }

  /** Keeps a part's outcome; the run is done when no part is pending. */
  async finish(
    task: PartTask,
    outcome: { body: unknown } | { error: string },
    now = Date.now(),
  ) {
    await this.init();
    if ("body" in outcome)
      await this.results.put([
        {
          key: resultKey(task.job, task.index),
          meta: { job: task.job },
          text: JSON.stringify(outcome.body),
        },
      ]);
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE backtest_job_parts SET state = ?, error = ?, done_at = ? " +
            "WHERE job_id = ? AND idx = ? AND state = 'pending'",
        )
        .bind(
          "body" in outcome ? "done" : "failed",
          "error" in outcome ? outcome.error.slice(0, 500) : null,
          now,
          task.job,
          task.index,
        ),
      this.db
        .prepare(
          "UPDATE backtest_jobs SET updated_at = ?, status = CASE WHEN status = 'running' AND " +
            "NOT EXISTS (SELECT 1 FROM backtest_job_parts WHERE job_id = ? AND state = 'pending') " +
            "THEN 'done' ELSE status END WHERE id = ?",
        )
        .bind(now, task.job, task.job),
    ]);
  }
}

const resultKey = (job: string, index: number) => `${job}/${index}`;

/** Computes one part: the bot's backtest endpoint's handler. */
export type PartCompute = (
  bot: JobBot,
  request: Record<string, unknown>,
) => Promise<{ status: number; body: unknown }>;

/**
 * Runs one part if it is still to be run and keeps its outcome. Never throws:
 * a failure is the part's error, as the page showed it before.
 */
export async function runPart(
  jobs: BacktestJobs,
  task: PartTask,
  compute: PartCompute,
  now: () => number = Date.now,
): Promise<"done" | "failed" | "skipped"> {
  const claimed = await jobs.claim(task, now());
  if (!claimed) return "skipped";
  let outcome: { body: unknown } | { error: string };
  try {
    const result = await compute(claimed.bot, claimed.request);
    const body = result.body as { error?: unknown } | null;
    outcome =
      result.status >= 200 && result.status < 300
        ? { body: result.body }
        : {
            error:
              body && typeof body.error === "string"
                ? body.error
                : `HTTP ${result.status}`,
          };
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }
  await jobs.finish(task, outcome, now());
  return "body" in outcome ? "done" : "failed";
}

/** Runs tasks `width` at a time (the local API and a Worker without a queue). */
export async function runParts(
  jobs: BacktestJobs,
  tasks: PartTask[],
  compute: PartCompute,
  width = 4,
) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await runPart(jobs, tasks[next++]!, compute);
  };
  await Promise.all(Array.from({ length: width }, worker));
}

/**
 * The /api/backtest-jobs routes. `start` hands a new run's parts to the
 * runner (a queue, or in-process) and must not wait for them.
 *
 *   POST /api/backtest-jobs                 { bot, parts, body, meta } → 201 { id, total }
 *   GET  /api/backtest-jobs?bot=main&offset=0&limit=10
 *                                           a page of the caller's runs, newest first
 *                                           → { runs: JobSummary[], total, offset, limit }
 *   GET  /api/backtest-jobs/latest?bot=main the caller's latest run → JobView (404: none)
 *   GET  /api/backtest-jobs/:id?since=ms    JobView with parts finished since then
 *   POST /api/backtest-jobs/:id/stop        → JobView
 *   POST /api/backtest-jobs/:id/summary     { summary } → { saved }, the run's result in short
 */
export async function handleBacktestJobs(o: {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  owner: string; // the signed-in email, "" without sign-in
  jobs: BacktestJobs | undefined;
  start: (tasks: PartTask[]) => Promise<void>;
  now?: number;
}): Promise<{ status: number; body: unknown }> {
  const now = o.now ?? Date.now();
  if (!o.jobs)
    return { status: 503, body: { error: "The run store is not configured" } };
  const jobs = o.jobs;
  const rest = o.path.replace(/^\/api\/backtest-jobs\/?/, "").split("/");
  const [first = "", second] = rest;
  const allow = (allowed: string) =>
    ({
      status: 405,
      body: { error: `Method not allowed (${allowed})` },
    }) as const;

  const botOf = (): JobBot | null => {
    const bot = (o.query.bot ?? "main") as JobBot;
    return jobBots.includes(bot) ? bot : null;
  };
  const badBot = {
    status: 400,
    body: { error: `bot must be one of ${jobBots.join(", ")}` },
  } as const;

  if (first === "" && o.method === "GET") {
    const bot = botOf();
    if (!bot) return badBot;
    const offset = countOf(o.query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = countOf(o.query.limit, 1, maxRunsPage, runsPage);
    const runs = await jobs.list(o.owner, bot, offset, limit);
    const total = await jobs.count(o.owner, bot);
    return { status: 200, body: { runs, total, offset, limit } };
  }
  if (first === "") {
    if (o.method !== "POST") return allow("GET, POST");
    let spec: JobSpec;
    try {
      spec = parseJobSpec(o.body);
    } catch (error) {
      if (error instanceof JobInputError)
        return { status: 400, body: { error: error.message } };
      throw error;
    }
    const id = await jobs.create(spec, o.owner, now);
    await o.start(await jobs.pending(id));
    return { status: 201, body: { id, total: spec.parts.length } };
  }
  if (first === "latest" && second === undefined) {
    if (o.method !== "GET") return allow("GET");
    const bot = botOf();
    if (!bot) return badBot;
    const id = await jobs.latest(o.owner, bot);
    const view = id && (await jobs.view(id, sinceOf(o.query)));
    return view
      ? { status: 200, body: view }
      : { status: 404, body: { error: "No run yet" } };
  }
  // A run is its starter's: another viewer neither sees nor stops it.
  if ((await jobs.owner(first)) !== o.owner)
    return { status: 404, body: { error: "No such run" } };
  if (second === undefined) {
    if (o.method !== "GET") return allow("GET");
    const view = await jobs.view(first, sinceOf(o.query));
    return { status: 200, body: view };
  }
  if (second === "summary" && rest.length === 2) {
    if (o.method !== "POST") return allow("POST");
    const summary = (o.body as { summary?: unknown } | null)?.summary;
    const text = JSON.stringify(summary ?? null);
    const isObject =
      typeof summary === "object" &&
      summary !== null &&
      !Array.isArray(summary);
    if (!isObject || text.length > maxSummaryChars)
      return {
        status: 400,
        body: {
          error: `summary must be an object under ${maxSummaryChars} characters`,
        },
      };
    await jobs.saveSummary(first, summary, now);
    return { status: 200, body: { saved: true } };
  }
  if (second === "stop" && rest.length === 2) {
    if (o.method !== "POST") return allow("POST");
    await jobs.stop(first, now);
    return { status: 200, body: await jobs.view(first) };
  }
  return { status: 404, body: { error: "Not found" } };
}

function sinceOf(query: Record<string, unknown>) {
  const n = Number(query.since ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A whole number from the query, within min..max; the fallback otherwise. */
function countOf(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
