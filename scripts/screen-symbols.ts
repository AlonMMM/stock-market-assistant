// Read-only by default. Credentials remain outside Git.
// railway run -- npm run screen:symbols -- --symbols AAPL,PLUG,NVDA --out data/local/universe.json
// Omit --symbols to discover ALL active, tradable Alpaca optionable underlyings.
// --options fetches their 7–30 DTE chains (OPRA required); only use on a shortlist.
// Reports exclusions; this command never changes the live symbol list.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AlpacaUniverse,
  liquidityDefaults,
  optionSpread,
  screenStock,
} from "../packages/market-data/src/universe.js";
import {
  newYork,
  previousSessions,
} from "../packages/market-data/src/calendar.js";

const args = process.argv.slice(2);
const value = (flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const key = process.env.ALPACA_API_KEY;
const secret = process.env.ALPACA_API_SECRET;
if (!key || !secret)
  throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET outside Git");
const client = new AlpacaUniverse(key, secret);
const assets = await client.optionableAssets();
const optionable = new Set(assets.map((a) => a.symbol));
const symbols = [
  ...new Set(
    value("--symbols")
      ?.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean) ?? [...optionable],
  ),
].sort();
if (symbols.some((s) => !/^[A-Z][A-Z0-9. -]{0,9}$/.test(s)))
  throw new Error("Invalid symbol");
if (args.includes("--options") && symbols.length > 250)
  throw new Error(
    "Use --symbols with at most 250 underlyings for chain screening",
  );
const now = Date.now();
const today = newYork(now).date;
const asOf = previousSessions(today, 1)[0]!;
const from = previousSessions(asOf, liquidityDefaults.sessions - 1)[0]!;
const results: ReturnType<typeof screenStock>[] = [];
for (let i = 0; i < symbols.length; i += 100) {
  const batch = symbols.slice(i, i + 100);
  const bars = await client.dailyBars(batch, from, asOf);
  for (const s of batch) results.push(screenStock(s, bars.get(s) ?? [], asOf));
  console.error(
    `Screened ${Math.min(i + 100, symbols.length)} / ${symbols.length}`,
  );
}
const contracts: {
  symbol: string;
  underlying: string;
  spreadPercent: number | null;
  eligible: boolean;
  delta: number | null;
}[] = [];
if (args.includes("--options")) {
  const expiry = (days: number) =>
    new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000)
      .toISOString()
      .slice(0, 10);
  for (const row of results.filter(
    (r) => r.eligible && optionable.has(r.symbol),
  )) {
    const chain = await client.optionChain(row.symbol, expiry(7), expiry(30));
    const observed = Date.now();
    for (const [symbol, snapshot] of Object.entries(chain)) {
      const delta = snapshot.greeks?.delta;
      const spread = optionSpread(snapshot.latestQuote, observed);
      contracts.push({
        symbol,
        underlying: row.symbol,
        ...spread,
        delta: delta ?? null,
        eligible: spread.eligible,
      });
    }
  }
}
const out = value("--out") ?? "data/local/universe.json";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date(now).toISOString(),
      asOf,
      policy: liquidityDefaults,
      optionableSymbols: [...optionable].sort(),
      results,
      contracts,
      notes: [
        "Current universe; do not use it to filter historical runs (survivorship bias).",
        "Option spreads are current OPRA quotes, not historical execution costs.",
        "Eligibility is per contract; one wide contract does not exclude its underlying.",
      ],
    },
    null,
    2,
  ),
);
console.log(
  `${results.filter((r) => r.eligible).length} / ${results.length} pass stock liquidity. Report: ${out}`,
);
