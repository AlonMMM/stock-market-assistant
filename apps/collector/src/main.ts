import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
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

const enabled = process.env.ALPACA_ENABLED === "true";
const tickers: unknown = process.env.ALPACA_SYMBOLS
  ? process.env.ALPACA_SYMBOLS.split(",").map((ticker) => ticker.trim())
  : JSON.parse(
      readFileSync(
        process.env.ALPACA_WATCHLIST ?? "config/alpaca-watchlist.json",
        "utf8",
      ),
    );
if (
  !Array.isArray(tickers) ||
  tickers.length < 1 ||
  tickers.length > 50 ||
  !tickers.every(
    (t) => typeof t === "string" && /^[A-Z][A-Z0-9. -]{0,9}$/.test(t),
  ) ||
  new Set(tickers).size !== tickers.length
)
  throw new Error("Watchlist must contain 1–50 distinct US stock symbols");
const feed = process.env.ALPACA_FEED ?? "iex";
if (!(["iex", "sip", "delayed_sip"] as string[]).includes(feed))
  throw new Error("ALPACA_FEED must be iex, sip, or delayed_sip");
const key = process.env.ALPACA_API_KEY ?? "";
const secret = process.env.ALPACA_API_SECRET ?? "";
if (enabled && (!key || !secret))
  throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET");
const token = process.env.COLLECTOR_TOKEN;
if (!token || token.length < 32)
  throw new Error("Set a random COLLECTOR_TOKEN of at least 32 characters");
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
const feedClient = enabled
  ? new AlpacaFeed(key, secret, feed as AlpacaFeedName, (message) => {
      failure = message;
      void stop(1);
    })
  : null;

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
api.addHook("onRequest", async (request, reply) => {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
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

async function collect() {
  if (!feedClient) throw new Error("Alpaca collector is disabled");
  state = "warming-up";
  const today = newYork(Date.now()).date;
  const dates = previousSessions(today, config.days);
  const from = dates[0]!;
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1);
  const evaluators = new Map<string, LiveEvaluator>();

  for (const ticker of tickers as string[]) {
    symbols.set(ticker, {
      state: "warming-up",
      lastBar: null,
      evaluation: null,
    });
    const cached = store.bars(ticker, from);
    const cachedDates = new Set(cached.map((bar) => bar.date));
    const firstMissing = dates.find((date) => !cachedDates.has(date));
    const rows = await feedClient.history(
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
    // 50-symbol rollout below common REST request-per-minute limits.
    await delay(800);
  }

  await feedClient.stream(tickers as string[], (ticker, raw) => {
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
  state = "subscribed";
  for (const symbol of symbols.values()) symbol.state = "subscribed";
  const prune = () =>
    store.prune(
      new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10),
    );
  prune();
  setInterval(prune, 86400000).unref();
}

try {
  await api.listen({
    host: process.env.COLLECTOR_HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3002),
  });
  if (enabled) {
    await collect();
  } else {
    state = "awaiting-alpaca-activation";
    console.log(JSON.stringify({ state, address: api.server.address() }));
  }
} catch (error) {
  failure = error instanceof Error ? error.message : "Collector startup failed";
  await stop(1);
}
