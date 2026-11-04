// The Main bot on the app's Backtest engine against the research twin
// (research/indi-v2 scripts/research/indi_bt/app_twin.py), trade by trade (the
// user, 2026-11-01: "run the app backtest and the local backtest ... I expect
// it to be the same trade exactly"; "I want them to be align").
//
//   run      the Backtest page's "Same as paper" run: the saved settings ->
//            paperSetup -> handleBotBacktest per stock and 60-session part.
//            Real quotes are read from the site's D1 (wrangler --remote,
//            read-only, cached next to the output).
//   compare  both runs' trades through the app's own account (runAccount) with
//            the live money settings, so a gap is the trades', not the account's.
//
//   node --env-file=.env --import tsx scripts/bot-backtest-compare.ts run <settings.json> <bot.json> <from> <to> <app.json>
//   node --import tsx scripts/bot-backtest-compare.ts compare <app.json> <research.json> <label> <out.json>
//
// settings.json / bot.json: the trader's GET /v1/bot/settings and /v1/bot
// (bot-backtest skill, read-only). ONLY=A,B limits the run to those stocks.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { handleBotBacktest } from "../packages/market-data/src/bot-backtest.js";
import { mergeSources } from "../packages/market-data/src/option-quotes.js";
import { paperUrl } from "../packages/trading/src/alpaca-trading.js";
import {
  defaultMoney,
  runAccount,
} from "../packages/trading/src/bot/backtest-account.js";
import { withDefaults } from "../packages/trading/src/bot/settings.js";
import { paperSetup, periodParts } from "../apps/web/src/bot-backtest-model.js";

const [mode, ...args] = process.argv.slice(2);

async function run() {
  const [settingsFile, botFile, from, to, outFile] = args;
  const settings = withDefaults(
    JSON.parse(readFileSync(settingsFile!, "utf8")),
  );
  const view = JSON.parse(readFileSync(botFile!, "utf8"));
  const live = paperSetup(settings, view.watching);
  const only = process.env.ONLY?.split(",");
  const tickers: string[] = only ?? live.tickers;

  const qcacheFile = `${outFile}.quotes.json`;
  const qcache: Record<string, unknown> = existsSync(qcacheFile)
    ? JSON.parse(readFileSync(qcacheFile, "utf8"))
    : {};
  let qcalls = 0;
  const quotes = {
    async get(contract: string, a: string, z: string) {
      const key = `${contract}|${a}|${z}`;
      if (!(key in qcache)) {
        qcalls++;
        const sql = `SELECT date, source, quotes FROM option_quotes WHERE contract = '${contract.replace(/'/g, "")}' AND date BETWEEN '${a}' AND '${z}' AND source = 'databento'`;
        let text = "";
        for (let i = 0; i < 4; i++) {
          try {
            text = execFileSync(
              "npx",
              [
                "wrangler@4",
                "d1",
                "execute",
                "sma-bars-cache",
                "--remote",
                "--json",
                "--command",
                sql,
              ],
              { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] },
            ).toString();
            break;
          } catch (e) {
            if (i === 3) throw e;
          }
        }
        qcache[key] = JSON.parse(text)[0].results;
        writeFileSync(qcacheFile, JSON.stringify(qcache));
      }
      const rows = qcache[key] as {
        date: string;
        source: string;
        quotes: string;
      }[];
      const byDate = new Map<
        string,
        { source: string; quotes: [number, number, number][] }[]
      >();
      for (const r of rows) {
        const q = r.quotes.startsWith("gz:")
          ? JSON.parse(
              gunzipSync(Buffer.from(r.quotes.slice(3), "base64")).toString(),
            )
          : JSON.parse(r.quotes);
        if (!byDate.has(r.date)) byDate.set(r.date, []);
        byDate.get(r.date)!.push({ source: r.source, quotes: q });
      }
      const out = new Map();
      for (const [d, list] of byDate) {
        const day = mergeSources(list);
        if (day.length) out.set(d, day);
      }
      return out;
    },
  };

  const creds = {
    key: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_API_SECRET,
  };
  const parts = periodParts(from!, to!);
  const trades: any[] = [];
  const skips: any[] = [];
  const noData: Record<string, number> = {};
  const jobs = tickers.flatMap((symbol) =>
    parts.map((p) => ({ symbol, ...p })),
  );
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      const t0 = Date.now();
      const r = await handleBotBacktest(
        { symbol: j.symbol, from: j.from, to: j.to, rules: live.rules },
        creds,
        paperUrl,
        fetch,
        Date.now(),
        undefined,
        quotes,
      );
      if (r.status !== 200 || "error" in r.body) {
        console.log(j.symbol, j.from, r.status, JSON.stringify(r.body));
        continue;
      }
      const body = r.body;
      trades.push(...body.trades);
      skips.push(...body.skips);
      noData[j.symbol] = (noData[j.symbol] ?? 0) + body.noData;
      console.log(
        `${j.symbol} ${j.from}..${j.to}: ${body.trades.length} trades ${body.skips.length} skips ${body.noData} no-data ${((Date.now() - t0) / 1000).toFixed(0)}s q${qcalls}`,
      );
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  const money = {
    ...defaultMoney,
    ...live.money,
    sizeSteps: live.rules.sizeSteps ?? [],
    nightCapPct: live.rules.nightCapPct,
    fillPct: 2,
  };
  const acct = runAccount(trades, money);
  writeFileSync(
    outFile!,
    JSON.stringify(
      {
        version: live.version,
        rules: live.rules,
        money,
        tickers,
        from,
        to,
        trades,
        skips,
        noData,
        account: acct,
      },
      null,
      1,
    ),
  );
  console.log(
    `end $${acct.end.toFixed(0)} pnl $${acct.pnl.toFixed(0)} taken ${acct.taken} wins ${acct.wins} dd ${acct.maxDrawdownPct.toFixed(1)}% trades ${trades.length}`,
  );
}

function compare() {
  const [appFile, resFile, label, outFile] = args;
  const app = JSON.parse(readFileSync(appFile!, "utf8"));
  const res = JSON.parse(readFileSync(resFile!, "utf8"));

  const appPriced = new Map<string, string>();
  for (const t of app.trades)
    appPriced.set(
      `${t.symbol}|${t.date}|${t.minute}|${t.right}|${t.pyramid}`,
      t.priced,
    );
  const researchTrades = res.trades.map((t: any, i: number) => {
    const shift =
      appPriced.get(`${t.sym}|${t.date}|${t.minute}|${t.right}|${t.add}`) ===
      "trades"
        ? 0
        : 1;
    return {
      id: `R|${t.sym}|${t.date}|${i}`,
      symbol: t.sym,
      contract: t.contract,
      right: t.right,
      date: t.date,
      minute: t.minute,
      pyramid: t.add,
      sizeShare: t.add ? 0.5 : 1,
      open: false,
      steps: t.real.map((s: any) => ({
        date: s[0],
        minute: Math.max(s[1] - shift, 0),
        kind: s[2],
        share: s[3],
        price: s[4],
        reason: s[5],
      })),
    };
  });
  const appAcct = runAccount(app.trades, app.money);
  const resAcct = runAccount(researchTrades, app.money);
  const noLimits = { ...app.money, maxBuysPerDay: 1e9, maxOpen: 1e9 };
  const appFree = runAccount(app.trades, noLimits);
  const resFree = runAccount(researchTrades, noLimits);

  const key = (
    sym: string,
    date: string,
    minute: number,
    right: string,
    add: boolean,
  ) => `${sym}|${date}|${minute}|${right}|${add ? "add" : "main"}`;
  const fills = (steps: any[]) =>
    steps
      .filter((s) => s.kind !== "carry")
      .map((s) => ({
        d: s.date,
        m: s.minute,
        k: s.kind,
        q: +s.share.toFixed(3),
        p: +s.price.toFixed(4),
        r: s.reason,
      }));
  const A = new Map<string, any>();
  appAcct.trades.forEach((a: any) =>
    A.set(
      key(
        a.trade.symbol,
        a.trade.date,
        a.trade.minute,
        a.trade.right,
        a.trade.pyramid,
      ),
      a,
    ),
  );
  const B = new Map<string, any>();
  resAcct.trades.forEach((a: any) =>
    B.set(
      key(
        a.trade.symbol,
        a.trade.date,
        a.trade.minute,
        a.trade.right,
        a.trade.pyramid,
      ),
      a,
    ),
  );
  const rows: any[] = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(k),
      b = B.get(k);
    const fa = a ? fills(a.trade.steps) : null,
      fb = b ? fills(b.trade.steps) : null;
    let match = "same";
    let diff = "";
    if (!a) match = "research-only";
    else if (!b) match = "app-only";
    else if (a.trade.contract !== b.trade.contract) {
      match = "contract";
      diff = `${a.trade.contract} vs ${b.trade.contract}`;
    } else {
      const sa = JSON.stringify(fa!.map((f) => [f.d, f.m, f.k, f.q])),
        sb = JSON.stringify(fb!.map((f) => [f.d, f.m, f.k, f.q]));
      if (sa !== sb) {
        match = "exit-time";
        diff = `app ${fa!
          .slice(1)
          .map((f) => `${f.d.slice(5)} m${f.m} ${f.q}`)
          .join(", ")} | research ${fb!
          .slice(1)
          .map((f) => `${f.d.slice(5)} m${f.m} ${f.q}`)
          .join(", ")}`;
      } else {
        const pd = fa!
          .map((f, i) => Math.abs(f.p - fb![i]!.p))
          .reduce((x, y) => Math.max(x, y), 0);
        if (pd > 0.0001) {
          match = "price";
          diff = `largest fill gap $${pd.toFixed(4)}`;
        }
      }
    }
    const [sym, date, minute, right, kind] = k.split("|");
    rows.push({
      sym,
      date,
      minute: +minute!,
      right,
      add: kind === "add",
      match,
      diff,
      contract: a?.trade.contract ?? b?.trade.contract,
      app: a
        ? {
            status: a.status,
            qty: a.qty,
            pnl: Math.round(a.pnl),
            ret: +a.retPct.toFixed(1),
            priced: a.trade.priced,
            fills: fa,
          }
        : null,
      research: b
        ? {
            status: b.status,
            qty: b.qty,
            pnl: Math.round(b.pnl),
            ret: +b.retPct.toFixed(1),
            fills: fb,
          }
        : null,
    });
  }
  rows.sort(
    (x, y) =>
      x.date.localeCompare(y.date) ||
      x.minute - y.minute ||
      x.sym.localeCompare(y.sym),
  );
  const sum = (acct: any) => ({
    end: Math.round(acct.end),
    pnl: Math.round(acct.pnl),
    ret: +acct.returnPct.toFixed(1),
    taken: acct.taken,
    wins: acct.wins,
    dd: +acct.maxDrawdownPct.toFixed(1),
    signals: acct.trades.length,
    curve: acct.curve.map((c: any) => [c.date, Math.round(c.equity)]),
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.match] = (counts[r.match] ?? 0) + 1;
  const out = {
    label,
    from: app.from,
    to: app.to,
    version: app.version,
    tickers: app.tickers.length,
    money: app.money,
    app: sum(appAcct),
    research: sum(resAcct),
    appNoLimits: sum(appFree),
    researchNoLimits: sum(resFree),
    counts,
    rows,
    appSkips: app.skips,
    researchSkips: res.skips,
    priced: app.trades.reduce(
      (m: any, t: any) => ((m[t.priced] = (m[t.priced] ?? 0) + 1), m),
      {},
    ),
  };
  writeFileSync(outFile!, JSON.stringify(out));
  console.log(
    label,
    JSON.stringify(counts),
    "app",
    JSON.stringify({ ...out.app, curve: undefined }),
    "research",
    JSON.stringify({ ...out.research, curve: undefined }),
  );
}

if (mode === "run") await run();
else if (mode === "compare") compare();
else throw new Error("usage: bot-backtest-compare.ts run|compare ...");
