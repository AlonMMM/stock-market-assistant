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
  volumeBacktestStory,
  pricedCounts,
  sameRun,
  volumeCsv,
  volumeMoney,
  volumeRows,
  rowHeld,
  dataGapWords,
  slowBurstWords,
  rowReturn,
  sortVolumeRows,
  volumeWhatIfStory,
  whatIfTrade,
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
  // Every alert not bought, the account's refusals too.
  assert.deepEqual(outcomeCounts(rows), [
    {
      reason: "account:per_stock",
      label: "The stock's trades for the day were used",
      count: 1,
      account: true,
    },
    {
      reason: "slow_cross",
      label: "Side too slow",
      count: 1,
      account: false,
    },
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
  // Its window (the trade story): why, the sale, the paid and stop lines, the alert.
  const story = volumeBacktestStory(taken, settings, true);
  assert.equal(story.entryTitle, "Why the volume bot entered");
  assert.equal(story.entry.length, 3);
  assert.equal(story.paid, 0.41);
  assert.equal(
    story.stop,
    Number((0.41 * (1 - settings.safetyStopPct / 100)).toFixed(2)),
  );
  assert.equal(story.exits.length, 1);
  assert.equal(story.exits[0]!.price, 0.82);
  // The alert's label on the chart's clock, Israel time (not New York).
  const alert = story.markers.find((m) => m.kind === "signal")!;
  const israel = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(alert.ms);
  assert.equal(alert.label, `alert ${israel}`);
  assert.equal(volumeBacktestStory(taken, settings, false).stop, null);
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
    /^2024-02-07,MRVL,shock,10:30:00,up,1.40,,,traded,Traded,MRVL240207C00070000,10:30:05,0.41,seconds,0.82,minutes,giveback,,,,,60,0.4,0.42,5.0,,,,,,,$/,
  );
  assert.match(
    csv[2]!,
    /^2024-02-06,MRVL,plan,10:10:00,up,1.40,,,no_fill,No fill,/,
  );
});

test("volume alerts table (2026-11-06): the return of a trade, of one the account refused (if taken), and of an alert not bought (a model); how close; held; sorting", () => {
  const whatIf = {
    contract: "MRVL240207C00071000",
    right: "C" as const,
    strike: 71,
    expiry: "2024-02-07",
    sideSecond: null,
    buyMinute: 70,
    exitMinute: 100,
    exitReason: "giveback" as const,
    stockIn: 68.4,
    stockOut: 68.9,
    buy: 0.2,
    sell: 0.3,
    iv: 0.55,
    ret: 0.5,
  };
  const taken = signal({ trade: trade({ volume30: 640 }) });
  const refused = signal({
    id: "MRVL|2024-02-07|plan|9000",
    kind: "plan",
    second: 9000,
    trade: trade({ buyMinute: 150, exitMinute: 170, buy: 0.5, sell: 0.4 }),
  });
  const slow = signal({
    id: "MRVL|2024-02-07|plan|4200",
    kind: "plan",
    second: 4200,
    outcome: "slow_cross",
    reach: 0.87,
    whatIf,
  });
  const runs = [run([taken, refused, slow])];
  const rows = volumeRows(runs, volumeAccount(runs, money));
  const by = (id: string) => rows.find((r) => r.key === id)!;
  assert.equal(rowReturn(by(taken.id), 0.62)!.kind, "trade");
  const ifTaken = rowReturn(by(refused.id), 0.62)!;
  assert.equal(ifTaken.kind, "refused");
  assert.equal(ifTaken.ret, (0.4 * 100 - 0.62) / (0.5 * 100 + 0.62) - 1);
  assert.deepEqual(rowReturn(by(slow.id), 0.62), { ret: 0.5, kind: "model" });
  // On the saved books (2026-11-07): "book", not a model price.
  const onBooks = by(slow.id);
  assert.deepEqual(
    rowReturn(
      {
        ...onBooks,
        signal: { ...onBooks.signal, whatIf: { ...whatIf, priced: "book" } },
      },
      0.62,
    ),
    { ret: 0.5, kind: "book" },
  );
  assert.deepEqual(rowHeld(by(taken.id)), { minutes: 60, model: false });
  assert.deepEqual(rowHeld(by(slow.id)), { minutes: 30, model: true });
  // Sorting: how close, high first; the empty ones last.
  assert.deepEqual(
    sortVolumeRows(rows, "reach", "desc").map((r) => r.key),
    [slow.id, refused.id, taken.id],
  );
  assert.deepEqual(
    sortVolumeRows(rows, "ret", "desc").map((r) => r.key)[0],
    taken.id,
  );
  // The CSV carries the new columns.
  const csv = volumeCsv(rows).split("\n");
  assert.match(
    csv[0]!,
    /reach_pct,held_min,bid,ask,spread_pct,volume30,whatif_contract,whatif_buy,whatif_sell,whatif_return_pct,whatif_priced,data_gap_s$/,
  );
  assert.match(
    csv.find((l) => l.includes("slow_cross"))!,
    /,87,30,,,,,MRVL240207C00071000,0.2,0.3,50.0,model,$/,
  );
  // The what-if opens as a one-contract trade with its own story.
  const one = whatIfTrade(slow)!;
  assert.equal(one.qty, 1);
  assert.equal(one.signal.trade!.toSide, 0);
  const story = volumeWhatIfStory(slow, "Side too slow", settings)!;
  assert.match(story.story.entryTitle, /model price/);
  assert.match(
    story.story.entry[0]!,
    /Not bought: Side too slow\. In the window the stock reached 87%/,
  );
  assert.equal(story.story.stop, null);
  assert.equal(whatIfTrade(taken), null);
});

test("volume alerts table (2026-11-06): a buy under 5 cents shows no return, traded or a model", () => {
  const cheapTrade = signal({ trade: trade({ buy: 0.04, sell: 0.4 }) });
  const cheapModel = signal({
    id: "MRVL|2024-02-07|plan|4200",
    kind: "plan",
    second: 4200,
    outcome: "slow_cross",
    whatIf: {
      contract: "MRVL240207C00075000",
      right: "C" as const,
      strike: 75,
      expiry: "2024-02-07",
      sideSecond: null,
      buyMinute: 70,
      exitMinute: 100,
      exitReason: "giveback" as const,
      stockIn: 68.4,
      stockOut: 68.9,
      buy: 0.01,
      sell: 0.2,
      iv: 0.55,
      ret: 19,
    },
  });
  const runs = [run([cheapTrade, cheapModel])];
  const rows = volumeRows(runs, volumeAccount(runs, money));
  for (const r of rows) assert.equal(rowReturn(r, 0.62), null);
  const csv = volumeCsv(rows).split("\n");
  assert.ok(!csv.some((line) => line.includes("1900.0")));
});

test("volume alerts table (2026-11-06): a data gap is a warning in words and a CSV column", () => {
  const gapped = signal({
    outcome: "slow_cross",
    dataGap: { from: 12200, to: 12213 },
  });
  const words = dataGapWords(gapped)!;
  assert.match(words, /from 12:53:20 to 12:53:33 New York \(13 s\)/);
  assert.equal(dataGapWords(signal({})), null);
  const runs = [run([gapped])];
  const csv = volumeCsv(volumeRows(runs, volumeAccount(runs, money))).split(
    "\n",
  );
  assert.match(csv[1]!, /,13$/);
});

test("volume alerts table (2026-11-07): a side too slow says whether its burst would have passed too", () => {
  const whatIf = {
    contract: "MRVL240207P00066000",
    right: "P" as const,
    strike: 66,
    expiry: "2024-02-07",
    sideSecond: 3700,
    buyMinute: 61,
    exitMinute: 90,
    exitReason: "giveback" as const,
    stockIn: 68,
    stockOut: 67,
    buy: 0.5,
    sell: 0.4,
    iv: 0.55,
    ret: -0.2,
  };
  const weak = slowBurstWords(
    signal({
      kind: "plan",
      outcome: "slow_cross",
      burst: 0.4,
      whatIf,
      slowBurst: { passes: false, need: 1.1 },
    }),
  )!;
  assert.equal(weak.label, "burst weak too");
  assert.match(weak.title, /-0\.40× \(it needs 1\.1×\)/);
  const ok = slowBurstWords(
    signal({
      kind: "plan",
      outcome: "slow_cross",
      burst: -1.5,
      whatIf,
      slowBurst: { passes: true, need: 1.1 },
    }),
  )!;
  assert.equal(ok.passes, true);
  assert.match(ok.title, /1\.50×/);
  assert.equal(slowBurstWords(signal({})), null);
});

test("volume account (2026-11-07): the open trades' cost cap refuses a buy that would pass it", () => {
  const at = (symbol: string) =>
    signal({ id: `${symbol}|2024-02-07|shock|3600`, symbol, trade: trade() });
  const runs = [run([at("MRVL"), at("AMD"), at("NVDA")])];
  // 2% of $100K buys 48 contracts at $0.41: $1,968 each; 5% of the account holds two.
  const capped = volumeAccount(runs, { ...money, maxOpenCostPct: 5 });
  assert.deepEqual(capped.trades.map((t) => t.status).sort(), [
    "open_cost",
    "taken",
    "taken",
  ]);
  const off = volumeAccount(runs, { ...money, maxOpenCostPct: 100 });
  assert.equal(off.taken, 3);
  assert.equal(
    volumeMoney(
      { start: 100_000, feePerContract: 0.62, limits: true },
      settings,
    ).maxOpenCostPct,
    100,
  );
});
