import assert from "node:assert/strict";
import { defaultAccountRisk } from "../packages/trading/src/account-risk.js";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { readSecret, Vault } from "../apps/trader/src/secrets.js";
import { ensureOwnerIbkr, seedOwner } from "../apps/trader/src/seed.js";
import {
  botAccount,
  botAccountFor,
  botBrokerFromEnv,
  ensureBotAccount,
} from "../apps/trader/src/seed-bot.js";
import { ShortWatch, shortRepeatMs } from "../apps/trader/src/short-watch.js";
import { TradeStore, type Channel } from "../apps/trader/src/store.js";
import { Traders } from "../apps/trader/src/traders.js";
import { FanOutNotifier } from "../packages/trading/src/fan-out.js";
import { TelegramNotifier } from "../packages/trading/src/notifier.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";
import { resolveValidator } from "../packages/trading/src/validators.js";

// Synthetic contracts, quotes and keys; brokers are simulated in memory.
const friday = "NVDA261016C00240000";
const monday = Date.parse("2026-10-12T15:00:00Z");
const buyNvda = { underlying: "NVDA", right: "call", sizePct: 0.5 };
const env = {
  ALPACA_API_KEY: "synthetic-key",
  ALPACA_API_SECRET: "synthetic-secret",
  TRADES_TELEGRAM_BOT_TOKEN: "synthetic-bot",
  TRADES_TELEGRAM_CHAT_ID: "-100",
  TRADER_OWNER_EMAIL: "Owner@Example.com",
};

function setup() {
  const store = new TradeStore(":memory:");
  seedOwner(store, env, monday);
  store.addUser(
    {
      id: "friend",
      email: "friend@example.com",
      name: "Friend",
      enabled: true,
      isAdmin: false,
      validatorId: null,
      validatorParams: null,
    },
    monday,
  );
  store.addAccount(
    {
      id: "friend-alpaca",
      userId: "friend",
      broker: "alpaca",
      mode: "paper",
      isDefault: true,
      credentials: { key: { env: "X" }, secret: { env: "Y" } },
      gatewayUrl: null,
      enabled: true,
    },
    monday,
  );
  const brokers = new Map<string, SimBroker>();
  const sent: { channel: string; html: string }[] = [];
  const traders = new Traders({
    store,
    secrets: { env },
    enabled: true,
    log: () => {},
    makeBroker: (account) => {
      const broker = new SimBroker();
      broker.setQuote(friday, 1.0, 1.04, 0.12);
      broker.fillAt.set(friday, 1.03);
      brokers.set(account.userId, broker);
      return broker;
    },
    makeNotifier: (channel: Channel) =>
      new TelegramNotifier({
        send: async (html) => {
          sent.push({ channel: channel.id, html });
          return { ok: true, messageId: sent.length };
        },
      }),
    now: () => monday,
    sleep: async () => {},
  });
  return { store, traders, brokers, sent };
}

test("vault: sealed secrets open with the same key only", () => {
  const key = randomBytes(32).toString("base64");
  const ref = new Vault(key).seal("synthetic password");
  assert.ok("vault" in ref && ref.vault.startsWith("v1:"));
  assert.ok(!JSON.stringify(ref).includes("synthetic password"));
  assert.equal(new Vault(key).open(ref.vault), "synthetic password");
  const other = new Vault(randomBytes(32).toString("hex"));
  assert.throws(() => other.open(ref.vault));
  assert.throws(() => new Vault("too short"), /32 bytes/);
});

test("secrets: references only, never plain values", () => {
  const vault = new Vault(randomBytes(32).toString("base64"));
  const source = { env: { A: "from env" }, vault };
  assert.equal(readSecret({ env: "A" }, "a", source), "from env");
  assert.equal(readSecret(vault.seal("v"), "b", source), "v");
  assert.throws(() => readSecret("plain", "c", source), /not a secret ref/);
  assert.throws(() => readSecret({ env: "MISSING" }, "d", source), /not set/);
  assert.throws(
    () => readSecret(vault.seal("v"), "e", { env: {} }),
    /TRADER_VAULT_KEY/,
  );
});

test("seed: the single trader of before becomes the owner, once", () => {
  const store = new TradeStore(":memory:");
  assert.equal(seedOwner(store, env, monday), "owner");
  assert.equal(seedOwner(store, env, monday), null);
  const [owner] = store.users();
  assert.equal(owner?.validatorId, "owner-v1");
  assert.equal(owner?.email, "owner@example.com");
  assert.ok(owner?.isAdmin);
  const [account] = store.accounts("owner");
  assert.deepEqual(account?.credentials, {
    key: { env: "ALPACA_API_KEY" },
    secret: { env: "ALPACA_API_SECRET" },
  });
  assert.equal(store.channels("owner")[0]?.provider, "telegram");
  assert.throws(
    () => seedOwner(new TradeStore(":memory:"), {}, monday),
    /ALPACA_API_KEY/,
  );
});

test("traders: a caller is found by email or id; others are refused", () => {
  const { traders, store } = setup();
  assert.equal(traders.forCaller(undefined).user.id, "owner");
  assert.equal(traders.forCaller("OWNER@example.com").user.id, "owner");
  assert.equal(traders.forCaller("friend").user.id, "friend");
  assert.throws(() => traders.forCaller("stranger@example.com"), /not allowed/);
  store.addUser(
    {
      id: "off",
      email: null,
      name: "Off",
      enabled: false,
      isAdmin: false,
      validatorId: "owner-v1",
      validatorParams: null,
    },
    monday,
  );
  assert.throws(() => traders.forCaller("off"), /not allowed/);
  assert.equal(traders.all().length, 2);
});

test("traders: each user trades only their own account", async () => {
  const { traders, brokers, store } = setup();
  const owner = traders.get("owner").service;
  const friend = traders.get("friend").service;
  const started = await owner.buy(buyNvda);
  assert.equal(started.status, "started");
  await owner.idle();
  assert.ok("jobId" in started);
  // The friend cannot see or cancel the owner's job.
  assert.throws(() => friend.job(started.jobId), /No such job/);
  assert.equal(brokers.get("friend")!.orders.size, 0);
  assert.ok(brokers.get("owner")!.orders.size > 0);
  assert.equal(store.runningJobs("friend").length, 0);
});

test("validators: no validator, or an unknown one, means no buy", async () => {
  const { traders } = setup();
  const friend = traders.get("friend").service;
  const refused = await friend.buy(buyNvda);
  assert.equal(refused.status, "refused");
  assert.ok(
    "refused" in refused &&
      refused.refused.some((r) => r.startsWith("validator:")),
  );
  assert.match(
    resolveValidator("nope").check({} as never)[0]!.detail,
    /does not exist/,
  );
  assert.deepEqual(resolveValidator("owner-v1").check({} as never), []);
});

test("traders: only paper accounts; an IBKR account needs its Gateway", () => {
  const store = new TradeStore(":memory:");
  const traders = new Traders({
    store,
    secrets: { env: {} },
    enabled: true,
    log: () => {},
  });
  const base = {
    id: "a",
    userId: "u",
    isDefault: true,
    credentials: {},
    gatewayUrl: null,
    enabled: true,
    createdAt: 0,
  };
  assert.throws(
    () => traders.broker({ ...base, broker: "alpaca", mode: "live" }),
    /only paper/,
  );
  assert.throws(
    () => traders.broker({ ...base, broker: "ibkr", mode: "paper" }),
    /no IB Gateway/,
  );
});

test("fan-out: each channel gets its events; a failure blocks nothing", async () => {
  const got: string[] = [];
  const channel = (name: string, fail = false) =>
    new TelegramNotifier({
      send: async () => {
        got.push(name);
        return fail
          ? { ok: false as const, retry: false, error: "down" }
          : { ok: true as const, messageId: 7 };
      },
    });
  const lines: string[] = [];
  const fan = new FanOutNotifier(
    [
      { name: "a", notifier: channel("a", true), events: null },
      { name: "b", notifier: channel("b"), events: ["notice"] },
    ],
    (l) => lines.push(l),
  );
  const alert = await fan.alert("t", ["x"]);
  assert.deepEqual(got, ["a"]);
  assert.equal(alert.ok, false);
  assert.match(lines[0]!, /a: alert not sent: down/);
  got.length = 0;
  await fan.notice("t", ["x"]);
  assert.deepEqual(got.sort(), ["a", "b"]);
  const none = new FanOutNotifier([]);
  assert.equal((await none.alert("t", [])).ok, false);
});

test("seed: the owner's IBKR paper account is added once, next to the default", () => {
  const store = new TradeStore(":memory:");
  assert.equal(
    ensureOwnerIbkr(store, { IBKR_GATEWAY: "gw:4001" }, monday),
    null,
  );
  seedOwner(store, env, monday);
  assert.equal(ensureOwnerIbkr(store, {}, monday), null);
  assert.throws(
    () => ensureOwnerIbkr(store, { IBKR_GATEWAY: "gw" }, monday),
    /host:port/,
  );
  const gw = { IBKR_GATEWAY: "ib-gateway.railway.internal:4001" };
  assert.equal(ensureOwnerIbkr(store, gw, monday), "owner-ibkr");
  assert.equal(ensureOwnerIbkr(store, gw, monday), null);
  const ibkr = store.accounts("owner").find((a) => a.broker === "ibkr")!;
  assert.deepEqual(
    [ibkr.mode, ibkr.isDefault, ibkr.gatewayUrl, ibkr.credentials],
    ["paper", false, "ib-gateway.railway.internal:4001", {}],
  );
});

test("traders: a call may name the broker; each account keeps its own records", async () => {
  const { traders, store, brokers } = setup();
  ensureOwnerIbkr(store, { IBKR_GATEWAY: "gw:4001" }, monday);
  const alpaca = traders.forCaller(undefined);
  const ibkr = traders.forCaller(undefined, "ibkr");
  assert.deepEqual(
    [alpaca.scope, ibkr.scope, ibkr.account.broker],
    ["owner", "owner/owner-ibkr", "ibkr"],
  );
  assert.equal(traders.forCaller(undefined, "alpaca"), alpaca);
  assert.throws(() => traders.forCaller("friend", "ibkr"), /no ibkr account/);
  const started = await ibkr.service.buy(buyNvda);
  await ibkr.service.idle();
  assert.equal(started.status, "started");
  const jobId = (started as { jobId: string }).jobId;
  // The IBKR job is not the Alpaca account's.
  assert.throws(() => alpaca.service.job(jobId), /No such job/);
  assert.equal(store.runningJobs("owner").length, 0);
  assert.equal(traders.all().length, 3);
  assert.ok(brokers.size >= 2);
});

test("short watch: a short is sent at once, repeated after 15 minutes, and cleared", async () => {
  const { traders } = setup();
  const t = traders.get("owner");
  const alerts: string[] = [];
  const clock = { now: monday };
  const watch = new ShortWatch(
    () => {},
    () => clock.now,
  );
  const trader = {
    ...t,
    notifier: {
      ...t.notifier,
      alert: async (title: string) => {
        alerts.push(title);
        return { ok: true as const };
      },
    } as typeof t.notifier,
  };
  const short = [{ symbol: friday, qty: -1, avgEntryPrice: 1 }];
  let held = short;
  trader.broker = {
    ...t.broker,
    capabilities: t.broker.capabilities,
    positions: async () => held,
    stockPositions: async () => [],
    openOrders: async () => [],
  } as typeof t.broker;
  assert.match((await watch.check(trader))[0]!, /SHORT/);
  await watch.check(trader);
  assert.equal(alerts.length, 1);
  clock.now += shortRepeatMs;
  await watch.check(trader);
  assert.equal(alerts.length, 2);
  held = [];
  assert.deepEqual(await watch.check(trader), []);
  assert.match(alerts[2]!, /gone/);
});

test("seed: the bot's own Alpaca paper account is added once, from its two variables", () => {
  const store = new TradeStore(":memory:");
  const keys = {
    BOT_ALPACA_API_KEY: "synthetic-bot-key",
    BOT_ALPACA_API_SECRET: "synthetic-bot-secret",
  };
  // No owner yet, then no variables: nothing is added.
  assert.equal(ensureBotAccount(store, keys, monday), null);
  seedOwner(store, env, monday);
  assert.equal(ensureBotAccount(store, {}, monday), null);
  assert.equal(
    ensureBotAccount(store, { BOT_ALPACA_API_KEY: "only" }, monday),
    null,
  );
  assert.equal(botAccount(store), null);
  assert.equal(ensureBotAccount(store, keys, monday), "owner-bot");
  assert.equal(ensureBotAccount(store, keys, monday), null);
  const bot = botAccount(store)!;
  assert.deepEqual(
    [bot.userId, bot.broker, bot.mode, bot.isDefault, bot.credentials],
    [
      "owner",
      "alpaca",
      "paper",
      false,
      {
        key: { env: "BOT_ALPACA_API_KEY" },
        secret: { env: "BOT_ALPACA_API_SECRET" },
      },
    ],
  );
});

test("traders: the bot's account is reached by id; naming alpaca still means the owner's default", async () => {
  const { traders, store } = setup();
  const keys = {
    BOT_ALPACA_API_KEY: "synthetic-bot-key",
    BOT_ALPACA_API_SECRET: "synthetic-bot-secret",
  };
  ensureBotAccount(store, keys, monday);
  const own = traders.forCaller(undefined);
  assert.equal(traders.forCaller(undefined, "alpaca"), own);
  assert.equal(traders.get("owner", "alpaca").scope, "owner");
  const bot = traders.forAccount("owner-bot");
  assert.notEqual(bot, own);
  assert.deepEqual(
    [bot.scope, bot.account.broker, bot.account.isDefault],
    ["owner/owner-bot", "alpaca", false],
  );
  assert.equal(traders.forAccount("owner-bot"), bot);
  assert.throws(() => traders.forAccount("nobody-bot"), /No account/);
  // Its records are its own: a buy there is not the owner's job.
  const started = await bot.service.buy(buyNvda);
  await bot.service.idle();
  assert.equal(started.status, "started");
  const jobId = (started as { jobId: string }).jobId;
  assert.throws(() => own.service.job(jobId), /No such job/);
  // Both accounts are watched (owner, friend, bot).
  assert.equal(traders.all().length, 3);
});

test("bot account: BOT_BROKER is the start-up default; each broker maps to the owner's account there", () => {
  const store = new TradeStore(":memory:");
  seedOwner(store, env, monday);
  assert.equal(botBrokerFromEnv({}), "alpaca");
  assert.equal(botBrokerFromEnv({ BOT_BROKER: "ibkr" }), "ibkr");
  // A typo must not pick an account by accident.
  assert.equal(botBrokerFromEnv({ BOT_BROKER: "both" }), "both");
  assert.throws(
    () => botBrokerFromEnv({ BOT_BROKER: "ib" }),
    /BOT_BROKER must be alpaca, ibkr or both/,
  );
  // Alpaca without the bot's own account: the owner's default; IBKR: none yet.
  assert.equal(botAccountFor(store, "alpaca")?.id, "owner-alpaca");
  assert.equal(botAccountFor(store, "ibkr"), null);
  ensureOwnerIbkr(store, { IBKR_GATEWAY: "gw:4001" }, monday);
  assert.equal(botAccountFor(store, "ibkr")?.id, "owner-ibkr");
  // The bot's own Alpaca account wins over the default.
  ensureBotAccount(
    store,
    { BOT_ALPACA_API_KEY: "k", BOT_ALPACA_API_SECRET: "s" },
    monday,
  );
  assert.equal(botAccountFor(store, "alpaca")?.id, "owner-bot");
  assert.equal(botAccountFor(store, "ibkr")?.id, "owner-ibkr");
});

test("risk settings: an account's saved numbers reach its trader, at once once built", async () => {
  const { traders, store } = setup();
  const before = await traders.get("owner").engine.status();
  assert.equal(before.limits.maxDayLossPct, 5);
  assert.equal(before.limits.riskManager.day, 5); // the default daily loss limit
  store.setAccountRisk(
    "owner-alpaca",
    { ...defaultAccountRisk, dayLossPct: 7, buysPerDay: 4 },
    monday,
  );
  traders.reloadRisk("owner-alpaca");
  const after = await traders.get("owner").engine.status();
  assert.equal(after.limits.maxDayLossPct, 7);
  assert.equal(after.limits.maxBuysPerDay, 4);
  assert.equal(after.limits.riskManager.day, 7);
  // Another account keeps its own (the defaults).
  const friend = await traders.get("friend").engine.status();
  assert.equal(friend.limits.maxDayLossPct, 5);
});
