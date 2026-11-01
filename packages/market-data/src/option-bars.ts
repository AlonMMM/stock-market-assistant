import type { D1Like } from "./bar-cache.js";
import type { MinuteBar } from "../../trading/src/bot/signal.js";

// Option minute bars, kept (the user, 2026-10-31: "Is this volume saved in the
// options database? No. - so save it."): every contract-day the backtest reads
// from Alpaca is stored, next to the real quotes (option-quotes.ts) in the same
// D1, so its volume (contracts traded each minute, the bot's 200-in-30-minutes
// check) and prices stay after Alpaca, and a rerun reads them back instead of
// fetching. Only finished sessions are stored, so a row never changes. One row
// per contract and New York day; `bars` is [[m, o, h, l, c, v], ...] (m = the
// session minute, 09:30 New York = 0), gzipped and base64'd with a "gz:" prefix
// like the bar cache. An empty list is stored too: no trade all day is a fact
// about a finished day, and thin contracts are most of the chain.

export interface OptionBarStore {
  /** Stored days of these contracts on one date, by contract; missing = not stored. */
  get(contracts: string[], date: string): Promise<Map<string, MinuteBar[]>>;
  /** Stores contract-days in one batch. */
  put(
    days: { contract: string; date: string; bars: MinuteBar[] }[],
  ): Promise<void>;
}

export const optionBarsTable =
  "CREATE TABLE IF NOT EXISTS option_bars (contract TEXT NOT NULL, date TEXT NOT NULL, bars TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (contract, date))";

const encode = (bars: MinuteBar[]) =>
  JSON.stringify(bars.map((b) => [b.m, b.o, b.h, b.l, b.c, b.v]));
const decode = (text: string): MinuteBar[] =>
  (JSON.parse(text) as number[][]).map(([m, o, h, l, c, v]) => ({
    m: m!,
    o: o!,
    h: h!,
    l: l!,
    c: c!,
    v: v!,
  }));

async function pack(bars: MinuteBar[]): Promise<string> {
  const stream = new Blob([encode(bars)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `gz:${btoa(binary)}`;
}
async function unpack(text: string): Promise<MinuteBar[]> {
  if (!text.startsWith("gz:")) return decode(text);
  const bytes = Uint8Array.from(atob(text.slice(3)), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return decode(await new Response(stream).text());
}

// D1 binds at most 100 values a statement (contracts per read) and a statement
// stays under 100 KB: a liquid contract's full day packs to ~6 KB, so 10 rows a
// write. Each statement is a Worker subrequest, so the writes go in one batch.
const perRead = 90;
const perInsert = 10;

export class D1OptionBars implements OptionBarStore {
  private ready?: Promise<unknown>;
  constructor(private db: D1Like) {}
  private init() {
    return (this.ready ??= this.db.prepare(optionBarsTable).run());
  }
  async get(contracts: string[], date: string) {
    const out = new Map<string, MinuteBar[]>();
    if (!contracts.length) return out;
    await this.init();
    for (let i = 0; i < contracts.length; i += perRead) {
      const part = contracts.slice(i, i + perRead);
      const { results } = await this.db
        .prepare(
          `SELECT contract, bars FROM option_bars WHERE date = ? AND contract IN (${part.map(() => "?").join(", ")})`,
        )
        .bind(date, ...part)
        .all<{ contract: string; bars: string }>();
      for (const row of results) out.set(row.contract, await unpack(row.bars));
    }
    return out;
  }
  async put(days: { contract: string; date: string; bars: MinuteBar[] }[]) {
    if (!days.length) return;
    await this.init();
    const now = Date.now();
    const rows = await Promise.all(
      days.map(async (d) => [d.contract, d.date, await pack(d.bars), now]),
    );
    const statements = [];
    for (let i = 0; i < rows.length; i += perInsert) {
      const chunk = rows.slice(i, i + perInsert);
      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO option_bars (contract, date, bars, stored_at) VALUES ${chunk
              .map(() => "(?, ?, ?, ?)")
              .join(", ")}`,
          )
          .bind(...chunk.flat()),
      );
    }
    await this.db.batch(statements);
  }
}
