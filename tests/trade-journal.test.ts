// SYNTHETIC trades and buy commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "../packages/trading/src/explain.js";
import type { ClosedTrade } from "../packages/trading/src/portfolio.js";
import {
  filterJournal,
  filterTrades,
  journal,
  journalTickers,
} from "../packages/trading/src/trade-journal.js";

const trade = (
  symbol: string,
  underlying: string,
  openedAt: string,
  closedAt: string,
  pnl: number,
): ClosedTrade => ({
  symbol,
  underlying,
  option: null,
  openedAt,
  closedAt,
  qty: 1,
  entry: 1,
  exit: 1,
  pnl,
  pnlPct: null,
  expired: false,
});

const decision = (
  id: string,
  symbol: string,
  underlying: string,
  at: string,
  filledQty: number,
): Decision =>
  ({
    id,
    at: Date.parse(at),
    symbol,
    outcome: filledQty > 0 ? "filled" : "refused",
    explanation: { contract: { symbol, underlying } },
    result: filledQty > 0 ? { filledQty, avgPrice: 1 } : undefined,
  }) as unknown as Decision;

const amd = "AMD261016C00720000";
const nvda = "NVDA261016P00180000";
const trades = [
  trade(amd, "AMD", "2026-10-12T14:00:00Z", "2026-10-12T20:30:00Z", 120),
  trade(nvda, "NVDA", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z", -80),
  trade(amd, "AMD", "2026-10-14T13:40:00Z", "2026-10-14T14:00:00Z", 0),
];

test("history filters by Israel date of the close, ticker and result", () => {
  // 20:30Z on Oct 12 is 23:30 in Israel, still Oct 12.
  assert.deepEqual(
    filterTrades(trades, { from: "2026-10-12", to: "2026-10-12" }).map(
      (t) => t.pnl,
    ),
    [120],
  );
  assert.deepEqual(
    filterTrades(trades, { tickers: ["amd"] }).map((t) => t.pnl),
    [120, 0],
  );
  assert.deepEqual(
    filterTrades(trades, { result: "loss" }).map((t) => t.underlying),
    ["NVDA"],
  );
  // Breakeven is neither a win nor a loss.
  assert.deepEqual(
    filterTrades(trades, { result: "win" }).map((t) => t.pnl),
    [120],
  );
  assert.equal(filterTrades(trades, {}).length, 3);
});

test("buy commands link to the closed trade they opened", () => {
  const decisions = [
    decision("a", amd, "AMD", "2026-10-12T13:59:30Z", 3),
    decision("b", nvda, "NVDA", "2026-10-13T14:00:05Z", 2),
    decision("c", amd, "AMD", "2026-10-14T13:39:50Z", 1),
    decision("d", amd, "AMD", "2026-10-14T15:00:00Z", 1), // still held
    decision("e", nvda, "NVDA", "2026-10-14T15:00:00Z", 0), // refused
  ];
  const entries = journal(decisions, trades);
  assert.deepEqual(
    entries.map((e) => [e.decision.id, e.result, e.trade?.pnl ?? null]),
    [
      ["a", "win", 120],
      ["b", "loss", -80],
      ["c", "even", 0],
      ["d", "open", null],
      ["e", null, null],
    ],
  );
  assert.deepEqual(
    filterJournal(entries, { result: "win" }).map((e) => e.decision.id),
    ["a"],
  );
  assert.deepEqual(
    filterJournal(entries, { from: "2026-10-14", tickers: ["NVDA"] }).map(
      (e) => e.decision.id,
    ),
    ["e"],
  );
  assert.deepEqual(journalTickers(trades, decisions), ["AMD", "NVDA"]);
});
