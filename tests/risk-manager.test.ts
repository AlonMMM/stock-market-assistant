import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAccountRisk,
  defaultAccountRisk,
  parseAccountRisk,
  withDefaults,
} from "../packages/trading/src/account-risk.js";
import { defaultBuyLimits } from "../packages/trading/src/checks.js";
import {
  accountState,
  checkRisk,
  defaultRiskRules,
  lossShare,
} from "../packages/trading/src/risk-manager.js";

// Synthetic equity curves.
const days = (...equity: number[]) =>
  equity.map((e, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    equity: e,
  }));

test("risk manager: share of the premium at risk by days to expiry", () => {
  assert.deepEqual(
    [45, 30, 29, 7, 6, 5, 4, 3, 2, 1, 0].map(lossShare),
    [0.5, 0.5, 0.7, 0.7, 0.7, 0.75, 0.8, 0.85, 0.9, 1, 1],
  );
});

test("risk manager: full at a new high and with no history", () => {
  assert.equal(accountState([]).state, "full");
  assert.equal(accountState(days(100, 101, 103)).state, "full");
  assert.equal(accountState(days(100, 110, 100)).state, "full");
});

test("risk manager: the brake goes on 12.5% below the high", () => {
  assert.equal(accountState(days(100, 96, 92, 88)).state, "full");
  const s = accountState(days(100, 96, 92, 87.5));
  assert.equal(s.state, "brake");
  assert.equal(s.drawdownPct, 12.5);
});

test("risk manager: two days in a row at the daily limit put the brake on", () => {
  // Full state: the daily limit is 7%.
  assert.equal(accountState(days(100, 93, 99)).state, "full");
  assert.equal(accountState(days(200, 186, 172.98)).state, "brake");
  assert.equal(accountState(days(200, 186, 190, 176.7)).state, "full");
});

test("risk manager: recovery after two thirds, brake again after giving half back, full at a new high", () => {
  const fall = [100, 94, 88, 82]; // trough 82, fall of 18
  assert.equal(accountState(days(...fall, 93)).state, "brake");
  assert.equal(accountState(days(...fall, 94)).state, "recovery");
  // Recovered 82 → 94; half of it back is 88.
  assert.equal(accountState(days(...fall, 94, 89)).state, "recovery");
  assert.equal(accountState(days(...fall, 94, 88)).state, "brake");
  assert.equal(accountState(days(...fall, 94, 97, 100)).state, "full");
});

test("risk manager: allows a normal trade at full limits", () => {
  const v = checkRisk({
    history: days(100_000, 101_000),
    equity: 101_000,
    todayLoss: 0,
    premium: 3000,
    daysToExpiry: 4,
  });
  assert.equal(v.ok, true);
  assert.equal(v.tradeRisk, 2400);
  assert.equal(v.tradeLimit, 5050);
});

test("risk manager: under the brake a short-dated 3% trade is refused", () => {
  const history = days(100_000, 94_000, 88_000, 82_000);
  const order = { history, equity: 82_000, todayLoss: 0, premium: 2460 };
  // 3% of the account in premium; the brake allows 2% at risk.
  const week = checkRisk({ ...order, daysToExpiry: 7 });
  assert.equal(week.account.state, "brake");
  assert.equal(week.ok, false);
  assert.match(week.reasons[0]!, /limit per trade is 2% of the account/);
  assert.equal(checkRisk({ ...order, daysToExpiry: 30 }).ok, true);
});

test("risk manager: today's loss counts toward the daily limit", () => {
  const order = {
    history: days(100_000),
    equity: 100_000,
    premium: 2000,
    daysToExpiry: 2,
  };
  assert.equal(checkRisk({ ...order, todayLoss: 5000 }).ok, true);
  const v = checkRisk({ ...order, todayLoss: 5300 });
  assert.equal(v.ok, false);
  assert.match(v.reasons[0]!, /limit per day is 7% of the account, \$7,000/);
  // A day that is ahead does not add room.
  assert.equal(checkRisk({ ...order, todayLoss: -9000 }).dayRisk, 1800);
});

test("risk manager: a trade with a stop is counted at its stop; the user's case: 4% down, a 2% trade at the 50% stop fits a 5% day", () => {
  const rules = applyAccountRisk(
    defaultBuyLimits,
    defaultRiskRules,
    defaultAccountRisk,
  ).riskRules;
  const order = {
    history: days(100_000),
    equity: 100_000,
    premium: 2000, // 2% of the account
    daysToExpiry: 2,
    stopPct: 50,
  };
  const ok = checkRisk({ ...order, todayLoss: 4000 }, rules);
  assert.equal(ok.ok, true);
  assert.equal(ok.tradeRisk, 1000);
  assert.equal(ok.dayRisk, 5000);
  assert.equal(ok.dayLimit, 5000);
  // 4.5% down: 5.5% with this trade, over the 5% limit.
  const no = checkRisk({ ...order, todayLoss: 4500 }, rules);
  assert.equal(no.ok, false);
  assert.match(no.reasons[0]!, /limit per day is 5% of the account/);
  // Without a stop it is the share lost by expiry, as before (90% at 2 days).
  const { stopPct: _, ...bare } = order;
  assert.equal(checkRisk({ ...bare, todayLoss: 0 }, rules).tradeRisk, 1800);
});

test("account risk: defaults, a saved record over them, the bounds, and the rules they make", () => {
  assert.equal(defaultAccountRisk.dayLossPct, 5);
  const merged = withDefaults({
    dayLossPct: 6,
    brake: { trade: 1, day: 2 },
  } as never);
  assert.equal(merged.dayLossPct, 6);
  assert.equal(merged.tradeRiskPct, 5);
  assert.deepEqual(merged.brake, { trade: 1, day: 2 });
  assert.deepEqual(merged.recovery, defaultAccountRisk.recovery);
  assert.deepEqual(
    parseAccountRisk({ ...defaultAccountRisk }),
    defaultAccountRisk,
  );
  assert.match(
    String(parseAccountRisk({ ...defaultAccountRisk, dayLossPct: 40 })),
    /daily loss limit must be from 0.5 to 25/,
  );
  assert.match(
    String(parseAccountRisk({ ...defaultAccountRisk, buysPerDay: 2.5 })),
    /whole number/,
  );
  const r = applyAccountRisk(defaultBuyLimits, defaultRiskRules, merged);
  assert.equal(r.limits.maxDayLossPct, 6);
  assert.equal(r.limits.maxSizePct, defaultBuyLimits.maxSizePct); // the size cap stays
  assert.deepEqual(r.riskRules.limits.full, { trade: 5, day: 6 });
  assert.deepEqual(r.riskRules.limits.brake, { trade: 1, day: 2 });
});
