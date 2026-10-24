import assert from "node:assert/strict";
import test from "node:test";
import type { TradeChartSession } from "../packages/market-data/src/trade-chart.js";
import type { BotView } from "../packages/trading/src/bot-api.js";
import { defaultSettings } from "../packages/trading/src/bot/settings.js";
import type { Decision } from "../packages/trading/src/explain.js";
import type { ClosedTrade } from "../packages/trading/src/portfolio.js";
import {
  botStory,
  chartAxis,
  decisionFor,
  momentOf,
  ownerStory,
  rulesFor,
  tradeChartUrl,
  tradeDates,
  unknownStory,
  valueAt,
} from "../apps/web/src/trade-story-model.js";

// A synthetic RKLB call: bought 16:59 Israel time (09:59 New York) on
// 2026-09-30, half sold at the 10-minute check, the rest on the failed break.
const contract = "RKLB261003C00080000";
const bought = Date.parse("2026-09-30T13:59:20Z");
const half = Date.parse("2026-09-30T14:10:05Z");
const rest = Date.parse("2026-09-30T14:16:30Z");
const trade: ClosedTrade = {
  symbol: contract,
  underlying: "RKLB",
  option: { right: "call", strike: 80, expiry: "2026-10-03" },
  openedAt: new Date(bought).toISOString(),
  closedAt: new Date(rest).toISOString(),
  qty: 2,
  entry: 0.4,
  exit: 0.3,
  pnl: -20,
  pnlPct: -25,
  expired: false,
  fills: [
    { side: "buy", at: new Date(bought).toISOString(), qty: 2, price: 0.4 },
    { side: "sell", at: new Date(half).toISOString(), qty: 1, price: 0.32 },
    { side: "sell", at: new Date(rest).toISOString(), qty: 1, price: 0.28 },
  ],
};

const view = {
  settings: defaultSettings,
  signals: [],
  entries: [
    {
      day: "2026-09-30",
      symbol: "RKLB",
      right: "C",
      minute: 29,
      t: 2.3,
      rvol: 2.1,
      outcome: "bought",
      detail: "",
      at: bought - 20000,
      version: "2.1",
    },
  ],
  positions: [
    {
      id: "p1",
      day: "2026-09-30",
      symbol: "RKLB",
      contract,
      right: "C",
      qty: 0,
      bought: 2,
      cost: 0.4,
      entryMinute: 29,
      entryStock: 74.0,
      nights: 0,
      status: "closed",
      dry: false,
      version: "2.1",
      sales: [
        { at: half, qty: 1, reason: "check-10", price: 0.32 },
        { at: rest, qty: 1, reason: "failed-break", price: 0.28 },
      ],
      breakWatch: {
        name: "day high so far",
        level: 74.4,
        state: "failed",
        touch: 34,
        at: 36,
      },
      openedAt: bought - 15000,
      closedAt: rest,
    },
  ],
} as unknown as BotView;

test("story: the trade's sessions and the chart request", () => {
  assert.deepEqual(tradeDates(trade), { from: "2026-09-30", to: "2026-09-30" });
  assert.equal(
    tradeChartUrl(trade),
    `/api/trade-chart?symbol=${contract}&from=2026-09-30&to=2026-09-30`,
  );
  // 09:59 New York is minute 29 of the session.
  assert.deepEqual(momentOf(bought), { date: "2026-09-30", minute: 29 });
  // An expiry is stamped 20:00Z: still that session.
  assert.equal(momentOf(Date.parse("2026-10-03T20:00:00Z")).date, "2026-10-03");
});

test("story: the x axis puts the sessions side by side with a gap", () => {
  const sessions: TradeChartSession[] = [
    { date: "2026-09-30", minutes: 390, stock: [], option: [] },
    { date: "2026-10-01", minutes: 390, stock: [], option: [] },
  ];
  const axis = chartAxis(sessions);
  assert.equal(axis.total, 390 + 15 + 390);
  assert.equal(axis.xOf({ date: "2026-09-30", minute: 29 }), 29);
  assert.equal(axis.xOf({ date: "2026-10-01", minute: 0 }), 405);
  assert.equal(axis.xOf({ date: "2026-10-01", minute: 390 }), 405 + 389); // the close, clamped
  assert.equal(axis.xOf({ date: "2026-10-02", minute: 0 }), null);
  assert.deepEqual(axis.at(29.4), { date: "2026-09-30", minute: 29 });
  assert.deepEqual(axis.at(398), { date: "2026-10-01", minute: 0 });
  assert.equal(
    valueAt(
      [
        [0, 1],
        [5, 2],
        [9, 3],
      ],
      7,
    ),
    2,
  );
  assert.equal(valueAt([[3, 1]], 2), null);
});

test("story: a bot trade is told from the signal, the position and its sales", () => {
  const s = botStory(trade, view, defaultSettings)!;
  assert.ok(s);
  assert.equal(s.bot, true);
  assert.equal(s.version, "2.1");
  assert.match(
    s.entry[0]!,
    /^Signal at 16:59: RKLB showed strength against SPY with t 2\.3 \(rule 1\.8\+\) on volume 2\.1× normal \(rule 1\.5×\+\)\.$/,
  );
  assert.match(
    s.entry[1]!,
    /RKLB 80 call, expiry 2026-10-03, .*delta closest to 0\.15 and 1–7 days out\. Paid 0\.40 for 2 contracts\./,
  );
  assert.match(s.entry[2]!, /^Level ahead: day high so far at \$74\.40/);
  assert.deepEqual(
    s.exits.map((x) => [x.title, x.qty, x.price]),
    [
      ["10-minute check", 1, 0.32],
      ["Failed break", 1, 0.28],
    ],
  );
  assert.match(
    s.exits[1]!.text,
    /reached day high so far at \$74\.40 and fell back/,
  );
  assert.equal(s.paid, 0.4);
  assert.equal(s.stop, 0.28); // −30% of 0.40
  assert.equal(s.stockEntry, 74);
  assert.deepEqual(s.wall, { name: "day high so far", level: 74.4 });
  assert.deepEqual(
    s.markers.map((m) => [m.kind, m.pane, m.at.minute]),
    [
      ["buy", "option", 29],
      ["sell", "option", 40],
      ["sell", "option", 46],
      ["signal", "stock", 29],
      ["touch", "stock", 34],
    ],
  );
  // A version with other rules words the exits with its own numbers.
  const v1 = botStory(
    trade,
    {
      ...view,
      positions: [{ ...view.positions[0]!, version: "1.0" }],
    } as BotView,
    defaultSettings,
  )!;
  assert.match(v1.entry[0]!, /rule 2\+/);
  assert.equal(rulesFor("2.1*", defaultSettings), defaultSettings);
  // No record of the trade: nothing is invented.
  assert.equal(
    botStory(trade, { ...view, positions: [] } as BotView, defaultSettings),
    null,
  );
  const unknown = unknownStory(trade);
  assert.equal(unknown.exits.length, 2);
  assert.equal(unknown.exits[0]!.title, "Sale");
  assert.equal(unknown.stop, null);
});

test("story: the owner's trade is told from the buy order and the fills", () => {
  const decision = {
    id: "d1",
    at: bought - 4000,
    symbol: contract,
    outcome: "filled",
    result: { filledQty: 2, avgPrice: 0.4, stopPrice: 0.28 },
    explanation: {
      contract: {
        symbol: contract,
        underlying: "RKLB",
        expiry: "2026-10-03",
        right: "call",
        strike: 80,
        delta: 0.16,
      },
      inputs: [
        { name: "Stock", value: "RKLB", source: "command" },
        { name: "Size", value: "2%", source: "command" },
        { name: "Delta", value: "0.15", source: "default" },
      ],
      selection: {
        offered: [],
        expiryRule: "The nearest expiry 1–7 days out.",
        strikeRule: "The strike with delta closest to 0.15.",
        strikes: [],
      },
      pricing: {
        bid: 0.38,
        ask: 0.4,
        mid: 0.39,
        spreadPct: 5,
        ceiling: 0.41,
        rule: "",
      },
      sizing: {
        equity: 10000,
        sizePct: 2,
        budget: 200,
        qty: 2,
        maxCost: 80,
        rule: "2% of $10,000 is $200; 2 contracts at the ceiling.",
      },
      stop: { pct: 30, atCeiling: 0.29, rule: "" },
      risk: {
        state: "normal",
        reason: "",
        daysToExpiry: 3,
        sharePct: 0.8,
        tradeRisk: 24,
        tradeLimit: 100,
        dayRisk: 24,
        dayLimit: 500,
        ok: true,
      },
      offHours: false,
      checks: [],
      notes: ["Earnings in 2 days."],
      refused: [],
      paper: true,
      at: "",
    },
  } as unknown as Decision;
  // The order is matched by contract and time; a refused or later one is not.
  assert.equal(decisionFor(trade, [decision]), decision);
  assert.equal(decisionFor(trade, [{ ...decision, at: rest + 60000 }]), null);
  assert.equal(
    decisionFor(trade, [
      { ...decision, result: { filledQty: 0, avgPrice: null } },
    ]),
    null,
  );
  const s = ownerStory(trade, decision);
  assert.equal(s.bot, false);
  assert.equal(s.entry[0], "Your command at 16:59: Stock RKLB, Size 2%.");
  assert.equal(
    s.entry[1],
    "The nearest expiry 1–7 days out. The strike with delta closest to 0.15.",
  );
  assert.match(
    s.entry[2]!,
    /^2 contracts: 2% of \$10,000 is \$200; 2 contracts at the ceiling\. The ask was 0\.40, paid up to 0\.41\.$/,
  );
  assert.equal(s.entry[3], "A broker stop at 0.28 (−30%).");
  assert.equal(s.entry[4], "Earnings in 2 days.");
  assert.equal(s.stop, 0.28);
  // The first sale was above the stop (yours); the second at the stop (the broker's).
  assert.deepEqual(
    s.exits.map((x) => x.title),
    ["Your sale", "Broker stop"],
  );
  assert.equal(s.decision, decision);
  // Without the order: said plainly, and every sale is yours.
  const bare = ownerStory(trade, null);
  assert.match(bare.entry[0]!, /no longer in the orders list/);
  assert.equal(bare.stop, null);
  assert.deepEqual(
    bare.exits.map((x) => x.title),
    ["Your sale", "Your sale"],
  );
  // An expiry closes with its own words.
  const expired = ownerStory(
    {
      ...trade,
      expired: true,
      closedAt: "2026-10-03T20:00:00Z",
      fills: [
        trade.fills![0]!,
        { side: "expired", at: "2026-10-03T20:00:00Z", qty: 2, price: 0 },
      ],
    },
    null,
  );
  assert.deepEqual(
    expired.exits.map((x) => [x.title, x.price]),
    [["Expired", null]],
  );
  assert.equal(expired.markers[1]!.kind, "expired");
});
