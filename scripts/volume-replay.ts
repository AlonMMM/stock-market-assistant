// Replays a past session through the Volume bot end to end (the user,
// 2026-10-28: "run e2e test"): the live StrangleBot with the winner's settings,
// the owner's trading service and its engine on the in-memory broker, on a
// clock that moves one second at a time (the 1-second side watch) with the
// 10-second tick, as on the server. Stock bars, pre-market volume and the
// earnings calendar are the real recorded data the live bot reads; the stocks'
// latest trades come from the backtest's 1-second Databento prints around each
// alert (else 10-second bars, else the last closed minute), so the 15-second
// cross is checked as live. Option bid / ask are synthetic as in bot-replay.ts:
// the recorded 1-minute option bar close -/+ 2%, delta by Black-Scholes. No
// order reaches any account. The bot's trades are set beside the backtest's.
//
//   node --env-file=.env --import tsx scripts/volume-replay.ts <YYYY-MM-DD> [report.md]
//
// VOLUME_REPLAY_STOCKS: the stocks (comma-separated); default the backtest's top 50 below.
// VOLUME_REPLAY_SECONDS: the backtest's 1-second stock folder (sec_cache/stock).
// VOLUME_REPLAY_BACKTEST: leg_seconds.py's STR_DUMP_ALL file, for the comparison.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotTrading } from "../apps/trader/src/bot.js";
import { AlpacaBotMarket } from "../apps/trader/src/bot-market.js";
import { nasdaqEarnings } from "../apps/trader/src/bot-news.js";
import { StrangleBot } from "../apps/trader/src/strangle.js";
import { StrangleStore, tradeCash } from "../apps/trader/src/strangle-store.js";
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
import { defaultStrangleSettings } from "../packages/trading/src/strangle/settings.js";
import { resolveValidator } from "../packages/trading/src/validators.js";

// The backtest's top 50 (strangle_rank.json, research/indi-v2): the stocks production watches.
const TOP50 =
  "QQQ,TSLA,NVDA,AMZN,SPCX,PLTR,AAPL,GOOG,AMD,GOOGL,IWM,NFLX,META,MSFT,IBIT,INTC,ORCL,SOFI,MSTR,F,COIN,WMT,HOOD,MU,CRWV,AVGO,SMCI,MRVL,RGTI,BABA,QBTS,IREN,RKLB,ASTS,SPCE,SNOW,ONDS,NBIS,QCOM,BA,CRM,IONQ,DELL,CSCO,HIMS,USO,SMR,OKLO,UBER,CRWD";

const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const out = args.find((a) => a.endsWith(".md")) ?? `volume-replay-${date}.md`;
if (!date || coreClose(date) === null)
  throw new Error("usage: volume-replay.ts <session date> [report.md]");
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
const clock = () =>
  new Date(now).toLocaleTimeString("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

// ---- the stocks' latest trades ----

// The backtest's 1-second prints around its alerts: "second after 09:30, price" rows.
const secDir =
  process.env.VOLUME_REPLAY_SECONDS ??
  "../sma-indi-backtest/scripts/research/indi_bt/sec_cache/stock";
const seconds = new Map<string, [number, number][]>();
function secondsOf(symbol: string): [number, number][] {
  let rows = seconds.get(symbol);
  if (rows) return rows;
  rows = [];
  if (existsSync(secDir))
    for (const f of readdirSync(secDir))
      if (f.startsWith(`${date}_${symbol}_`))
        for (const line of gunzipSync(readFileSync(join(secDir, f)))
          .toString()
          .split("\n")) {
          const [s, p] = line.split(",");
          if (s && p) rows.push([Number(s), Number(p)]);
        }
  rows.sort((x, y) => x[0] - y[0]);
  seconds.set(symbol, rows);
  return rows;
}
const tenPath = process.env.BOT_REPLAY_10S ?? "data/local/bars-10s.sqlite";
const ten = existsSync(tenPath)
  ? new DatabaseSync(tenPath, { readOnly: true })
  : null;
const tenAt = ten?.prepare(
  "SELECT close FROM bars WHERE symbol = ? AND start >= ? AND start + 10 <= ? ORDER BY start DESC LIMIT 1",
);
const source = { second: 0, ten: 0, minute: 0 };
async function lastPricesAt(symbols: string[]): Promise<Map<string, number>> {
  const t = Math.floor(now / 1000);
  const open = Math.floor(newYorkToUtc(date!, 570) / 1000);
  const sec = t - open;
  const out = new Map<string, number>();
  for (const s of symbols) {
    // A second's print counts once that second is over; within 60 s of the last one.
    const rows = secondsOf(s);
    let got: number | null = null;
    for (let i = rows.length - 1; i >= 0; i--)
      if (rows[i]![0] < sec) {
        if (sec - rows[i]![0] <= 60) got = rows[i]![1];
        break;
      }
    if (got !== null) {
      out.set(s, got);
      source.second++;
      continue;
    }
    const row = tenAt?.get(s, open, t) as { close: number } | undefined;
    if (row) {
      out.set(s, row.close);
      source.ten++;
      continue;
    }
    source.minute++;
    const c = await stockAt(s, sessionMinute() - 1);
    if (c !== null) out.set(s, c);
  }
  return out;
}
const replayMarket = new Proxy(market, {
  get(target, prop) {
    if (prop === "lastPrices") return lastPricesAt;
    const v = Reflect.get(target, prop) as unknown;
    return typeof v === "function" ? v.bind(target) : v;
  },
});

// ---- the bot, with production's settings ----

const store = new StrangleStore(
  join(mkdtempSync(join(tmpdir(), "volume-replay-")), "strangle.sqlite"),
);
const bot = new StrangleBot({
  store,
  market: replayMarket,
  trading,
  account: "owner-strangle",
  notify: async (title, lines) => {
    posts.push(`${clock()} ${[title, ...lines].join(" | ")}`);
  },
  earnings: (d) => nasdaqEarnings(d),
  now: () => now,
  log: (line) => events.push(`${clock()} ${line}`),
});
const stocks = (process.env.VOLUME_REPLAY_STOCKS ?? TOP50).split(",");
bot.setSettings({
  ...defaultStrangleSettings,
  enabled: true,
  mode: "live",
  followFavorites: false,
  added: stocks,
  sizePct: 2,
  delta: 0.2,
  // The 2026-10-29 plan: no limits (2 trades a stock stays), the same-week expiry on.
  maxOpen: 50,
  maxTradesPerDay: 100,
  dayLossPct: 100,
});

// ---- the clock: the side watch every second, the tick every 10 ----

const close = coreClose(date)!;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
for (let wall = 565; wall <= close + 15; wall++) {
  for (let sec = 0; sec < 60; sec++) {
    now = newYorkToUtc(date, wall) + sec * 1000;
    await bot.watchSides();
    if (sec % 10 === 0) {
      const held = (await broker.positions()).map((p) => p.symbol);
      for (const s of held) await quoteNow(s);
      await bot.tick();
    }
    await settle();
  }
  if (wall % 30 === 0) process.stderr.write(`${clock()} `);
}
process.stderr.write("\n");

// ---- the report: the bot's trades beside the backtest's ----

const hm = (m: number) => {
  const t = 570 + m;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const trades = store.recentTrades(date).filter((t) => t.day === date);
const rows = trades.map((t) => {
  const cash = t.leg ? tradeCash(t) : null;
  return `| ${t.symbol} | ${hm(t.alertMinute + 1)} | ${t.burst === null || t.burst === undefined ? "—" : t.burst.toFixed(2)} | ${t.side ?? "—"} | ${t.sideMinute === null ? "—" : hm(t.sideMinute)} | ${t.leg?.contract ?? "—"} | ${cash ? `$${Math.round(cash.paid)} → $${Math.round(cash.got)}` : "—"} | ${t.closeReason ?? t.phase} |`;
});
const backtest = process.env.VOLUME_REPLAY_BACKTEST
  ? (
      JSON.parse(readFileSync(process.env.VOLUME_REPLAY_BACKTEST, "utf8")) as {
        date: string;
        sym: string;
        side: string;
        minute: number;
        bm: number;
        xm: number;
        news_skip: number;
      }[]
    ).filter((t) => t.date === date && !t.news_skip)
  : [];
const bought = trades.filter((t) => t.leg && t.leg.bought > 0);
const matched = backtest.filter((b) =>
  bought.some(
    (t) =>
      t.symbol === b.sym &&
      t.side === b.side &&
      Math.abs((t.sideMinute ?? -9) - b.bm) <= 1,
  ),
);
const lines = [
  `# Volume bot replay, ${date}`,
  "",
  "The live Volume bot (the winner's rules, production's settings: the top 50, 2%, delta 0.20, no limits, same-week expiries) and the trading",
  "service on an in-memory broker, second by second. Stock bars, pre-market and earnings are the recorded data; the",
  "stocks' latest trades are the backtest's 1-second prints where it has them; option bid / ask are the recorded",
  "1-minute option bar close -/+ 2% (not the real spread). Times are New York.",
  "",
  `Account: $100,000 -> $${Math.round(await broker.equity()).toLocaleString("en-US")}. Latest-trade source: ${source.second} from 1-second prints, ${source.ten} from 10-second bars, ${source.minute} from the last closed minute.`,
  "",
  `Bought ${bought.length}; the backtest's trades that day (before its account): ${backtest.length}, of them bought here (same stock, side, minute ±1): ${matched.length}.`,
  "",
  "| Stock | Alert | Burst | Side | Side at | Contract | Paid → got | Outcome |",
  "|---|---|---|---|---|---|---|---|",
  ...rows,
  "",
  "## The backtest's trades that day",
  "",
  ...backtest.map(
    (b) =>
      `- ${b.sym} ${b.side} alert ${hm(b.minute + 1)}, bought ${hm(b.bm)}, sold ${hm(b.xm + 1)}${matched.includes(b) ? "" : " (not bought here)"}`,
  ),
  "",
  "## Signals",
  "",
  ...store
    .signals(date)
    .map(
      (s) =>
        `- ${s.symbol} ${hm(s.minute + 1)}: ${s.outcome} ${s.detail ?? ""}`,
    ),
  "",
  "## Posts",
  "",
  ...posts.map((p) => `- ${p.replace(/\n+/g, " / ")}`),
  "",
  "## Log",
  "",
  ...events.map((e) => `- ${e}`),
];
writeFileSync(out, lines.join("\n"));
console.log(
  `wrote ${out}: bought ${bought.length}, backtest ${backtest.length}, matched ${matched.length}`,
);
