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
  newYork,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import { LiveEvaluator } from "../../../packages/market-data/src/evaluator.js";
import { MarketStore } from "../../../packages/market-data/src/store.js";
import {
  parseWatchlistInput,
  WatchlistInputError,
} from "../../../packages/market-data/src/watchlist.js";

const enabled = process.env.ALPACA_ENABLED === "true";
const feed = process.env.ALPACA_FEED ?? "iex";
if (!(["iex", "sip", "delayed_sip"] as string[]).includes(feed))
  throw new Error("ALPACA_FEED must be iex, sip, or delayed_sip");
// Alpaca's free plan allows 30 symbols on one IEX stream subscription.
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

const live = (tickers: string[]) => tickers.slice(0, maxLive);

async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  state = "disconnected";
  console.error(JSON.stringify({ state, error: failure, exitCode: code }));
  feedClient?.close();
  await api.close();
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
}));
api.get("/alerts", async () => ({ source: "alpaca", alerts: store.alerts() }));
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

  for (const ticker of tickers) {
    if (id !== session) return;
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
    const evaluator = new LiveEvaluator(config);
    for (const bar of store.bars(ticker, from))
      evaluator.push(bar, Date.now(), false);
    evaluators.set(ticker, evaluator);
    symbols.get(ticker)!.state = "subscribing";
    // A cold 20-session warmup usually paginates twice. This keeps the
    // rollout below common REST request-per-minute limits.
    await delay(800);
  }
  if (id !== session) return;

  await client.stream(tickers, (ticker, raw) => {
    if (id !== session) return;
    try {
      const evaluator = evaluators.get(ticker);
      const symbol = symbols.get(ticker);
      if (!evaluator || !symbol) return;
      const bar = normalize(ticker, raw, "shares");
      if (!bar || Date.parse(bar.end) > Date.now()) return;
      store.put(bar);
      const result = evaluator.push(bar, Date.now(), true);
      symbols.set(ticker, {
        state: "receiving",
        lastBar: bar.end,
        evaluation: result?.status ?? null,
      });
      if (result?.status === "alert") store.alert(result);
    } catch {
      failure = `Invalid market data for ${ticker}`;
      void stop(1);
    }
  });
  if (id !== session) return;
  state = "subscribed";
  for (const symbol of symbols.values()) symbol.state = "subscribed";
  console.log(JSON.stringify({ state, symbols: tickers.length }));
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
  const prune = () =>
    store.prune(
      new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10),
    );
  prune();
  setInterval(prune, 86400000).unref();
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
