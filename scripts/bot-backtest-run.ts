// Runs the app's Main bot backtest (POST /api/bot-backtest) from the command
// line, with the account applied as the Backtest page does:
//
//   node --env-file=.env --import tsx scripts/bot-backtest-run.ts <SYMBOL[,SYMBOL]> <from> <to> [version]
import { handleBotBacktest } from "../packages/market-data/src/bot-backtest.js";
import {
  defaultMoney,
  runAccount,
} from "../packages/trading/src/bot/backtest-account.js";
import type { SimTrade } from "../packages/trading/src/bot/backtest.js";
import { paperUrl } from "../packages/trading/src/alpaca-trading.js";
import {
  versionById,
  currentVersion,
} from "../packages/trading/src/bot/versions.js";

const [symbols, from, to, version = currentVersion] = process.argv.slice(2);
if (!symbols || !from || !to)
  throw new Error("usage: bot-backtest-run.ts <SYMBOLS> <from> <to> [version]");
const rules = versionById(version)?.rules;
if (!rules) throw new Error(`unknown version ${version}`);
const credentials = {
  key: process.env.ALPACA_API_KEY,
  secret: process.env.ALPACA_API_SECRET,
};
const trades: SimTrade[] = [];
for (const symbol of symbols.split(",")) {
  const t0 = Date.now();
  const r = await handleBotBacktest(
    { symbol, from, to, rules },
    credentials,
    paperUrl,
  );
  if (r.status !== 200) {
    console.log(symbol, r.status, r.body);
    continue;
  }
  const body = r.body as Extract<typeof r.body, { trades: unknown }>;
  console.log(
    `${symbol}: ${body.trades.length} trades, ${body.skips.length} skips, ${body.noData} days without data, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  for (const s of body.skips)
    console.log(
      `  skip ${s.date} ${s.minute} ${s.right} ${s.reason} ${s.detail}`,
    );
  trades.push(...body.trades);
}
const acct = runAccount(trades, {
  ...defaultMoney,
  nightCapPct: rules.nightCapPct,
});
for (const a of acct.trades) {
  const t = a.trade;
  console.log(
    `${t.date} ${t.symbol} ${t.right} ${t.contract} m${t.minute} t${t.t.toFixed(2)}${t.bonus ? " D2" : ""}${t.pyramid ? " PYR" : ""} ${a.status} qty ${a.qty} pnl ${a.pnl.toFixed(0)} (${a.retPct.toFixed(0)}%)${a.open ? " OPEN" : ""}`,
  );
  for (const f of a.fills)
    console.log(
      `    ${f.date} m${f.minute} ${f.kind} ${f.qty} @${f.price.toFixed(2)} ${f.reason}`,
    );
}
console.log(
  `end $${acct.end.toFixed(0)} pnl $${acct.pnl.toFixed(0)} (${acct.returnPct.toFixed(1)}%) taken ${acct.taken} wins ${acct.wins} dd ${acct.maxDrawdownPct.toFixed(1)}%`,
);
