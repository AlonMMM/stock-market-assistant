import assert from "node:assert/strict";
import test from "node:test";
import {
  addTicker,
  algorithmSteps,
  botVersions,
  defaultSettings,
  fromBotView,
  leftBacktest,
  resetToDefaults,
  settingsWarnings,
  tickerItems,
  toggleTicker,
  versionState,
  type Rules,
} from "../apps/web/src/bot-settings-model.js";
import type { BotView } from "../packages/trading/src/bot-api.js";

// Synthetic bot status: only the fields the settings page reads matter.
const view = (patch: Partial<BotView> = {}): BotView => ({
  enabled: false,
  mode: "dry",
  sizePct: 1,
  delta: 0.1,
  universe: ["NVDA", "TSLA", "AAPL"],
  favorites: { name: "Favorites ★", tickers: ["AAPL", "WIX", "QQQ"], at: 0 },
  watching: ["NVDA", "AAPL", "WIX"],
  lastRun: null,
  day: "2026-10-22",
  scan: [],
  activity: [],
  signals: [],
  positions: [],
  ...patch,
});

test("seeds from what the bot reports; stocks it does not watch start off", () => {
  const s = fromBotView(view());
  assert.equal(s.enabled, false);
  assert.equal(s.mode, "dry");
  assert.equal(s.sizePct, 1);
  assert.equal(s.delta, 0.1);
  assert.deepEqual(s.off, ["TSLA", "QQQ"]);
  assert.equal(s.stopPct, defaultSettings.stopPct);
});

test("without a watch list yet, the index ETFs start off", () => {
  assert.deepEqual(fromBotView(view({ watching: [] })).off, ["QQQ", "SQQQ"]);
});

test("ticker items: core first, then added, then favorites, each marked", () => {
  const s = { ...defaultSettings, added: ["HOOD"], off: ["TSLA"] };
  const items = tickerItems(
    s,
    ["NVDA", "TSLA", "AAPL"],
    ["AAPL", "WIX", "SPY"],
  );
  assert.deepEqual(
    items.map((k) => k.t),
    ["NVDA", "TSLA", "AAPL", "HOOD", "WIX"],
  );
  const aapl = items.find((k) => k.t === "AAPL")!;
  assert.equal(aapl.core && aapl.favorite, true);
  assert.equal(items.find((k) => k.t === "HOOD")!.added, true);
  assert.equal(items.find((k) => k.t === "TSLA")!.on, false);
});

test("not following favorites hides them", () => {
  const s = { ...defaultSettings, followFavorites: false };
  const items = tickerItems(s, ["NVDA"], ["WIX"]);
  assert.deepEqual(
    items.map((k) => k.t),
    ["NVDA"],
  );
});

test("toggling turns a stock off and back on", () => {
  const off = toggleTicker(defaultSettings, "NVDA");
  assert.ok(off.off.includes("NVDA"));
  assert.ok(!toggleTicker(off, "NVDA").off.includes("NVDA"));
});

test("adding: new tickers are added, listed ones turned back on, bad ones refused", () => {
  const s = { ...defaultSettings, off: ["NVDA"] };
  const back = addTicker(s, " nvda ", ["NVDA"]);
  assert.ok(typeof back !== "string");
  assert.deepEqual(back.off, []);
  assert.deepEqual(back.added, []);
  const added = addTicker(s, "hood", ["NVDA"]);
  assert.ok(typeof added !== "string");
  assert.deepEqual(added.added, ["HOOD"]);
  assert.match(addTicker(s, "SPY", []) as string, /benchmark/);
  assert.match(addTicker(s, "GC", []) as string, /future/);
  assert.match(addTicker(s, "12", []) as string, /1–6 letters/);
});

test("reset keeps on/off and the mode", () => {
  const s = {
    ...defaultSettings,
    enabled: false,
    mode: "dry" as const,
    stopPct: 45,
  };
  const r = resetToDefaults(s);
  assert.equal(r.stopPct, 60);
  assert.equal(r.enabled, false);
  assert.equal(r.mode, "dry");
});

test("warnings: a safety stop above the stop, and a big trade size", () => {
  assert.deepEqual(settingsWarnings(defaultSettings), []);
  const w = settingsWarnings({
    ...defaultSettings,
    safetyStopPct: 30,
    sizePct: 4,
  });
  assert.equal(w.length, 2);
});

test("the version card: the chosen version, its changes and the entry label", () => {
  const clean = versionState(defaultSettings);
  assert.equal(clean.known?.id, "2.10.0");
  assert.deepEqual(clean.changes, []);
  assert.equal(clean.label, "2.10.0");
  assert.equal(clean.latest, true);
  assert.equal(clean.bump, null);
  assert.equal(clean.next, null);
  const patch = versionState({ ...defaultSettings, weaknessT: 0.25 });
  assert.equal(patch.bump, "patch");
  assert.equal(patch.next, "2.10.1");
  assert.equal(patch.label, "2.10.0*");
  const edited = versionState({ ...defaultSettings, stopPct: 40 });
  assert.equal(edited.bump, "minor");
  assert.equal(edited.next, "2.11.0");
  assert.deepEqual(edited.changes, ["stopPct 60 → 40"]);
  assert.equal(edited.label, "2.10.0*");
  const old = versionState({ ...defaultSettings, version: "2.0" });
  assert.equal(old.latest, false);
  assert.deepEqual(old.changes, [
    "stopPct 30 → 60",
    "restStopPct 0 → 20",
    "checks true → false",
    "sellOnWeakness false → true",
    "holdFromPct 100 → 50",
    "d2Entry false → true",
    "lowFloorSymbols none → IBIT",
    "pyramid false → true",
    "earlyEntry false → true",
    "stockStages false → true",
    "lateHold false → true",
    "sizeSteps none → 2.5% from $300,000, 1.5% from $1,000,000, 1% from $4,000,000",
    "breakEvenLock false → true",
    "volumeTiers none → 50% from 0×, 100% from 1.75×, 150% from 2.5×",
  ]);
  const own = versionState({ ...defaultSettings, version: "mine" });
  assert.equal(own.known, undefined);
  assert.equal(own.label, "mine");
});

test("each version opens to its full algorithm in words", () => {
  const names = (rules: Rules) => algorithmSteps(rules).map((s) => s.name);
  const expected = [
    "Signal",
    "News filter",
    "Contract",
    "Pyramid",
    "Size",
    "Early checks",
    "Staged stock exit",
    "Break-even lock",
    "Late entries",
    "Failed break",
    "Strength gone",
    "Stop",
    "Day exit",
  ];
  for (const v of botVersions) assert.deepEqual(names(v.rules), expected);
  const text = (rules: Rules, name: string) =>
    algorithmSteps(rules).find((s) => s.name === name)!.text;
  const v1 = botVersions[0]!;
  const v21 = botVersions[2]!;
  assert.match(text(v1.rules, "Signal"), /t 2\+/);
  assert.match(text(v21.rules, "Signal"), /t 1\.8\+/);
  assert.match(text(v1.rules, "News filter"), /^Off/);
  assert.match(
    text(v21.rules, "News filter"),
    /earnings reaction day, or when its pre-market volume/,
  );
  assert.match(text(v1.rules, "Failed break"), /^Off/);
  assert.match(
    text(v21.rules, "Failed break"),
    /sold when the stock reaches the next level/,
  );
  assert.match(
    text(v1.rules, "Day exit"),
    /2 nights at most, never into expiry\)\./,
  );
  assert.match(text(v21.rules, "Day exit"), /at most 10% of the account/);
  // 2.7: early entry, IBIT's floor and the pyramid in words.
  const v27 = botVersions.find((v) => v.id === "2.7.0")!;
  assert.match(text(v27.rules, "Signal"), /checked every 5 seconds/);
  assert.match(text(v1.rules, "Signal"), /checked once a minute/);
  assert.match(text(v27.rules, "Contract"), /IBIT down to \$0\.10/);
  // 2.9: the break-even lock in words; off before it.
  const v29 = botVersions.find((v) => v.id === "2.9.0")!;
  assert.match(text(v29.rules, "Break-even lock"), /once the option is up 50%/);
  assert.match(text(v27.rules, "Break-even lock"), /^Off/);
  assert.match(text(v27.rules, "Contract"), /skipped under \$0\.20/);
  assert.match(text(v27.rules, "Pyramid"), /50% of the size/);
  assert.match(text(v1.rules, "Pyramid"), /^Off/);
  // 2.8: the staged stock exit, no checks, the stop at -60%.
  const v28 = botVersions.find((v) => v.id === "2.8.0")!;
  assert.match(
    text(v28.rules, "Staged stock exit"),
    /half is sold once the stock is 0\.5 of its usual 30-minute move against the price at the signal, the rest at 1 against/,
  );
  assert.match(text(v27.rules, "Staged stock exit"), /^Off/);
  assert.match(text(v28.rules, "Early checks"), /^No 10- and 20-minute checks/);
  assert.match(text(v28.rules, "Stop"), /down 60%/);
  assert.match(text(v28.rules, "Late entries"), /15:00 or later is not sold/);
  assert.match(text(v27.rules, "Late entries"), /^Off/);
  // The rules as set, not only a version's: a changed stop and no volume floor.
  const own = text({ ...defaultSettings, stopPct: 40, minVolume: 0 }, "Stop");
  assert.match(own, /down 40%/);
  assert.doesNotMatch(
    text({ ...defaultSettings, minVolume: 0 }, "Contract"),
    /contracts traded/,
  );
  assert.match(
    text({ ...defaultSettings, maxNights: 0 }, "Day exit"),
    /^At 15:50 everything is sold\./,
  );
});

test("the signal leaves the backtest when any of its values change", () => {
  assert.equal(leftBacktest(defaultSettings), false);
  assert.equal(leftBacktest({ ...defaultSettings, minT: 2.5 }), true);
  assert.equal(leftBacktest({ ...defaultSettings, skipEarnings: false }), true);
});
