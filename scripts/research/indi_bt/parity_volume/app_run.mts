// The Volume bot's backtest as the Backtest page runs it: POST /api/volume-backtest's
// handler (handleVolumeBacktest, origin/main 08c212d in sma-deploy), one request a
// stock and 20 sessions, the live saved settings, fillPct = defaultFillPct, the
// D1 stores from a read-only snapshot of production D1 (d1_dump.py), Alpaca for
// the stock bars, chains, option bars missing from the snapshot and stock seconds
// missing from it (as the Worker does). Then volumeAccount with volumeMoney(defaultVolumeMoney).
//
//   node --env-file=<repo>/.env --import tsx app_run.ts <d1 copy> <out.json> [from] [to]
import { readFileSync, writeFileSync } from "node:fs";
const D = process.env.APP_DIR ?? "/Users/alonmo/Desktop/Personal/sma-deploy";
const { SqliteD1 } = await import(`${D}/apps/api/src/sqlite-d1.ts`);
const { D1OptionQuotes } = await import(`${D}/packages/market-data/src/option-quotes.ts`);
const { D1OptionBars } = await import(`${D}/packages/market-data/src/option-bars.ts`);
const { D1VolumeData } = await import(`${D}/packages/market-data/src/volume-data.ts`);
const { handleVolumeBacktest } = await import(`${D}/packages/market-data/src/volume-backtest.ts`);
const { volumeAccount } = await import(`${D}/packages/trading/src/strangle/backtest.ts`);
const { strangleWithDefaults, strangleStocks } = await import(`${D}/packages/trading/src/strangle/settings.ts`);
const { periodParts, maxStocks } = await import(`${D}/apps/web/src/bot-backtest-model.ts`);
const { defaultFillPct } = await import(`${D}/packages/trading/src/bot/backtest.ts`);
const { defaultVolumeMoney, volumeMoney } = await import(`${D}/apps/web/src/volume-backtest-model.ts`);

const [dbPath, outPath, from = "2026-07-31", to = "2026-10-30"] = process.argv.slice(2);
// The live saved settings (GET /v1/strangle/settings on the trader, or the connector's volume_bot_settings), read-only.
const SETTINGS = process.env.VOLUME_SETTINGS ?? "strangle_settings.json";
const saved = JSON.parse(readFileSync(SETTINGS, "utf8"));
if (!strangleWithDefaults) throw new Error("strangleWithDefaults not found");
const live = strangleWithDefaults(saved);
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
const tickers: string[] = strangleStocks(live, []).slice(0, maxStocks).filter((t: string) => !only || only.includes(t));
const db = new SqliteD1(dbPath!);
const quotes = new D1OptionQuotes(db);
const optionBars = new D1OptionBars(db);
const volume = new D1VolumeData(db);
const parts = periodParts(from!, to!, 20);
const runs: unknown[] = [];
const errors: string[] = [];
console.error(`${tickers.length} stocks, ${parts.length} parts`, parts);
let n = 0;
const jobs = parts.flatMap((p: { from: string; to: string }) => tickers.map((symbol) => ({ symbol, ...p })));
async function one(job: { symbol: string; from: string; to: string }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await handleVolumeBacktest(
      { symbol: job.symbol, from: job.from, to: job.to, settings: live, fillPct: defaultFillPct },
      { key: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_API_SECRET },
      process.env.ALPACA_TRADING_LIVE === "true" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets",
      fetch,
      Date.now(),
      undefined,
      quotes,
      optionBars,
      volume,
    );
    if (r.status === 200) return r.body;
    if (attempt === 3) throw new Error(`${job.symbol} ${job.from}: ${r.status} ${JSON.stringify(r.body)}`);
    await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
  }
}
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    try {
      runs.push(await one(job));
    } catch (e) {
      errors.push(String(e));
    }
    n++;
    if (n % 20 === 0) console.error(`${n}/${jobs.length}`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const money = volumeMoney(defaultVolumeMoney, live);
const account = volumeAccount(runs as never, money);
writeFileSync(outPath!, JSON.stringify({ settings: live, money, tickers, from, to, errors, runs, account }));
console.log(
  `${account.taken} taken, ${account.won} won, end $${Math.round(account.end)}, drop ${account.maxDrawdownPct.toFixed(1)}%, errors ${errors.length}`,
);
