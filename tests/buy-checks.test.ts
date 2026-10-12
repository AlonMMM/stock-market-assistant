import assert from "node:assert/strict";
import test from "node:test";
import {
  checkBuy,
  defaultBuyLimits,
  openRisk,
  type BuyContext,
} from "../packages/trading/src/checks.js";
import { checkRisk } from "../packages/trading/src/risk-manager.js";

// A synthetic order that passes every check; each case breaks one thing.
const now = Date.parse("2026-10-12T15:00:00Z"); // Monday 11:00 New York
const symbol = "NVDA261016C00240000";
const risk = (premium = 412, todayLoss = 0, history = [100_000]) =>
  checkRisk({
    history: history.map((equity, i) => ({
      date: `2026-09-0${i + 1}`,
      equity,
    })),
    equity: 100_000,
    todayLoss,
    premium,
    daysToExpiry: 4,
  });
const good = (): BuyContext => ({
  now,
  enabled: true,
  paper: true,
  shortRisks: [],
  marketOpen: true,
  equity: 100_000,
  lastEquity: 100_000,
  buyingPower: 100_000,
  positions: [],
  buysToday: [],
  order: {
    quote: {
      symbol,
      underlying: "NVDA",
      expiry: "2026-10-16",
      right: "call",
      strike: 240,
      bid: 1.0,
      ask: 1.04,
      delta: 0.12,
      quotedAt: now - 2000,
    },
    qty: 4,
    ceiling: 1.03,
    sizePct: 0.5,
    stopPct: 40,
    deltaRange: [0.1, 0.15],
  },
  risk: risk(),
});
const quote =
  (change: Partial<BuyContext["order"]["quote"]>) => (c: BuyContext) => {
    c.order.quote = { ...c.order.quote, ...change };
  };
const held = (
  stopQty: number,
  stopPrice: number | null,
  qty = 10,
  entry = 2,
) => ({
  symbol: "AMD261016C00660000",
  qty,
  avgEntryPrice: entry,
  stopQty,
  stopPrice,
});

test("buy checks: a good order passes all of them", () => {
  const v = checkBuy(good());
  assert.deepEqual(v.refused, []);
  assert.equal(v.ok, true);
  assert.equal(v.checks.length, 16);
  assert.deepEqual(v.notes, []);
});

const cases: [string, (c: BuyContext) => void, RegExp][] = [
  ["trading switched on", (c) => (c.enabled = false), /switched off/],
  ["paper account", (c) => (c.paper = false), /live account is not authorized/],
  [
    "no short risk",
    (c) => (c.shortRisks = ["SHORT X: 1 contract sold short"]),
    /SHORT X/,
  ],
  [
    "buys per day",
    (c) =>
      (c.buysToday = Array.from({ length: 10 }, () => ({
        symbol: "AMD261016C00660000",
        at: now - 3_600_000,
      }))),
    /10 of 10 used today/,
  ],
  ["day loss", (c) => (c.equity = 94_900), /5\.1% down today/],
  [
    "risk at the same time",
    // 50 contracts at 2.00 stopped at 0.03: $9,850 at risk, plus this trade's $165.
    (c) => (c.positions = [held(50, 0.03, 50)]),
    /\$10,015 at risk with this trade; the limit is 10% of the account, \$10,000/,
  ],
  [
    "positions without a stop",
    (c) => (c.positions = [held(6, 1.2)]),
    /no full stop on AMD261016C00660000/,
  ],
  [
    "position size",
    // $4,700 of NVDA calls held, fully stopped, plus this order's $412.
    (c) =>
      (c.positions = [
        {
          symbol: "NVDA261016C00230000",
          qty: 47,
          avgEntryPrice: 1,
          stopQty: 47,
          stopPrice: 0.9,
        },
      ]),
    /\$4,700 already in NVDA calls plus \$412 is 5\.11% of the account; one position may be at most 5%, \$5,000, so \$300 more fits/,
  ],
  [
    "position size",
    // An open buy order counts with what is held.
    (c) => (c.working = [{ symbol: "NVDA261012C00235000", qty: 46, price: 1 }]),
    /\$4,600 already in NVDA calls plus \$412 is 5\.01%/,
  ],
  [
    "buying power",
    (c) => (c.buyingPower = 400),
    /needs \$412, \$400 available/,
  ],
  [
    "risk manager",
    (c) => (c.risk = risk(412, 6800)),
    /limit per day is 7% of the account/,
  ],
  ["size", (c) => (c.order.sizePct = 3.5), /size 3\.5% is outside 0–3%/],
  ["size", (c) => (c.order.qty = 0), /buys no contract at 1\.03/],
  ["stop", (c) => (c.order.stopPct = 71), /stop 71% is outside 0–70%/],
  [
    "stop",
    (c) => {
      c.order.ceiling = 0.01;
      c.order.stopPct = 70;
    },
    /too small for a stop price/,
  ],
  ["quote is usable", quote({ bid: 0 }), /bid 0, ask 1\.04/],
  [
    "quote is usable",
    quote({ quotedAt: now - 121_000 }),
    /121 s old, at most 120 s/,
  ],
  ["spread", quote({ ask: 1.12 }), /11\.32% of the mid, at most 10%/],
  [
    "not a repeat",
    (c) =>
      (c.buysToday = [{ symbol: "NVDA261012C00235000", at: now - 30_000 }]),
    /NVDA calls were bought 30 s ago/,
  ],
  [
    "contract not expiring",
    (c) => {
      c.now = Date.parse("2026-10-16T19:50:00Z");
      c.order.quote.quotedAt = c.now;
    },
    /stops trading in 10 minutes/,
  ],
];

for (const [check, breakIt, detail] of cases)
  test(`buy checks: "${check}" alone refuses the order (${detail.source})`, () => {
    const c = good();
    breakIt(c);
    const v = checkBuy(c);
    assert.equal(v.ok, false);
    // An unusable quote also has no meaningful spread.
    const failed = v.refused.filter(
      (r) => check !== "quote is usable" || !r.startsWith("spread: "),
    );
    assert.equal(failed.length, 1, v.refused.join(" | "));
    assert.match(failed[0]!, new RegExp(`^${check}: `));
    assert.match(failed[0]!, detail);
  });

test("buy checks: things that must not refuse", () => {
  const ok = (change: (c: BuyContext) => void) => {
    const c = good();
    change(c);
    return checkBuy(c).refused;
  };
  // A put and a call of the same stock are different trades.
  assert.deepEqual(
    ok(
      (c) =>
        (c.buysToday = [{ symbol: "NVDA261016P00200000", at: now - 5000 }]),
    ),
    [],
  );
  // The same kind again after a minute.
  assert.deepEqual(
    ok((c) => (c.buysToday = [{ symbol, at: now - 61_000 }])),
    [],
  );
  // A day that is ahead, and a broker that gives no quote time.
  assert.deepEqual(
    ok((c) => (c.equity = 120_000)),
    [],
  );
  assert.deepEqual(ok(quote({ quotedAt: undefined })), []);
  // A named delta is a target: the range does not apply.
  assert.deepEqual(
    ok((c) => {
      delete c.order.deltaRange;
      c.order.quote.delta = 0.3;
    }),
    [],
  );
  // A position fully covered by its stop.
  assert.deepEqual(
    ok((c) => (c.positions = [held(10, 1.2)])),
    [],
  );
});

test("buy checks: off hours and a delta outside the range are noted, not refused", () => {
  const c = good();
  c.marketOpen = false;
  c.order.quote.quotedAt = now - 160_000_000; // Friday's close
  c.order.quote.delta = 0.085;
  const v = checkBuy(c);
  assert.deepEqual(v.refused, []);
  assert.match(v.notes[0]!, /^off hours: the market is closed/);
  assert.match(
    v.notes[1]!,
    /^delta: no strike of this expiry is in the range; delta 0\.085/,
  );
  // An empty quote is refused off hours too.
  c.order.quote.bid = 0;
  assert.match(checkBuy(c).refused.join(), /quote is usable: bid 0/);
});

test("buy checks: the optional checks refuse when switched on", () => {
  const strict = {
    ...defaultBuyLimits,
    requireMarketOpen: true,
    requireDeltaInRange: true,
  };
  const closed = good();
  closed.marketOpen = false;
  assert.deepEqual(checkBuy(closed, strict).refused, [
    "market open: the market is closed",
  ]);
  const far = good();
  far.order.quote.delta = 0.16;
  assert.deepEqual(checkBuy(far, strict).refused, [
    "delta in range: delta 0.160, wanted 0.10–0.15",
  ]);
  // And a position without a stop can be allowed.
  const bare = good();
  bare.positions = [held(0, null, 1)];
  assert.deepEqual(
    checkBuy(bare, { ...defaultBuyLimits, requireStops: false }).refused,
    [],
  );
});

test("buy checks: risk of open positions, a missing stop counts in full", () => {
  // 10 held at 2.00, stop 1.20 on all: 0.80 × 10 × 100.
  assert.equal(openRisk([held(10, 1.2)]), 800);
  // Stop on 6 only: 0.80 × 6 × 100, plus 4 × 2.00 × 100 unprotected.
  assert.equal(openRisk([held(6, 1.2)]), 480 + 800);
  assert.equal(openRisk([held(0, null)]), 2000);
  // A stop above the entry risks nothing; a short position is not this check's.
  assert.equal(openRisk([held(10, 2.5), held(0, null, -3)]), 0);
});
