// SYNTHETIC market data: Worker subrequest budget of the board and the day
// chart with the area score (Workers Free allows 50 per request; the budget
// is 40). Every Alpaca page and every D1 statement counts, like the
// collector's watchlist request (+1 for the board).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import {
  D1BarCache,
  type D1Like,
  type D1Statement,
} from "../packages/market-data/src/bar-cache.js";
import {
  boardSubrequestBudget,
  D1StrengthStore,
  handleBoard,
  sigmaSymbolsPerPoll,
  type Board,
} from "../packages/market-data/src/board.js";
import { D1BaselineStore } from "../packages/market-data/src/volume-baseline.js";
import { D1AreaSigmaStore } from "../packages/market-data/src/area-sigma.js";
import {
  handleDayChart,
  type DayChart,
} from "../packages/market-data/src/day-chart.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
} from "../packages/market-data/src/calendar.js";

const date = "2026-09-29";
const now = Date.parse(`${date}T15:00:00Z`); // 11:00 New York

/** D1 that counts statements: each query, each statement of a batch. */
class CountingD1 implements D1Like {
  count = 0;
  constructor(private inner: D1Like) {}
  private wrap(inner: D1Statement): D1Statement & { inner: D1Statement } {
    return {
      inner,
      bind: (...values) => this.wrap(inner.bind(...values)),
      all: async <T>() => {
        this.count++;
        return inner.all<T>();
      },
      run: async () => {
        this.count++;
        return inner.run();
      },
    };
  }
  prepare(sql: string) {
    return this.wrap(this.inner.prepare(sql));
  }
  async batch(statements: D1Statement[]) {
    this.count += statements.length;
    return this.inner.batch(
      statements.map((s) => (s as D1Statement & { inner: D1Statement }).inner),
    );
  }
}

// Fake Alpaca at worst-case density: every minute 04:00–20:00 New York on
// trading days, 10,000 bars per page (symbols in request order).
function alpaca() {
  const counter = { count: 0 };
  const seed = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0);
  const bars = (
    symbol: string,
    timeframe: string,
    start: number,
    end: number,
  ) => {
    const out: {
      t: string;
      o: number;
      h: number;
      l: number;
      c: number;
      v: number;
    }[] = [];
    const base = symbol === "SPY" ? 500 : 50 + seed(symbol);
    for (let day = start - 86400000; day <= end + 86400000; day += 86400000) {
      const d = new Date(day).toISOString().slice(0, 10);
      let close: number | null;
      try {
        close = coreClose(d);
      } catch {
        close = null;
      }
      if (close === null) continue;
      const k = Math.floor(day / 86400000);
      const step = timeframe === "1Day" ? 0 : timeframe === "5Min" ? 5 : 1;
      const minutes =
        step === 0
          ? [0]
          : Array.from(
              { length: (1200 - 240) / step },
              (_, i) => 240 + i * step,
            );
      for (const m of minutes) {
        const t = newYorkToUtc(d, m);
        if (t < start || t > end || t > now) continue;
        const c =
          base *
          (1 +
            0.01 * Math.sin(k * 1.7 + seed(symbol)) +
            0.003 * Math.sin(m / 23 + k));
        out.push({ t: new Date(t).toISOString(), o: c, h: c, l: c, c, v: 100 });
      }
    }
    return out;
  };
  const fetcher = (async (input: URL | string) => {
    counter.count++;
    const url = new URL(String(input));
    const p = url.searchParams;
    const start = Date.parse(p.get("start")!);
    const end = Date.parse(p.get("end")!);
    const offset = Number(p.get("page_token") ?? 0);
    const single = url.pathname.match(/^\/v2\/stocks\/([^/]+)\/bars$/);
    const symbols = single
      ? [decodeURIComponent(single[1]!)]
      : p.get("symbols")!.split(",");
    const all = symbols.flatMap((s) =>
      bars(s, p.get("timeframe")!, start, end).map((b) => ({ s, b })),
    );
    const page = all.slice(offset, offset + 10000);
    const next = offset + 10000 < all.length ? String(offset + 10000) : null;
    const body = single
      ? { bars: page.map((x) => x.b), next_page_token: next }
      : {
          bars: Object.fromEntries(
            symbols.map((s) => [
              s,
              page.filter((x) => x.s === s).map((x) => x.b),
            ]),
          ),
          next_page_token: next,
        };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { counter, fetcher };
}

test("board polls stay within 40 subrequests from a cold cache (30 symbols)", async () => {
  const tickers = Array.from(
    { length: 30 },
    (_, i) => `S${String(i).padStart(2, "0")}`,
  );
  const db = new CountingD1(new SqliteD1(":memory:"));
  const stores = {
    baselines: new D1BaselineStore(db),
    strengths: new D1StrengthStore(db),
    sigmas: new D1AreaSigmaStore(db),
  };
  const k = sigmaSymbolsPerPoll(tickers.length + 2, tickers.length);
  assert.equal(k, 12);
  const counts: number[] = [];
  let board: Board | null = null;
  for (let poll = 0; poll < 6; poll++) {
    const { counter, fetcher } = alpaca();
    db.count = 0;
    const result = await handleBoard(
      tickers,
      {},
      { key: "k", secret: "s", sipDelayMinutes: 0 },
      fetcher,
      now + poll * 60000,
      stores.baselines,
      stores.strengths,
      stores.sigmas,
    );
    assert.equal(result.status, 200);
    board = result.body as Board;
    // +1: the Worker's watchlist request to the collector.
    counts.push(1 + counter.count + db.count);
    if (board.series.slice(0, 30).every((s) => s.stats!.rsScore !== null))
      break;
  }
  console.log(
    `board subrequests per poll (30 symbols, cold): ${counts.join(", ")}`,
  );
  for (const n of counts) assert.ok(n <= boardSubrequestBudget, `${n} > 40`);
  // Cold poll (Rel vol and β history) + ⌈30 / 12⌉ polls for the σ curves.
  assert.equal(counts.length, 4);
  assert.ok(board!.series.slice(0, 30).every((s) => s.stats!.rsScore !== null));
  assert.equal(newYork(board!.series[0]!.stats!.asOf * 1000).minute, 660);
});

test("the day chart's first σ computation stays within 40 subrequests", async () => {
  const db = new CountingD1(new SqliteD1(":memory:"));
  const cache = new D1BarCache(db);
  const sigmas = new D1AreaSigmaStore(db);
  const counts: number[] = [];
  for (let i = 0; i < 2; i++) {
    const { counter, fetcher } = alpaca();
    db.count = 0;
    const result = await handleDayChart(
      { ticker: "S00", date },
      { key: "k", secret: "s", sipDelayMinutes: 0 },
      fetcher,
      now,
      cache,
      sigmas,
    );
    assert.equal(result.status, 200);
    const chart = result.body as DayChart;
    assert.equal(chart.areaVsSpy!.score.at(-1) === null, false);
    counts.push(counter.count + db.count);
  }
  console.log(`day chart subrequests (cold, then warm): ${counts.join(", ")}`);
  for (const n of counts) assert.ok(n <= boardSubrequestBudget, `${n} > 40`);
});
