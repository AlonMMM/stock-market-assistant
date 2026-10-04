// Cloud cache of computed backtest results, shared by the site (Worker), the
// local API and the offline backtest script. Lives in the D1 database next to
// the bar cache (a local SQLite file stands in for it when run locally).
//
// backtest_parts holds each symbol's computed part (BacktestRun.compute);
// backtest_runs holds complete offline runs. Keys are SHA-256 over everything a
// result depends on: the rule version, the evaluation code version, the dates
// and their data window, the rule and scoring settings, and the symbol (or the
// sorted symbol list for a run). Values are gzipped JSON in base64, split into
// rows below D1's 100 KB statement limit.
import { ruleVersion } from "../../alerts/src/relative-volume.js";
import type { D1Like, D1Statement } from "./bar-cache.js";
import {
  decodePart,
  encodePart,
  type BacktestRequest,
  type BacktestWindow,
  type SymbolPart,
} from "./backtest.js";

const chunkChars = 90_000;
const keysPerQuery = 50; // D1 allows 100 bound parameters per query

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

async function gzipBase64(text: string) {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function gunzipBase64(data: string) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** What every part of a run depends on besides its symbol. */
function settings(
  code: string,
  request: BacktestRequest,
  window: BacktestWindow,
) {
  return {
    rule: ruleVersion,
    code,
    from: request.from,
    to: request.to,
    window,
    config: request.config,
    validation: request.validation,
  };
}
export const partKey = (
  code: string,
  request: BacktestRequest,
  window: BacktestWindow,
  ticker: string,
) => sha256(JSON.stringify({ ...settings(code, request, window), ticker }));
export const runKey = (
  code: string,
  request: BacktestRequest,
  window: BacktestWindow,
) =>
  sha256(
    JSON.stringify({
      ...settings(code, request, window),
      tickers: [...request.tickers].sort(),
    }),
  );

/** Text values in a D1 table, split into rows; `meta` columns are readable. */
export class D1Blobs {
  private ready?: Promise<unknown>;
  constructor(
    private readonly db: D1Like,
    private readonly table: string,
    private readonly meta: string[],
  ) {}

  private init() {
    return (this.ready ??= this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT NOT NULL, chunk INTEGER NOT NULL, ` +
          `chunks INTEGER NOT NULL, ${this.meta.map((c) => `${c} TEXT`).join(", ")}, ` +
          `data TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (key, chunk))`,
      )
      .run());
  }

  /** Values found for `keys`; incomplete values count as missing. */
  async get(keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!keys.length) return out;
    await this.init();
    for (let i = 0; i < keys.length; i += keysPerQuery) {
      const group = keys.slice(i, i + keysPerQuery);
      const { results } = await this.db
        .prepare(
          `SELECT key, chunk, chunks, data FROM ${this.table} WHERE key IN ` +
            `(${group.map(() => "?").join(", ")}) ORDER BY key, chunk`,
        )
        .bind(...group)
        .all<{ key: string; chunk: number; chunks: number; data: string }>();
      const byKey = new Map<string, typeof results>();
      for (const row of results)
        byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
      for (const [key, rows] of byKey)
        if (
          rows.length === rows[0]!.chunks &&
          rows.every((r, n) => Number(r.chunk) === n)
        )
          out.set(key, await gunzipBase64(rows.map((r) => r.data).join("")));
    }
    return out;
  }

  async put(
    entries: { key: string; meta: Record<string, string>; text: string }[],
  ) {
    if (!entries.length) return;
    await this.init();
    const statements: D1Statement[] = [];
    const columns = [
      "key",
      "chunk",
      "chunks",
      ...this.meta,
      "data",
      "stored_at",
    ];
    const sql =
      `INSERT OR REPLACE INTO ${this.table} (${columns.join(", ")}) ` +
      `VALUES (${columns.map(() => "?").join(", ")})`;
    for (const { key, meta, text } of entries) {
      const data = await gzipBase64(text);
      const chunks = Math.max(1, Math.ceil(data.length / chunkChars));
      for (let n = 0; n < chunks; n++)
        statements.push(
          this.db
            .prepare(sql)
            .bind(
              key,
              n,
              chunks,
              ...this.meta.map((c) => meta[c] ?? ""),
              data.slice(n * chunkChars, (n + 1) * chunkChars),
              Date.now(),
            ),
        );
    }
    await this.db.batch(statements);
  }
}

/** Computed backtest results in D1 for evaluation code `code`. */
export class ResultCache {
  readonly parts: D1Blobs;
  readonly runs: D1Blobs;
  constructor(
    db: D1Like,
    readonly code: string,
  ) {
    this.parts = new D1Blobs(db, "backtest_parts", ["rule", "ticker"]);
    this.runs = new D1Blobs(db, "backtest_runs", [
      "rule",
      "from_date",
      "to_date",
      "symbols",
      "settings",
      "summary",
    ]);
  }

  partKey(request: BacktestRequest, window: BacktestWindow, ticker: string) {
    return partKey(this.code, request, window, ticker);
  }

  async getParts(keys: string[]): Promise<Map<string, SymbolPart>> {
    const texts = await this.parts.get(keys);
    return new Map([...texts].map(([k, t]) => [k, decodePart(t)]));
  }

  putParts(parts: { key: string; part: SymbolPart }[]) {
    return this.parts.put(
      parts.map(({ key, part }) => ({
        key,
        meta: { rule: ruleVersion, ticker: part.ticker },
        text: encodePart(part),
      })),
    );
  }
}
