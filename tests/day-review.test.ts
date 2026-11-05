import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { newYorkToUtc } from "../packages/market-data/src/calendar.js";
import {
  BacktestJobs,
  runParts,
  type PartCompute,
} from "../packages/market-data/src/backtest-jobs.js";
import {
  compareMain,
  compareVolume,
  D1DayReviews,
  isReviewDay,
  mainJob,
  minuteBooks,
  parseAnalysis,
  reviewOwner,
  type MainDay,
  type VolumeDay,
} from "../packages/market-data/src/day-review.js";
import {
  handleDayReviews,
  type ReviewDeps,
} from "../packages/market-data/src/day-review-run.js";
import { mergeSources } from "../packages/market-data/src/option-quotes.js";
import { D1VolumeData } from "../packages/market-data/src/volume-data.js";
import { runAccount } from "../packages/trading/src/bot/backtest-account.js";
import type { SimTrade } from "../packages/trading/src/bot/backtest.js";
import {
  volumeAccount,
  type VolumeSignal,
} from "../packages/trading/src/strangle/backtest.js";
import {
  inlineSpans,
  markdownBlocks,
} from "../apps/web/src/day-review-model.js";

// Synthetic trades and books: no market data is read.
const day = "2026-11-04";
const at = (minute: number, second = 0) =>
  newYorkToUtc(day, 570 + minute) + second * 1000;

test("day review: recorded books become minute books, the newest of each minute, no look-ahead", () => {
  const rows = minuteBooks(day, [
    { at: at(10, 5), bid: 1.0, ask: 1.1 },
    { at: at(10, 50), bid: 1.2, ask: 1.3 },
    { at: at(11, 1), bid: 1.4, ask: 1.5 },
    { at: at(12, 0), bid: null, ask: 1.5 }, // no bid: left out
    { at: at(13, 0), bid: 2, ask: 1 }, // crossed: left out
    { at: at(-1, 0), bid: 1, ask: 2 }, // before the open
  ]);
  assert.deepEqual(rows, [
    [10, 1.2, 1.3],
    [11, 1.4, 1.5],
  ]);
});

test("day review: Databento wins a minute over the recorded book, the live one over both", () => {
  const merged = mergeSources([
    { source: "live", quotes: [[3, 0.9, 1.0]] },
    {
      source: "recorded",
      quotes: [
        [1, 0.1, 0.2],
        [2, 0.3, 0.4],
        [3, 0.5, 0.6],
      ],
    },
    {
      source: "databento",
      quotes: [
        [2, 0.31, 0.41],
        [3, 0.51, 0.61],
      ],
    },
  ]);
  assert.deepEqual(merged, [
    { m: 1, bid: 0.1, ask: 0.2 },
    { m: 2, bid: 0.31, ask: 0.41 },
    { m: 3, bid: 0.9, ask: 1.0 },
  ]);
});

test("day review: only a closed session can be reviewed", () => {
  assert.equal(isReviewDay(day, at(389)), false); // before the close
  assert.equal(isReviewDay(day, at(391)), true);
  assert.equal(isReviewDay("2026-11-07", Date.parse("2026-11-09")), false); // a Saturday
  assert.equal(isReviewDay("nope", Date.now()), false);
});

const book = (bid: number, ask: number, t: number) => ({ bid, ask, at: t });

function mainLive(): MainDay {
  return {
    day,
    version: "2.10",
    settings: { watched: [], off: ["TSLA"] } as never,
    watching: ["aapl", "NVDA", "TSLA", "AAPL"],
    signals: [
      {
        day,
        symbol: "AMD",
        right: "C",
        minute: 40,
        outcome: "risk",
        detail: "day loss",
      },
    ],
    positions: [
      {
        // Live bought at 1.00 paper (mid 0.98), sold at 1.50 paper (mid 1.40).
        id: "p1",
        day,
        symbol: "NVDA",
        contract: "NVDA261106C00200000",
        right: "C",
        qty: 0,
        bought: 10,
        cost: 1.0,
        entryMinute: 30,
        openedAt: at(31, 5),
        filledAt: at(31, 20),
        closedAt: at(90),
        status: "closed",
        dry: false,
        broker: "alpaca",
        entryBook: book(0.95, 1.01, at(31, 5)),
        entryFillBook: book(0.96, 1.0, at(31, 15)),
        sales: [
          {
            at: at(90),
            qty: 10,
            reason: "check-10",
            settled: true,
            price: 1.5,
            fillBook: book(1.35, 1.45, at(90)),
          },
        ],
      },
      {
        // Only live: the backtest has no NVDA put.
        id: "p2",
        day,
        symbol: "NVDA",
        contract: "NVDA261106P00180000",
        right: "P",
        qty: 5,
        bought: 5,
        cost: 0.5,
        entryMinute: 200,
        openedAt: at(201),
        closedAt: null,
        status: "open",
        dry: false,
        broker: "alpaca",
        sales: [],
      },
    ],
  };
}

function simTrade(
  o: Partial<SimTrade> &
    Pick<SimTrade, "symbol" | "right" | "minute" | "steps">,
): SimTrade {
  return {
    id: `${o.symbol}|${day}|0`,
    contract: `${o.symbol}261106${o.right}00200000`,
    date: day,
    t: 2,
    rvol: 3,
    d2: false,
    bonus: false,
    pyramid: false,
    sizeShare: 1,
    stock: 100,
    strike: 200,
    expiry: "2026-11-06",
    delta: 0.15,
    volume30: 500,
    fallback: false,
    priced: "quotes",
    open: false,
    watch: false,
    ...o,
  } as SimTrade;
}

test("day review: the Main bot's live trades beside the backtest's, with the verdict at real prices", () => {
  const live = mainLive();
  const job = mainJob(live, day);
  // The live stocks, without the ones off, each once.
  assert.deepEqual(
    job.spec.parts.map((p) => p.symbol),
    ["AAPL", "NVDA"],
  );
  assert.deepEqual(job.spec.body.quoteSources, ["databento", "recorded"]);
  const trades = [
    simTrade({
      symbol: "NVDA",
      right: "C",
      minute: 29,
      steps: [
        {
          date: day,
          minute: 29,
          kind: "buy",
          share: 1,
          price: 1.0,
          reason: "entry",
        },
        {
          date: day,
          minute: 80,
          kind: "sell",
          share: 1,
          price: 1.6,
          reason: "check-10",
        },
      ] as SimTrade["steps"],
    }),
    simTrade({
      symbol: "AMD",
      right: "C",
      minute: 40,
      priced: "trades",
      steps: [
        {
          date: day,
          minute: 40,
          kind: "buy",
          share: 1,
          price: 2,
          reason: "entry",
        },
        {
          date: day,
          minute: 100,
          kind: "sell",
          share: 1,
          price: 1,
          reason: "stop",
        },
      ] as SimTrade["steps"],
    }),
  ];
  const account = runAccount(trades, job.money);
  const c = compareMain(live, account, [], 2);
  const byMatch = Object.fromEntries(
    c.rows.map((r) => [`${r.symbol}${r.right}`, r]),
  );
  const nvda = byMatch.NVDAC!;
  assert.equal(nvda.match, "both");
  assert.equal(nvda.live!.paidReal, 0.98); // the fill book's mid
  assert.equal(nvda.entryMinutes, 1); // live filled a minute after the backtest's buy
  // Live real: bought 0.98, sold 1.40; the backtest: 1.00 → 1.60.
  const liveCost = 0.98 * 100 * 10 + 0.62 * 10;
  const livePnl = (1.4 - 0.98) * 100 * 10 - 2 * 0.62 * 10;
  const btRet = ((1.6 * 100 - 0.62) / (1.0 * 100 + 0.62) - 1) * 100;
  assert.ok(Math.abs(nvda.live!.pnlReal! - livePnl) < 1e-9);
  assert.ok(
    Math.abs(nvda.dollarsGap! - ((liveCost * btRet) / 100 - livePnl)) < 1e-6,
  );
  assert.equal(byMatch.NVDAP!.match, "live-only");
  assert.equal(byMatch.NVDAP!.why, "no signal in the backtest");
  assert.equal(byMatch.NVDAP!.live!.open, true);
  assert.equal(byMatch.AMDC!.match, "backtest-only");
  assert.equal(byMatch.AMDC!.why, "live: risk (day loss)");
  assert.equal(c.summary.matched, 1);
  assert.equal(c.summary.open, 1);
  assert.equal(c.summary.estimates, 1);
  // The backtest made 60% where live made ~42% at real prices: optimistic.
  assert.equal(c.summary.verdict, "optimistic");
  // The records the causes are looked for in go with the comparison.
  assert.deepEqual(
    (c.evidence.live as { symbol: string }[]).map((x) => x.symbol),
    ["AMD"],
  );
  assert.deepEqual(c.evidence.settings, live.settings);
  assert.equal(byMatch.NVDAC!.backtest!.delta, 0.15);
  assert.equal(byMatch.NVDAC!.backtest!.volume30, 500);
  // The account's day: the bot's closed trades; the backtest's NVDA at the
  // bot's cost, its AMD (the bot took none) at the bot's average cost.
  assert.equal(c.accounts.length, 1);
  assert.equal(c.accounts[0]!.broker, "alpaca");
  assert.equal(c.accounts[0]!.botTrades, 2);
  assert.equal(c.accounts[0]!.backtestTrades, 2);
  assert.ok(Math.abs(c.accounts[0]!.bot - livePnl) < 1e-9);
  assert.ok(c.summary.gapPts > 5);
});

test("day review: the Volume bot's trades are matched by stock, side and alert time", () => {
  const live: VolumeDay = {
    day,
    settings: {},
    watching: ["AMD"],
    signals: [],
    trades: [
      {
        id: "t1",
        day,
        symbol: "AMD",
        alertMinute: 60,
        alertSecond: 3660,
        side: "C",
        phase: "closed",
        dry: false,
        openedAt: at(61, 30),
        closedAt: at(75),
        leg: {
          contract: "AMD261104C00250000",
          qty: 0,
          bought: 4,
          cost: 1.0,
          orders: [
            {
              at: at(61, 40),
              side: "buy",
              qty: 4,
              reason: "entry",
              settled: true,
              price: 1.0,
              book: book(0.9, 1.0, at(61, 38)),
            },
            {
              at: at(75, 2),
              side: "sell",
              qty: 4,
              reason: "giveback",
              settled: true,
              price: 0.9,
              book: book(0.88, 0.92, at(75)),
            },
          ],
        },
      },
    ],
  };
  const signal: VolumeSignal = {
    id: `AMD|${day}|plan|3660`,
    symbol: "AMD",
    date: day,
    kind: "plan",
    minute: 60,
    second: 3660,
    alert: "up",
    price: 250,
    unit: 1,
    burst: 2,
    expiry: day,
    outcome: "traded",
    detail: "",
    trade: {
      contract: "AMD261104C00250000",
      right: "C",
      strike: 250,
      expiry: day,
      delta: 0.35,
      fallback: false,
      sideSecond: 3688,
      toSide: 28,
      stockIn: 250.5,
      buyMinute: 61,
      buy: 0.95,
      book: { bid: 0.9, ask: 1.0 },
      spread: 0.1,
      buyPriced: "seconds",
      exitMinute: 74,
      exitReason: "giveback",
      sell: 0.88,
      sellPriced: "minutes",
      stockOut: 251,
    },
  } as unknown as VolumeSignal;
  const account = volumeAccount(
    [{ symbol: "AMD", signals: [signal], ignored: [] } as never],
    {
      start: 100000,
      sizePct: 3,
      feePerContract: 0.62,
      maxPerStock: 2,
      limits: true,
      maxTradesPerDay: 5,
      maxOpen: 3,
      dayLossPct: 5,
    },
  );
  const c = compareVolume(live, account, [signal], 1);
  assert.equal(c.rows.length, 1);
  const r = c.rows[0]!;
  assert.equal(r.match, "both");
  assert.equal(r.live!.paidReal, 0.95);
  assert.equal(r.live!.exits[0]!.real, 0.9);
  // Both lost about the same: on target.
  assert.equal(c.summary.verdict, "on target");
});

test("day review: a plain live entry pairs with the backtest's D2 entry, a pyramid add only with an add", () => {
  const live = mainLive();
  live.positions = [live.positions[0]!];
  const steps = [
    {
      date: day,
      minute: 29,
      kind: "buy",
      share: 1,
      price: 1.0,
      reason: "entry",
    },
    {
      date: day,
      minute: 80,
      kind: "sell",
      share: 1,
      price: 1.5,
      reason: "check-10",
    },
  ] as SimTrade["steps"];
  const d2 = simTrade({
    symbol: "NVDA",
    right: "C",
    minute: 29,
    bonus: true,
    steps,
  });
  const job = mainJob(live, day);
  assert.equal(
    compareMain(live, runAccount([d2], job.money), [], 1).rows[0]!.match,
    "both",
  );
  const add = simTrade({
    symbol: "NVDA",
    right: "C",
    minute: 29,
    pyramid: true,
    steps,
  });
  const rows = compareMain(live, runAccount([add], job.money), [], 1).rows;
  assert.deepEqual(rows.map((r) => r.match).sort(), [
    "backtest-only",
    "live-only",
  ]);
});

test("day review: an analysis is checked before it is kept", () => {
  assert.equal(
    typeof parseAnalysis({ verdict: "maybe", headline: "x", markdown: "y" }, 1),
    "string",
  );
  assert.equal(
    typeof parseAnalysis(
      { verdict: "optimistic", headline: "", markdown: "y" },
      1,
    ),
    "string",
  );
  assert.equal(
    typeof parseAnalysis(
      {
        verdict: "optimistic",
        headline: "h",
        markdown: "m",
        differences: [{ class: "a guess", title: "t", why: "w" }],
      },
      1,
    ),
    "string",
  );
  const ok = parseAnalysis(
    {
      verdict: "pessimistic",
      headline: " Live beat it ",
      markdown: "## Why",
      differences: [
        {
          class: "pick",
          title: "COIN: another strike",
          why: "Delta differs.",
          evidence: "bot.ts:1251",
          action: "test",
          symbols: ["coin"],
        },
      ],
    },
    5,
  );
  assert.deepEqual(ok, {
    verdict: "pessimistic",
    headline: "Live beat it",
    markdown: "## Why",
    differences: [
      {
        class: "pick",
        title: "COIN: another strike",
        why: "Delta differs.",
        evidence: "bot.ts:1251",
        action: "test",
        symbols: ["COIN"],
        accounts: [],
      },
    ],
    writtenAt: 5,
  });
});

test("day review: start runs the day's backtest, the finished run is compared, the analysis is saved", async () => {
  const db = new SqliteD1(":memory:");
  const jobs = new BacktestJobs(db);
  const live = mainLive();
  const traderCalls: string[] = [];
  const fetcher = (async (input: URL) => {
    const url = String(input);
    traderCalls.push(url.replace("https://trader.test", ""));
    if (url.includes("/v1/bot/day")) return Response.json(live);
    if (url.includes("/v1/records/ticks"))
      return Response.json({
        ticks: [
          {
            at: at(50, 30),
            contract: "NVDA261106C00200000",
            bid: 1.1,
            ask: 1.2,
          },
        ],
      });
    return Response.json({ error: "no" }, { status: 404 });
  }) as unknown as typeof fetch;
  const put: [string, string, string, [number, number, number][]][] = [];
  const compute: PartCompute = async (_bot, request) => ({
    status: 200,
    body: {
      symbol: request.symbol,
      sessions: 1,
      noData: 0,
      skips: [],
      trades:
        request.symbol === "NVDA"
          ? [
              simTrade({
                symbol: "NVDA",
                right: "C",
                minute: 29,
                steps: [
                  {
                    date: day,
                    minute: 29,
                    kind: "buy",
                    share: 1,
                    price: 0.98,
                    reason: "entry",
                  },
                  {
                    date: day,
                    minute: 80,
                    kind: "sell",
                    share: 1,
                    price: 1.4,
                    reason: "check-10",
                  },
                ] as SimTrade["steps"],
              }),
            ]
          : [],
    },
  });
  let now = at(395);
  const deps: ReviewDeps = {
    reviews: new D1DayReviews(db),
    jobs,
    start: (tasks) => runParts(jobs, tasks, compute).then(() => {}),
    trader: { url: "https://trader.test", token: "read" },
    quotes: { put: async (c, d, s, q) => void put.push([c, d, s, q]) },
    volume: new D1VolumeData(db),
    now: () => now,
    fetcher,
  };
  const call = (method: string, path: string, body?: unknown) =>
    handleDayReviews(deps, { method, path, query: {}, body });
  assert.equal((await call("GET", `/api/day-reviews/main/${day}`)).status, 404);
  assert.equal(
    (await call("POST", `/api/day-reviews/main/2026-11-07/start`)).status,
    400,
  );
  const started = await call("POST", `/api/day-reviews/main/${day}/start`, {});
  assert.equal(started.status, 200);
  assert.equal((started.body as { status: string }).status, "running");
  // The held contract's recorded books went to D1 first.
  // The held call's books (its buy, sale and a tick); the put recorded none.
  assert.deepEqual(
    put.map(([c, d, s]) => [c, d, s]),
    [["NVDA261106C00200000", day, "recorded"]],
  );
  assert.deepEqual(
    put[0]![3].map((r) => r[0]),
    [31, 50, 90],
  );
  const job = await jobs.list(reviewOwner, "main");
  assert.equal(job.length, 1);
  // A saved analysis must wait for the comparison; the run is done, so it is compared on read.
  now += 60000;
  const got = await call("GET", `/api/day-reviews/main/${day}`);
  const review = got.body as {
    status: string;
    comparison: { summary: { verdict: string; matched: number } };
  };
  assert.equal(review.status, "compared");
  assert.equal(review.comparison.summary.matched, 1);
  assert.equal(review.comparison.summary.verdict, "on target");
  const saved = await call("PUT", `/api/day-reviews/main/${day}/analysis`, {
    analysis: {
      verdict: "on target",
      headline: "Same trade, same money.",
      markdown: "## NVDA\n- matched",
    },
  });
  assert.equal(saved.status, 200);
  const list = await handleDayReviews(deps, {
    method: "GET",
    path: "/api/day-reviews",
    query: { bot: "main" },
    body: undefined,
  });
  const reviews = (
    list.body as { reviews: { analysis: { headline: string } }[] }
  ).reviews;
  assert.equal(reviews[0]!.analysis.headline, "Same trade, same money.");
  // A second start keeps the review; force runs it again with the analysis kept.
  const again = await call("POST", `/api/day-reviews/main/${day}/start`, {});
  assert.equal((again.body as { status: string }).status, "compared");
  const forced = await call("POST", `/api/day-reviews/main/${day}/start`, {
    force: true,
  });
  assert.equal(
    (forced.body as { status: string; analysis: unknown }).status,
    "running",
  );
  assert.ok((forced.body as { analysis: unknown }).analysis);
});

test("day review: the analysis markdown is read as blocks, never as HTML", () => {
  const blocks = markdownBlocks(
    "## Verdict\nThe backtest was **optimistic**.\n\n- NVDA: `+1 min`\n- AMD\n\n| a | b |\n|---|---|\n| 1 | <b>2</b> |",
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["heading", "paragraph", "list", "table"],
  );
  assert.deepEqual(
    inlineSpans("a **b** `c`").map((s) => s.kind),
    ["text", "bold", "text", "code"],
  );
  const table = blocks[3] as { rows: string[][] };
  assert.equal(table.rows[0]![1], "<b>2</b>"); // kept as text
});

test("day review: the connector's token opens the day reviews and nothing else", async () => {
  const { default: worker } = await import("../apps/api/src/worker.js");
  const review = "k".repeat(40);
  const env = {
    ACCESS_TEAM_DOMAIN: "https://team.example",
    ACCESS_AUD: "aud",
    TRADE_OWNER_EMAIL: "owner@example.com",
    DAY_REVIEW_TOKEN: review,
    BARS_CACHE: new SqliteD1(":memory:"),
  };
  const get = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request(`https://site.internal${path}`, { headers }),
      env as never,
    );
  assert.equal(
    (await get("/api/day-reviews?bot=main", { "X-Day-Review-Token": review }))
      .status,
    200,
  );
  assert.equal(
    (
      await get("/api/day-reviews?bot=main", {
        "X-Day-Review-Token": `${review}x`,
      })
    ).status,
    401,
  );
  assert.equal((await get("/api/day-reviews?bot=main")).status, 401);
  assert.equal(
    (await get("/api/watchlists", { "X-Day-Review-Token": review })).status,
    401,
  );
});

test("day review page: the running sums by account, the fallback causes, the bot's trade for its window", async () => {
  const m = await import("../apps/web/src/day-review-model.js");
  const review = (
    date: string,
    bot: number,
    backtest: number,
    broker = "alpaca",
  ) =>
    ({
      bot: "main",
      date,
      status: "compared",
      jobId: "j",
      startedAt: 0,
      updatedAt: 0,
      error: null,
      analysis: null,
      comparison: {
        summary: { verdict: "on target" },
        accounts: [
          {
            broker,
            bot,
            botPaper: bot,
            backtest,
            botTrades: 1,
            backtestTrades: 1,
          },
        ],
        rows: [
          {
            key: "k",
            symbol: "COIN",
            right: "C",
            kind: "entry",
            match: "live-only",
            why: "backtest skipped: illiquid",
          },
        ],
      },
    }) as never;
  // Newest first from the server; the chart runs oldest first.
  const points = m.performance(
    [review("2026-11-04", -100, 50), review("2026-11-03", 200, 300)],
    "alpaca",
  );
  assert.deepEqual(
    points.map((p) => [p.date, p.cumBot, p.cumBacktest]),
    [
      ["2026-11-03", 200, 300],
      ["2026-11-04", 100, 350],
    ],
  );
  assert.deepEqual(
    m.accountsIn([
      review("2026-11-04", 1, 1, "ibkr"),
      review("2026-11-03", 1, 1),
    ]),
    ["alpaca", "ibkr"],
  );
  const causes = m.differencesOf(review("2026-11-04", 0, 0));
  assert.deepEqual(
    causes.map((d) => [d.class, d.title, d.why]),
    [["unknown", "COIN: only the bot traded", "backtest skipped: illiquid"]],
  );
  assert.equal(m.contractWords("COIN261106C00160000"), "Call 160 · 6 Nov");
  assert.equal(m.dayLabel("2026-11-04"), "Wed 4 Nov");
  const t = m.closedTradeOf("COIN", {
    ref: "p",
    contract: "COIN261106C00160000",
    broker: "alpaca",
    dry: false,
    version: null,
    entryAt: Date.parse("2026-11-04T14:50:00Z"),
    qty: 10,
    paidPaper: 1,
    paidReal: 0.98,
    entryBook: null,
    exits: [
      {
        at: Date.parse("2026-11-04T14:54:00Z"),
        qty: 5,
        paper: 0.8,
        real: 0.82,
        reason: "stage-half",
        book: null,
      },
      {
        at: Date.parse("2026-11-04T14:55:00Z"),
        qty: 5,
        paper: 0.6,
        real: 0.62,
        reason: "stage-full",
        book: null,
      },
    ],
    open: false,
    retPaper: -30,
    retReal: -28,
    pnlPaper: -300,
    pnlReal: -280,
  });
  assert.equal(t!.exit, 0.7);
  assert.deepEqual(t!.option, {
    right: "call",
    strike: 160,
    expiry: "2026-11-06",
  });
  assert.equal(t!.closedAt, "2026-11-04T14:55:00.000Z");
  assert.equal(
    m.tradeLine({ match: "both", dollarsGap: -350 } as never),
    "The bot made $350 more",
  );
  assert.equal(
    m.tradeLine({ match: "both", dollarsGap: 176 } as never),
    "The backtest made $176 more",
  );
});
