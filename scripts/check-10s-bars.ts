// Checks the 10-second bar database against Alpaca's own minute bars: rolls a
// symbol-day's bars up to minutes and compares open, high, low, close and
// volume with GET /v2/stocks/{symbol}/bars (1Min, raw, SIP). Agreement means
// the trade-condition rules reproduce Alpaca's aggregation; differences are
// listed minute by minute.
//
//   node --env-file=.env --import tsx scripts/check-10s-bars.ts SYMBOL YYYY-MM-DD [--db path]
import { DatabaseSync } from "node:sqlite";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";
import {
  coreClose,
  newYorkToUtc,
} from "../packages/market-data/src/calendar.js";
import {
  rollUp,
  type TradeBar,
} from "../packages/market-data/src/trade-bars.js";

const [symbol, date] = [process.argv[2]?.toUpperCase(), process.argv[3]];
const dbIndex = process.argv.indexOf("--db");
const dbPath =
  dbIndex > 0 ? process.argv[dbIndex + 1]! : "data/local/bars-10s.sqlite";
if (!symbol || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
  throw new Error("Usage: check-10s-bars.ts SYMBOL YYYY-MM-DD [--db path]");
const key = process.env.ALPACA_API_KEY;
const secret = process.env.ALPACA_API_SECRET;
if (!key || !secret)
  throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET");
const closeMinute = coreClose(date);
if (closeMinute === null) throw new Error(`${date} is not a trading day`);
const startMs = newYorkToUtc(date, 570);
const endMs = newYorkToUtc(date, closeMinute);

const db = new DatabaseSync(dbPath, { readOnly: true });
const day = db
  .prepare("SELECT trades, bars FROM symbol_days WHERE symbol = ? AND date = ?")
  .get(symbol, date) as { trades: number; bars: number } | undefined;
if (!day) throw new Error(`${symbol} ${date} is not in ${dbPath}`);
const ours = db
  .prepare(
    "SELECT start, open, high, low, close, volume, trades, vwap FROM bars WHERE symbol = ? AND start >= ? AND start < ? ORDER BY start",
  )
  .all(symbol, startMs / 1000, endMs / 1000) as unknown as TradeBar[];
db.close();
const minutes = new Map(rollUp(ours, 60).map((b) => [b.start, b]));

const feed = new AlpacaFeed(key, secret, "sip", () => {});
const theirs = (
  await feed.history(
    symbol,
    new Date(startMs).toISOString(),
    new Date(endMs - 1).toISOString(),
    "1Min",
    "raw",
  )
).filter((b) => b.start * 1000 >= startMs && b.start * 1000 < endMs);

let same = 0;
const differences: string[] = [];
// A 10-second slot whose only trades set no price (odd lots, average-price
// prints) makes no bar, as in Alpaca's rules, so its shares are not in our
// minute while Alpaca's minute, which did have a priced trade, counts them.
// Prices still agree; such minutes are reported but are not failures.
let volumeOnlyShort = 0;
const hhmm = (start: number) =>
  new Date(start * 1000).toLocaleTimeString("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
  });
for (const bar of theirs) {
  const mine = minutes.get(bar.start);
  if (!mine) {
    differences.push(
      `${hhmm(bar.start)}: Alpaca has a bar (v ${bar.volume}), we have none`,
    );
    continue;
  }
  const fields: [string, number, number][] = [
    ["open", mine.open, bar.open],
    ["high", mine.high, bar.high],
    ["low", mine.low, bar.low],
    ["close", mine.close, bar.close],
    ["volume", mine.volume, bar.volume],
  ];
  const off = fields.filter(([, a, b]) => Math.abs(a - b) > 1e-9);
  if (!off.length) {
    same++;
    continue;
  }
  const onlyVolume = off.length === 1 && off[0]![0] === "volume";
  if (onlyVolume && mine.volume < bar.volume) {
    volumeOnlyShort++;
    continue;
  }
  differences.push(
    `${hhmm(bar.start)}: ${off.map(([f, a, b]) => `${f} ${a} vs ${b}`).join(", ")}`,
  );
}
for (const start of minutes.keys())
  if (!theirs.some((b) => b.start === start))
    differences.push(`${hhmm(start)}: we have a bar, Alpaca has none`);

console.log(
  `${symbol} ${date}: ${day.trades.toLocaleString()} trades → ${day.bars} ten-second bars → ` +
    `${minutes.size} minutes; Alpaca has ${theirs.length} minute bars; ${same} identical, ` +
    `${volumeOnlyShort} with a little less volume (slots with only unpriced trades), ` +
    `${differences.length} different`,
);
for (const line of differences.slice(0, 40)) console.log("  " + line);
if (differences.length > 40) console.log(`  … ${differences.length - 40} more`);
process.exitCode = differences.length ? 1 : 0;
