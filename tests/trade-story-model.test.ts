import assert from "node:assert/strict";
import test from "node:test";
import type { TradeChart } from "../packages/market-data/src/trade-chart.js";
import type { BotView } from "../packages/trading/src/bot-api.js";
import { defaultSettings } from "../packages/trading/src/bot/settings.js";
import type { Decision } from "../packages/trading/src/explain.js";
import type { ClosedTrade } from "../packages/trading/src/portfolio.js";
import {
  barTime,
  botStory,
  chartWindow,
  decisionFor,
  heldText,
  lastOpenSession,
  levelLines,
  mergeSessions,
  momentOf,
  ownerStory,
  rulesFor,
  tradeChartUrl,
  tradeDates,
  tradeStats,
  unknownStory,
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
        unit: 0.9,
        state: "failed",
        touch: 34,
        at: 36,
      },
      openedAt: bought - 15000,
      closedAt: rest,
    },
  ],
} as unknown as BotView;

test("story: the trade's sessions, the days the window opens on, the chart's times", () => {
  assert.deepEqual(tradeDates(trade), { from: "2026-09-30", to: "2026-09-30" });
  assert.equal(
    tradeChartUrl(contract, "2026-09-28", "2026-10-02"),
    `/api/trade-chart?symbol=${contract}&from=2026-09-28&to=2026-10-02`,
  );
  // 09:59 New York is minute 29 of the session.
  assert.deepEqual(momentOf(bought), { date: "2026-09-30", minute: 29 });
  // An expiry is stamped 20:00Z: still that session.
  assert.equal(momentOf(Date.parse("2026-10-03T20:00:00Z")).date, "2026-10-03");
  // A session is complete 20 minutes after its close; before that, the day before.
  // The latest session that has opened: from 09:30 New York.
  assert.equal(
    lastOpenSession(Date.parse("2026-10-01T13:31:00Z")),
    "2026-10-01",
  );
  assert.equal(
    lastOpenSession(Date.parse("2026-10-01T13:29:00Z")),
    "2026-09-30",
  );
  assert.equal(
    lastOpenSession(Date.parse("2026-10-04T12:00:00Z")),
    "2026-10-02",
  ); // a Sunday
  // Two days each side of the trade, up to the latest session that has opened.
  assert.deepEqual(chartWindow(trade, Date.parse("2026-10-20T12:00:00Z")), {
    from: "2026-09-28",
    to: "2026-10-02",
  });
  assert.deepEqual(chartWindow(trade, Date.parse("2026-10-01T15:00:00Z")), {
    from: "2026-09-28",
    to: "2026-10-01",
  });
  // Viewed during its own session (the bug of 2026-10-26): the trade's day is
  // drawn, not only the days before it.
  assert.deepEqual(chartWindow(trade, Date.parse("2026-09-30T15:00:00Z")), {
    from: "2026-09-28",
    to: "2026-09-30",
  });
  // The chart's times read the Israel wall clock as UTC: 09:59 New York is 16:59.
  assert.equal(
    barTime("2026-09-30", 29),
    Date.parse("2026-09-30T16:59:00Z") / 1000,
  );
  const session = (date: string): TradeChart["sessions"][number] => ({
    date,
    minutes: 390,
    stock: [],
    spy: [],
    strength: [],
    option: [],
  });
  const base: TradeChart = {
    symbol: contract,
    underlying: "RKLB",
    option: true,
    sessions: [session("2026-09-30"), session("2026-10-01")],
    skipped: 0,
    at: 0,
  };
  const more = {
    ...base,
    sessions: [session("2026-09-28"), session("2026-09-29")],
  };
  assert.deepEqual(
    mergeSessions(base, more).sessions.map((s) => s.date),
    ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"],
  );
  // A day read twice is drawn once.
  assert.equal(mergeSessions(base, base).sessions.length, 2);
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
  assert.deepEqual(s.wall, { name: "day high so far", level: 74.4, unit: 0.9 });
  assert.equal(s.right, "C");
  assert.equal(s.rule, 1.8);
  assert.deepEqual(
    s.markers.map((m) => [m.kind, m.pane, m.at.minute, m.label]),
    [
      ["buy", "option", 29, "buy 2 @ 0.40"],
      ["sell", "option", 40, "sell 1 @ 0.32"],
      ["sell", "option", 46, "sell 1 @ 0.28"],
      ["signal", "stock", 29, "signal 16:59"],
      ["touch", "stock", 34, "touch"],
    ],
  );
  // The lines: the entry, the level with its touch and fall-back lines (a
  // quarter and half a unit short of it for a call), paid and the stop.
  assert.deepEqual(
    levelLines(s).map((l) => [l.pane, l.kind, l.price]),
    [
      ["stock", "entry", 74],
      ["stock", "level", 74.4],
      ["stock", "touch", 74.18],
      ["stock", "fallback", 73.95],
      ["option", "paid", 0.4],
      ["option", "stop", 0.28],
    ],
  );
  // A put watches a level below: its lines sit above the level.
  const put = { ...s, right: "P" as const };
  assert.deepEqual(
    levelLines(put)
      .filter((l) => l.kind === "touch" || l.kind === "fallback")
      .map((l) => l.price),
    [74.63, 74.85],
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

test("the trade measured: entry, exits, held, best and worst, after the sale", () => {
  const story = botStory(trade, view, defaultSettings)!;
  // Synthetic minutes of 2026-09-30 (minute since 09:30 New York).
  const bar = (
    m: number,
    c: number,
    h = c,
    l = c,
  ): [number, number, number, number, number, number] => [m, c, h, l, c, 10];
  const chart: TradeChart = {
    symbol: contract,
    underlying: "RKLB",
    option: true,
    skipped: 0,
    at: 0,
    sessions: [
      {
        date: "2026-09-30",
        minutes: 390,
        stock: [bar(28, 73.9), bar(29, 74.1), bar(40, 73.8), bar(46, 73.5)],
        spy: [
          [29, 500],
          [46, 501],
        ],
        strength: [],
        option: [
          bar(25, 0.38), // before the entry: not counted
          bar(29, 0.4, 0.42, 0.39),
          bar(31, 0.45, 0.5, 0.44), // the best while held
          bar(35, 0.27, 0.3, 0.25), // the worst while held
          bar(40, 0.32),
          bar(46, 0.28),
          bar(50, 0.4, 0.45, 0.39), // after the sale: it ran to 0.45
          bar(380, 0.3), // that day's last trade
        ],
      },
    ],
  };
  const s = tradeStats(trade, story, chart)!;
  assert.equal(s.entry.ms, bought);
  assert.equal(s.entry.price, 0.4);
  assert.equal(s.entry.qty, 2);
  assert.equal(s.entry.stock, 74.0); // the bot's own entry price of the stock
  assert.deepEqual(
    s.exits.map((x) => [x.ms, x.qty, x.price, x.title]),
    [
      [half, 1, 0.32, "10-minute check"],
      [rest, 1, 0.28, "Failed break"],
    ],
  );
  assert.equal(heldText(s.heldMs), "17 min");
  assert.equal(s.best!.price, 0.5);
  assert.ok(Math.abs(s.best!.pct - 25) < 1e-9);
  assert.equal(s.worst!.price, 0.25);
  assert.ok(Math.abs(s.worst!.pct + 37.5) < 1e-9);
  assert.ok(Math.abs(s.stock!.pct - (73.5 / 74 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(s.spyPct! - 0.2) < 1e-9);
  assert.equal(s.afterBest!.price, 0.45);
  assert.ok(Math.abs(s.afterBest!.pct - (0.45 / 0.28 - 1) * 100) < 1e-9);
  assert.equal(s.afterClose!.price, 0.3);
  assert.equal(heldText(125 * 60000), "2 h 5 min");
  assert.equal(heldText(27 * 3600000), "1 day 3 h");
});
