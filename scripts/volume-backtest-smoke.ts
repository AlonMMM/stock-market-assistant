// One stock through POST /api/volume-backtest's handler on real Alpaca data,
// with the Volume bot's D1 rows from scripts/volume-data-upload.ts loaded into
// a local copy (the user, 2026-10-31: "lets open the volume for backtesting
// on the app"): the shock alerts and 1-second windows the upload wrote.
//
//   node --env-file=.env --import tsx scripts/volume-backtest-smoke.ts SYMBOL FROM TO [settings JSON]
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { D1OptionQuotes } from "../packages/market-data/src/option-quotes.js";
import { handleVolumeBacktest } from "../packages/market-data/src/volume-backtest.js";
import { D1VolumeData } from "../packages/market-data/src/volume-data.js";
import {
  tradeReturn,
  volumeAccount,
} from "../packages/trading/src/strangle/backtest.js";

const [symbol, from, to, settings] = process.argv.slice(2);
const UPLOAD =
  "/Users/alonmo/Desktop/Personal/stock-market-assistant/data/local/volume-upload";
const path = join(mkdtempSync(join(tmpdir(), "vbt-")), "d1.sqlite");
const raw = new DatabaseSync(path);
for (const f of readdirSync(UPLOAD).filter((f) => f.endsWith(".sql")))
  raw.exec(readFileSync(join(UPLOAD, f), "utf8"));
raw.close();
const db = new SqliteD1(path);
const result = await handleVolumeBacktest(
  { symbol, from, to, settings: settings ? JSON.parse(settings) : {} },
  {
    key: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_API_SECRET,
  },
  "https://paper-api.alpaca.markets",
  fetch,
  Date.now(),
  undefined,
  new D1OptionQuotes(db),
  undefined,
  new D1VolumeData(db),
);
if (result.status !== 200 || !("signals" in result.body)) {
  console.log(result.status, result.body);
  process.exit(1);
}
const run = result.body;
const counts: Record<string, number> = {};
for (const s of run.signals) counts[s.outcome] = (counts[s.outcome] ?? 0) + 1;
console.log(`${run.signals.length} alerts`, counts, "ignored:", run.ignored);
for (const s of run.signals.filter((x) => x.trade)) {
  const t = s.trade!;
  console.log(
    `${s.date} ${s.kind} ${s.minute}: ${t.contract} buy ${t.buy.toFixed(2)} (${t.buyPriced}) -> sell ${t.sell.toFixed(2)} (${t.sellPriced}) at ${t.exitMinute}, ${(tradeReturn(t, 0.62) * 100).toFixed(0)}%`,
  );
}
const a = volumeAccount([run], {
  start: 100_000,
  sizePct: 2,
  feePerContract: 0.62,
  maxPerStock: 2,
  limits: true,
  maxTradesPerDay: 15,
  maxOpen: 5,
  dayLossPct: 7.5,
});
console.log(
  `account: ${a.taken} taken, $${Math.round(a.end)}, drop ${a.maxDrawdownPct.toFixed(1)}%`,
);
