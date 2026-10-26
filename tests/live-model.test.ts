import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board } from "../packages/market-data/src/board.js";
import type { LiveStatus } from "../packages/market-data/src/live.js";
import {
  directionCounts,
  filterAlerts,
  filterRows,
  groupAlertDays,
  keepOrder,
  marketPhase,
  phoneColumns,
  pillFor,
  sipDelayText,
  sortRows,
  sortsDescending,
  symbolCounts,
  textWidthCh,
  watchRows,
  type LiveAlertRow,
  type WatchRow,
} from "../apps/web/src/live-model.js";

const status = (over: Partial<LiveStatus>): LiveStatus => ({
  state: "subscribed",
  feed: "iex",
  failure: null,
  symbols: 30,
  receiving: 30,
  lastBarAt: null,
  alerts: [],
  strengthNow: {},
  ...over,
});

test("pill: Saturday with a Friday bar is market closed until Monday's pre-market", () => {
  const now = Date.parse("2026-10-03T12:00:00Z"); // Saturday
  const pill = pillFor(
    status({ lastBarAt: "2026-10-02T20:59:00Z" }), // Fri 23:59 Israel
    now,
    now,
  );
  assert.equal(pill.kind, "closed");
  assert.equal(pill.tone, "grey");
  assert.equal(
    `${pill.label} ${pill.detail}`,
    "Market closed · pre-market Mon 11:00",
  );
});

test("pill: inside a session a 6-minute-old bar is delayed", () => {
  const now = Date.parse("2026-10-06T15:00:00Z"); // Tue 18:00 Israel
  const pill = pillFor(status({ lastBarAt: "2026-10-06T14:54:00Z" }), now, now);
  assert.equal(pill.kind, "delayed");
  assert.equal(pill.tone, "amber");
  assert.equal(pill.detail, "· last bar 6 min ago");
});

test("pill: fresh bar is live with receiving count and Israel clock", () => {
  const now = Date.parse("2026-10-06T14:45:00Z");
  const pill = pillFor(
    status({ receiving: 29, lastBarAt: "2026-10-06T14:44:00Z" }),
    now,
    now,
  );
  assert.equal(pill.kind, "live");
  assert.equal(pill.detail, "· 29/30 · 17:44");
});

test("pill: other collector states", () => {
  const now = Date.parse("2026-10-06T15:00:00Z");
  assert.equal(pillFor(null, now, null).kind, "connecting");
  assert.equal(
    pillFor(status({ state: "unavailable" }), now, now).kind,
    "offline",
  );
  assert.equal(pillFor(status({ state: "unavailable" }), now, now).tone, "red");
  assert.equal(
    pillFor(status({ state: "disconnected" }), now, now).kind,
    "reconnecting",
  );
  assert.equal(
    pillFor(status({ state: "awaiting-alpaca-activation" }), now, now).kind,
    "off",
  );
  assert.equal(
    pillFor(status({ state: "warming-up" }), now, now).kind,
    "warming",
  );
  assert.equal(
    pillFor(status({ state: "starting" }), now, now).kind,
    "warming",
  );
});

test("market phase follows the exchange calendar", () => {
  // Tue 2026-10-06: pre 04:00, open 09:30, close 16:00 New York (UTC−4).
  assert.equal(marketPhase(Date.parse("2026-10-06T07:59:00Z")).phase, "closed");
  assert.equal(marketPhase(Date.parse("2026-10-06T08:00:00Z")).phase, "pre");
  assert.equal(
    marketPhase(Date.parse("2026-10-06T13:30:00Z")).phase,
    "regular",
  );
  assert.equal(marketPhase(Date.parse("2026-10-06T20:00:00Z")).phase, "post");
  assert.equal(marketPhase(Date.parse("2026-10-07T00:00:00Z")).phase, "closed");
  // Thanksgiving is closed; the next session is Friday's (early close).
  const holiday = marketPhase(Date.parse("2026-11-26T15:00:00Z"));
  assert.equal(holiday.phase, "closed");
  assert.equal(holiday.next?.date, "2026-11-27");
});

const alert = (
  ticker: string,
  end: string,
  move: number,
  ratio: number,
  session: "pre" | "regular" | "post" = "regular",
): LiveAlertRow =>
  ({
    ticker,
    end,
    session,
    move,
    ratio,
    direction: move >= 0 ? "up" : "down",
  }) as LiveAlertRow;

const seven = [
  alert("NVDA", "2026-10-06T14:42:00Z", 1.84, 5.1),
  alert("AMD", "2026-10-06T14:38:00Z", 1.12, 3.4),
  alert("TSLA", "2026-10-06T14:21:00Z", -2.05, 4.0),
  alert("NVDA", "2026-10-06T14:05:00Z", 0.92, 3.1),
  alert("AAPL", "2026-10-06T13:41:00Z", -0.62, 3.8),
  alert("PLTR", "2026-10-06T12:12:00Z", 2.4, 6.2, "pre"),
  alert("META", "2026-10-06T11:03:00Z", -1.1, 3.0, "pre"),
];

test("alert filters: direction counts and symbol filter (scenario 5)", () => {
  assert.deepEqual(directionCounts(seven, null), { all: 7, up: 4, down: 3 });
  assert.equal(filterAlerts(seven, "up", null).length, 4);
  assert.equal(filterAlerts(seven, "all", "NVDA").length, 2);
  assert.deepEqual(directionCounts(seven, "NVDA"), { all: 2, up: 2, down: 0 });
  assert.equal(filterAlerts(seven, "all", null).length, 7);
  assert.deepEqual(symbolCounts(seven)[0], ["NVDA", 2]);
  assert.deepEqual(symbolCounts(seven)[1], ["AAPL", 1]);
});

test("alert grouping: Israel days outside, session groups inside (scenario 6)", () => {
  // An after-hours alert after midnight Israel time lands on the next day.
  const late = alert("SMCI", "2026-10-06T21:30:00Z", 1.2, 4.5, "post");
  const earlier = alert("MU", "2026-10-05T15:00:00Z", -1, 3.3);
  const days = groupAlertDays([...seven, late, earlier], "time");
  assert.deepEqual(
    days.map((d) => [d.day, d.label, d.count]),
    [
      ["2026-10-07", "Wed 7 Oct", 1],
      ["2026-10-06", "Tue 6 Oct", 7],
      ["2026-10-05", "Mon 5 Oct", 1],
    ],
  );
  assert.deepEqual(
    days[0]!.groups.map((g) => [g.title, g.sub, g.rows.length]),
    [["After-hours", "23:00–03:00", 1]],
  );
  assert.deepEqual(
    days[1]!.groups.map((g) => [g.title, g.sub, g.rows.length]),
    [
      ["Regular session", "16:30–23:00", 5],
      ["Pre-market", "11:00–16:30", 2],
    ],
  );
  assert.equal(days[1]!.groups[0]!.rows[0]!.ticker, "NVDA");
  const flat = groupAlertDays(seven, "ratio");
  assert.equal(flat.length, 1);
  assert.equal(flat[0]!.groups.length, 1);
  assert.equal(flat[0]!.groups[0]!.title, "");
  assert.deepEqual(flat[0]!.groups[0]!.rows.map((a) => a.ticker).slice(0, 2), [
    "PLTR",
    "NVDA",
  ]);
  assert.deepEqual(groupAlertDays([], "ratio"), []);
});

const board = {
  date: "2026-10-06",
  watchlist: ["NVDA", "AAPL", "TSLA", "MSFT"],
  benchmarks: { NVDA: "SMH" },
  series: [
    {
      ticker: "NVDA",
      previousClose: 100,
      points: [[0, 102]],
      stats: { relVolume: 3.4, dayLow: 99, dayHigh: 103, rsScore: 64 },
    },
    {
      ticker: "AAPL",
      previousClose: 100,
      points: [[0, 99.5]],
      stats: { relVolume: null, rsScore: 31 },
    },
    {
      ticker: "TSLA",
      previousClose: 100,
      points: [[0, 97]],
      stats: { relVolume: null, rsScore: null },
    },
    { ticker: "MSFT", previousClose: 100, points: [] },
    { ticker: "SPY", previousClose: 100, points: [[0, 100.5]] },
    { ticker: "SMH", previousClose: 100, points: [[0, 101]] },
  ],
} as unknown as Board;

test("watch rows: change, excess against SPY or sector, stats when present", () => {
  const rows = watchRows(board, new Map([["NVDA", 2]]), "SPY");
  const nvda = rows[0]!;
  assert.ok(Math.abs(nvda.change! - 2) < 1e-9);
  assert.ok(Math.abs(nvda.excess! - 1.5) < 1e-9);
  assert.equal(nvda.relVolume, 3.4);
  assert.equal(nvda.alerts, 2);
  assert.equal(rows[2]!.relVolume, null); // TSLA: no rel vol yet
  assert.equal(nvda.rsScore, 64);
  assert.equal(rows[2]!.rsScore, null);
  assert.equal(rows[3]!.rsScore, null);
  assert.equal(rows[3]!.change, null); // MSFT: no bars
  const sector = watchRows(board, new Map(), "sector");
  assert.equal(sector[0]!.against, "SMH");
  assert.ok(Math.abs(sector[0]!.excess! - 1) < 1e-9);
  assert.equal(sector[1]!.against, "SPY"); // no sector benchmark
  // The score stays against SPY when the table compares vs sector.
  assert.equal(sector[0]!.rsScore, 64);
});

test("watch sort by vs SPY score: highest first, then lowest; missing last (chart-vs-spy scenario 6)", () => {
  const order = (r: WatchRow[]) => r.map((x) => x.ticker);
  for (const compare of ["SPY", "sector"] as const) {
    const rows = watchRows(board, new Map(), compare);
    assert.deepEqual(order(sortRows(rows, "rsScore", true)), [
      "NVDA",
      "AAPL",
      "TSLA",
      "MSFT",
    ]);
    assert.deepEqual(order(sortRows(rows, "rsScore", false)), [
      "AAPL",
      "NVDA",
      "TSLA",
      "MSFT",
    ]);
  }
  assert.equal(sortsDescending("rsScore"), true);
});

test("watch sort: |change| first, rel vol toggles, missing values last (scenarios 7, 8)", () => {
  const rows = watchRows(board, new Map([["NVDA", 2]]), "SPY");
  const order = (r: WatchRow[]) => r.map((x) => x.ticker);
  assert.deepEqual(order(sortRows(rows, "change", true)), [
    "TSLA",
    "NVDA",
    "AAPL",
    "MSFT",
  ]);
  assert.deepEqual(order(sortRows(rows, "relVolume", true)), [
    "NVDA",
    "AAPL",
    "TSLA",
    "MSFT",
  ]);
  assert.deepEqual(order(sortRows(rows, "relVolume", false)), [
    "NVDA",
    "AAPL",
    "TSLA",
    "MSFT",
  ]);
  assert.deepEqual(order(sortRows(rows, "ticker", false)), [
    "AAPL",
    "MSFT",
    "NVDA",
    "TSLA",
  ]);
});

test("watch filters: moving, with alerts, find by prefix (scenario 10)", () => {
  const rows = watchRows(board, new Map([["NVDA", 2]]), "SPY");
  assert.deepEqual(
    filterRows(rows, "moving", "").map((r) => r.ticker),
    ["NVDA", "TSLA"],
  );
  assert.deepEqual(
    filterRows(rows, "alerts", "").map((r) => r.ticker),
    ["NVDA"],
  );
  assert.deepEqual(
    filterRows(rows, "all", " a").map((r) => r.ticker),
    ["AAPL"],
  );
});

test("source note follows the API's SIP delay; an older API means 15 min", () => {
  assert.equal(sipDelayText(0), "SIP, real time");
  assert.equal(sipDelayText(15), "SIP, 15-min delayed");
  assert.equal(sipDelayText(5), "SIP, 5-min delayed");
  assert.equal(sipDelayText(undefined), "SIP, 15-min delayed");
});

test("watchlist: the Rel vol ≥2× filter keeps unusual volume only", () => {
  const row = (ticker: string, relVolume: number | null) =>
    ({ ticker, index: 0, change: 0.2, relVolume, alerts: 0 }) as WatchRow;
  const rows = [row("A", 2), row("B", 1.9), row("C", null), row("AB", 3)];
  assert.deepEqual(
    filterRows(rows, "hot", "").map((r) => r.ticker),
    ["A", "AB"],
  );
  assert.deepEqual(
    filterRows(rows, "hot", "ab").map((r) => r.ticker),
    ["AB"],
  );
});

test("watch sort by today's volume: most shares first, missing last", () => {
  const rows = watchRows(board, new Map(), "SPY");
  const sorted = sortRows(rows, "volume", true);
  const volumes = sorted.map((r) => r.volume);
  const known = volumes.filter((v) => v !== null) as number[];
  assert.deepEqual(
    known,
    [...known].sort((a, b) => b - a),
  );
  assert.deepEqual(
    volumes.slice(known.length),
    volumes.filter((v) => v === null),
  );
  assert.equal(sortsDescending("volume"), true);
});

test("watchlist: phone columns fit the longest value, the same in every row", () => {
  const row = (over: Partial<WatchRow>) =>
    ({
      mark: "live",
      last: 11.15,
      changeUsd: -4.01,
      change: -26.45,
      relVolume: null,
      volume: 0,
      ...over,
    }) as WatchRow;
  assert.equal(textWidthCh("-26.45%").toFixed(1), "6.7");
  const cols = phoneColumns([
    row({}),
    row({
      last: 895.05,
      changeUsd: 17.5,
      change: 1.99,
      relVolume: 12.3,
      volume: 2.4e7,
    }),
  ]).split(" max(");
  assert.equal(cols[0], "minmax(0, 1fr)");
  // Last 895.05 (5.6ch), Chng +17.50 (5.6ch), Chg % -26.45% (6.7ch),
  // Rel vol 12.3× (4.6ch), Volume 24.0M (5.1ch), each + 0.3ch.
  assert.deepEqual(cols.slice(1), [
    "5.9ch, 44px)",
    "5.9ch, 40px)",
    "7.0ch, 50px)",
    "4.9ch, 34px)",
    "5.4ch, 48px)",
  ]);
  // A close or overnight mark in front of a price widens Last.
  assert.match(phoneColumns([row({ mark: "close" })]), /max\(6.2ch, 44px\)/);
});

test("watchlist: a kept order holds while values change; new rows go last", () => {
  const row = (ticker: string, change: number) =>
    ({ ticker, change }) as WatchRow;
  const order = sortRows(
    [row("A", 3), row("B", 2), row("C", 1)],
    "change",
    true,
  ).map((r) => r.ticker);
  // C now moves most, but the order holds until the next sort.
  const now = [row("C", 9), row("D", 5), row("A", 3), row("B", 2)];
  assert.deepEqual(
    keepOrder(now, order).map((r) => r.ticker),
    ["A", "B", "C", "D"],
  );
});
