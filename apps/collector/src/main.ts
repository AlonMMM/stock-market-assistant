import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import {
  defaults,
  validateConfig,
  type Config,
} from "../../../packages/alerts/src/relative-volume.js";
import {
  AlpacaFeed,
  type AlpacaFeedName,
} from "../../../packages/market-data/src/alpaca.js";
import { normalize } from "../../../packages/market-data/src/bars.js";
import {
  coreClose,
  newYork,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import { benchmark } from "../../../packages/market-data/src/beta.js";
import {
  alertedToday,
  LiveStrength,
  raiseScored,
} from "../../../packages/market-data/src/live-strength.js";
import { LiveEvaluator } from "../../../packages/market-data/src/evaluator.js";
import {
  AlertEvents,
  type AlertEvent,
} from "../../../packages/alerts/src/events.js";
import {
  notifyOnAlerts,
  Outbox,
} from "../../../packages/notifications/src/outbox.js";
import { TelegramSender } from "../../../packages/notifications/src/telegram.js";
import { MarketStore } from "../../../packages/market-data/src/store.js";
import { claudeCreate } from "../../../packages/analysis/src/agents.js";
import { telegramDelivery } from "../../../packages/analysis/src/format.js";
import { alpacaNews } from "../../../packages/analysis/src/news.js";
import {
  AnalysisQueue,
  analyzeOnAlerts,
} from "../../../packages/analysis/src/pipeline.js";
import { pythonRunner } from "../../../packages/analysis/src/technical.js";
import { chartNamePattern } from "../../../packages/analysis/src/technical-facts.js";
import {
  parseWatchlistInput,
  WatchlistInputError,
} from "../../../packages/market-data/src/watchlist.js";

const enabled = process.env.ALPACA_ENABLED === "true";
const feed = process.env.ALPACA_FEED ?? "iex";
if (!(["iex", "sip", "delayed_sip"] as string[]).includes(feed))
  throw new Error("ALPACA_FEED must be iex, sip, or delayed_sip");
// Alpaca's free plan allows 30 symbols on one IEX stream subscription. SPY
// (streamed for the score vs SPY) counts toward this limit.
const maxLive = Number(process.env.ALPACA_MAX_SYMBOLS ?? 30);
if (!Number.isInteger(maxLive) || maxLive < 1 || maxLive > 1000)
  throw new Error("ALPACA_MAX_SYMBOLS must be an integer from 1 to 1000");
const key = process.env.ALPACA_API_KEY ?? "";
const secret = process.env.ALPACA_API_SECRET ?? "";
if (enabled && (!key || !secret))
  throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET");
const token = process.env.COLLECTOR_TOKEN;
if (!token || token.length < 32)
  throw new Error("Set a random COLLECTOR_TOKEN of at least 32 characters");
// Optional narrower credential that may only replace the watchlist, for the
// scheduled IBKR sync job.
const syncToken = process.env.WATCHLIST_SYNC_TOKEN;
if (syncToken !== undefined && syncToken.length < 32)
  throw new Error("WATCHLIST_SYNC_TOKEN must have at least 32 characters");
const config: Config = {
  ...defaults,
  ...JSON.parse(process.env.RVOL_CONFIG ?? "{}"),
};
validateConfig(config);
const dbPath = process.env.COLLECTOR_DB ?? "data/local/alpaca.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const store = new MarketStore(dbPath);
// Every new live alert is published here; consumers subscribe below.
const alertEvents = new AlertEvents();
// Phone notifications are on when both Telegram values are set.
const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
const telegramChat = process.env.TELEGRAM_CHAT_ID ?? "";
if (!telegramToken !== !telegramChat)
  throw new Error(
    "Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or neither",
  );
const telegram = telegramToken
  ? new TelegramSender(telegramToken, telegramChat)
  : null;
const outbox = telegram
  ? new Outbox(dbPath, telegram, { siteUrl: process.env.SITE_URL })
  : null;
if (outbox) notifyOnAlerts(alertEvents, outbox);
// Alert analysis (relative strength, technical scan, sentiment and news
// agents) is opt-in: it calls Alpaca REST and, with a key, the Claude API.
const analysisEnabled = process.env.ANALYSIS_ENABLED === "true";
if (analysisEnabled && (!key || !secret))
  throw new Error(
    "ANALYSIS_ENABLED needs ALPACA_API_KEY and ALPACA_API_SECRET",
  );
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
const analyses = analysisEnabled
  ? new AnalysisQueue(
      dbPath,
      {
        feed: new AlpacaFeed(key, secret, feed as AlpacaFeedName, () => {}),
        bars: (ticker, from) => store.bars(ticker, from),
        sector: (ticker) => store.watchlist()?.benchmarks?.[ticker],
        news: (symbol, start, end) =>
          alpacaNews({ key, secret }, symbol, start, end),
        claude: anthropicKey ? claudeCreate(anthropicKey) : null,
        script: pythonRunner(
          process.env.TECHNICAL_SCAN_PYTHON ?? "python3",
          process.env.TECHNICAL_SCAN_SCRIPT,
        ),
      },
      telegram && outbox
        ? telegramDelivery(telegram, outbox, process.env.SITE_URL)
        : async () => "off",
    )
  : null;
if (analyses) analyzeOnAlerts(alertEvents, analyses);
const api = Fastify({ logger: false });
let stopping = false;
let failure: string | null = null;
let state = "starting";
const symbols = new Map<
  string,
  { state: string; lastBar: string | null; evaluation: string | null }
>();
// Each watchlist change starts a new session with its own stream connection;
// a superseded session stops quietly.
let session = 0;
let feedClient: AlpacaFeed | null = null;

// Watchlist symbols on the stream. SPY is streamed as well (for the score vs
// SPY) and takes one of the `maxLive` slots unless it is on the watchlist.
const live = (tickers: string[]) => {
  const first = tickers.slice(0, maxLive);
  return first.includes(benchmark) || maxLive < 2
    ? first
    : tickers.slice(0, maxLive - 1);
};
const streamed = (tickers: string[]) =>
  tickers.includes(benchmark) ? tickers : [...tickers, benchmark];

// Area score vs SPY at alert time and now (docs/features/area-vs-spy.md).
// Daily bars (β) come from Alpaca's SIP history whatever the stream feed:
// final daily closes are available on every plan. σ curves come from the
// stored minute bars of the previous 20 sessions (the warmup history).
const dailyFeed = new AlpacaFeed(key, secret, "sip", () => {});
const strength = new LiveStrength({
  multi: (tickers, start, end, timeframe, adjustment) =>
    dailyFeed.multiHistory(tickers, start, end, timeframe, adjustment),
  store: store.strengths,
  sigmas: store.sigmas,
  bars: (ticker, from) => store.bars(ticker, from),
});
let watched: string[] = [];
// Session whose warmup history is stored: σ curves need it.
let warmed = -1;
let spyLastBar: string | null = null; // newest streamed SPY bar end
// β and σ curves for today's US session date, for the streamed watchlist;
// runs at startup, after the warmup, on each watchlist change and every 5
// minutes, so a new date is prepared shortly after New York midnight, before
// the pre-market. Only missing symbols are computed; failures are retried on
// the next run. σ curves wait for the warmup history to be stored.
async function prepareStrength() {
  if (!enabled || !watched.length) return;
  const date = newYork(Date.now()).date;
  try {
    if (coreClose(date) === null) return;
    const missing = await strength.prepare(date, watched);
    if (missing)
      console.error(
        JSON.stringify({ event: "spy-strength-incomplete", date, missing }),
      );
    if (warmed !== session) return;
    const noSigma = await strength.prepareSigma(date, watched);
    if (noSigma)
      console.error(
        JSON.stringify({ event: "area-sigma-incomplete", date, noSigma }),
      );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "spy-strength-failed",
        date,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

// Attaches the area score vs SPY (waiting ≤ 3 s for SPY's bar of the same minute),
// then stores and publishes the alert. A failure yields a null score; the
// alert is still stored and published.
const raise = (alert: AlertEvent) =>
  raiseScored(alert, strength, store, alertEvents);

async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  state = "disconnected";
  console.error(JSON.stringify({ state, error: failure, exitCode: code }));
  feedClient?.close();
  telegram?.stop();
  await api.close();
  outbox?.close();
  analyses?.close();
  store.close();
  process.exit(code);
}
process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

function bearer(
  request: { headers: { authorization?: string } },
  value: string,
) {
  const expected = Buffer.from(`Bearer ${value}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
api.addHook("onRequest", async (request, reply) => {
  const sync =
    syncToken !== undefined &&
    request.method === "PUT" &&
    request.url === "/watchlist" &&
    bearer(request, syncToken);
  if (!sync && !bearer(request, token))
    return reply.code(401).send({ error: "Unauthorized" });
});
api.get("/health", async () => ({
  source: "alpaca",
  feed,
  state,
  failure,
  symbols: Object.fromEntries(
    [...symbols].map(([ticker, value]) => [
      ticker,
      {
        ...value,
        ageSeconds: value.lastBar
          ? Math.floor((Date.now() - Date.parse(value.lastBar)) / 1000)
          : null,
      },
    ]),
  ),
  // Streamed for the score vs SPY even when it is not on the watchlist.
  benchmark: { ticker: benchmark, lastBar: spyLastBar },
}));
api.get("/alerts", async () => {
  const alerts = store.alerts();
  return {
    source: "alpaca",
    alerts,
    strengthNow: strength.current(alertedToday(alerts, Date.now())),
  };
});
api.get("/notifications", async () => ({
  channel: outbox ? "telegram" : null,
  muted: outbox?.muted() ?? null,
  recent: outbox?.recent() ?? [],
}));
api.put("/notifications", async (request, reply) => {
  if (!outbox)
    return reply.code(409).send({ error: "Telegram is not configured" });
  const muted = (request.body as { muted?: unknown } | null)?.muted;
  if (typeof muted !== "boolean")
    return reply.code(400).send({ error: "Body must be { muted: boolean }" });
  outbox.setMuted(muted);
  console.log(JSON.stringify({ event: "notifications-muted", muted }));
  return { channel: "telegram", muted };
});
// Sends a labeled test message now, bypassing mute and the outbox.
api.post("/notifications/test", async (_request, reply) => {
  if (!telegram)
    return reply.code(409).send({ error: "Telegram is not configured" });
  const result = await telegram.send(
    "🧪 <b>Test message</b> from the stock-market collector. Not a market alert.",
  );
  if (!result.ok) return reply.code(502).send({ error: result.error });
  return { sent: true };
});
// Publishes a SYNTHETIC alert on the bus, so every consumer (the Telegram
// outbox included, mute respected) handles it like a live one. It is not
// stored as an alert. Delivery state appears in GET /notifications.
api.post("/notifications/synthetic", async (_request, reply) => {
  const alert: AlertEvent = {
    ticker: "TEST",
    end: new Date().toISOString(),
    session: "regular",
    actual: 123456,
    expected: 30000,
    ratio: 4.1,
    paceRatio: null,
    volumeBasis: "history",
    move: 1.23,
    expectedMove: 0.3,
    direction: "up",
    samples: config.days,
    status: "alert",
    rule: "rvol-v4",
    config,
    close: 100,
    synthetic: true,
  };
  alertEvents.publish(alert);
  return reply
    .code(202)
    .send({ published: true, ticker: alert.ticker, end: alert.end });
});
api.get("/analyses", async () => ({
  enabled: analyses !== null,
  claude: analyses !== null && anthropicKey !== "",
  analyses: analyses?.recent() ?? [],
}));
// Analyzes a stored alert again (manual check); delivery follows as usual.
// With `resend: true` the alert message is sent again first (labeled) and
// the analysis replies under it.
api.post("/analyses", async (request, reply) => {
  if (!analyses)
    return reply.code(409).send({ error: "Analysis is not enabled" });
  const body = request.body as {
    ticker?: unknown;
    end?: unknown;
    resend?: unknown;
  } | null;
  if (
    typeof body?.ticker !== "string" ||
    typeof body.end !== "string" ||
    (body.resend !== undefined && typeof body.resend !== "boolean")
  )
    return reply.code(400).send({
      error: "Body must be { ticker: string, end: string, resend?: boolean }",
    });
  const alert = store.findAlert(body.ticker, body.end);
  if (!alert) return reply.code(404).send({ error: "No such stored alert" });
  if (body.resend) {
    if (!outbox)
      return reply.code(409).send({ error: "Telegram is not configured" });
    const sent = await outbox.resend(alert);
    if (!sent.ok) return reply.code(502).send({ error: sent.error });
  }
  analyses.requeue(alert);
  void analyses.drain();
  return reply
    .code(202)
    .send({ queued: true, ticker: alert.ticker, end: alert.end });
});
// One stored technical-scan chart of an analysis, for the site.
api.get("/analyses/chart", async (request, reply) => {
  const { ticker, end, name } = request.query as Record<string, unknown>;
  if (
    typeof ticker !== "string" ||
    typeof end !== "string" ||
    typeof name !== "string" ||
    !chartNamePattern.test(name)
  )
    return reply.code(400).send({ error: "Expected ticker, end and name" });
  const png = analyses?.chart(ticker, end, name);
  if (!png) return reply.code(404).send({ error: "No such chart" });
  return reply
    .type("image/png")
    .header("Cache-Control", "private, max-age=300")
    .send(png);
});
api.get("/watchlist", async (_request, reply) => {
  const list = store.watchlist();
  if (!list) return reply.code(404).send({ error: "No watchlist synced yet" });
  return { source: "ibkr", ...list, live: live(list.tickers) };
});
api.put("/watchlist", async (request, reply) => {
  let input: { name: string; tickers: string[] };
  try {
    input = parseWatchlistInput(request.body);
  } catch (error) {
    if (error instanceof WatchlistInputError)
      return reply.code(400).send({ error: error.message });
    throw error;
  }
  const previous = store.watchlist();
  const list = { ...input, syncedAt: new Date().toISOString() };
  store.setWatchlist(list);
  const changed =
    live(previous?.tickers ?? []).join() !== live(list.tickers).join();
  console.log(
    JSON.stringify({
      event: "watchlist-synced",
      symbols: list.tickers.length,
      changed,
    }),
  );
  if (changed && enabled) void restart(list.tickers);
  return {
    source: "ibkr",
    ...list,
    live: live(list.tickers),
    restarting: changed && enabled,
  };
});

async function collect(tickers: string[], id: number) {
  const client = new AlpacaFeed(
    key,
    secret,
    feed as AlpacaFeedName,
    (message) => {
      if (id !== session) return;
      failure = message;
      void stop(1);
    },
  );
  feedClient = client;
  state = "warming-up";
  symbols.clear();
  const today = newYork(Date.now()).date;
  const dates = previousSessions(today, config.days);
  const from = dates[0]!;
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1);
  const evaluators = new Map<string, LiveEvaluator>();
  watched = tickers;
  void prepareStrength();

  // SPY is warmed up and streamed for the score vs SPY; it is evaluated
  // (and listed in /health) only when it is on the watchlist.
  for (const ticker of streamed(tickers)) {
    if (id !== session) return;
    const evaluated = tickers.includes(ticker);
    if (evaluated)
      symbols.set(ticker, {
        state: "warming-up",
        lastBar: null,
        evaluation: null,
      });
    const cached = store.bars(ticker, from);
    const cachedDates = new Set(cached.map((bar) => bar.date));
    const firstMissing = dates.find((date) => !cachedDates.has(date));
    const rows = await client.history(
      ticker,
      `${firstMissing ?? today}T00:00:00Z`,
      end.toISOString(),
    );
    for (const row of rows) {
      const bar = normalize(ticker, row, "shares");
      if (bar && Date.parse(bar.end) <= Date.now()) store.put(bar);
    }
    if (evaluated) {
      const evaluator = new LiveEvaluator(config);
      for (const bar of store.bars(ticker, from))
        evaluator.push(bar, Date.now(), false);
      evaluators.set(ticker, evaluator);
      symbols.get(ticker)!.state = "subscribing";
    }
    // A cold 20-session warmup usually paginates twice. This keeps the
    // rollout below common REST request-per-minute limits.
    await delay(800);
  }
  if (id !== session) return;
  // Warmup stored: σ curves (and β, if still missing) before streaming.
  warmed = id;
  await prepareStrength();
  if (id !== session) return;

  const spyStreamed = streamed(tickers);
  await client.stream(spyStreamed, (ticker, raw) => {
    if (id !== session) return;
    try {
      if (!spyStreamed.includes(ticker)) return;
      const bar = normalize(ticker, raw, "shares");
      if (!bar || Date.parse(bar.end) > Date.now()) return;
      store.put(bar);
      strength.bar(bar);
      if (ticker === benchmark) spyLastBar = bar.end;
      const evaluator = evaluators.get(ticker);
      const symbol = symbols.get(ticker);
      if (!evaluator || !symbol) return;
      const result = evaluator.push(bar, Date.now(), true);
      symbols.set(ticker, {
        state: "receiving",
        lastBar: bar.end,
        evaluation: result?.status ?? null,
      });
      if (result?.status === "alert")
        raise({ ...result, close: bar.close }).catch((error) =>
          console.error(
            JSON.stringify({
              event: "alert-failed",
              ticker,
              end: result.end,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    } catch {
      failure = `Invalid market data for ${ticker}`;
      void stop(1);
    }
  });
  if (id !== session) return;
  state = "subscribed";
  for (const symbol of symbols.values()) symbol.state = "subscribed";
  console.log(
    JSON.stringify({ state, symbols: tickers.length, streamed: spyStreamed }),
  );
}

// Replaces the live subscription. Alpaca allows one stream connection per
// account, so the previous one is closed and given a moment to drop first.
async function restart(tickers: string[]) {
  const id = ++session;
  feedClient?.close();
  feedClient = null;
  await delay(2000);
  if (id !== session) return;
  try {
    await collect(live(tickers), id);
  } catch (error) {
    if (id !== session) return;
    failure = error instanceof Error ? error.message : "Collector failed";
    await stop(1);
  }
}

try {
  await api.listen({
    host: process.env.COLLECTOR_HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3002),
  });
  const prune = () => {
    store.prune(
      new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10),
    );
    // Analyses carry chart images; keep 60 days.
    analyses?.prune(new Date(Date.now() - 60 * 86400000).toISOString());
  };
  prune();
  setInterval(prune, 86400000).unref();
  // Picks up retries and rows left pending by a restart.
  if (outbox) setInterval(() => void outbox.drain(), 5000).unref();
  if (analyses) setInterval(() => void analyses.drain(), 5000).unref();
  setInterval(() => void prepareStrength(), 5 * 60000).unref();
  const list = store.watchlist();
  if (!enabled) {
    state = "awaiting-alpaca-activation";
  } else if (!list) {
    state = "awaiting-watchlist";
  } else {
    void restart(list.tickers);
  }
  console.log(JSON.stringify({ state, address: api.server.address() }));
} catch (error) {
  failure = error instanceof Error ? error.message : "Collector startup failed";
  await stop(1);
}
