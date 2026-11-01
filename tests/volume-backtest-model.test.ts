// SYNTHETIC alerts and trades: the Volume bot's backtest on the Backtest page.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { VolumeBacktestResponse } from "../packages/market-data/src/volume-backtest.js";
import {
  volumeAccount,
  type VolumeSignal,
  type VolumeTrade,
} from "../packages/trading/src/strangle/backtest.js";
import { defaultStrangleSettings } from "../packages/trading/src/strangle/settings.js";
import {
  closedVolumeTrade,
  defaultVolumeMoney,
  nyClock,
  outcomeCounts,
  pricedCounts,
  sameRun,
  volumeCsv,
  volumeMoney,
  volumeRows,
} from "../apps/web/src/volume-backtest-model.js";

const trade = (over: Partial<VolumeTrade> = {}): VolumeTrade => ({
  contract: "MRVL240207C00070000",
  right: "C",
  strike: 70,
  expiry: "2024-02-07",
  delta: 0.2,
  fallback: "",
  sideSecond: 3605,
  toSide: 5,
  stockIn: 68.5,
  buyMinute: 60,
  buy: 0.41,
  book: { bid: 0.4, ask: 0.42 },
  spread: 0.05,
  buyPriced: "seconds",
  exitMinute: 120,
  exitReason: "giveback",
  sell: 0.82,
  sellPriced: "minutes",
  stockOut: 69.4,
  ...over,
});

const signal = (over: Partial<VolumeSignal> = {}): VolumeSignal => ({
  id: "MRVL|2024-02-07|shock|3600",
  symbol: "MRVL",
  date: "2024-02-07",
  kind: "shock",
  minute: 60,
  second: 3600,
  alert: "up",
  price: 68.4,
  unit: 0.01,
  burst: 1.4,
  expiry: "2024-02-07",
  outcome: "traded",
  detail: "",
  ...over,
});

const run = (signals: VolumeSignal[]): VolumeBacktestResponse => ({
  symbol: "MRVL",
  signals,
  ignored: [],
  from: "2024-02-01",
  to: "2024-02-29",
  lastSession: "2024-02-29",
  fillPct: 2,
});

const settings = { ...defaultStrangleSettings, sizePct: 2, maxPerStock: 1 };
const money = volumeMoney(defaultVolumeMoney, settings);

test("volume backtest page: every alert, newest first, with the account's verdict", () => {
  const first = signal({ trade: trade() });
  // A second trade of the stock that day: refused (one a stock a day here).
  const second = signal({
    id: "MRVL|2024-02-07|plan|9000",
    kind: "plan",
    minute: 149,
    second: 9000,
    trade: trade({ buyMinute: 150, exitMinute: 200 }),
  });
  const skipped = signal({
    id: "MRVL|2024-02-06|plan|2400",
    date: "2024-02-06",
    kind: "plan",
    second: 2400,
    outcome: "slow_cross",
  });
  const runs = [run([first, second, skipped])];
  const account = volumeAccount(runs, money);
  const rows = volumeRows(runs, account);
  assert.deepEqual(
    rows.map((r) => [r.key, r.bought, r.why]),
    [
      [
        "MRVL|2024-02-07|plan|9000",
        false,
        "The stock's trades for the day were used",
      ],
      ["MRVL|2024-02-07|shock|3600", true, "Traded"],
      ["MRVL|2024-02-06|plan|2400", false, "Side too slow"],
    ],
  );
  assert.deepEqual(outcomeCounts(rows), [
    { outcome: "slow_cross", label: "Side too slow", count: 1 },
  ]);
  // Only taken trades count in the fills' sources.
  assert.deepEqual(pricedCounts(account), {
    buys: { seconds: 1, minutes: 0, bars: 0 },
    sales: { seconds: 0, minutes: 1, bars: 0 },
  });
  // 2% of $100,000 at $0.41: 48 contracts.
  const taken = account.trades.find((a) => a.status === "taken")!;
  assert.equal(taken.qty, 48);
  const closed = closedVolumeTrade(taken);
  assert.equal(closed.entry, 0.41);
  assert.equal(closed.exit, 0.82);
  assert.equal(closed.underlying, "MRVL");
  assert.equal(closed.fills!.length, 2);
  assert.ok(Date.parse(closed.closedAt) > Date.parse(closed.openedAt));
});

test("volume backtest page: the size and limits need no new run; the rest does", () => {
  assert.ok(sameRun(defaultStrangleSettings, settings));
  assert.ok(!sameRun(defaultStrangleSettings, { ...settings, delta: 0.25 }));
  assert.ok(
    !sameRun(defaultStrangleSettings, { ...settings, shockAlert: false }),
  );
  assert.equal(money.sizePct, 2);
  assert.equal(money.limits, true);
  assert.equal(money.start, 100_000);
});

test("volume backtest page: New York clock and CSV", () => {
  assert.equal(nyClock(0), "9:30:00");
  assert.equal(nyClock(3605), "10:30:05");
  const rows = volumeRows(
    [
      run([
        signal({ trade: trade() }),
        signal({
          id: "MRVL|2024-02-06|plan|2400",
          date: "2024-02-06",
          kind: "plan",
          second: 2400,
          outcome: "no_fill",
          detail: 'ask ran away, "fast"',
        }),
      ]),
    ],
    null,
  );
  const csv = volumeCsv(rows).split("\n");
  assert.equal(csv.length, 3);
  assert.match(csv[0]!, /^date,symbol,alert,time_ny/);
  assert.match(
    csv[1]!,
    /^2024-02-07,MRVL,shock,10:30:00,up,1.40,traded,Traded,MRVL240207C00070000,10:30:05,0.41,seconds,0.82,minutes,giveback,,,$/,
  );
  assert.match(
    csv[2]!,
    /^2024-02-06,MRVL,plan,10:10:00,up,1.40,no_fill,No fill,/,
  );
});
