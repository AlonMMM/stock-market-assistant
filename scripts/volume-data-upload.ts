// The Volume bot's backtest data, from the Mac to the app's D1 (the user,
// 2026-10-31: "lets open the volume for backtesting on the app";
// packages/market-data/src/volume-data.ts):
//
//   shock    the shock alerts of every stock in data/local/bars-10s.sqlite,
//            computed with the live rule (strangle/fast.ts fastAlerts with
//            shockRule) on the 20 sessions before each day -> volume_alerts
//   seconds  the research's 1-second Databento windows after its alerts
//            (leg_seconds.py sec_cache): the stocks' last price each second
//            -> stock_seconds, the contracts' books -> option_seconds
//   books    the alert books backfill (data/local/alert-books.sqlite,
//            alert_books_hist: every plan and shock alert of Aug 3 - Oct 30
//            2026, the |delta| 0.10-0.35 calls and puts every 2 s for 300 s,
//            Databento cbbo-1s), shaped like the live trader's alert books
//            -> option_seconds, a window a contract (volume-daily.ts
//            bookWindows, as the scheduled step stores the live ones)
//
//   node --import tsx scripts/volume-data-upload.ts shock|seconds|books --from YYYY-MM-DD --to YYYY-MM-DD [--symbols A,B] [--apply]
//
// Without --apply the SQL files are written (data/local/volume-upload/) and
// counted, nothing is sent; with it each file goes up with `wrangler d1
// execute` from the deploy checkout. `shock --compare FILE` checks the alerts
// against the research's list (sec_cache/eventse_shock15.json) first.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  coreClose,
  newYorkToUtc,
  previousSessions,
} from "../packages/market-data/src/calendar.js";
import {
  bookWindows,
  type TraderBooks,
} from "../packages/market-data/src/volume-daily.js";
import {
  optionSecondsTable,
  stockSecondsTable,
  volumeAlertsTable,
} from "../packages/market-data/src/volume-data.js";
import {
  fastAlerts,
  fastBaseline,
  fastRule,
  fastWindows,
  shockRule,
  type FastDay,
  type FastWindows,
} from "../packages/trading/src/strangle/fast.js";

const MAIN = "/Users/alonmo/Desktop/Personal/stock-market-assistant";
const DEPLOY = "/Users/alonmo/Desktop/Personal/sma-deploy";
const SEC =
  "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt/sec_cache";
const OUT = `${MAIN}/data/local/volume-upload`;
const FILE_BYTES = 4_000_000;
// cbbo-1s starts here; before it the research read cmbp-1 from 30 s before the side.
const SEC1 = "2025-02-20";

const args = process.argv.slice(2);
const step = args[0];
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const from = opt("from", "2024-02-01");
const to = opt("to", "2026-10-30");
const only = opt("symbols", "").split(",").filter(Boolean);
const apply = args.includes("--apply");

function sessions(lo: string, hi: string): string[] {
  const out: string[] = [];
  for (let d = hi; d >= lo; d = previousSessions(d, 1)[0]!)
    if (coreClose(d) !== null) out.unshift(d);
  return out;
}

const pack = (value: unknown) =>
  `gz:${gzipSync(JSON.stringify(value)).toString("base64")}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** SQL files of at most FILE_BYTES each, every one starting with the table. */
function writeFiles(name: string, table: string, lines: string[]): string[] {
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT))
    if (f.startsWith(`${name}_`)) rmSync(`${OUT}/${f}`);
  const files: string[] = [];
  let part: string[] = [];
  let size = 0;
  const flush = () => {
    if (!part.length) return;
    const path = `${OUT}/${name}_${String(files.length).padStart(4, "0")}.sql`;
    writeFileSync(path, `${table};\n${part.join("\n")}\n`);
    files.push(path);
    part = [];
    size = 0;
  };
  for (const line of lines) {
    part.push(line);
    size += line.length;
    if (size >= FILE_BYTES) flush();
  }
  flush();
  return files;
}

function send(files: string[]) {
  const mb = files.reduce((n, f) => n + readFileSync(f).length, 0) / 1e6;
  console.log(
    `${files.length} files, ${mb.toFixed(1)} MB${apply ? "" : " (not sent: add --apply)"}`,
  );
  if (!apply) return;
  for (const f of files) {
    const r = spawnSync(
      "npx",
      [
        "wrangler@4",
        "d1",
        "execute",
        "sma-bars-cache",
        "--remote",
        "--yes",
        "--file",
        f,
      ],
      { cwd: DEPLOY, encoding: "utf8" },
    );
    if (r.status !== 0) {
      console.error(
        `${f} failed:\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-1500)}`,
      );
      process.exit(1);
    }
    console.log(`${f} sent`);
  }
}

// ---- shock: the live rule on the Mac's 10-second bars ----

function shock() {
  const db = new DatabaseSync(`${MAIN}/data/local/bars-10s.sqlite`, {
    readOnly: true,
  });
  const symbols = only.length
    ? only
    : (
        db
          .prepare("SELECT DISTINCT symbol FROM symbol_days ORDER BY symbol")
          .all() as {
          symbol: string;
        }[]
      ).map((r) => r.symbol);
  const read = db.prepare(
    "SELECT start, volume, close FROM bars WHERE symbol = ? AND start >= ? AND start < ? ORDER BY start",
  );
  const days = sessions(previousSessions(from, fastRule.days)[0]!, to);
  const found: {
    symbol: string;
    date: string;
    second: number;
    price: number;
    up: boolean;
  }[] = [];
  const t0 = Date.now();
  for (const [n, symbol] of symbols.entries()) {
    const prior: FastWindows[] = [];
    for (const date of days) {
      const close = coreClose(date)!;
      const openMs = newYorkToUtc(date, 570);
      const rows = read.all(
        symbol,
        Math.floor(openMs / 1000),
        Math.floor(newYorkToUtc(date, close) / 1000),
      ) as { start: number; volume: number; close: number }[];
      // A session in 10-second slots (strangle-fast.ts dayFromBars).
      const today: FastDay = {
        v: new Array(fastRule.slots).fill(0),
        c: new Array(fastRule.slots).fill(null),
      };
      for (const r of rows) {
        const t = Math.floor((r.start * 1000 - openMs) / 10_000);
        if (t < 0 || t >= fastRule.slots) continue;
        today.v[t] = r.volume;
        today.c[t] = r.close;
      }
      if (!rows.length) continue; // no trades: not a session of this stock's history
      const base = date >= from ? fastBaseline(prior) : null;
      if (base)
        for (const a of fastAlerts(today, base, shockRule))
          found.push({
            symbol,
            date,
            second: a.second,
            price: a.price,
            up: a.up,
          });
      prior.push(fastWindows(today));
      if (prior.length > fastRule.days) prior.shift();
    }
    console.error(
      `${symbol}: ${n + 1}/${symbols.length}, ${found.length} alerts (${Math.round((Date.now() - t0) / 1000)} s)`,
    );
  }
  const compare = opt("compare", "");
  if (compare) {
    const theirs = (
      JSON.parse(readFileSync(compare, "utf8")) as {
        date: string;
        sym: string;
        sec0: number;
      }[]
    ).filter(
      (e) =>
        e.date >= from &&
        e.date <= to &&
        (!only.length || only.includes(e.sym)) &&
        symbols.includes(e.sym),
    );
    const key = (d: string, s: string, sec: number) => `${d}|${s}|${sec}`;
    const ours = new Set(found.map((a) => key(a.date, a.symbol, a.second)));
    const theirSet = new Set(theirs.map((e) => key(e.date, e.sym, e.sec0)));
    const both = [...ours].filter((k) => theirSet.has(k)).length;
    console.log(
      `shock alerts vs the research: ours ${ours.size}, theirs ${theirSet.size}, both ${both}; ours only ${[
        ...ours,
      ]
        .filter((k) => !theirSet.has(k))
        .slice(0, 8)
        .join(", ")}; theirs only ${[...theirSet]
        .filter((k) => !ours.has(k))
        .slice(0, 8)
        .join(", ")}`,
    );
  }
  const lines = found.map(
    (a) =>
      `INSERT OR REPLACE INTO volume_alerts (symbol, date, kind, second, price, up) VALUES (${q(a.symbol)}, ${q(a.date)}, 'shock', ${a.second}, ${a.price}, ${a.up ? 1 : 0});`,
  );
  console.log(
    `${found.length} shock alerts, ${symbols.length} stocks, ${from} .. ${to}`,
  );
  send(writeFiles("shock", volumeAlertsTable, lines));
}

// ---- seconds: the research's 1-second windows ----

function csv(path: string): string[][] {
  return gunzipSync(readFileSync(path))
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(","));
}

function seconds() {
  const lines: string[] = [];
  let stocks = 0;
  let options = 0;
  // Stocks: <date>_<SYM>_<minute>.csv.gz (a minute alert: from its close) or
  // _s<second>.csv.gz (a 10-second alert: from its second); 10 minutes each.
  for (const f of readdirSync(`${SEC}/stock`)) {
    const m = /^(\d{4}-\d{2}-\d{2})_([A-Z.]+)_(s?)(\d+)\.csv\.gz$/.exec(f);
    if (!m) continue;
    const [, date, symbol, isSecond, n] = m;
    if (date! < from || date! > to || (only.length && !only.includes(symbol!)))
      continue;
    const start = isSecond ? Number(n) : (Number(n) + 1) * 60;
    const rows = csv(`${SEC}/stock/${f}`).map(([s, c]) => [
      Number(s),
      Number(c),
    ]);
    lines.push(
      `INSERT OR REPLACE INTO stock_seconds (symbol, date, start, end, rows) VALUES (${q(symbol!)}, ${q(date!)}, ${start}, ${start + 600}, ${q(pack(rows))});`,
    );
    stocks++;
  }
  // Options: <date>_<OCC>_<side second>.csv.gz, the book as each second ended.
  for (const f of readdirSync(`${SEC}/opt`)) {
    const m =
      /^(\d{4}-\d{2}-\d{2})_([A-Z.]+\d{6}[CP]\d{8})_(\d+)\.csv\.gz$/.exec(f);
    if (!m) continue;
    const [, date, contract, n] = m;
    const symbol = /^[A-Z.]+/.exec(contract!)![0];
    if (date! < from || date! > to || (only.length && !only.includes(symbol)))
      continue;
    const sec = Number(n);
    const start = date! >= SEC1 ? sec - 2 : sec - 30;
    const rows = csv(`${SEC}/opt/${f}`)
      .map(([s, b, a]) => [Number(s), Number(b), Number(a)])
      .filter(([, b, a]) => b! > 0 && a! > 0);
    if (!rows.length) continue;
    lines.push(
      `INSERT OR REPLACE INTO option_seconds (contract, date, start, end, rows) VALUES (${q(contract!)}, ${q(date!)}, ${start}, ${sec + 14}, ${q(pack(rows))});`,
    );
    options++;
  }
  console.log(
    `${stocks} stock windows, ${options} option windows, ${from} .. ${to}`,
  );
  send(
    writeFiles(
      "seconds",
      `${stockSecondsTable};\n${optionSecondsTable}`,
      lines,
    ),
  );
}

// ---- books: the alert books backfill ----

function books() {
  const db = new DatabaseSync(`${MAIN}/data/local/alert-books.sqlite`, {
    readOnly: true,
  });
  const rows = db
    .prepare(
      "SELECT day, symbol, second, kind, contracts, data FROM alert_books_hist WHERE day BETWEEN ? AND ? ORDER BY day, second",
    )
    .all(from, to) as {
    day: string;
    symbol: string;
    second: number;
    kind: string;
    contracts: string;
    data: string;
  }[];
  const lines: string[] = [];
  let alerts = 0;
  let windows = 0;
  for (const r of rows) {
    if (only.length && !only.includes(r.symbol)) continue;
    const samples = JSON.parse(
      gunzipSync(Buffer.from(r.data.slice(3), "base64")).toString(),
    ) as TraderBooks["samples"];
    const ws = bookWindows({
      day: r.day,
      symbol: r.symbol,
      second: r.second,
      kind: r.kind,
      contracts: JSON.parse(r.contracts) as { symbol: string }[],
      samples,
    });
    alerts++;
    for (const w of ws) {
      lines.push(
        `INSERT OR REPLACE INTO option_seconds (contract, date, start, end, rows) VALUES (${q(w.contract)}, ${q(w.date)}, ${w.start}, ${w.end}, ${q(pack(w.rows))});`,
      );
      windows++;
    }
  }
  console.log(
    `${alerts} alerts' books, ${windows} option windows, ${from} .. ${to}`,
  );
  send(writeFiles("books", optionSecondsTable, lines));
}

if (step === "shock") shock();
else if (step === "books") books();
else if (step === "seconds") seconds();
else {
  console.error(
    "usage: volume-data-upload.ts shock|seconds|books --from --to [--symbols] [--compare FILE] [--apply]",
  );
  process.exit(1);
}
