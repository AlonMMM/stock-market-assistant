// The end-of-day review's steps on the server (day-review.ts holds the
// comparison): start a bot's review of a session (its recorded books into
// D1, then the app's backtest of the day on the job queue), compare once the
// run is done, and the HTTP routes the Analyse page and the connector use.
import type { AccountResult } from "../../trading/src/bot/backtest-account.js";
import { runAccount } from "../../trading/src/bot/backtest-account.js";
import type { SimSkip, SimTrade } from "../../trading/src/bot/backtest.js";
import {
  volumeAccount,
  type VolumeStockRun,
} from "../../trading/src/strangle/backtest.js";
import type { BacktestJobs, JobSpec, PartTask } from "./backtest-jobs.js";
import { parseJobSpec } from "./backtest-jobs.js";
import {
  compareMain,
  compareVolume,
  isReviewDay,
  mainJob,
  minuteBooks,
  parseAnalysis,
  recordedSource,
  reviewBots,
  reviewOwner,
  volumeJob,
  type D1DayReviews,
  type DayReview,
  type LivePosition,
  type MainDay,
  type ReviewBot,
  type VolumeDay,
} from "./day-review.js";
import type { VolumeDataStore } from "./volume-data.js";

export interface ReviewDeps {
  reviews: D1DayReviews;
  jobs: BacktestJobs;
  start: (tasks: PartTask[]) => Promise<void>;
  trader: { url?: string; token?: string };
  quotes: {
    put(
      contract: string,
      date: string,
      source: string,
      quotes: [number, number, number][],
      now: number,
    ): Promise<void>;
  };
  volume: VolumeDataStore;
  now: () => number;
  fetcher?: typeof fetch;
}

async function traderGet<T>(d: ReviewDeps, path: string): Promise<T> {
  if (!d.trader.url || !d.trader.token)
    throw new Error("The trading service is not configured");
  const response = await (d.fetcher ?? fetch).call(
    globalThis,
    new URL(path, d.trader.url),
    {
      headers: { Authorization: `Bearer ${d.trader.token}` },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(
      `The trading service answered ${response.status} for ${path}`,
    );
  return (await response.json()) as T;
}

const liveMain = (d: ReviewDeps, date: string) =>
  traderGet<MainDay>(d, `/v1/bot/day?day=${date}`);
const liveVolume = (d: ReviewDeps, date: string) =>
  traderGet<VolumeDay>(d, `/v1/strangle/day?day=${date}`);

interface Tick {
  at: number;
  contract: string | null;
  bid: number | null;
  ask: number | null;
}

/** Each contract's samples: the books a bot recorded that day. */
type Samples = Map<
  string,
  { at: number; bid: number | null; ask: number | null }[]
>;

function addSample(
  into: Samples,
  contract: string | null | undefined,
  s: { at: number; bid: number | null; ask: number | null } | undefined,
) {
  if (!contract || !s || typeof s.at !== "number") return;
  let list = into.get(contract);
  if (!list) into.set(contract, (list = []));
  list.push(s);
}

/** A held Main bot position's books: its buy, every second held, its sales. */
async function mainSamples(
  d: ReviewDeps,
  positions: LivePosition[],
): Promise<Samples> {
  const out: Samples = new Map();
  for (const p of positions) {
    addSample(
      out,
      p.contract,
      p.entryBook && { ...p.entryBook, at: p.entryBook.at ?? p.openedAt },
    );
    addSample(
      out,
      p.contract,
      p.entryFillBook && {
        ...p.entryFillBook,
        at: p.entryFillBook.at ?? p.openedAt,
      },
    );
    for (const s of p.sales) {
      addSample(
        out,
        p.contract,
        s.book && { ...s.book, at: s.book.at ?? s.at },
      );
      addSample(
        out,
        p.contract,
        s.fillBook && { ...s.fillBook, at: s.fillBook.at ?? s.at },
      );
    }
    await addTicks(d, out, p.id, p.contract);
  }
  return out;
}

/** Every second a bot held `ref` (price-recorder.ts); none when not recorded. */
async function addTicks(
  d: ReviewDeps,
  into: Samples,
  ref: string,
  contract: string,
) {
  const { ticks } = await traderGet<{ ticks: Tick[] }>(
    d,
    `/v1/records/ticks?ref=${encodeURIComponent(ref)}`,
  ).catch(() => ({ ticks: [] as Tick[] }));
  for (const t of ticks ?? []) addSample(into, t.contract ?? contract, t);
}

/**
 * The Volume bot's traded contracts, every second held, for its sales after
 * the alert windows. The alert windows themselves are already in D1: the
 * scheduled step at 16:20 New York keeps them (option_seconds), and the
 * backtest reads them there first.
 */
async function volumeSamples(
  d: ReviewDeps,
  date: string,
  live: VolumeDay,
): Promise<Samples> {
  const out: Samples = new Map();
  for (const t of live.trades)
    if (t.day === date && t.leg) await addTicks(d, out, t.id, t.leg.contract);
  return out;
}

/** The recorded books as minute books in D1 (source "recorded"); the count of contracts. */
async function keepBooks(d: ReviewDeps, date: string, samples: Samples) {
  let kept = 0;
  for (const [contract, list] of samples) {
    const rows = minuteBooks(date, list);
    if (!rows.length) continue;
    await d.quotes.put(contract, date, recordedSource, rows, d.now());
    kept++;
  }
  return kept;
}

/**
 * Starts a bot's review of a session: the day's recorded books, then the
 * backtest job. A review already running or compared is left as it is unless
 * `force` (a later day sold a trade held overnight, or the rules changed).
 */
export async function startReview(
  d: ReviewDeps,
  bot: ReviewBot,
  date: string,
  force: boolean,
): Promise<DayReview> {
  const now = d.now();
  const was = await d.reviews.get(bot, date);
  if (was && !force && was.status !== "failed") return was;
  let spec: JobSpec;
  let books: number;
  try {
    if (bot === "main") {
      const live = await liveMain(d, date);
      books = await keepBooks(
        d,
        date,
        await mainSamples(
          d,
          live.positions.filter((p) => p.day === date),
        ),
      );
      spec = parseJobSpec(mainJob(live, date).spec);
    } else {
      // The day's alerts and 1-second books come from our own D1, kept by
      // the scheduled step at 16:20 New York; never copied again here.
      if (!(await d.volume.daySynced(date)))
        throw new Error(
          "the Volume bot's data of the day is saved at 16:20 New York; start the review after it",
        );
      const live = await liveVolume(d, date);
      books = await keepBooks(d, date, await volumeSamples(d, date, live));
      spec = parseJobSpec(volumeJob(live, date).spec);
    }
  } catch (error) {
    const failed: DayReview = {
      bot,
      date,
      status: "failed",
      jobId: null,
      startedAt: now,
      updatedAt: now,
      error: error instanceof Error ? error.message : String(error),
      comparison: null,
      analysis: was?.analysis ?? null,
    };
    await d.reviews.put(failed);
    return failed;
  }
  const jobId = await d.jobs.create(spec, reviewOwner, now);
  await d.start(await d.jobs.pending(jobId));
  const review: DayReview = {
    bot,
    date,
    status: "running",
    jobId,
    startedAt: now,
    updatedAt: now,
    error: null,
    comparison: null,
    // A rerun keeps the old analysis until the skill writes a new one.
    analysis: was?.analysis ?? null,
  };
  await d.reviews.put(review);
  console.log(
    `day review: ${bot} ${date} started, ${spec.parts.length} stocks, ${books} contracts' recorded books`,
  );
  return review;
}

/** A running review once its job is done: compared and kept. */
export async function refreshReview(
  d: ReviewDeps,
  review: DayReview,
): Promise<DayReview> {
  if (review.status !== "running" || !review.jobId) return review;
  const view = await d.jobs.view(review.jobId);
  if (!view) {
    const lost = {
      ...review,
      status: "failed" as const,
      error: "The backtest run is gone",
      updatedAt: d.now(),
    };
    await d.reviews.put(lost);
    return lost;
  }
  if (view.status === "running") return review;
  try {
    const date = review.date;
    let comparison;
    if (review.bot === "main") {
      const live = await liveMain(d, date);
      const { money } = mainJob(live, date);
      const bodies = view.results.map(
        (r) => r.body as { trades: SimTrade[]; skips: SimSkip[] },
      );
      const account: AccountResult = runAccount(
        bodies.flatMap((b) => b.trades),
        money,
      );
      comparison = compareMain(
        live,
        account,
        bodies.flatMap((b) => b.skips),
        view.total,
      );
    } else {
      const live = await liveVolume(d, date);
      const { money } = volumeJob(live, date);
      const runs = view.results.map((r) => r.body as VolumeStockRun);
      comparison = compareVolume(
        live,
        volumeAccount(runs, money),
        runs.flatMap((r) => r.signals),
        view.total,
      );
    }
    if (view.errors.length)
      comparison.notes.push(
        `${view.errors.length} of ${view.total} stocks failed in the backtest: ${view.errors
          .slice(0, 10)
          .map((e) => `${e.symbol} (${e.error})`)
          .join(", ")}`,
      );
    if (view.status === "stopped")
      comparison.notes.push("The backtest run was stopped before the end.");
    const done: DayReview = {
      ...review,
      status: "compared",
      updatedAt: d.now(),
      error: null,
      comparison,
    };
    await d.reviews.put(done);
    return done;
  } catch (error) {
    const failed: DayReview = {
      ...review,
      status: "failed",
      updatedAt: d.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    await d.reviews.put(failed);
    return failed;
  }
}

/**
 * GET  /api/day-reviews?bot=main|volume[&limit=30]   the latest days
 * GET  /api/day-reviews/<bot>/<date>                 one day (compared when its run is done)
 * POST /api/day-reviews/<bot>/<date>/start {force?}  starts the day's review (owner)
 * PUT  /api/day-reviews/<bot>/<date>/analysis {verdict, headline, markdown}  (owner)
 */
export async function handleDayReviews(
  d: ReviewDeps,
  o: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const rest = o.path.replace(/^\/api\/day-reviews\/?/, "");
  const [botPart, date, action] = rest ? rest.split("/") : [];
  if (!rest) {
    if (o.method !== "GET")
      return { status: 405, body: { error: "Method not allowed (GET)" } };
    const bot = o.query.bot as ReviewBot;
    if (!reviewBots.includes(bot))
      return { status: 400, body: { error: "bot must be main or volume" } };
    const limit = Math.min(Math.max(Number(o.query.limit ?? 30) || 30, 1), 120);
    const list = await d.reviews.list(bot, limit);
    return {
      status: 200,
      body: {
        reviews: await Promise.all(list.map((r) => refreshReview(d, r))),
      },
    };
  }
  const bot = botPart as ReviewBot;
  if (!reviewBots.includes(bot))
    return { status: 400, body: { error: "bot must be main or volume" } };
  if (!date || !isReviewDay(date, d.now()))
    return {
      status: 400,
      body: { error: "date must be a session that has closed (YYYY-MM-DD)" },
    };
  if (!action) {
    if (o.method !== "GET")
      return { status: 405, body: { error: "Method not allowed (GET)" } };
    const review = await d.reviews.get(bot, date);
    if (!review)
      return { status: 404, body: { error: "No review of that day yet" } };
    return { status: 200, body: await refreshReview(d, review) };
  }
  if (action === "start") {
    if (o.method !== "POST")
      return { status: 405, body: { error: "Method not allowed (POST)" } };
    const force = (o.body as { force?: unknown } | null)?.force === true;
    return { status: 200, body: await startReview(d, bot, date, force) };
  }
  if (action === "analysis") {
    if (o.method !== "PUT")
      return { status: 405, body: { error: "Method not allowed (PUT)" } };
    const review = await d.reviews.get(bot, date);
    if (!review)
      return { status: 404, body: { error: "No review of that day yet" } };
    const current = await refreshReview(d, review);
    if (current.status !== "compared")
      return {
        status: 409,
        body: {
          error: `The review is ${current.status}; save the analysis once it is compared`,
        },
      };
    const analysis = parseAnalysis(
      (o.body as { analysis?: unknown } | null)?.analysis ?? o.body,
      d.now(),
    );
    if (typeof analysis === "string")
      return { status: 400, body: { error: analysis } };
    const saved = { ...current, analysis, updatedAt: d.now() };
    await d.reviews.put(saved);
    return { status: 200, body: saved };
  }
  return { status: 404, body: { error: "Not found" } };
}

/** Every review still running, for the scheduled step. */
export async function refreshRunning(d: ReviewDeps): Promise<string[]> {
  const out: string[] = [];
  for (const bot of reviewBots)
    for (const r of await d.reviews.list(bot, 5))
      if (r.status === "running") {
        const next = await refreshReview(d, r);
        if (next.status !== "running")
          out.push(`${bot} ${r.date} ${next.status}`);
      }
  return out;
}
