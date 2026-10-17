import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { readSecret, Vault } from "../apps/trader/src/secrets.js";
import { seedOwner } from "../apps/trader/src/seed.js";
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

test("traders: only paper accounts, and only brokers that exist", () => {
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
    /not supported yet/,
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
