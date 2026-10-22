import assert from "node:assert/strict";
import test from "node:test";
import {
  addTicker,
  defaultSettings,
  fromBotView,
  leftBacktest,
  resetToDefaults,
  settingsWarnings,
  tickerItems,
  toggleTicker,
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
  assert.equal(r.stopPct, 30);
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

test("the signal leaves the backtest when any of its values change", () => {
  assert.equal(leftBacktest(defaultSettings), false);
  assert.equal(leftBacktest({ ...defaultSettings, minT: 2.5 }), true);
  assert.equal(leftBacktest({ ...defaultSettings, skipEarnings: false }), true);
});
