import { test } from "node:test";
import assert from "node:assert/strict";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";
import type { RawBar } from "../packages/market-data/src/bars.js";
import {
  handleBoard,
  latestSession,
  runBoard,
} from "../packages/market-data/src/board.js";
import { previousSessions } from "../packages/market-data/src/calendar.js";

const at = (iso: string) => Date.parse(iso);

test("the board shows today once pre-market data exists, else the last session", () => {
  // Monday 2026-09-28 (EDT): 04:15 New York is 08:15Z; data lags 15 minutes.
  assert.equal(latestSession(at("2026-09-28T08:14:00Z")), "2026-09-25");
  assert.equal(latestSession(at("2026-09-28T08:15:00Z")), "2026-09-28");
  assert.equal(latestSession(at("2026-09-28T23:00:00Z")), "2026-09-28");
  // Weekend and holiday fall back to the previous trading day.
  assert.equal(latestSession(at("2026-09-27T12:00:00Z")), "2026-09-25");
  assert.equal(latestSession(at("2026-11-26T15:00:00Z")), "2026-11-25");
});

const bar = (iso: string, close: number): RawBar => ({
  start: at(iso) / 1000,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
});

test("board series follow the watchlist, add SPY and QQQ, and keep the session day", async () => {
  const calls: unknown[][] = [];
  const board = await runBoard(
    ["NVDA", "SPY"],
    async (symbols, start, end, timeframe) => {
      calls.push([symbols.join(), start, end, timeframe]);
      return new Map(
        symbols.map((s) => [
          s,
          timeframe === "1Day"
            ? [bar("2026-09-24T04:00:00Z", 1), bar("2026-09-25T04:00:00Z", 100)]
            : [
                bar("2026-09-25T13:30:00Z", 101),
                bar("2026-09-25T19:55:00Z", 102),
                bar("2026-09-26T12:00:00Z", 999), // next day: excluded
              ],
        ]),
      );
    },
    at("2026-09-27T12:00:00Z"),
  );
  assert.equal(board.date, "2026-09-25");
  assert.deepEqual(board.watchlist, ["NVDA", "SPY"]);
  // 09:30 and 16:00 New York (EDT) on 2026-09-25.
  assert.equal(board.open, at("2026-09-25T13:30:00Z") / 1000);
  assert.equal(board.close, at("2026-09-25T20:00:00Z") / 1000);
  assert.deepEqual(calls.slice(0, 2), [
    [
      "NVDA,SPY,QQQ",
      "2026-09-25T00:00:00Z",
      "2026-09-26T06:00:00.000Z",
      "5Min",
    ],
    ["NVDA,SPY,QQQ", "2026-09-24T00:00:00Z", "2026-09-25T00:00:00Z", "1Day"],
  ]);
  // Rel vol history: watchlist symbols only, each previous session's regular
  // hours as 5-minute bars (09:30–16:00 New York = 13:30–20:00Z in EDT).
  // Plus one split-adjusted daily request for β/σ vs SPY (last).
  assert.equal(calls.length, 23);
  assert.deepEqual(calls[2], [
    "NVDA,SPY",
    "2026-08-27T13:30:00.000Z",
    "2026-08-27T20:00:00.000Z",
    "5Min",
  ]);
  assert.deepEqual(calls.at(-1), [
    "NVDA,SPY",
    `${previousSessions("2026-09-25", 61)[0]}T00:00:00Z`,
    "2026-09-25T00:00:00Z",
    "1Day",
  ]);
  assert.deepEqual(calls.at(-2), [
    "NVDA,SPY",
    "2026-09-24T13:30:00.000Z",
    "2026-09-24T20:00:00.000Z",
    "5Min",
  ]);
  assert.deepEqual(
    board.series.map((s) => [s.ticker, s.previousClose, s.points.length]),
    [
      ["NVDA", 1, 2],
      ["SPY", 1, 2],
      ["QQQ", 1, 2],
    ],
  );
});

test("multi-symbol history paginates, skips null symbols and rejects bad shapes", async () => {
  const pages = [
    {
      bars: {
        AAPL: [{ t: "2026-09-25T13:30:00Z", o: 1, h: 1, l: 1, c: 1, v: 5 }],
        MSFT: null,
      },
      next_page_token: "p2",
    },
    {
      bars: {
        AAPL: [{ t: "2026-09-25T13:35:00Z", o: 2, h: 2, l: 2, c: 2, v: 5 }],
      },
      next_page_token: null,
    },
  ];
  const urls: URL[] = [];
  const feed = new AlpacaFeed("k", "s", "sip", () => {}, (async (
    input: URL,
  ) => {
    urls.push(new URL(String(input)));
    return Response.json(pages[urls.length - 1]);
  }) as typeof fetch);
  const result = await feed.multiHistory(
    ["AAPL", "MSFT"],
    "2026-09-25T00:00:00Z",
    "2026-09-26T00:00:00Z",
    "5Min",
  );
  assert.deepEqual(
    result.get("AAPL")!.map((b) => b.close),
    [1, 2],
  );
  assert.deepEqual(result.get("MSFT"), []);
  assert.equal(urls[0]!.pathname, "/v2/stocks/bars");
  assert.equal(urls[0]!.searchParams.get("symbols"), "AAPL,MSFT");
  assert.equal(urls[1]!.searchParams.get("page_token"), "p2");
  const bad = new AlpacaFeed("k", "s", "sip", () => {}, (async () =>
    Response.json({ bars: { OTHER: [] } })) as typeof fetch);
  await assert.rejects(
    bad.multiHistory(["AAPL"], "a", "b", "5Min"),
    /Invalid Alpaca history response/,
  );
  assert.equal((await handleBoard(["AAPL"], {}, {})).status, 503);
});

test("board fetches each symbol's sector benchmark and reports the mapping", async () => {
  let fetched: string[] = [];
  const board = await runBoard(
    ["MSTR", "NVDA", "WMT"],
    async (symbols) => {
      if (!fetched.length) fetched = symbols;
      return new Map(symbols.map((s) => [s, []]));
    },
    at("2026-09-27T12:00:00Z"),
    { MSTR: "IBIT", NVDA: "SOXX" },
  );
  assert.deepEqual(fetched, [
    "MSTR",
    "NVDA",
    "WMT",
    "SPY",
    "QQQ",
    "IBIT",
    "SOXX",
  ]);
  assert.deepEqual(board.benchmarks, { MSTR: "IBIT", NVDA: "SOXX" });
  assert.deepEqual(board.watchlist, ["MSTR", "NVDA", "WMT"]);
});

test("New York wall time converts to UTC across DST and early closes", async () => {
  const { newYorkToUtc } =
    await import("../packages/market-data/src/calendar.js");
  assert.equal(newYorkToUtc("2026-01-05", 570), at("2026-01-05T14:30:00Z"));
  assert.equal(newYorkToUtc("2026-07-06", 570), at("2026-07-06T13:30:00Z"));
  assert.equal(newYorkToUtc("2026-11-27", 780), at("2026-11-27T18:00:00Z"));
});
