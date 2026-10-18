// Trade-log charts for the trader study: 1-minute SIP bars (all sessions, 04:00–20:00 ET)
// of the traded stock and SPY on every day a trade was entered, from the read-only Alpaca
// market-data API. Index and futures options use an ETF proxy for the chart.
//
//   node --env-file=.env --import tsx scripts/research/indi-daybars.ts <out.sqlite> <data dir>...
// Reads <dir>/actions.csv; writes bars(symbol, date, bars JSON [t,o,h,l,c,v]) (resumable).
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const [out, ...dirs] = process.argv.slice(2);
const headers = {
  "APCA-API-KEY-ID": process.env.ALPACA_API_KEY ?? "",
  "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET ?? "",
};
if (!headers["APCA-API-KEY-ID"] || !out || !dirs.length)
  throw new Error(
    "usage: indi-daybars.ts <out.sqlite> <dir>... (ALPACA_API_KEY/SECRET set)",
  );

// Chart symbol for an option underlying.
export function chartSymbol(underlying: string): string | null {
  const root = underlying.split(" ")[0]!;
  const proxy: Record<string, string> = {
    SPXW: "SPY",
    SPX: "SPY",
    NDXP: "QQQ",
    NDX: "QQQ",
    VIXW: "VIXY",
    VIX: "VIXY",
    GC: "GLD",
    CL: "USO",
    ZB: "TLT",
  };
  return proxy[root] ?? root;
}

const want = new Set<string>();
for (const dir of dirs) {
  const lines = readFileSync(`${dir}/actions.csv`, "utf8")
    .trim()
    .split("\n")
    .slice(1);
  for (const l of lines) {
    const c = l
      .match(/("([^"]|"")*"|[^,]*)(,|$)/g)!
      .map((x) => x.replace(/,$/, "").replace(/^"|"$/g, ""));
    const [, , contract, date] = c as [string, string, string, string];
    const sym = chartSymbol(contract.replace(/ \S+ \S+$/, ""));
    if (sym) want.add(`${sym}|${date}`);
    want.add(`SPY|${date}`);
  }
}

const db = new DatabaseSync(out);
db.exec(
  `CREATE TABLE IF NOT EXISTS bars (symbol TEXT, date TEXT, bars TEXT, PRIMARY KEY (symbol, date))`,
);
const have = db.prepare("SELECT 1 FROM bars WHERE symbol=? AND date=?");
const put = db.prepare("INSERT OR REPLACE INTO bars VALUES (?, ?, ?)");
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
// 04:00–20:00 New York, expressed in UTC (EDT or EST).
function window(date: string): [string, string] {
  const noon = new Date(`${date}T12:00:00Z`);
  const ny = Number(
    noon.toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
  );
  const offset = 12 - ny; // 4 (EDT) or 5 (EST)
  const at = (hour: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + (hour + offset) * 3600000)
      .toISOString()
      .replace(".000", "");
  return [at(4), at(20)];
}
let fetched = 0,
  empty = 0;
for (const key of [...want].sort()) {
  const [symbol, date] = key.split("|") as [string, string];
  if (have.get(symbol, date)) continue;
  const [start, end] = window(date);
  const all: number[][] = [];
  let token: string | undefined;
  do {
    const q = new URLSearchParams({
      symbols: symbol,
      timeframe: "1Min",
      start,
      end,
      limit: "10000",
      feed: "sip",
      adjustment: "raw",
      sort: "asc",
    });
    if (token) q.set("page_token", token);
    const j = await get(`https://data.alpaca.markets/v2/stocks/bars?${q}`);
    for (const b of (j.bars ?? {})[symbol] ?? [])
      all.push([Date.parse(b.t) / 1000, b.o, b.h, b.l, b.c, b.v]);
    token = j.next_page_token ?? undefined;
  } while (token);
  put.run(symbol, date, JSON.stringify(all));
  fetched++;
  if (!all.length) empty++;
  if (fetched % 100 === 0)
    console.log(JSON.stringify({ fetched, empty, of: want.size }));
}
console.log(JSON.stringify({ done: true, pairs: want.size, fetched, empty }));
