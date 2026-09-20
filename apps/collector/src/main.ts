import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import {
  defaults,
  validateConfig,
  type Config,
} from "../../../packages/alerts/src/relative-volume.js";
import {
  ClosedMinutes,
  normalize,
  type RawBar,
} from "../../../packages/market-data/src/bars.js";
import {
  newYork,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import { LiveEvaluator } from "../../../packages/market-data/src/evaluator.js";
import { IbkrFeed } from "../../../packages/market-data/src/ibkr.js";
import { MarketStore } from "../../../packages/market-data/src/store.js";

const tickers: unknown = process.env.IBKR_SYMBOLS
  ? process.env.IBKR_SYMBOLS.split(",").map((ticker) => ticker.trim())
  : JSON.parse(
      readFileSync(
        process.env.IBKR_WATCHLIST ?? "config/ibkr-watchlist.json",
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
const unit = process.env.IBKR_VOLUME_UNIT;
if (unit !== "shares" && unit !== "lots")
  throw new Error("Set IBKR_VOLUME_UNIT to match the Gateway's volume setting");
const token = process.env.COLLECTOR_TOKEN;
if (!token || token.length < 32)
  throw new Error("Set a random COLLECTOR_TOKEN of at least 32 characters");
const config: Config = {
  ...defaults,
  ...JSON.parse(process.env.RVOL_CONFIG ?? "{}"),
};
validateConfig(config);
const dbPath = process.env.COLLECTOR_DB ?? "data/local/ibkr.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const store = new MarketStore(dbPath);
const api = Fastify({ logger: false });
let stopping = false;
let failure: string | null = null;
let state = "connecting";
const symbols = new Map<
  string,
  { state: string; lastBar: string | null; evaluation: string | null }
>();
const feed = new IbkrFeed(
  process.env.IBKR_HOST ?? "127.0.0.1",
  Number(process.env.IBKR_PORT ?? 4001),
  (message) => {
    failure = message;
    void stop(1);
  },
);
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  state = "disconnected";
  console.error(JSON.stringify({ state, error: failure, exitCode: code }));
  feed.close();
  await api.close();
  store.close();
  process.exit(code); // Supervisor restarts with a delay; never silent stale operation.
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
  source: "ibkr",
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
api.get("/alerts", async () => ({ source: "ibkr", alerts: store.alerts() }));

async function collect() {
  await feed.connect();
  state = "warming-up";
  for (const ticker of tickers as string[]) {
    const today = newYork(Date.now()).date;
    const dates = previousSessions(today, config.days);
    symbols.set(ticker, {
      state: "warming-up",
      lastBar: null,
      evaluation: null,
    });
    const cached = new Set(store.bars(ticker, dates[0]!).map((b) => b.date));
    for (const date of dates) {
      if (cached.has(date)) continue;
      // 01:00 UTC on the following date is after all included US sessions.
      const next = new Date(`${date}T01:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const end = `${next.toISOString().slice(0, 10).replaceAll("-", "")}-01:00:00`;
      const rows = await feed.history(ticker, end);
      for (const row of rows) {
        const bar = normalize(ticker, row, unit as "shares" | "lots");
        if (bar && Date.parse(bar.end) <= Date.now()) store.put(bar);
      }
      await delay(1200);
    }
    const pending = new ClosedMinutes();
    const evaluator = new LiveEvaluator(config);
    const buffered: RawBar[] = [];
    let ready = false;
    function update(raw: RawBar) {
      try {
        // Validate even the in-progress minute so malformed timestamps cannot
        // poison the pending buffer and silently prevent all later closes.
        normalize(ticker, raw, unit as "shares" | "lots");
        if (!ready) {
          buffered.push(raw);
          return;
        }
        const closed = pending.push(raw);
        if (!closed) return;
        const bar = normalize(ticker, closed, unit as "shares" | "lots");
        if (!bar) return;
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
    }
    const recent = await feed.history(ticker, "", update);
    for (const row of recent.sort((a, b) => a.start - b.start)) {
      const bar = normalize(ticker, row, unit as "shares" | "lots");
      if (bar && Date.parse(bar.end) < Date.now() - 5000) store.put(bar);
      pending.push(row);
    }
    for (const bar of store.bars(ticker, dates[0]!))
      evaluator.push(bar, Date.now(), false);
    ready = true;
    for (const raw of buffered) update(raw);
    symbols.get(ticker)!.state = "subscribed";
    await delay(1200);
  }
  state = "subscribed";
  // Retain 120 calendar days for investigations/replays, with bounded disk growth.
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
  if (process.env.IBKR_ENABLED === "true") {
    await collect();
  } else {
    state = "awaiting-ibkr-activation";
    console.log(JSON.stringify({ state, address: api.server.address() }));
  }
} catch (error) {
  failure = error instanceof Error ? error.message : "Collector startup failed";
  await stop(1);
}
