// Replays a past session through the Indi bot end to end
// (docs/tasks/test-bot-replay.md): the bot, the owner's trading service and
// its engine run as on the server, on the in-memory broker, on a clock that
// moves one minute at a time. Stock bars, pre-market volume and the earnings
// calendar are the real recorded data the live bot reads; option quotes are
// built from the day's recorded 1-minute option bars (Alpaca has no
// historical option quotes): bid and ask are the last bar's close -/+ 2%, the
// backtest's fill cost; a buy fills at the ladder's ceiling, a sale at the
// bid; delta is Black-Scholes from that price. No order
// reaches any account; Telegram posts are kept in the report.
//
//   node --env-file=.env --import tsx scripts/bot-replay.ts <YYYY-MM-DD> [report.md] [--no-favorites]
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndiBot, type BotTrading } from "../apps/trader/src/bot.js";
import { AlpacaBotMarket } from "../apps/trader/src/bot-market.js";
import { nasdaqEarnings } from "../apps/trader/src/bot-news.js";
import { BotStore } from "../apps/trader/src/bot-store.js";
import { TraderService } from "../apps/trader/src/service.js";
import { TradeStore } from "../apps/trader/src/store.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
} from "../packages/market-data/src/calendar.js";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";
import { TradeEngine } from "../packages/trading/src/engine.js";
import { TelegramNotifier } from "../packages/trading/src/notifier.js";
import {
  ceilingPrice,
  parseOccSymbol,
} from "../packages/trading/src/options.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";
import { resolveValidator } from "../packages/trading/src/validators.js";

const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const out = args.find((a) => a.endsWith(".md")) ?? `bot-replay-${date}.md`;
const withFavorites = !args.includes("--no-favorites");
if (!date || coreClose(date) === null)
  throw new Error("usage: bot-replay.ts <session date> [report.md]");
const key = process.env.ALPACA_API_KEY ?? process.env.APCA_API_KEY_ID;
const secret = process.env.ALPACA_API_SECRET ?? process.env.APCA_API_SECRET_KEY;
if (!key || !secret)
  throw new Error("Need ALPACA_API_KEY and ALPACA_API_SECRET");
const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };

const HALF_SPREAD = 0.02; // the backtest's fill cost (sim.SH)
const BAR_MAX_AGE = 10; // minutes; the backtest's bar_max_age
const RATE = 0.04;

let now = newYorkToUtc(date, 560);
const sessionMinute = () => {
  const { date: d, minute } = newYork(now);
  return d === date ? minute - 570 : -1;
};

// ---- recorded option bars -> quotes ----

async function getJson(url: URL) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url.pathname} failed (${r.status})`);
  return r.json();
}

const contractLists = new Map<string, string[]>();
async function contracts(u: string, right: string, from: string, to: string) {
  const k = `${u}|${right}|${from}|${to}`;
  let list = contractLists.get(k);
  if (list) return list;
  list = [];
  for (const status of ["active", "inactive"]) {
    let page: string | undefined;
    do {
      const url = new URL(
        "/v2/options/contracts",
        "https://paper-api.alpaca.markets",
      );
      url.searchParams.set("underlying_symbols", u);
      url.searchParams.set("type", right);
      url.searchParams.set("status", status);
      url.searchParams.set("expiration_date_gte", from);
      url.searchParams.set("expiration_date_lte", to);
      url.searchParams.set("limit", "10000");
      if (page) url.searchParams.set("page_token", page);
      const body = (await getJson(url)) as {
        option_contracts?: { symbol: string }[];
        next_page_token?: string | null;
      };
      for (const c of body.option_contracts ?? []) list.push(c.symbol);
      page = body.next_page_token ?? undefined;
    } while (page);
  }
  contractLists.set(k, list);
  return list;
}

const optionDays = new Map<string, MinuteBar[]>();
async function loadOptionBars(symbols: string[]) {
  const need = symbols.filter((s) => !optionDays.has(s));
  for (let i = 0; i < need.length; i += 100) {
    const part = need.slice(i, i + 100);
    for (const s of part) optionDays.set(s, []);
    let page: string | undefined;
    do {
      const url = new URL(
        "/v1beta1/options/bars",
        "https://data.alpaca.markets",
      );
      url.searchParams.set("symbols", part.join(","));
      url.searchParams.set("timeframe", "1Min");
      url.searchParams.set(
        "start",
        new Date(newYorkToUtc(date!, 570)).toISOString(),
      );
      url.searchParams.set(
        "end",
        new Date(newYorkToUtc(date!, 960)).toISOString(),
      );
      url.searchParams.set("limit", "10000");
      if (page) url.searchParams.set("page_token", page);
      const body = (await getJson(url)) as {
        bars?: Record<string, { t: string; c: number; v: number }[]>;
        next_page_token?: string | null;
      };
      for (const [s, rows] of Object.entries(body.bars ?? {}))
        for (const b of rows) {
          const m = newYork(Date.parse(b.t)).minute - 570;
          optionDays
            .get(s)!
            .push({ m, o: b.c, h: b.c, l: b.c, c: b.c, v: b.v });
        }
      page = body.next_page_token ?? undefined;
    } while (page);
  }
}

const stockDays = new Map<string, MinuteBar[]>();
async function stockAt(symbol: string, minute: number) {
  let bars = stockDays.get(symbol);
  if (!bars) {
    bars = (await market.bars([symbol], date!, 0, 389)).get(symbol) ?? [];
    stockDays.set(symbol, bars);
  }
  return lastBar(bars, minute)?.c ?? null;
}

function lastBar(bars: MinuteBar[], minute: number, maxAge = 390) {
  let best: MinuteBar | undefined;
  for (const b of bars) if (b.m <= minute) best = b;
  return best && minute - best.m <= maxAge ? best : undefined;
}

const cdf = (x: number) => {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
};
function bs(s: number, k: number, t: number, v: number, call: boolean) {
  const d1 = (Math.log(s / k) + (RATE + (v * v) / 2) * t) / (v * Math.sqrt(t));
  const d2 = d1 - v * Math.sqrt(t);
  if (call)
    return [s * cdf(d1) - k * Math.exp(-RATE * t) * cdf(d2), cdf(d1)] as const;
  return [
    k * Math.exp(-RATE * t) * cdf(-d2) - s * cdf(-d1),
    cdf(d1) - 1,
  ] as const;
}
/** |delta| from the implied volatility of a price (store.py iv_delta). */
function delta(price: number, s: number, k: number, t: number, call: boolean) {
  let lo = 0.01,
    hi = 6;
  if (!(bs(s, k, t, lo, call)[0] < price && price < bs(s, k, t, hi, call)[0]))
    return null;
  let m = lo;
  for (let i = 0; i < 60; i++) {
    m = (lo + hi) / 2;
    if (bs(s, k, t, m, call)[0] < price) lo = m;
    else hi = m;
  }
  return Math.abs(bs(s, k, t, m, call)[1]);
}

/** Puts a contract's quote at the current minute on the broker; false when it has none. */
async function quoteNow(symbol: string) {
  await loadOptionBars([symbol]);
  // The last complete minute: the bar of the minute now running is not out yet.
  const minute = sessionMinute() - 1;
  const b = lastBar(optionDays.get(symbol) ?? [], minute, BAR_MAX_AGE);
  const c = parseOccSymbol(symbol);
  const spot = await stockAt(c.underlying, minute);
  if (!b || spot === null) return false;
  const years =
    Math.max(newYorkToUtc(c.expiry, 960) - now, 600_000) / (365 * 86400_000);
  const d = delta(b.c, spot, c.strike, years, c.right === "call");
  const bid = Math.max(0.01, Math.round(b.c * (1 - HALF_SPREAD) * 100) / 100);
  const ask = Math.round(b.c * (1 + HALF_SPREAD) * 100) / 100;
  // A buy fills once the ladder reaches its ceiling (85% of mid -> ask).
  broker.fillAt.set(symbol, ceilingPrice({ bid, ask }));
  broker.setQuote(symbol, bid, ask, d === null ? null : d, now);
  broker.stocks.set(c.underlying, spot);
  return true;
}

// ---- the owner's service on the in-memory broker ----

const posts: string[] = [];
const broker = new SimBroker(100_000);
const tradeStore = new TradeStore(":memory:");
const notifier = new TelegramNotifier({
  send: async (html) => {
    posts.push(`${clock()} ${html.replace(/<[^>]+>/g, "")}`);
    return { ok: true, messageId: posts.length };
  },
});
const validator = resolveValidator("owner-v1", undefined);
const engine = new TradeEngine({
  broker,
  notifier,
  posts: tradeStore.posts("owner"),
  buys: tradeStore.buys("owner"),
  decisions: tradeStore.decisions("owner"),
  limits: validator.limits,
  riskRules: validator.riskRules,
  validate: validator.check,
  enabled: true,
  now: () => now,
  sleep: async () => {},
});
const service = new TraderService({
  userId: "owner",
  store: tradeStore,
  engine,
  broker,
  notifier,
  posts: tradeStore.posts("owner"),
  now: () => now,
});

const market = new AlpacaBotMarket(key, secret, "sip");
const trading: BotTrading = {
  async chain(u, right, from, to) {
    const list = await contracts(u, right, from, to);
    const spot = await stockAt(u, sessionMinute() - 1);
    // Strikes within 30% of the stock, as the backtest downloads them.
    const near = list.filter((s) => {
      const k = parseOccSymbol(s).strike;
      return spot !== null && Math.abs(k / spot - 1) <= 0.3;
    });
    await loadOptionBars(near);
    for (const s of near) await quoteNow(s);
    return broker.chain(u, right, from, to);
  },
  async quote(c) {
    await quoteNow(c);
    return broker.quote(c);
  },
  async held(c) {
    const p = await broker.position(c).catch(() => null);
    return p && p.qty > 0 ? p : null;
  },
  equity: () => broker.equity(),
  buy: (b) => service.buy(b),
  sell: (b) => service.sell(b),
  job: (id) => service.job(id),
};

const events: string[] = [];
const clock = () => {
  const t = new Date(now);
  return t.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
  });
};
const store = new BotStore(
  join(mkdtempSync(join(tmpdir(), "bot-replay-")), "bot.sqlite"),
);
const universe = (
  JSON.parse(readFileSync("config/bot-universe.json", "utf8")) as {
    symbols: string[];
  }
).symbols;
const bot = new IndiBot({
  store,
  market,
  trading,
  notify: async (title, lines) => {
    posts.push(`${clock()} ${[title, ...lines].join(" | ")}`);
  },
  universe,
  earnings: (d) => nasdaqEarnings(d),
  mode: "live",
  enabled: true,
  now: () => now,
  log: (line) => events.push(`${clock()} ${line}`),
});
if (withFavorites && process.env.BOT_REPLAY_FAVORITES)
  bot.setWatchlist(
    "favorites",
    process.env.BOT_REPLAY_FAVORITES.split(",").map((s) => s.trim()),
  );

// ---- the clock ----

const close = coreClose(date)!;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
for (let wall = 565; wall <= close + 15; wall++) {
  now = newYorkToUtc(date, wall) + 20_000;
  // Held contracts and open orders see this minute's prices first.
  const held = (await broker.positions()).map((p) => p.symbol);
  for (const s of held) await quoteNow(s);
  await bot.tick();
  await settle();
  if (wall % 30 === 0) process.stderr.write(`${clock()} `);
}
process.stderr.write("\n");

// ---- the report ----

const status = bot.status() as unknown as Record<string, unknown>;
const positions = store.recentPositions(date);
const left = await broker.positions();
const lines = [
  `# Bot replay, ${date}`,
  "",
  "The live bot and trading service on an in-memory broker, minute by minute.",
  "Stock bars, pre-market and earnings are the recorded data; option bid/ask are synthetic:",
  `the recorded 1-minute option bar close -/+ ${HALF_SPREAD * 100}%, delta by Black-Scholes. Times are Israel time.`,
  "",
  `Account: $100,000 -> $${Math.round(await broker.equity()).toLocaleString("en-US")}` +
    (left.length
      ? ` (still holding ${left.map((p) => `${p.qty} ${p.symbol}`).join(", ")}, at the bid)`
      : ""),
  "",
  "## Bot positions",
  "",
  "```",
  JSON.stringify(positions, null, 1),
  "```",
  "",
  "## Bot feed",
  "",
  ...store
    .events(1000)
    .reverse()
    .map(
      (e) =>
        `- ${e.at ? new Date(e.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" }) : ""} ${e.kind}: ${e.text}`,
    ),
  "",
  "## Telegram posts",
  "",
  ...posts.map((p) => `- ${p.replace(/\n+/g, " / ")}`),
  "",
  "## Log",
  "",
  ...events.map((e) => `- ${e}`),
];
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out}`);
void status;
