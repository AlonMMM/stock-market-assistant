import assert from "node:assert/strict";
import test from "node:test";
import { handleBotSettings } from "../packages/trading/src/bot-api.js";
import { nextAction, nightCapSell } from "../packages/trading/src/bot/exits.js";
import {
  defaultSettings,
  drawdown,
  exitRules,
  limits,
  parseSettings,
  pickRules,
  signalParams,
  untested,
  watchedStocks,
  withDefaults,
} from "../packages/trading/src/bot/settings.js";

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
  assert.equal(parseSettings({ ...defaultSettings, checks: "yes" }).ok, false);
  assert.equal(parseSettings([]).ok, false);
});

test("saved values over the defaults; a bad saved record falls back whole", () => {
  assert.equal(withDefaults({ stopPct: 40 }).stopPct, 40);
  assert.equal(withDefaults({ stopPct: 40 }).delta, 0.15);
  assert.equal(withDefaults({ stopPct: 999 }).stopPct, 30);
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
  assert.equal(exitRules(defaultSettings).checks.length, 2);
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
  const on = nextAction(position, market, exitRules(defaultSettings));
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
  assert.deepEqual([stop.sell, stop.reason], [10, "stop-30"]);
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
