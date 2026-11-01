import assert from "node:assert/strict";
import test from "node:test";
import { handleBotSettings } from "../packages/trading/src/bot-api.js";
import { nextAction, nightCapSell } from "../packages/trading/src/bot/exits.js";
import {
  cState,
  priorFrom,
  splitRatio,
} from "../packages/trading/src/bot/signal.js";
import {
  defaultSettings,
  drawdown,
  entryBrokers,
  exitRules,
  limits,
  parseSettings,
  pickRules,
  signalParams,
  untested,
  watchedStocks,
  withDefaults,
} from "../packages/trading/src/bot/settings.js";
import {
  applyVersion,
  botVersions,
  canonicalVersion,
  currentVersion,
  matchingVersion,
  nextVersionId,
  ruleBump,
  ruleChanges,
  ruleKeys,
  rulesOf,
  versionBump,
  versionById,
  versionLabel,
} from "../packages/trading/src/bot/versions.js";

// ---- versions (docs/tasks/backend-bot-settings.md, "Versions") ----

test("versions: distinct ids oldest first; the defaults are the current version's rules", () => {
  const ids = botVersions.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(currentVersion, "2.9.0");
  assert.equal(defaultSettings.version, currentVersion);
  assert.equal(matchingVersion(defaultSettings)?.id, "2.9.0");
  assert.deepEqual(rulesOf(defaultSettings), botVersions.at(-1)!.rules);
  // Each version differs from the one before, and 2.1 is 2.0 plus the failed-break sale.
  for (let i = 1; i < botVersions.length; i++)
    assert.ok(ruleChanges(botVersions[i]!.rules, botVersions[i - 1]!).length);
  assert.deepEqual(ruleChanges(botVersions[2]!.rules, botVersions[1]!), [
    "sellFailedBreak false → true",
  ]);
  // 2.2 is 2.1 plus the t-stat exit.
  assert.deepEqual(ruleChanges(botVersions[3]!.rules, botVersions[2]!), [
    "sellOnWeakness false → true",
  ]);
  // 2.3 is 2.2 holding overnight from +50%.
  assert.deepEqual(ruleChanges(botVersions[4]!.rules, botVersions[3]!), [
    "holdFromPct 100 → 50",
  ]);
  // 2.4 is 2.3 with the rest at -20% after the 10-minute half.
  assert.deepEqual(ruleChanges(botVersions[5]!.rules, botVersions[4]!), [
    "restStopPct 0 → 20",
  ]);
  // 2.5 is 2.4 with the D2 bonus entry and without the failed-break sale.
  assert.deepEqual(ruleChanges(botVersions[6]!.rules, botVersions[5]!), [
    "sellFailedBreak true → false",
    "d2Entry false → true",
  ]);
  // 2.6 is 2.5 with the cheap fallback.
  assert.deepEqual(ruleChanges(botVersions[7]!.rules, botVersions[6]!), [
    "cheapFallback false → true",
  ]);
  // 2.7 is 2.5 with IBIT down to $0.10, the pyramid and early entry (from 2.6: no cheap fallback).
  assert.deepEqual(ruleChanges(botVersions[8]!.rules, botVersions[7]!), [
    "cheapFallback true → false",
    "lowFloorSymbols none → IBIT",
    "pyramid false → true",
    "earlyEntry false → true",
  ]);
  // 2.8 is 2.7 with the staged stock exit, no checks and the stop at -60%.
  assert.deepEqual(ruleChanges(botVersions[9]!.rules, botVersions[8]!), [
    "stopPct 30 → 60",
    "checks true → false",
    "stockStages false → true",
    "lateHold false → true",
  ]);
  // 2.8.1 is 2.8 with the size stepping down as the account grows.
  assert.deepEqual(ruleChanges(botVersions[10]!.rules, botVersions[9]!), [
    "sizeSteps none → 2.5% from $300,000, 1.5% from $1,000,000, 1% from $4,000,000",
  ]);
  // 2.9 is 2.8.1 (its size steps kept) with the break-even lock from +50%.
  assert.deepEqual(ruleChanges(botVersions[11]!.rules, botVersions[10]!), [
    "breakEvenLock false → true",
  ]);
  assert.deepEqual(
    botVersions[11]!.rules.sizeSteps,
    botVersions[10]!.rules.sizeSteps,
  );
});

test("versions: the label is the version, starred when its rules were changed; an own label stays", () => {
  assert.equal(versionLabel(defaultSettings), "2.9.0");
  assert.equal(versionLabel({ ...defaultSettings, stopPct: 40 }), "2.9.0*");
  // The IBIT list is a rule: changing it stars the label.
  assert.equal(
    versionLabel({ ...defaultSettings, lowFloorSymbols: ["IBIT", "MSTR"] }),
    "2.9.0*",
  );
  // The owner's limits and lists are not rules: no star.
  assert.equal(
    versionLabel({ ...defaultSettings, sizePct: 1, off: ["TSLA"] }),
    "2.9.0",
  );
  const own = { ...defaultSettings, version: "2.2-test", stopPct: 40 };
  assert.equal(versionLabel(own), "2.2-test");
  assert.equal(matchingVersion(own), undefined);
});

test("versions: applying one sets its rules and keeps the owner's limits", () => {
  const s = applyVersion({ ...defaultSettings, sizePct: 1 }, "1.0.0");
  assert.equal(s.version, "1.0.0");
  assert.equal(s.minT, 2);
  assert.equal(s.nightCapPct, 0);
  assert.equal(s.skipEarnings, false);
  assert.equal(s.sellFailedBreak, false);
  assert.equal(s.sizePct, 1);
  assert.equal(versionLabel(s), "1.0.0");
  const back = applyVersion(s, "2.9.0");
  assert.deepEqual(rulesOf(back), rulesOf(defaultSettings));
  assert.equal(applyVersion(s, "mine").version, "mine");
});

test("versions: parse checks the label; a record saved before versions gets the version its rules match", () => {
  assert.equal(parseSettings({ ...defaultSettings, version: "" }).ok, false);
  assert.equal(
    parseSettings({ ...defaultSettings, version: "a".repeat(25) }).ok,
    false,
  );
  assert.equal(parseSettings({ ...defaultSettings, version: "<x>" }).ok, false);
  const own = parseSettings({ ...defaultSettings, version: " 2.2 test " });
  assert.equal(own.ok && own.value.version, "2.2 test");
  // A record from before versions takes its missing rules from 2.6. Saved with those rules: 2.6. Without the cheap fallback: 2.5. With the failed break and no D2 bonus either: 2.4; also no rest stop and holding from +100%: 2.2; without the t-stat exit too: 2.1; also without the failed-break sale: 2.0. Odd rules: the current version.
  assert.equal(withDefaults({ stopPct: 30 }).version, "2.6.0");
  assert.equal(withDefaults({ cheapFallback: false }).version, "2.5.0");
  const before25 = {
    sellFailedBreak: true,
    d2Entry: false,
    cheapFallback: false,
  };
  assert.equal(withDefaults(before25).version, "2.4.0");
  assert.equal(
    withDefaults({ ...before25, holdFromPct: 100, restStopPct: 0 }).version,
    "2.2.0",
  );
  assert.equal(
    withDefaults({
      ...before25,
      holdFromPct: 100,
      restStopPct: 0,
      sellOnWeakness: false,
    }).version,
    "2.1.0",
  );
  assert.equal(
    withDefaults({
      ...before25,
      holdFromPct: 100,
      restStopPct: 0,
      sellFailedBreak: false,
      sellOnWeakness: false,
    }).version,
    "2.0.0",
  );
  assert.equal(withDefaults({ stopPct: 40 }).version, currentVersion);
  assert.equal(versionLabel(withDefaults({ stopPct: 40 })), "2.9.0*");
  // ...and none of the 2.7 rules came with it.
  assert.equal(withDefaults({ stopPct: 30 }).pyramid, false);
  // A saved version is kept as saved.
  assert.equal(withDefaults({ version: "1.0", minT: 2 }).version, "1.0.0");
  // A rule saved before it existed takes the saved version's value: a running
  // 2.3 stays 2.3 (no rest stop) until 2.4 is chosen.
  const old = withDefaults({ version: "2.3", stopPct: 30, holdFromPct: 50 });
  assert.equal(old.restStopPct, 0);
  assert.equal(versionLabel(old), "2.3.0");
  assert.equal(withDefaults({ version: "2.4" }).restStopPct, 20);
  // A running 2.4 keeps its failed-break sale and gets no D2 bonus until 2.5 is chosen.
  const live24 = withDefaults({ version: "2.4", sellFailedBreak: true });
  assert.equal(live24.d2Entry, false);
  assert.equal(versionLabel(live24), "2.4.0");
  assert.equal(withDefaults({ version: "2.5" }).d2Entry, true);
  // A running 2.5 gets no cheap fallback until 2.6 is chosen.
  const live25 = withDefaults({ version: "2.5" });
  assert.equal(live25.cheapFallback, false);
  assert.equal(versionLabel(live25), "2.5.0");
  assert.equal(withDefaults({ version: "2.6" }).cheapFallback, true);
  // A running 2.6 gets no IBIT floor, pyramid or early entry until 2.7 is chosen.
  const live26 = withDefaults({ version: "2.6", minPrice: 0.15 });
  assert.deepEqual(live26.lowFloorSymbols, []);
  assert.equal(live26.pyramid, false);
  assert.equal(live26.earlyEntry, false);
  assert.equal(versionLabel(live26), "2.6.0*");
  const live27 = withDefaults({ version: "2.7" });
  assert.deepEqual(live27.lowFloorSymbols, ["IBIT"]);
  assert.equal(live27.lowFloorPrice, 0.1);
  assert.equal(live27.pyramid, true);
  assert.equal(live27.pyramidSharePct, 50);
  assert.equal(live27.earlyEntry, true);
  assert.equal(live27.cheapFallback, false);
});

test("parse: the defaults pass; values are checked, snapped to the step and tickers cleaned", () => {
  assert.deepEqual(parseSettings(defaultSettings), {
    ok: true,
    value: defaultSettings,
  });
  const delta = parseSettings({ ...defaultSettings, delta: 0.3 });
  assert.equal(delta.ok, false);
  assert.match(
    !delta.ok ? delta.error : "",
    /delta must be a number from 0.05 to 0.25/,
  );
  const snapped = parseSettings({ ...defaultSettings, delta: 0.1500001 });
  assert.equal(snapped.ok && snapped.value.delta, 0.15);
  const tickers = parseSettings({
    ...defaultSettings,
    added: ["hood", "HOOD", "SPY"],
  });
  assert.deepEqual(tickers.ok && tickers.value.added, ["HOOD"]);
  assert.equal(
    parseSettings({ ...defaultSettings, off: ["not a ticker"] }).ok,
    false,
  );
  assert.equal(parseSettings({ ...defaultSettings, mode: "real" }).ok, false);
  assert.equal(parseSettings({ ...defaultSettings, broker: "ibkr" }).ok, true);
  assert.equal(parseSettings({ ...defaultSettings, broker: "both" }).ok, true);
  assert.equal(parseSettings({ ...defaultSettings, broker: "ib" }).ok, false);
  assert.deepEqual(entryBrokers("both", ["alpaca", "ibkr"]), [
    "alpaca",
    "ibkr",
  ]);
  assert.deepEqual(entryBrokers("both", ["alpaca"]), ["alpaca"]);
  assert.deepEqual(entryBrokers("ibkr", ["alpaca"]), []);
  // Settings saved before the broker setting keep the base's broker.
  assert.equal(
    withDefaults({ sizePct: 1 }, { ...defaultSettings, broker: "ibkr" }).broker,
    "ibkr",
  );
  assert.equal(parseSettings({ ...defaultSettings, checks: "yes" }).ok, false);
  assert.equal(parseSettings([]).ok, false);
});

test("saved values over the defaults; a bad saved record falls back whole", () => {
  assert.equal(withDefaults({ stopPct: 40 }).stopPct, 40);
  assert.equal(withDefaults({ stopPct: 40 }).delta, 0.15);
  assert.equal(withDefaults({ stopPct: 999 }).stopPct, 60);
  assert.equal(withDefaults(null).mode, "live");
});

test("watched stocks: core, added and followed favorites, less those off and SPY", () => {
  const s = { ...defaultSettings, added: ["HOOD"], off: ["TSLA", "QQQ"] };
  assert.deepEqual(
    watchedStocks(s, ["NVDA", "TSLA"], ["QQQ", "WIX", "SPY", "NVDA"]),
    ["NVDA", "HOOD", "WIX"],
  );
  assert.deepEqual(
    watchedStocks({ ...s, followFavorites: false }, ["NVDA"], ["WIX"]),
    ["NVDA", "HOOD"],
  );
});

test("settings become the signal, contract and exit rules", () => {
  const s = {
    ...defaultSettings,
    minT: 2.5,
    minRvol: 2,
    firstEntryMin: 20,
    delta: 0.1,
    maxDte: 3,
    minPrice: 0.5,
    minVolume: 100,
    stopPct: 40,
    holdFromPct: 150,
    maxNights: 0,
    checks: false,
  };
  const sig = signalParams(s);
  assert.deepEqual([sig.strengthT, sig.rvolDay, sig.firstMinute], [2.5, 2, 20]);
  const pick = pickRules(s);
  assert.deepEqual(
    [pick.delta, pick.dteMax, pick.minPrice, pick.minVolume30],
    [0.1, 3, 0.5, 100],
  );
  const exits = exitRules(s);
  assert.deepEqual(exits.checks, []);
  assert.equal(exits.stopOut, -0.4);
  assert.equal(exits.carryMinGain, 1.5);
  assert.equal(exits.carryMaxNights, 0);
  assert.equal(exitRules(defaultSettings).checks.length, 0);
  assert.equal(
    exitRules({ ...defaultSettings, checks: true }).checks.length,
    2,
  );
  assert.deepEqual(exitRules(defaultSettings).stages, { half: 0.5, full: 1 });
  assert.equal(
    exitRules({ ...defaultSettings, stockStages: false }).stages,
    null,
  );
});

test("splits: the prior volume is put in today's shares (a 10:1 split no longer passes the volume rule)", () => {
  assert.equal(splitRatio(1208.65, 121.0), 10);
  assert.equal(splitRatio(100, 400), 1 / 4);
  assert.equal(splitRatio(100, 97), 1);
  // 20 sessions at 1,000 shares a minute at $100, then a 10:1 split: today trades 10,000 a minute at $10.
  // a small wiggle so beta and the t-stat can be computed
  const bar = (m: number, p: number, v: number) => {
    const c = p * (1 + 0.001 * Math.sin(m) + 0.0005 * Math.cos(3 * m));
    return { m, o: c, h: c, l: c, c, v };
  };
  const session = (p: number, v: number) =>
    Array.from({ length: 390 }, (_, m) => bar(m, p, v));
  const days = Array.from({ length: 20 }, () => ({
    stock: session(100, 1000),
    spy: session(500, 1000),
  }));
  const prior = priorFrom(days);
  assert.ok(Math.abs(prior.lastClose! - 100) < 1);
  const today = session(10, 10000).slice(0, 60);
  const spy = session(500, 1000).slice(0, 60);
  const st = cState(today, spy, prior, 59);
  // the same activity as usual: rvol 1, not 10
  assert.ok(st && Math.abs(st.rvol - 1) < 1e-9, String(st?.rvol));
  // and a split inside the prior sessions: the older ones count in the later shares
  const mixed = priorFrom([
    ...Array.from({ length: 10 }, () => ({
      stock: session(100, 1000),
      spy: session(500, 1000),
    })),
    ...Array.from({ length: 10 }, () => ({
      stock: session(10, 10000),
      spy: session(500, 1000),
    })),
  ]);
  assert.ok(mixed.curves.every((c) => c.at(-1) === 390 * 10000));
});

test("the staged stock exit (2.8): half at 0.5 S30 against the signal price, the rest at 1.0, the entry day only", () => {
  const position = {
    right: "C" as const,
    qty: 10,
    cost: 1,
    entryMinute: 30,
    entryStock: 100,
    nights: 0,
    checksDone: [],
    morningDone: false,
  };
  // The stock's usual 30-minute move: 1% of its price, so 1 S30 = $1.00 here.
  const market = {
    minute: 35,
    stock: 99.6,
    option: 0.9,
    unit: 0.01,
    isExpiryDay: false,
    sessionBeforeExpiry: true,
    open: null,
    prevClose: null,
  };
  const r = exitRules(defaultSettings);
  // 0.4 S30 against: held.
  assert.deepEqual(nextAction(position, market, r).sell, 0);
  // 0.5 S30 against: half.
  const half = nextAction(position, { ...market, stock: 99.5 }, r);
  assert.deepEqual([half.sell, half.reason], [5, "stage-half"]);
  // Once the half is sold, the same move holds the rest...
  const after = { ...position, qty: 5, stageHalfSold: true };
  assert.equal(nextAction(after, { ...market, stock: 99.5 }, r).sell, 0);
  // ...until 1.0 S30 against: all of it.
  const full = nextAction(after, { ...market, stock: 99 }, r);
  assert.deepEqual([full.sell, full.reason], [5, "stage-full"]);
  // A put is the mirror: the stock up 1.0 S30 sells all.
  const put = nextAction(
    { ...position, right: "P" },
    { ...market, stock: 101 },
    r,
  );
  assert.deepEqual([put.sell, put.reason], [10, "stage-full"]);
  // Without the stock's unit, or off, or on a carried day: no staged sale.
  assert.equal(
    nextAction(position, { ...market, stock: 99, unit: null }, r).sell,
    0,
  );
  const off = exitRules({ ...defaultSettings, stockStages: false });
  assert.equal(nextAction(position, { ...market, stock: 99 }, off).sell, 0);
  const night = { ...position, nights: 1, morningDone: true };
  assert.equal(
    nextAction(night, { ...market, minute: 60, stock: 99 }, r).sell,
    0,
  );
  // A late entry (15:00 or later) that is up is held: no staged sale...
  const late = { ...position, entryMinute: 335 };
  assert.equal(
    nextAction(late, { ...market, minute: 345, stock: 99, option: 1.1 }, r)
      .sell,
    0,
  );
  // ...but one that is down meets the exits as usual...
  const lateDown = nextAction(
    late,
    { ...market, minute: 345, stock: 99, option: 0.9 },
    r,
  );
  assert.deepEqual([lateDown.sell, lateDown.reason], [10, "stage-full"]);
  // ...and the 15:50 decision still runs: up +10% is not a carry, so it is sold.
  const lateClose = nextAction(
    late,
    { ...market, minute: 380, stock: 99, option: 1.1 },
    r,
  );
  assert.deepEqual([lateClose.sell, lateClose.reason], [10, "close-1550"]);
  // Off: the late winner meets the staged exit.
  const noHold = exitRules({ ...defaultSettings, lateHold: false });
  assert.equal(
    nextAction(late, { ...market, minute: 345, stock: 99, option: 1.1 }, noHold)
      .reason,
    "stage-full",
  );
  // The stop is -60% with the stock against: -50% holds, -60% sells all.
  const unitless = { ...market, unit: null, stock: 99.9 };
  assert.equal(nextAction(position, { ...unitless, option: 0.5 }, r).sell, 0);
  const stop = nextAction(position, { ...unitless, option: 0.4 }, r);
  assert.deepEqual([stop.sell, stop.reason], [10, "stop-30"]);
});

test("without the checks, a losing entry is not sold at +10 minutes", () => {
  const position = {
    right: "C" as const,
    qty: 10,
    cost: 1,
    entryMinute: 30,
    entryStock: 100,
    nights: 0,
    checksDone: [],
    morningDone: false,
  };
  const market = {
    minute: 40,
    stock: 99, // against the call
    option: 0.8,
    isExpiryDay: false,
    sessionBeforeExpiry: true,
    open: null,
    prevClose: null,
  };
  const on = nextAction(
    position,
    market,
    exitRules({ ...defaultSettings, checks: true }),
  );
  assert.deepEqual([on.sell, on.reason], [5, "check-10"]);
  const off = nextAction(
    position,
    market,
    exitRules({ ...defaultSettings, checks: false }),
  );
  assert.equal(off.sell, 0);
  // The stop still works: −40% with the stock against.
  const stop = nextAction(
    position,
    { ...market, option: 0.6 },
    exitRules({ ...defaultSettings, checks: false, stopPct: 40 }),
  );
  assert.deepEqual([stop.sell, stop.reason], [10, "stop-30"]); // The rest stop: -20% by default, 0 turns it off.
  assert.equal(exitRules(defaultSettings).restStopOut, -0.2);
  assert.equal(
    exitRules({ ...defaultSettings, restStopPct: 0 }).restStopOut,
    null,
  );
});

test("drawdown: how far the running P&L is below its best", () => {
  assert.equal(drawdown([]), 0);
  assert.equal(drawdown([100, -300, 50]), 250);
  assert.equal(drawdown([-100]), 100);
  assert.equal(drawdown([-100, 300]), 0);
});

// The site's /api/bot/settings: reading with the read token, saving for the owner only.
const config = {
  owner: "owner@example.com",
  url: "https://trader.example",
  token: "full-token",
  readToken: "read-token",
};
const site = "https://site.example";

test("site: GET reads with the read-only token", async () => {
  const seen: { auth: string | null; method: string }[] = [];
  const fetcher = (async (_url: URL, init: RequestInit) => {
    seen.push({
      auth: new Headers(init.headers).get("Authorization"),
      method: init.method ?? "GET",
    });
    return Response.json(defaultSettings);
  }) as typeof fetch;
  const answer = await handleBotSettings(
    config,
    null,
    { method: "GET", origin: site, requestOrigin: null },
    fetcher,
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(seen, [{ auth: "Bearer read-token", method: "GET" }]);
});

test("site: PUT is the owner's, from the site itself, with the full token", async () => {
  const seen: { auth: string | null; body: unknown }[] = [];
  const fetcher = (async (_url: URL, init: RequestInit) => {
    seen.push({
      auth: new Headers(init.headers).get("Authorization"),
      body: JSON.parse(String(init.body)),
    });
    return Response.json(defaultSettings);
  }) as typeof fetch;
  const put = (identity: { email: string } | null, origin: string | null) =>
    handleBotSettings(
      config,
      identity,
      {
        method: "PUT",
        body: defaultSettings,
        origin: site,
        requestOrigin: origin,
      },
      fetcher,
    );
  assert.equal((await put(null, site)).status, 403);
  assert.equal((await put({ email: "someone@example.com" }, site)).status, 403);
  assert.equal(
    (await put({ email: "owner@example.com" }, "https://evil.example")).status,
    403,
  );
  assert.equal(seen.length, 0);
  assert.equal((await put({ email: "Owner@Example.com" }, site)).status, 200);
  assert.equal(seen[0]!.auth, "Bearer full-token");
  assert.deepEqual(seen[0]!.body, defaultSettings);
});

test("site: a value the trading service refuses comes back as its words", async () => {
  const fetcher = (async () =>
    Response.json(
      { error: "delta must be a number from 0.05 to 0.25" },
      {
        status: 400,
      },
    )) as unknown as typeof fetch;
  const answer = await handleBotSettings(
    config,
    { email: "owner@example.com" },
    { method: "PUT", body: {}, origin: site, requestOrigin: site },
    fetcher,
  );
  assert.deepEqual(answer, {
    status: 400,
    body: { error: "delta must be a number from 0.05 to 0.25" },
  });
});

test("2.5: the D2 bonus reaches the signal only when on", () => {
  assert.deepEqual(
    [defaultSettings.d2Entry, defaultSettings.d2T, defaultSettings.minD2],
    [true, 1.2, 1.5],
  );
  const on = signalParams(defaultSettings);
  assert.deepEqual([on.bonusT, on.bonusD2], [1.2, 1.5]);
  assert.equal(
    signalParams({ ...defaultSettings, d2Entry: false }).bonusT,
    null,
  );
  assert.equal(parseSettings({ ...defaultSettings, d2T: 2 }).ok, false);
  assert.equal(parseSettings({ ...defaultSettings, d2Entry: "yes" }).ok, false);
});

test("V2: minT defaults to 1.8 on a 0.1 step; a saved 2 still loads", () => {
  assert.equal(defaultSettings.minT, 1.8);
  assert.deepEqual(limits.minT, [1, 4, 0.1]);
  const at18 = parseSettings({ ...defaultSettings, minT: 1.8 });
  assert.equal(at18.ok && at18.value.minT, 1.8);
  assert.equal(signalParams(defaultSettings).strengthT, 1.8);
  // Settings saved before V2 (minT 2, no nightCapPct) keep their 2 and get the cap.
  const old = withDefaults({ minT: 2, stopPct: 30 });
  assert.equal(old.minT, 2);
  assert.equal(old.nightCapPct, 10);
  const odd = parseSettings({ ...defaultSettings, minT: 1.83 });
  assert.equal(odd.ok && odd.value.minT, 1.8);
});

test("V2: nightCapPct defaults to 10, from 0 (no cap) to 25 on a step of 1; backtested, so not untested", () => {
  assert.equal(defaultSettings.nightCapPct, 10);
  assert.deepEqual(limits.nightCapPct, [0, 25, 1]);
  assert.equal(untested.has("nightCapPct"), false);
  const off = parseSettings({ ...defaultSettings, nightCapPct: 0 });
  assert.equal(off.ok && off.value.nightCapPct, 0);
  assert.equal(
    parseSettings({ ...defaultSettings, nightCapPct: 26 }).ok,
    false,
  );
  assert.equal(
    parseSettings({ ...defaultSettings, nightCapPct: -1 }).ok,
    false,
  );
  // 0 is off: nothing is sold for the cap, however much is held.
  assert.equal(nightCapSell(1000, 10, 100000, 0), 0);
  assert.equal(nightCapSell(33, 3, 100000, 8), 7);
});

// ---- the numbering, MAJOR.MINOR.PATCH (versions.ts) ----

test("numbering: every id is MAJOR.MINOR.PATCH; ids from before the scheme read as .0", () => {
  for (const v of botVersions) assert.match(v.id, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(
    botVersions.map((v) => v.id),
    [
      "1.0.0",
      "2.0.0",
      "2.1.0",
      "2.2.0",
      "2.3.0",
      "2.4.0",
      "2.5.0",
      "2.6.0",
      "2.7.0",
      "2.8.0",
      "2.8.1",
      "2.9.0",
    ],
  );
  assert.equal(canonicalVersion("2.6"), "2.6.0");
  assert.equal(canonicalVersion("2.6*"), "2.6.0*");
  assert.equal(canonicalVersion("2.7.0"), "2.7.0");
  assert.equal(canonicalVersion("2.2-test"), "2.2-test");
  assert.equal(versionById("2.6")?.id, "2.6.0");
  assert.equal(versionById("2.6.0")?.id, "2.6.0");
  assert.equal(versionById("2.6*"), undefined);
  // A bot saved or picked as "2.6" runs 2.6.0, and its label says so.
  const live26 = withDefaults({ version: "2.6", minPrice: 0.15 });
  assert.equal(live26.version, "2.6.0");
  assert.equal(versionLabel(live26), "2.6.0*");
  const parsed = parseSettings({ ...defaultSettings, version: "2.6" });
  assert.equal(parsed.ok && parsed.value.version, "2.6.0");
  assert.equal(applyVersion(defaultSettings, "2.6").version, "2.6.0");
});

test("numbering: a core setting or a rule switch is MINOR, a rule's own number PATCH", () => {
  const v = botVersions.at(-1)!.rules;
  // core settings
  for (const key of [
    "minT",
    "minRvol",
    "delta",
    "stopPct",
    "holdFromPct",
    "maxNights",
  ] as const) {
    const b = typeof v[key] === "number" ? (v[key] as number) + 1 : v[key];
    assert.equal(ruleBump(key, v[key], b), "minor", key);
  }
  // rule switches
  for (const key of [
    "checks",
    "d2Entry",
    "sellOnWeakness",
    "sellFailedBreak",
    "cheapFallback",
    "pyramid",
    "earlyEntry",
    "skipEarnings",
    "skipPremarket",
  ] as const)
    assert.equal(ruleBump(key, v[key], !v[key]), "minor", key);
  // off at 0: switching on / off is MINOR, a new value PATCH
  assert.equal(ruleBump("restStopPct", 20, 0), "minor");
  assert.equal(ruleBump("restStopPct", 0, 20), "minor");
  assert.equal(ruleBump("restStopPct", 20, 15), "patch");
  assert.equal(ruleBump("nightCapPct", 10, 0), "minor");
  assert.equal(ruleBump("nightCapPct", 10, 15), "patch");
  // a rule's own numbers and lists
  assert.equal(ruleBump("weaknessT", 0.5, 0.25), "patch");
  assert.equal(ruleBump("d2T", 1.2, 1.3), "patch");
  assert.equal(ruleBump("minD2", 1.5, 2), "patch");
  assert.equal(ruleBump("pyramidSharePct", 50, 25), "patch");
  assert.equal(ruleBump("minPrice", 0.2, 0.15), "patch");
  assert.equal(ruleBump("minVolume", 200, 150), "patch");
  assert.equal(ruleBump("maxDte", 7, 5), "patch");
  assert.equal(ruleBump("firstEntryMin", 10, 15), "patch");
  assert.equal(ruleBump("lowFloorPrice", 0.1, 0.05), "patch");
  assert.equal(
    ruleBump("lowFloorSymbols", ["IBIT"], ["IBIT", "MSTR"]),
    "patch",
  );
  assert.equal(ruleBump("lowFloorSymbols", ["IBIT"], ["IBIT"]), null);
  // every rule key is sized
  for (const key of ruleKeys)
    assert.ok(ruleBump(key, 1, 2) || ruleBump(key, true, false), key);
});

test("numbering: a set of changes takes the biggest; the next id from it", () => {
  const base = rulesOf(defaultSettings);
  assert.equal(versionBump(base, base), null);
  assert.equal(versionBump(base, { ...base, weaknessT: 0.25 }), "patch");
  assert.equal(
    versionBump(base, { ...base, weaknessT: 0.25, holdFromPct: 75 }),
    "minor",
  );
  assert.equal(nextVersionId("2.7.0", "patch"), "2.7.1");
  assert.equal(nextVersionId("2.7.1", "patch"), "2.7.2");
  assert.equal(nextVersionId("2.7.3", "minor"), "2.8.0");
  assert.equal(nextVersionId("2.6", "patch"), "2.6.1");
  // the owner's limits are not rules: no change of number, no star
  const limitsOnly = {
    ...defaultSettings,
    sizePct: 3,
    maxOpen: 5,
    dayLossPct: 4,
  };
  assert.equal(versionBump(base, rulesOf(limitsOnly)), null);
  assert.equal(versionLabel(limitsOnly), currentVersion);
  // the history, in the scheme's words: 2.3 moved a core setting, 2.6 switched a rule on
  const at = (id: string) => versionById(id)!.rules;
  assert.equal(versionBump(at("2.2.0"), at("2.3.0")), "minor");
  assert.equal(versionBump(at("2.5.0"), at("2.6.0")), "minor");
  assert.equal(
    versionBump(at("2.6.0"), { ...at("2.6.0"), lowFloorSymbols: ["IBIT"] }),
    "patch",
  );
});

test("the break-even lock (2.9): armed at +50%, the stock back at the level sells all", async () => {
  const { breakEvenStock, tighterLevel } =
    await import("../packages/trading/src/bot/lock.js");
  const { blackScholes, impliedVolatility } =
    await import("../packages/trading/src/option-estimate.js");
  // The level is where the option, at the volatility implied now, is worth the cost.
  const years = 2 / 365;
  const level = breakEvenStock("C", 197.5, years, 1.23, 191.31, 0.78)!;
  const vol = impliedVolatility("call", 1.23, 191.31, 197.5, years, 0.045)!;
  assert.ok(
    Math.abs(blackScholes("call", level, 197.5, years, vol, 0.045) - 0.78) <
      1e-6,
  );
  assert.ok(level < 191.31 && level > 185);
  // A put's level is above the stock; a price no volatility reaches gives none.
  const putLevel = breakEvenStock("P", 176, years, 1.5, 178, 1)!;
  assert.ok(putLevel > 178);
  assert.equal(breakEvenStock("C", 197.5, years, 0, 191.31, 0.78), null);
  assert.equal(breakEvenStock("C", 197.5, years, 1e6, 191.31, 0.78), null);
  // The tighter of two levels: the higher for a call, the lower for a put.
  assert.equal(tighterLevel("C", 190, 191), 191);
  assert.equal(tighterLevel("P", 190, 191), 190);
  assert.equal(tighterLevel("C", null, 191), 191);

  const r = exitRules(defaultSettings);
  assert.deepEqual(r.lock, { arm: 0.5 });
  assert.equal(
    exitRules({ ...defaultSettings, breakEvenLock: false }).lock,
    null,
  );
  const position = {
    right: "C" as const,
    qty: 10,
    cost: 0.78,
    entryMinute: 10,
    entryStock: 189.76,
    nights: 0,
    checksDone: [],
    morningDone: false,
  };
  const market = {
    minute: 15,
    stock: 191.31,
    option: 1.23,
    unit: null,
    strike: 197.5,
    years,
    isExpiryDay: false,
    sessionBeforeExpiry: true,
    open: null,
    prevClose: null,
  };
  // Up 58%: armed, the level is stored, nothing sold.
  const armed = nextAction(position, market, r);
  assert.equal(armed.sell, 0);
  assert.ok(Math.abs(armed.update.lockLevel! - level) < 1e-9);
  // Up only 40% and not armed before: no level, nothing stored.
  const low = nextAction(position, { ...market, option: 1.09 }, r);
  assert.deepEqual([low.sell, low.update.lockLevel], [0, undefined]);
  // Armed (the level kept with the position, as after a restart): the stock
  // above it holds, at it sells all, even with the option no longer up 50%.
  const held = { ...position, lockLevel: 190.5 };
  assert.equal(
    nextAction(held, { ...market, stock: 190.6, option: 0.9 }, r).sell,
    0,
  );
  const sold = nextAction(held, { ...market, stock: 190.5, option: 0.9 }, r);
  assert.deepEqual([sold.sell, sold.reason], [10, "break-even-lock"]);
  // A new level only replaces a looser one: it ratchets up for a call.
  const up = nextAction({ ...position, lockLevel: 185 }, market, r);
  assert.ok(Math.abs(up.update.lockLevel! - level) < 1e-9);
  const keep = nextAction({ ...position, lockLevel: 191 }, market, r);
  assert.equal(keep.update.lockLevel, undefined);
  // A put: the stock back up at its level sells.
  const put = nextAction(
    { ...position, right: "P", lockLevel: 180 },
    { ...market, stock: 180.2, option: 1 },
    r,
  );
  assert.deepEqual([put.sell, put.reason], [10, "break-even-lock"]);
  // Off, unknown strike or time, or a carried day: no lock.
  const off = exitRules({ ...defaultSettings, breakEvenLock: false });
  assert.equal(
    nextAction(held, { ...market, stock: 190, option: 0.9 }, off).reason,
    null,
  );
  assert.equal(
    nextAction(position, { ...market, strike: null }, r).update.lockLevel,
    undefined,
  );
  const night = { ...held, nights: 1, morningDone: true };
  assert.equal(
    nextAction(night, { ...market, minute: 60, stock: 190, option: 0.9 }, r)
      .sell,
    0,
  );
  // A late winner (entry 15:00+, up) is held to 15:50 before the lock.
  const late = { ...held, entryMinute: 335 };
  assert.equal(
    nextAction(late, { ...market, minute: 345, stock: 190, option: 0.9 }, r)
      .sell,
    0,
  );
  // The strength exit comes first when both fire.
  const both = nextAction(
    held,
    { ...market, stock: 190, option: 0.9, strength: 0.2 },
    r,
  );
  assert.equal(both.reason, "strength-gone");
  // A new level rides on another rule's decision (here the staged half).
  const staged = nextAction(
    { ...position, entryStock: 192.5 },
    { ...market, unit: 0.01 },
    r,
  );
  assert.equal(staged.reason, "stage-half");
  assert.ok(staged.update.lockLevel! > 0);
});

test("2.9 review fixes: the ladder never raises the size; an unknown account trades small; saved settings keep the lock as they were", async () => {
  const { sizeAt } = await import("../packages/trading/src/bot/settings.js");
  const steps = defaultSettings.sizeSteps;
  // From 2%, "2.5% from $300K" keeps 2%; the lower steps still apply.
  assert.equal(sizeAt(2, steps, 500_000), 2);
  assert.equal(sizeAt(2, steps, 2_000_000), 1.5);
  assert.equal(sizeAt(3, steps, 500_000), 2.5);
  // The account read failed (0): the smallest size, never the base.
  assert.equal(sizeAt(3, steps, 0), 1);
  assert.equal(sizeAt(0.5, steps, 0), 0.5);
  assert.equal(sizeAt(3, [], 0), 3);
  // Saved as 2.8.1 / 2.8.0 before the lock existed: the lock stays off.
  const of = (version: string) => {
    const saved: Record<string, unknown> = { ...defaultSettings, version };
    delete saved.breakEvenLock;
    delete saved.lockArmPct;
    return withDefaults(saved);
  };
  assert.equal(of("2.8.1").breakEvenLock, false);
  assert.equal(of("2.8.1").version, "2.8.1");
  assert.equal(of("2.8.0").breakEvenLock, false);
  // An own label from before: the new rules off too, not the current version's.
  const own: Record<string, unknown> = { ...defaultSettings, version: "mine" };
  delete own.breakEvenLock;
  delete own.sizeSteps;
  const mine = withDefaults(own);
  assert.equal(mine.breakEvenLock, false);
  assert.deepEqual(mine.sizeSteps, []);
  assert.equal(mine.version, "mine");
});

test("2.9 review fixes: the lock arms at exactly +50% and decides on the minute close, not a live print", () => {
  const r = exitRules(defaultSettings);
  const position = {
    right: "C" as const,
    qty: 4,
    cost: 1,
    entryMinute: 10,
    entryStock: 189.76,
    nights: 0,
    checksDone: [],
    morningDone: false,
  };
  const market = {
    minute: 15,
    stock: 191.31,
    option: 1.5,
    unit: null,
    strike: 197.5,
    years: 2 / 365,
    isExpiryDay: false,
    sessionBeforeExpiry: true,
    open: null,
    prevClose: null,
  };
  // Exactly +50% arms.
  assert.ok(nextAction(position, market, r).update.lockLevel! > 0);
  const held = { ...position, lockLevel: 190.5 };
  // A live print through the level with the minute closing above it: held.
  assert.equal(
    nextAction(held, { ...market, option: 0.9, stock: 190.2, close: 190.7 }, r)
      .sell,
    0,
  );
  // The minute closes at the level: sold.
  const sold = nextAction(
    held,
    { ...market, option: 0.9, stock: 190.7, close: 190.5 },
    r,
  );
  assert.deepEqual([sold.sell, sold.reason], [4, "break-even-lock"]);
});
