import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { volumeAccount } from "/Users/alonmo/Desktop/Personal/sma-chain-liquidity/packages/trading/src/strangle/backtest.ts";
const S = process.argv[2]!;
const L = JSON.parse(readFileSync(`${S}/live_settings.json`, "utf8"));
const parts = readdirSync(`${S}/volyear/parts`).filter((f) => f.startsWith("pr_")).map((f) => JSON.parse(readFileSync(`${S}/volyear/parts/${f}`, "utf8")));
const a = volumeAccount(parts, { start: 100_000, sizePct: 2, feePerContract: 0.62, maxPerStock: L.maxPerStock, limits: true, maxTradesPerDay: L.maxTradesPerDay, maxOpen: L.maxOpen, dayLossPct: L.dayLossPct });
writeFileSync(`${S}/volyear/taken_ids.json`, JSON.stringify(a.trades.filter((t) => t.status === "taken").map((t) => t.signal.id)));
console.log(a.taken, (a.end / 1000).toFixed(1));
