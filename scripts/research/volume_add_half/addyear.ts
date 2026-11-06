// Scratch (not committed): the app's Volume backtest (handleVolumeBacktest, origin/main engine) over the year
// 2025-11-03 .. 2026-10-30 with the saved 1.3.0 settings, the -80% stop, real books only, reading a local
// read-only snapshot of production D1 (SqliteD1). Writes each stock-chunk's run (every alert, with its own
// simulated trade, also the ones the account refuses as busy) to <out>/parts.
//   node --env-file=<main>/.env --import tsx scripts/.addyear.ts <d1.sqlite> <settings.json> <outDir> [SYM,...] [conc]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { memoFetch } from "./.memofetch.js";
import { D1BarCache } from "../packages/market-data/src/bar-cache.js";
import { D1OptionBars } from "../packages/market-data/src/option-bars.js";
import { D1OptionQuotes } from "../packages/market-data/src/option-quotes.js";
import { handleVolumeBacktest } from "../packages/market-data/src/volume-backtest.js";
import { D1VolumeData } from "../packages/market-data/src/volume-data.js";
const [path, settingsFile, outDir, only, concArg] = process.argv.slice(2);
const db = new SqliteD1(path!);
const memo = memoFetch(join(outDir!, "memo"));
const saved = JSON.parse(readFileSync(settingsFile!, "utf8"));
const syms: string[] = only ? only.split(",") : saved.added;
const chunks = [["2025-11-03", "2025-12-31"], ["2026-01-02", "2026-02-27"], ["2026-03-02", "2026-04-30"],
  ["2026-05-01", "2026-06-30"], ["2026-07-01", "2026-08-31"], ["2026-09-01", "2026-10-30"]];
const cache = new D1BarCache(db), optionStore = new D1OptionBars(db), quotes = new D1OptionQuotes(db), store = new D1VolumeData(db);
mkdirSync(join(outDir!, "parts"), { recursive: true });
const jobs = syms.flatMap((symbol) => chunks.map(([from, to]) => ({ symbol, from: from!, to: to! })));
async function one(j: { symbol: string; from: string; to: string }) {
  const part = join(outDir!, "parts", `${j.symbol}_${j.from}.json`);
  if (existsSync(part)) return;
  const t0 = Date.now();
  let r: any;
  for (let k = 0; k < 12; k++) {
    r = await handleVolumeBacktest({ symbol: j.symbol, from: j.from, to: j.to, settings: saved, safetyStop: true },
      { key: process.env.ALPACA_API_KEY!, secret: process.env.ALPACA_API_SECRET! }, "https://paper-api.alpaca.markets",
      memo, Date.parse("2026-11-01T12:00:00Z"), cache, quotes, optionStore, store);
    if (r.status !== 502 && r.status !== 429) break;
    await new Promise((ok) => setTimeout(ok, 20000 * (k + 1)));
  }
  if (r.status !== 200) { console.log(j.symbol, j.from, r.status, JSON.stringify(r.body)); return; }
  writeFileSync(part, JSON.stringify(r.body));
  process.stderr.write(`${j.symbol} ${j.from} ${Math.round((Date.now() - t0) / 1000)}s signals ${r.body.signals.length}\n`);
}
const conc = Number(concArg ?? 1);
let next = 0;
await Promise.all(Array.from({ length: conc }, async () => { while (next < jobs.length) await one(jobs[next++]!); }));
console.log("done", jobs.length);
