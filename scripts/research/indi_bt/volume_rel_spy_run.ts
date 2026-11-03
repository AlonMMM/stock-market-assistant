// Copied from the app worktree (sma-vol120/scripts/.relspy.ts, run from there: imports are relative to the app repo's scripts/).
// Temporary (not committed). The user, 2026-11-03: "if we will add more trade we can catch more gaint that can cover
// these looses". A plan alert also when the stock's 3-minute volume is high against SPY's: the site's alert rule
// (strangle/alert.ts) with one more way to pass the volume test, stock ratio >= FLOOR and stock ratio / SPY ratio >= K
// (each ratio = the 3-minute window over its 20-session median at that minute). Everything else of the alert (the move,
// 10,000 shares, the candle's side) and of Volume 1.1.0 unchanged. Levels set before the run: K 3 / 4 / 6, FLOOR 2.
// One run a stock and period carries every variant's alerts (each alert is its own signal); each variant keeps its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { memoFetch } from "./.memofetch.js";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";
import { minuteHistory } from "../packages/market-data/src/backtest.js";
import { D1BarCache } from "../packages/market-data/src/bar-cache.js";
import { backtestCalendar, splitDays } from "../packages/market-data/src/bot-backtest.js";
import { newYorkToUtc, nextSessions, previousSessions } from "../packages/market-data/src/calendar.js";
import { D1OptionBars } from "../packages/market-data/src/option-bars.js";
import { D1OptionQuotes } from "../packages/market-data/src/option-quotes.js";
import { AlpacaVolumeData } from "../packages/market-data/src/volume-backtest.js";
import { D1VolumeData } from "../packages/market-data/src/volume-data.js";
import { alertRule, windows, type Windows } from "../packages/trading/src/strangle/alert.js";
import { runVolumeStock } from "../packages/trading/src/strangle/backtest.js";
import { defaultStrangleSettings, parseStrangleSettings } from "../packages/trading/src/strangle/settings.js";
import type { MinuteBar } from "../packages/trading/src/bot/signal.js";

const [path, settingsFile, outDir] = process.argv.slice(2);
const S0 = JSON.parse(readFileSync(settingsFile!, "utf8"));
const parsed = parseStrangleSettings({ ...defaultStrangleSettings, ...S0, version: "1.1.0", shockAgainstUnits: 0, added: [], off: [], mode: "dry" });
if (!parsed.ok) throw new Error(parsed.error);
const s = parsed.value;
export const VARIANTS: { name: string; k: number | null }[] = [{ name: "base", k: null }, { name: "k3", k: 3 }, { name: "k4", k: 4 }, { name: "k6", k: 6 }];
const FLOOR = 2;
const syms = [...new Set(readFileSync(0, "utf8").trim().split(/\s+/))];
const chunks = [["2025-11-03", "2025-12-31"], ["2026-01-02", "2026-02-27"], ["2026-03-02", "2026-04-30"],
  ["2026-05-01", "2026-06-30"], ["2026-07-01", "2026-08-31"], ["2026-09-01", "2026-10-30"]];
const db = new SqliteD1(path!);
const memo = memoFetch(process.env.MEMO_DIR!);
const cache = new D1BarCache(db), optionStore = new D1OptionBars(db), quotes = new D1OptionQuotes(db), store = new D1VolumeData(db);
const key = process.env.ALPACA_API_KEY!, secret = process.env.ALPACA_API_SECRET!;
const now = Date.parse("2026-11-01T12:00:00Z");
const feed = new AlpacaFeed(key, secret, "sip", () => {}, memo);
const history = minuteHistory(feed, cache, now);

const median = (v: number[]) => { const x = [...v].sort((a, b) => a - b); const k = Math.floor(x.length / 2); return x.length % 2 ? x[k]! : (x[k - 1]! + x[k]!) / 2; };
/** The 3-minute window's ratio to its median over the prior sessions at each minute (null: too little history). */
function ratios(w: Windows, hist: Windows[]): (number | null)[] {
  return w.map((cur, m) => {
    const h = hist.map((x) => x[m]).filter((x): x is [number, number] => !!x);
    if (!cur || h.length < alertRule.minSamples) return null;
    const e = median(h.map((x) => x[0]));
    return e > 0 ? cur[0] / e : null;
  });
}
/** alert.ts alerts(), line for line, with the SPY-relative way to pass the volume test when k is set. */
function sidesOf(bars: readonly MinuteBar[], hist: readonly Windows[], spy: (number | null)[], k: number | null) {
  const r = alertRule, W = r.window, w = windows(bars);
  const by = new Map(bars.map((b) => [b.m, b]));
  const out: ("up" | "down" | null)[] = new Array(390).fill(null);
  const pace = (m: number) => r.paceSkipOpen <= m && m <= 389 - r.paceSkipClose;
  let paceVol = 0, paceN = 0;
  for (let m = 0; m < 390; m++) {
    const b = by.get(m), q0 = m - W;
    if (q0 >= 0 && pace(q0) && by.has(q0)) { paceVol += by.get(q0)!.v; paceN++; }
    const cur = w[m];
    if (!cur || !b) continue;
    const [actual, move] = cur;
    const samples = hist.map((h) => h[m]).filter((x): x is [number, number] => !!x);
    if (samples.length < r.minSamples) continue;
    const expected = median(samples.map((x) => x[0]));
    const expectedMove = median(samples.map((x) => x[1]));
    const ratio = expected > 0 ? actual / expected : null;
    let inPace = true;
    for (let q = m - W + 1; q <= m; q++) if (!pace(q)) inPace = false;
    const paceRatio = inPace && paceN >= r.paceMinMinutes && paceVol > 0 ? actual / ((paceVol / paceN) * W) : null;
    let volumeOk = (ratio !== null && ratio >= r.threshold) || (paceRatio !== null && paceRatio >= r.pace);
    const sp = spy[m];
    if (k !== null && ratio !== null && sp && ratio >= FLOOR && ratio / sp >= k) volumeOk = true;
    const moveOk = move >= r.priceMultiple * expectedMove && move >= r.minMovePercent;
    if (!(volumeOk && moveOk && actual >= r.minVolume)) continue;
    const prev = by.get(m - 1)!.c;
    if (b.c > prev && b.c > b.o) out[m] = "up";
    else if (b.c < prev && b.c < b.o) out[m] = "down";
  }
  return out;
}
/** backtest.ts dayAlerts()'s plan part: a fresh burst from firstMinute to lastMinute. */
function planAlerts(bars: readonly MinuteBar[], sides: ("up" | "down" | null)[], last: number) {
  const out: { kind: "plan"; second: number; price: number; up: boolean }[] = [];
  const closes = new Map(bars.map((b) => [b.m, b.c]));
  let first = true;
  for (let m = s.firstMinute; m <= Math.min(s.lastMinute, last); m++) {
    const side = sides[m];
    if (!side) continue;
    const fresh = first || !sides[m - 1];
    first = false;
    const price = closes.get(m);
    if (!fresh || price === undefined) continue;
    out.push({ kind: "plan", second: (m + 1) * 60, price, up: side === "up" });
  }
  return out;
}

mkdirSync(join(outDir!, "parts"), { recursive: true });
for (const symbol of syms)
  for (const [from, to] of chunks) {
    const part = join(outDir!, "parts", `rel_${symbol}_${from}.json`);
    if (existsSync(part)) continue;
    const dates: string[] = [];
    for (let d = from!; d <= to!; d = nextSessions(d, 1)[0]!) if (backtestCalendar.sessionLength(d) !== null) dates.push(d);
    const first = previousSessions(dates[0]!, 25)[0]!;
    const start = new Date(newYorkToUtc(first, 0)).toISOString();
    const end = new Date(newYorkToUtc(nextSessions(dates.at(-1)!, 1)[0]!, 0)).toISOString();
    let body: any = null;
    for (let t = 0; t < 12 && !body; t++)
      try {
        const stocks = new Map([[symbol, splitDays(await history(symbol, start, end))]]);
        const spyDays = splitDays(await history("SPY", start, end));
        const data = new AlpacaVolumeData(stocks, "2026-10-30", { key, secret }, "https://paper-api.alpaca.markets", memo, feed, quotes, optionStore, store);
        const shocks = await data.shockAlerts(symbol, dates[0]!, dates.at(-1)!);
        const member: Record<string, string[]> = {};
        const alertsOf = (sym: string, date: string) => {
          const bars = data.bars(sym, date);
          const length = backtestCalendar.sessionLength(date)!;
          const prior = backtestCalendar.previousSessions(date, 20);
          const hist = prior.map((d) => windows(data.bars(sym, d)));
          const spyBars = (d: string) => spyDays.sessions.get(d) ?? [];
          const spy = ratios(windows(spyBars(date)), prior.map((d) => windows(spyBars(d))));
          const all = new Map<number, { kind: "plan" | "shock"; second: number; price: number; up: boolean }>();
          for (const v of VARIANTS)
            for (const a of planAlerts(bars, sidesOf(bars, hist, spy, v.k), length - 1)) {
              all.set(a.second, a);
              (member[`${sym}|${date}|plan|${a.second}`] ??= []).push(v.name);
            }
          const out = [...all.values()];
          for (const a of shocks) if (a.date === date) out.push({ kind: "shock", second: a.second, price: a.price, up: a.up });
          return out.sort((a, b) => a.second - b.second);
        };
        const run = await runVolumeStock(symbol, dates, s, data, backtestCalendar, { fillPct: 2, strictQuotes: true, safetyStop: false, alerts: alertsOf });
        body = { ...run, member };
      } catch (e) {
        process.stderr.write(`${symbol} ${from} ${String(e)}\n`);
        await new Promise((ok) => setTimeout(ok, 20000 * (t + 1)));
      }
    if (!body) { console.log(symbol, from, "failed"); continue; }
    writeFileSync(part, JSON.stringify(body));
    process.stderr.write(`${symbol} ${from} ${body.signals.length}\n`);
  }
