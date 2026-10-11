// Step 1 of the trader study: downloads the market data around every main-account trade
// extracted from @ultrawavetrader's daily summaries (read-only Alpaca market data).
//   - 1-minute SIP bars, all sessions, for each traded stock, SPY, QQQ and a sector ETF,
//     from 35 days before its first trade to 10 days after its last (baselines + overnight holds);
//   - 1-minute bars of each option contract from its first step to expiry.
// Index options use an ETF proxy for the underlying (SPXW → SPY, NDXP → QQQ).
//
//   node --env-file=.env --import tsx scripts/research/indi-bars.ts <data dir>
// Reads <dir>/actions.csv; writes <dir>/bars.sqlite (resumable). Credentials:
// ALPACA_API_KEY / ALPACA_API_SECRET.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const dir = process.argv[2]!;
const headers = {
  "APCA-API-KEY-ID": process.env.ALPACA_API_KEY ?? "",
  "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET ?? "",
};
if (!headers["APCA-API-KEY-ID"])
  throw new Error("Set ALPACA_API_KEY / ALPACA_API_SECRET");

// Sector benchmark per stock (ETF); index and macro products benchmark against themselves.
export const SECTOR: Record<string, string> = {
  NVDA: "SMH",
  AMD: "SMH",
  AVGO: "SMH",
  MU: "SMH",
  QCOM: "SMH",
  INTC: "SMH",
  SNDK: "SMH",
  SMCI: "SMH",
  MRAM: "SMH",
  AAOI: "SMH",
  LITE: "SMH",
  SOXL: "SMH",
  CBRS: "SMH",
  AAPL: "XLK",
  MSFT: "XLK",
  ORCL: "XLK",
  CSCO: "XLK",
  IBM: "XLK",
  CRWD: "XLK",
  PLTR: "XLK",
  APP: "XLK",
  IONQ: "XLK",
  NBIS: "XLK",
  CRWV: "XLK",
  META: "XLC",
  GOOGL: "XLC",
  RBLX: "XLC",
  AMZN: "XLY",
  TSLA: "XLY",
  BABA: "XLY",
  CVNA: "XLY",
  AEVA: "XLY",
  MRNA: "XLV",
  HIMS: "XLV",
  SCHW: "XLF",
  CBOE: "XLF",
  OWL: "XLF",
  COIN: "XLF",
  CRCL: "XLF",
  RKLB: "UFO",
  ASTS: "UFO",
  SPCX: "UFO",
  MSTR: "IBIT",
  IREN: "IBIT",
};
export const PROXY: Record<string, string> = { SPXW: "SPY", NDXP: "QQQ" };

type Row = { contract: string; account: string; date: string };
const rows: Row[] = readFileSync(`${dir}/actions.csv`, "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) =>
    l
      .match(/("([^"]|"")*"|[^,]*)(,|$)/g)!
      .map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "")),
  )
  .map((c) => ({ account: c[1]!, contract: c[2]!, date: c[3]! }));
const trades = rows.filter(
  (r) => r.account === "silexx" && !r.contract.endsWith("S"),
);

const db = new DatabaseSync(`${dir}/bars.sqlite`);
db.exec(`CREATE TABLE IF NOT EXISTS bars (symbol TEXT, date TEXT, bars TEXT, PRIMARY KEY (symbol, date));
         CREATE TABLE IF NOT EXISTS done (symbol TEXT, start TEXT, end TEXT, PRIMARY KEY (symbol, start, end))`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(url: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (!res.ok)
      throw new Error(
        `${res.status} ${url}: ${(await res.text()).slice(0, 200)}`,
      );
    await sleep(320); // stay under 200 requests/minute
    return res.json();
  }
}
type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };
const nyDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
async function fetchBars(
  kind: "stocks" | "options",
  symbol: string,
  start: string,
  end: string,
) {
  if (
    db
      .prepare("SELECT 1 FROM done WHERE symbol=? AND start=? AND end=?")
      .get(symbol, start, end)
  )
    return -1;
  const all: Bar[] = [];
  let token: string | undefined;
  do {
    const q = new URLSearchParams({
      symbols: symbol,
      timeframe: "1Min",
      start,
      end,
      limit: "10000",
      sort: "asc",
    });
    if (kind === "stocks") {
      q.set("feed", "sip");
      q.set("adjustment", "raw");
    }
    if (token) q.set("page_token", token);
    const base =
      kind === "stocks"
        ? "https://data.alpaca.markets/v2/stocks/bars"
        : "https://data.alpaca.markets/v1beta1/options/bars";
    const j = await get(`${base}?${q}`);
    all.push(...((j.bars ?? {})[symbol] ?? []));
    token = j.next_page_token ?? undefined;
  } while (token);
  const byDate = new Map<string, number[][]>();
  for (const b of all) {
    const d = nyDate(b.t);
    byDate.set(d, [
      ...(byDate.get(d) ?? []),
      [Date.parse(b.t) / 1000, b.o, b.h, b.l, b.c, b.v],
    ]);
  }
  const put = db.prepare("INSERT OR REPLACE INTO bars VALUES (?, ?, ?)");
  for (const [d, list] of byDate) put.run(symbol, d, JSON.stringify(list));
  db.prepare("INSERT OR REPLACE INTO done VALUES (?, ?, ?)").run(
    symbol,
    start,
    end,
  );
  return all.length;
}
const shift = (d: string, n: number) =>
  new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

// ---- stocks and benchmarks ----
const span = new Map<string, [string, string]>();
const want = (s: string, a: string, b: string) => {
  const cur = span.get(s);
  span.set(
    s,
    cur ? [a < cur[0] ? a : cur[0], b > cur[1] ? b : cur[1]] : [a, b],
  );
};
for (const t of trades) {
  const und = t.contract.split(" ")[0]!;
  const stock = PROXY[und] ?? und;
  const a = shift(t.date, -35),
    b = shift(t.date, 10);
  for (const s of [stock, "SPY", "QQQ", SECTOR[und]].filter(
    Boolean,
  ) as string[])
    want(s, a, b);
}
for (const [s, [a, b0]] of [...span].sort()) {
  const b = b0 > today ? today : b0;
  const n = await fetchBars("stocks", s, `${a}T00:00:00Z`, `${b}T23:59:59Z`);
  console.log(JSON.stringify({ stock: s, from: a, to: b, bars: n }));
}

// ---- option contracts ----
const occ = (root: string, expiry: string, strike: number, right: string) =>
  `${root}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${right}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
const contracts = new Map<string, string>();
for (const t of trades) {
  const [und, expiry, sr] = t.contract.split(" ") as [string, string, string];
  const sym = occ(und, expiry, Number(sr.slice(0, -1)), sr.slice(-1));
  const cur = contracts.get(sym);
  if (!cur || t.date < cur) contracts.set(sym, t.date);
}
let missing = 0;
for (const [sym, first] of [...contracts].sort()) {
  const m = sym.match(/(\d{2})(\d{2})(\d{2})[CP]/)!;
  const expiry = `20${m[1]}-${m[2]}-${m[3]}`;
  const n = await fetchBars(
    "options",
    sym,
    `${first}T08:00:00Z`,
    `${expiry}T23:59:59Z`,
  );
  if (n === 0) missing++;
  if (n !== -1) console.log(JSON.stringify({ option: sym, bars: n }));
}
console.log(
  JSON.stringify({
    done: true,
    stocks: span.size,
    options: contracts.size,
    optionsWithoutBars: missing,
  }),
);
