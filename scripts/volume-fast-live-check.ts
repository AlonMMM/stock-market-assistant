// The 60-second alert's live data path on a past session: the 20 prior
// sessions fetched from Alpaca trades (fetchFastDay), then the day replayed
// through FastTape polled every 2 seconds as if live, checked slot by slot as
// StrangleBot.watchFast does. Prints the alerts, for a check against the
// backtest's alert file.
//
//   node --env-file=.env --import tsx scripts/volume-fast-live-check.ts <date> SYM,SYM
import {
  coreClose,
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import {
  carried,
  fastBaseline,
  FastFire,
  fastRule,
  fastState,
  fastWindows,
  paceSums,
} from "../packages/trading/src/strangle/fast.js";
import { AlpacaBotMarket } from "../apps/trader/src/bot-market.js";
import { FastTape, fetchFastDay } from "../apps/trader/src/strangle-fast.js";

const [date, list] = process.argv.slice(2);
if (!date || !list) throw new Error("usage: <date> SYM,SYM");
const market = new AlpacaBotMarket(
  process.env.ALPACA_API_KEY!,
  process.env.ALPACA_API_SECRET!,
);
const symbols = list.split(",");
const openMs = newYorkToUtc(date, 570);
const endMs = newYorkToUtc(date, coreClose(date)!);
const bases = new Map<string, ReturnType<typeof fastBaseline>>();
for (const symbol of symbols) {
  const prior = [];
  for (const d of previousSessions(date, fastRule.days)) {
    const w = await fetchFastDay(
      market,
      symbol,
      newYorkToUtc(d, 570),
      newYorkToUtc(d, coreClose(d)!),
      fastWindows,
    );
    if (w) prior.push(w);
  }
  bases.set(symbol, fastBaseline(prior));
  console.log(`${symbol}: ${prior.length} sessions`);
}
const tape = new FastTape(symbols, openMs, endMs);
const fire = new Map(symbols.map((s) => [s, new FastFire()]));
const done = new Map(symbols.map((s) => [s, -1]));
// Live, polled every 2 seconds; here up to 13:01 in 2-second steps would be
// ~6,000 polls, so the replay polls every 60 seconds (the overlap and the
// slot checks are the same code).
for (let now = openMs + 60_000; now <= newYorkToUtc(date, 781); now += 60_000) {
  await tape.poll(market, now);
  const ready = Math.min(
    Math.floor((tape.cursor - 3_000 - openMs) / 10_000) - 1,
    fastRule.slots - 1,
  );
  for (const symbol of symbols) {
    const base = bases.get(symbol);
    if (!base) continue;
    const day = tape.day(symbol);
    const cf = carried(day.c);
    const cum = paceSums(day.v);
    for (let t = done.get(symbol)! + 1; t <= ready; t++) {
      const st = fastState(day, cf, base, t, cum);
      if (!fire.get(symbol)!.step(t, st.on)) continue;
      if (t < fastRule.firstSlot || t > fastRule.lastSlot) continue;
      console.log(
        `alert ${symbol} slot ${t} ${st.up ? "up" : "down"} at ${cf[t]}`,
      );
    }
    done.set(symbol, ready);
  }
}
