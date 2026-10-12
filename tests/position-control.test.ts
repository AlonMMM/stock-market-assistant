import assert from "node:assert/strict";
import test from "node:test";
import { RequestError, TraderService } from "../apps/trader/src/service.js";
import { TradeStore } from "../apps/trader/src/store.js";
import { TradeEngine, TradeRefusal } from "../packages/trading/src/engine.js";
import { TelegramNotifier } from "../packages/trading/src/notifier.js";
import { SimBroker } from "../packages/trading/src/sim-broker.js";

// Synthetic contracts and quotes; the broker is simulated in memory.
const friday = "NVDA261016C00240000";
const monday = Date.parse("2026-10-12T15:00:00Z");

type Post = { html: string; replyTo?: number; chatId?: string };

function setup(
  options: {
    store?: TradeStore;
    broker?: SimBroker;
    // The channel has a discussion group the bot can comment in.
    group?: string;
    sendFails?: () => boolean;
  } = {},
) {
  const store = options.store ?? new TradeStore(":memory:");
  const broker = options.broker ?? new SimBroker();
  if (!options.broker) {
    broker.setQuote(friday, 1.0, 1.04, 0.12);
    broker.fillAt.set(friday, 1.03);
  }
  const sent: Post[] = [];
  let id = 100;
  const notifier = new TelegramNotifier(
    {
      send: async (html, o) => {
        if (options.sendFails?.())
          return { ok: false, retry: true, error: "Telegram is down" };
        sent.push({
          html,
          ...(o?.replyTo === undefined ? {} : { replyTo: o.replyTo }),
          ...(o?.chatId === undefined ? {} : { chatId: o.chatId }),
        });
        return { ok: true, messageId: id++ };
      },
      ...(options.group
        ? {
            discussion: async () => options.group!,
            // The group's copy of post N is message N + 9000.
            discussionCopy: async (post: number) => post + 9000,
          }
        : {}),
    },
    { comments: options.group !== undefined },
  );
  const clock = { now: monday };
  const posts = store.posts("owner");
  const engine = new TradeEngine({
    broker,
    notifier,
    posts,
    buys: store.buys("owner"),
    now: () => clock.now,
    sleep: async () => {},
  });
  const service = new TraderService({
    userId: "owner",
    store,
    engine,
    broker,
    notifier,
    posts,
    now: () => clock.now,
  });
  return { store, broker, engine, service, sent, clock, posts };
}

test("no delta: the buy is refused with the reason and what to do instead", async () => {
  const broker = new SimBroker();
  broker.setQuote("META261012C00765000", 1.0, 1.04, null);
  broker.setQuote("META261012C00770000", 0.6, 0.63, null);
  const { engine, service, store } = setup({ broker });
  const request = { underlying: "META", right: "call" as const, sizePct: 0.5 };
  await assert.rejects(
    engine.buy(request),
    (error) =>
      error instanceof TradeRefusal &&
      error.check === "delta" &&
      /published no delta for any of the 2 META calls expiring 2026-10-12/.test(
        error.detail,
      ),
  );
  const out = await service.buy(request);
  assert.equal(out.status, "refused");
  assert.ok("refused" in out && "hint" in out);
  assert.match(out.refused[0]!, /^delta: the broker published no delta/);
  assert.match(
    out.hint!,
    /Name the strike to buy without a delta \(strikes 765 to 770 are listed\)/,
  );
  assert.equal(broker.orders.size, 0);
  assert.match(store.recentLog()[0]!.outcome, /^refused: delta: /);
  // The preview names the same reason on the row.
  const preview = await service.preview(request);
  const row = preview.rows[0]!;
  assert.ok("error" in row && "hint" in row);
  assert.match(String(row.error), /published no delta/);
  // A stock without options, and quotes with a delta but nothing offered.
  const none = await service.buy({ ...request, underlying: "ZZZZ" });
  assert.ok("refused" in none);
  assert.match(none.refused[0]!, /^options listed: the broker lists no calls/);
  broker.setQuote("AMD261012C00200000", 0, 0, 0.12);
  const dry = await service.buy({ ...request, underlying: "AMD" });
  assert.ok("refused" in dry);
  assert.match(dry.refused[0]!, /has an ask price/);
});

test("adding to a position: posted under its first post, up to 5% of the account", async () => {
  const { service, broker, sent, clock } = setup();
  const buy = { underlying: "NVDA", right: "call", sizePct: 2 };
  const first = await service.buy(buy);
  assert.equal(first.status, "started");
  await service.idle();
  assert.equal((await broker.position(friday)).qty, 19);
  clock.now += 5 * 60_000;
  const second = await service.buy(buy);
  assert.equal(second.status, "started");
  await service.idle();
  assert.equal((await broker.position(friday)).qty, 38);
  // One trade, one thread: the addition answers the first post.
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.replyTo, undefined);
  assert.equal(sent[1]!.replyTo, 100);
  assert.match(sent[1]!.html, /Added to the position, 38 held now/);
  // Every contract has a stop, and none is covered twice.
  const stops = (await broker.openOrders(friday)).filter(
    (o) => o.stopPrice !== null,
  );
  assert.equal(
    stops.reduce((sum, o) => sum + o.qty, 0),
    38,
  );
  // $3,914 is in; another 2% would make it more than 5%.
  clock.now += 5 * 60_000;
  const third = await service.buy(buy);
  assert.equal(third.status, "refused");
  assert.ok("refused" in third);
  assert.equal(third.refused.length, 1);
  assert.match(
    third.refused[0]!,
    // The simulated account values what it holds at the bid: $99,886.
    /^position size: \$3,914 already in NVDA calls plus \$1,957 is 5\.88% of the account; one position may be at most 5%, \$4,994, so \$1,080 more fits/,
  );
  // What still fits is accepted.
  const fits = await service.buy({ ...buy, sizePct: 1 });
  assert.equal(fits.status, "started");
  await service.idle();
});

test("resize: to more buys the difference, to fewer sells it, to zero closes", async () => {
  const { service, broker, sent, clock } = setup();
  await service.buy({ underlying: "NVDA", right: "call", sizePct: 0.5 });
  await service.idle();
  assert.equal((await broker.position(friday)).qty, 4);
  clock.now += 5 * 60_000;
  await assert.rejects(
    service.resize({ contract: friday, qty: 4 }),
    (e) => e instanceof RequestError && e.status === 409,
  );
  await assert.rejects(
    service.resize({ contract: friday, qty: 2.5 }),
    /whole number of contracts/,
  );
  const up = await service.resize({ contract: friday, qty: 6 });
  assert.ok(up.status === "started" && "qty" in up);
  assert.equal(up.qty, 2);
  await service.idle();
  assert.equal((await broker.position(friday)).qty, 6);
  assert.match(sent.at(-1)!.html, /Added to the position, 6 held now/);
  // More than one position may hold is refused by the same checks as a buy.
  const tooMuch = await service.resize({ contract: friday, qty: 60 });
  assert.equal(tooMuch.status, "refused");
  assert.ok("refused" in tooMuch);
  assert.match(tooMuch.refused.join(), /position size: /);
  broker.setQuote(friday, 1.5, 1.54, 0.2);
  const down = await service.resize({ contract: friday, qty: 5 });
  assert.ok("selling" in down);
  assert.deepEqual([down.selling, down.held], [1, 6]);
  await service.idle();
  assert.equal((await broker.position(friday)).qty, 5);
  const out = await service.resize({ underlying: "NVDA", qty: 0 });
  assert.ok("selling" in out && out.selling === 5);
  await service.idle();
  assert.equal((await broker.positions()).length, 0);
  assert.equal((await broker.openOrders()).length, 0);
});

test("stop watch: a stop that sells is posted under the entry and commented on it", async () => {
  const { service, broker, sent, posts, store } = setup({ group: "-100777" });
  await service.buy({ underlying: "NVDA", right: "call", sizePct: 0.5 });
  await service.idle();
  // The entry remembers its post and that post's copy in the group.
  assert.equal(await posts.get(friday), "100/9100");
  assert.equal(await service.watchStops(), 0);
  // The bid falls through the stop (0.62): the broker sells all four.
  broker.setQuote(friday, 0.6, 0.64, 0.05);
  assert.equal((await broker.positions()).length, 0);
  assert.equal(await service.watchStops(), 1);
  assert.equal(sent.length, 3);
  const [, reply, comment] = sent;
  // In the channel, as a reply that quotes the entry and notifies.
  assert.deepEqual([reply!.replyTo, reply!.chatId], [100, undefined]);
  assert.match(reply!.html, /STOPPED OUT/);
  assert.match(reply!.html, /\$NVDA \| 240 Call 10\/16/);
  assert.match(reply!.html, /Sold 4 at 0\.60 \(stop 0\.62\)/);
  assert.match(reply!.html, /Loss \$172 \(-42%\)/);
  // And as a comment under the entry post.
  assert.deepEqual([comment!.replyTo, comment!.chatId], [9100, "-100777"]);
  assert.equal(comment!.html, reply!.html);
  // Reported once; the trade's thread is closed.
  assert.equal(await service.watchStops(), 0);
  assert.equal(sent.length, 3);
  assert.equal(await posts.get(friday), undefined);
  assert.match(store.recentLog()[0]!.tool, /^stop-out$/);
  assert.equal(store.recentLog()[0]!.outcome, "posted");
});

test("stop watch: without a discussion group the channel reply is still sent", async () => {
  const { service, broker, sent } = setup();
  await service.buy({ underlying: "NVDA", right: "call", sizePct: 0.5 });
  await service.idle();
  broker.setQuote(friday, 0.6, 0.64, 0.05);
  assert.equal(await service.watchStops(), 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.replyTo, 100);
});

test("stop watch: a stop that sold while the service was down is reported on start", async () => {
  const store = new TradeStore(":memory:");
  const first = setup({ store });
  await first.service.buy({ underlying: "NVDA", right: "call", sizePct: 0.5 });
  await first.service.idle();
  first.broker.setQuote(friday, 0.6, 0.64, 0.05);
  // A new process on the same records and the same account.
  const second = setup({ store, broker: first.broker });
  assert.equal(await second.service.watchStops(), 1);
  assert.match(second.sent[0]!.html, /STOPPED OUT/);
  assert.equal(second.sent[0]!.replyTo, 100);
  assert.match(second.sent[0]!.html, /Loss \$172/);
});

test("stop watch: a canceled stop is not a stop-out; a failed post is tried again", async () => {
  let down = false;
  const { service, broker, sent } = setup({ sendFails: () => down });
  await service.buy({ underlying: "NVDA", right: "call", sizePct: 0.5 });
  await service.idle();
  // Selling takes the stop off and puts it back: nothing was stopped out.
  broker.setQuote(friday, 1.5, 1.54, 0.2);
  await service.sell({ contract: friday, qty: "half" });
  await service.idle();
  assert.equal(await service.watchStops(), 0);
  assert.equal(sent.filter((p) => /STOPPED OUT/.test(p.html)).length, 0);
  down = true;
  broker.setQuote(friday, 0.6, 0.64, 0.05);
  assert.equal(await service.watchStops(), 0);
  down = false;
  assert.equal(await service.watchStops(), 1);
  assert.match(sent.at(-1)!.html, /Sold 2 at 0\.60/);
});

test("trade ticket: the chain of one expiry, and a check that sends and records nothing", async () => {
  const broker = new SimBroker();
  broker.setQuote("NVDA261012C00235000", 0.2, 0.21, 0.09);
  broker.setQuote(friday, 1.0, 1.04, 0.12);
  broker.setQuote("NVDA261016C00245000", 0.5, 0.7, 0.07);
  broker.setQuote("NVDA261023C00250000", 1.5, 1.56, 0.14);
  const { service, store } = setup({ broker });
  const first = await service.chain({ underlying: "nvda", right: "call" });
  assert.deepEqual(first.expiries, ["2026-10-12", "2026-10-16", "2026-10-23"]);
  assert.equal(first.expiry, "2026-10-12");
  const week = await service.chain({
    underlying: "NVDA",
    right: "call",
    expiry: "2026-10-16",
  });
  assert.equal(week.expiries, undefined);
  assert.equal(week.pick, friday);
  assert.deepEqual(
    week.quotes.map((q) => [q.strike, q.bid, q.ask, q.spreadPct, q.delta]),
    [
      [240, 1.0, 1.04, 3.9, 0.12],
      [245, 0.5, 0.7, 33.3, 0.07],
    ],
  );
  await assert.rejects(
    service.chain({ underlying: "NVDA", right: "call", expiry: "2026-10-20" }),
    (e) =>
      e instanceof RequestError &&
      /no NVDA calls expire on 2026-10-20/.test(e.message),
  );
  await assert.rejects(
    service.chain({ underlying: "ZZZZ", right: "put" }),
    (e) => e instanceof RequestError && e.status === 404,
  );
  const ok = await service.check({ contract: friday, sizePct: 0.5 });
  assert.deepEqual([ok.wouldBuy, ok.qty, ok.stopAtCeiling], [true, 4, 0.62]);
  const wide = { contract: "NVDA261016C00245000", qty: 2 };
  const refused = await service.check(wide);
  assert.equal(refused.wouldBuy, false);
  assert.match(
    refused.refused.join(),
    /^spread: 33\.33% of the mid, at most 25%/,
  );
  const forced = await service.check({ ...wide, force: true });
  assert.equal(forced.wouldBuy, true);
  assert.match(forced.notes.join(), /^forced: the spread is 33\.33%/);
  // Nothing was sent, and no buy of the day was used up.
  assert.equal(broker.orders.size, 0);
  assert.equal((await service.status()).limits.buysToday, 0);
  assert.equal(store.recentDecisions("owner", 10).length, 0);
});
