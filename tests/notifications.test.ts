import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaults } from "../packages/alerts/src/relative-volume.js";
import { AlertEvents } from "../packages/alerts/src/events.js";
import {
  notifyOnAlerts,
  Outbox,
  topicName,
} from "../packages/notifications/src/outbox.js";
import {
  alertLink,
  parseAlertLink,
} from "../packages/contracts/src/alert-link.js";
import {
  automaticCopy,
  formatAlert,
  TelegramSender,
  type Alert,
  type SendResult,
} from "../packages/notifications/src/telegram.js";

// SYNTHETIC alert values.
const alert = (ticker: string, end: string): Alert => ({
  ticker,
  end,
  session: "regular",
  actual: 123456,
  expected: 30000,
  ratio: 4.12,
  paceRatio: null,
  volumeBasis: "history",
  move: 1.234,
  expectedMove: 0.3,
  direction: "up",
  samples: 20,
  status: "alert",
  rule: "rvol-v4",
  config: defaults,
  close: 187.5,
});

function setup(
  results: SendResult[],
  start = Date.parse("2026-09-28T14:00:00Z"),
) {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  const path = join(dir, "test.sqlite");
  const sent: string[] = [];
  let now = start;
  const sender = {
    async send(html: string) {
      sent.push(html);
      return results.shift() ?? { ok: true as const };
    },
  };
  const open = () =>
    new Outbox(path, sender, { baseDelayMs: 1000, now: () => now });
  return {
    path,
    sent,
    open,
    advance: (ms: number) => (now += ms),
    cleanup: () => rmSync(dir, { recursive: true }),
  };
}

test("formats an alert in Israel time with the evaluator's values", () => {
  // 14:00 UTC in September is 17:00 in Israel (IDT, UTC+3).
  const text = formatAlert(
    alert("AAPL", "2026-09-28T14:00:00Z"),
    "https://x.test",
  );
  assert.equal(
    text,
    [
      "<b>AAPL</b> · big move likely",
      // No score stored (older alert or no σ): placeholder line.
      "vs SPY —",
      "Burst ▲ +1.23% in 3 min · 17:00 Israel time · regular",
      "Volume 123,456 · 4.1× usual",
      "Last 187.5",
      '<a href="https://x.test/?alert=AAPL&amp;end=2026-09-28T14%3A00%3A00Z">Open in site</a>',
    ].join("\n"),
  );
  const down = formatAlert({
    ...alert("BRK.B", "2026-12-01T14:31:00Z"),
    direction: "down",
    move: -0.8,
    ratio: null,
    paceRatio: 3.46,
    session: "pre",
  });
  assert.match(down, /▼ -0.80%/);
  // The area score vs SPY sits directly under the headline; an older record
  // with a label still shows the score only.
  const scored = formatAlert({
    ...alert("AAPL", "2026-09-28T14:00:00Z"),
    vsSpy: {
      score: 78,
      area: 0.8,
      beta: 1.4,
      betaAssumed: false,
      label: "confirmed",
      spyLagged: true,
    },
  }).split("\n");
  assert.deepEqual(scored.slice(0, 3), [
    "<b>AAPL</b> · big move likely",
    "vs SPY 78/100",
    "Burst ▲ +1.23% in 3 min · 17:00 Israel time · regular",
  ]);
  // Winter: Israel is UTC+2.
  assert.match(down, /16:31 Israel time · pre-market/);
  assert.match(down, /Volume 123,456 · 3.5× today's pace\n/);
  // v4: in-play alerts carry a star and the day's volume level.
  const busy = formatAlert({
    ...alert("AAPL", "2026-09-28T14:00:00Z"),
    dayRvol: 2.43,
    inPlay: true,
  });
  assert.match(busy, /^⭐ <b>AAPL<\/b> · big move likely\n/);
  assert.match(busy, /\nDay volume 2\.4× usual · in play\n/);
  const calm = formatAlert({
    ...alert("AAPL", "2026-09-28T14:00:00Z"),
    dayRvol: 1.2,
    inPlay: false,
  });
  assert.match(calm, /^<b>AAPL<\/b>/);
  assert.match(calm, /\nDay volume 1\.2× usual\n/);
});

test("labels a synthetic alert on its first line", () => {
  const text = formatAlert({
    ...alert("TEST", "2026-09-28T14:00:00Z"),
    synthetic: true,
  });
  assert.match(
    text,
    /^🧪 <b>SYNTHETIC<\/b> · not a market alert\n<b>TEST<\/b>/,
  );
});

test("sends each alert once, even when enqueued twice or reopened", async () => {
  const t = setup([]);
  const box = t.open();
  const a = alert("AAPL", "2026-09-28T14:00:00Z");
  assert.equal(box.enqueue(a), true);
  assert.equal(box.enqueue(a), false);
  await Promise.all([box.drain(), box.drain()]);
  box.close();
  const again = t.open();
  assert.equal(again.enqueue(a), false);
  await again.drain();
  assert.equal(t.sent.length, 1);
  assert.equal(again.recent()[0]!.status, "sent");
  again.close();
  t.cleanup();
});

test("retries transient failures with backoff and stops at permanent ones", async () => {
  const t = setup([
    { ok: false, retry: true, error: "Network error" },
    { ok: false, retry: true, error: "Telegram 429", retryAfter: 7 },
    { ok: true },
    { ok: false, retry: false, error: "Telegram 400: chat not found" },
  ]);
  const box = t.open();
  box.enqueue(alert("AAPL", "2026-09-28T14:00:00Z"));
  await box.drain();
  assert.equal(t.sent.length, 1);
  t.advance(999);
  await box.drain();
  assert.equal(t.sent.length, 1, "not due before the 1 s backoff");
  t.advance(1);
  await box.drain();
  assert.equal(t.sent.length, 2);
  t.advance(6999);
  await box.drain();
  assert.equal(t.sent.length, 2, "honors Telegram's retry_after");
  t.advance(1);
  await box.drain();
  assert.deepEqual(
    box.recent().map((r) => [r.status, r.attempts]),
    [["sent", 3]],
  );

  box.enqueue(alert("MSFT", "2026-09-28T14:00:30Z"));
  await box.drain();
  t.advance(3600000);
  await box.drain();
  const msft = box.recent()[0]!;
  assert.equal(msft.status, "failed");
  assert.equal(msft.error, "Telegram 400: chat not found");
  assert.equal(t.sent.length, 4);
  box.close();
  t.cleanup();
});

test("gives up after the attempt limit and skips stale alerts", async () => {
  const fail = { ok: false as const, retry: true, error: "Telegram 502" };
  const t = setup([fail, fail, fail, fail, fail]);
  const box = t.open();
  box.enqueue(alert("AAPL", "2026-09-28T14:00:00Z"));
  for (let i = 0; i < 6; i++) {
    await box.drain();
    t.advance(1000 * 3 ** i);
  }
  assert.equal(t.sent.length, 5);
  assert.equal(box.recent()[0]!.status, "failed");

  t.advance(15 * 60000);
  box.enqueue(alert("OLD", "2026-09-28T14:01:00Z"));
  await box.drain();
  assert.equal(t.sent.length, 5);
  assert.equal(box.recent()[0]!.status, "expired");
  box.close();
  t.cleanup();
});

test("muted alerts are recorded and not replayed after unmuting", async () => {
  const t = setup([]);
  const box = t.open();
  box.setMuted(true);
  box.enqueue(alert("AAPL", "2026-09-28T14:00:00Z"));
  await box.drain();
  box.close();
  const again = t.open();
  assert.equal(again.muted(), true, "mute survives a restart");
  again.setMuted(false);
  await again.drain();
  assert.equal(t.sent.length, 0);
  assert.equal(again.recent()[0]!.status, "muted");
  again.enqueue(alert("MSFT", "2026-09-28T14:00:30Z"));
  await again.drain();
  assert.equal(t.sent.length, 1);
  again.close();
  t.cleanup();
});

test("a send interrupted by a crash is never repeated", async () => {
  const t = setup([]);
  const box = t.open();
  box.enqueue(alert("AAPL", "2026-09-28T14:00:00Z"));
  box.close();
  // Simulates a process that died after marking the row but before recording
  // Telegram's answer.
  const db = new DatabaseSync(t.path);
  db.exec("UPDATE notifications SET status='sending', attempts=1");
  db.close();
  const again = t.open();
  await again.drain();
  assert.equal(t.sent.length, 0);
  assert.equal(again.recent()[0]!.status, "unknown");
  again.close();
  t.cleanup();
});

test("TelegramSender classifies responses without leaking the token", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const reply = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  const ok = await new TelegramSender(
    "SECRET",
    "42",
    reply(200, { ok: true }),
  ).send("hi");
  assert.deepEqual(ok, { ok: true });
  assert.equal(calls[0]!.url, "https://api.telegram.org/botSECRET/sendMessage");
  assert.deepEqual(calls[0]!.body, {
    chat_id: "42",
    text: "hi",
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  const threaded = await new TelegramSender(
    "SECRET",
    "42",
    reply(200, { ok: true, result: { message_id: 7 } }),
  ).send("hi", { replyTo: 5 });
  assert.deepEqual(threaded, { ok: true, messageId: 7 });
  assert.deepEqual(
    (calls[1]!.body as { reply_parameters: unknown }).reply_parameters,
    {
      message_id: 5,
      allow_sending_without_reply: true,
    },
  );
  const limited = await new TelegramSender(
    "SECRET",
    "42",
    reply(429, {
      description: "Too Many Requests",
      parameters: { retry_after: 3 },
    }),
  ).send("hi");
  assert.deepEqual(limited, {
    ok: false,
    retry: true,
    error: "Telegram 429: Too Many Requests",
    retryAfter: 3,
  });
  const bad = await new TelegramSender(
    "SECRET",
    "42",
    reply(401, { description: "Unauthorized" }),
  ).send("hi");
  assert.equal(bad.ok || bad.retry, false);
  const down = await new TelegramSender("SECRET", "42", (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as typeof fetch).send("hi");
  assert.equal(!down.ok && down.retry, true);
  for (const r of [limited, bad, down])
    assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test("the outbox subscribes to published alerts and sends each once", async () => {
  const t = setup([]);
  const box = t.open();
  const events = new AlertEvents();
  const stop = notifyOnAlerts(events, box);
  const a = alert("AAPL", "2026-09-28T14:00:00Z");
  events.publish(a);
  events.publish(a);
  await box.drain();
  assert.equal(t.sent.length, 1);
  stop();
  events.publish(alert("MSFT", "2026-09-28T14:00:30Z"));
  await box.drain();
  assert.equal(t.sent.length, 1);
  box.close();
  t.cleanup();
});

test("alert links round-trip and reject incomplete input", () => {
  const link = alertLink("https://site.test/app?mode=x", {
    ticker: "BRK.B",
    end: "2026-09-28T14:00:00Z",
  });
  assert.equal(
    link,
    "https://site.test/app?alert=BRK.B&end=2026-09-28T14%3A00%3A00Z",
  );
  assert.deepEqual(parseAlertLink(new URL(link).search), {
    ticker: "BRK.B",
    end: "2026-09-28T14:00:00Z",
    synthetic: false,
  });
  const synthetic = alertLink("https://site.test", {
    ticker: "TEST",
    end: "2026-09-28T14:00:00Z",
    synthetic: true,
  });
  assert.equal(parseAlertLink(new URL(synthetic).search)?.synthetic, true);
  assert.equal(parseAlertLink("?alert=AAPL"), null);
  assert.equal(parseAlertLink("?alert=AAPL&end=soon"), null);
  assert.equal(parseAlertLink(""), null);
});

test("records the Telegram message id and upgrades an older database", async () => {
  const t = setup([{ ok: true, messageId: 99 }]);
  // A database created before the message_id column existed.
  const old = new DatabaseSync(t.path);
  old.exec(`CREATE TABLE notifications (ticker TEXT, end TEXT, payload TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
    error TEXT, sent_at TEXT, PRIMARY KEY(ticker,end))`);
  old.close();
  const box = t.open();
  const a = alert("AAPL", "2026-09-28T14:00:00Z");
  assert.equal(box.messageId(a.ticker, a.end), null);
  box.enqueue(a);
  await box.drain();
  assert.equal(box.messageId(a.ticker, a.end), 99);
  box.close();
  t.cleanup();
});

test("re-sends a stored alert labeled, even while muted, and threads under it", async () => {
  const t = setup([
    { ok: true, messageId: 5 },
    { ok: true, messageId: 8 },
  ]);
  const box = t.open();
  const a = alert("AAPL", "2026-09-28T14:00:00Z");
  box.enqueue(a);
  await box.drain();
  assert.equal(box.messageId(a.ticker, a.end), 5);
  box.setMuted(true);
  assert.deepEqual(await box.resend(a), { ok: true, messageId: 8 });
  assert.match(
    t.sent[1]!,
    /^🔁 <b>RE-SENT<\/b> · earlier alert, sent again for a test\n<b>AAPL<\/b>/,
  );
  assert.equal(box.messageId(a.ticker, a.end), 8);
  // An alert that was never sent gets a row on its first re-send.
  const b = alert("MSFT", "2026-09-28T14:01:00Z");
  await box.resend(b);
  assert.equal(box.recent()[0]!.status, "sent");
  box.close();
  t.cleanup();
});

test("TelegramSender sends one photo or an album into a topic", async () => {
  const calls: { url: string; form: FormData }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), form: init?.body as FormData });
    return Response.json({
      ok: true,
      result: String(url).endsWith("sendMediaGroup")
        ? [{ message_id: 11 }, { message_id: 12 }]
        : { message_id: 10 },
    });
  }) as typeof fetch;
  const sender = new TelegramSender("SECRET", "42", fetcher);
  const png = Buffer.from("PNG");
  assert.deepEqual(
    await sender.sendPhotos([{ png, caption: "one" }], { threadId: 7 }),
    { ok: true, messageId: 10 },
  );
  assert.match(calls[0]!.url, /\/sendPhoto$/);
  assert.equal(calls[0]!.form.get("message_thread_id"), "7");
  assert.equal(calls[0]!.form.get("caption"), "one");
  assert.ok(calls[0]!.form.get("photo") instanceof Blob);
  assert.deepEqual(
    await sender.sendPhotos([{ png, caption: "a" }, { png }], { replyTo: 3 }),
    { ok: true, messageId: 11 },
  );
  assert.match(calls[1]!.url, /\/sendMediaGroup$/);
  assert.deepEqual(JSON.parse(String(calls[1]!.form.get("media"))), [
    {
      type: "photo",
      media: "attach://photo0",
      caption: "a",
      parse_mode: "HTML",
    },
    { type: "photo", media: "attach://photo1" },
  ]);
  assert.deepEqual(JSON.parse(String(calls[1]!.form.get("reply_parameters"))), {
    message_id: 3,
    allow_sending_without_reply: true,
  });
});

function telegramApi(
  chat: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const methods: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1)!;
    methods.push(method);
    if (method === "getChat") return Response.json({ ok: true, result: chat });
    if (method === "getMe")
      return Response.json({
        ok: true,
        result: { id: 1, has_topics_enabled: true },
      });
    if (method in extra)
      return Response.json({ ok: true, result: extra[method] });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.name.length <= 128, true);
    return Response.json({
      ok: true,
      result: { message_thread_id: 99, name: body.name },
    });
  }) as typeof fetch;
  return { methods, fetcher };
}

test("TelegramSender detects topics per chat type and creates topics", async () => {
  const priv = telegramApi({ id: 42, type: "private" });
  const sender = new TelegramSender("SECRET", "42", priv.fetcher);
  assert.equal(await sender.topicsEnabled(), true);
  assert.equal(await sender.topicsEnabled(), true);
  assert.equal(await sender.createTopic("x".repeat(200)), 99);
  assert.deepEqual(priv.methods, ["getChat", "getMe", "createForumTopic"]);
  // A supergroup follows its own topics switch; a channel has none.
  const forum = telegramApi({ id: -100, type: "supergroup", is_forum: true });
  assert.equal(
    await new TelegramSender("S", "-100", forum.fetcher).topicsEnabled(),
    true,
  );
  const plain = telegramApi({ id: -100, type: "supergroup" });
  assert.equal(
    await new TelegramSender("S", "-100", plain.fetcher).topicsEnabled(),
    false,
  );
  const channel = telegramApi({
    id: -200,
    type: "channel",
    linked_chat_id: -300,
  });
  assert.equal(
    await new TelegramSender("S", "-200", channel.fetcher).topicsEnabled(),
    false,
  );
  assert.equal(channel.methods.includes("getMe"), false);
});

test("recognizes a channel post's automatic copy in its discussion group", () => {
  const copy = {
    message_id: 77,
    is_automatic_forward: true,
    chat: { id: -300, type: "supergroup" },
    forward_origin: { type: "channel", chat: { id: -200 }, message_id: 12 },
  };
  assert.deepEqual(automaticCopy(copy, "-300"), { postId: 12, messageId: 77 });
  assert.equal(automaticCopy(copy, "-999"), null);
  assert.equal(
    automaticCopy({ ...copy, is_automatic_forward: false }, "-300"),
    null,
  );
  assert.equal(
    automaticCopy({ ...copy, forward_origin: { type: "user" } }, "-300"),
    null,
  );
  assert.equal(automaticCopy(null, "-300"), null);
});

test("finds a post's discussion copy from updates, even one sent before tracking", async () => {
  let polls = 0;
  const offsets: number[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1)!;
    if (method === "getChat")
      return Response.json({
        ok: true,
        result: { id: -200, type: "channel", linked_chat_id: -300 },
      });
    if (method === "getUpdates") {
      offsets.push(JSON.parse(String(init?.body)).offset);
      polls++;
      return Response.json({
        ok: true,
        result:
          polls === 1
            ? [
                {
                  update_id: 5,
                  message: { message_id: 1, chat: { id: -300 }, text: "hi" },
                },
                {
                  update_id: 6,
                  message: {
                    message_id: 77,
                    is_automatic_forward: true,
                    chat: { id: -300 },
                    forward_origin: { type: "channel", message_id: 12 },
                  },
                },
              ]
            : [],
      });
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const sender = new TelegramSender("S", "-200", fetcher);
  assert.equal(await sender.discussion(), "-300");
  assert.equal(await sender.discussionCopy(12, 5000), 77);
  assert.equal(await sender.discussionCopy(13, 1500), null);
  sender.stop();
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], 7);
});

function topicSender(enabled: boolean) {
  const sent: { html: string; threadId?: number }[] = [];
  const topics: string[] = [];
  let next = 500;
  return {
    sent,
    topics,
    sender: {
      async send(
        html: string,
        options?: { threadId?: number },
      ): Promise<SendResult> {
        sent.push({ html, threadId: options?.threadId });
        return { ok: true, messageId: sent.length };
      },
      async topicsEnabled() {
        return enabled;
      },
      async createTopic(name: string) {
        topics.push(name);
        return next++;
      },
    },
  };
}

test("with topics on, each alert opens its own topic and a retry reuses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  let now = Date.parse("2026-09-28T14:00:00Z");
  const t = topicSender(true);
  const box = new Outbox(join(dir, "test.sqlite"), t.sender, {
    baseDelayMs: 1000,
    now: () => now,
  });
  const a = alert("AAPL", "2026-09-28T14:00:00Z");
  box.enqueue(a);
  await box.drain();
  // 14:00 UTC is 17:00 in Israel.
  assert.deepEqual(t.topics, ["AAPL ▲ +1.23% · 28/09, 17:00"]);
  assert.equal(t.sent[0]!.threadId, 500);
  assert.equal(box.threadId(a.ticker, a.end), 500);
  // Retry after a failed send: same topic, no second topic.
  const failing = { ...a, ticker: "MSFT", end: "2026-09-28T14:01:00Z" };
  const f = topicSender(true);
  let first = true;
  f.sender.send = async (html: string, options?: { threadId?: number }) => {
    f.sent.push({ html, threadId: options?.threadId });
    if (first) {
      first = false;
      return { ok: false, retry: true, error: "Network error" };
    }
    return { ok: true, messageId: 9 };
  };
  const box2 = new Outbox(join(dir, "test2.sqlite"), f.sender, {
    baseDelayMs: 1000,
    now: () => now,
  });
  box2.enqueue(failing);
  await box2.drain();
  now += 1000;
  await box2.drain();
  assert.equal(f.topics.length, 1);
  assert.deepEqual(
    f.sent.map((s) => s.threadId),
    [500, 500],
  );
  // A re-send opens a new, labeled topic.
  await box.resend(a);
  assert.equal(t.topics[1], "🔁 AAPL ▲ +1.23% · 28/09, 17:00");
  assert.equal(box.threadId(a.ticker, a.end), 501);
  box.close();
  box2.close();
  rmSync(dir, { recursive: true });
});

test("with topics off, alerts go to the main chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  const t = topicSender(false);
  const box = new Outbox(join(dir, "test.sqlite"), t.sender, {
    now: () => Date.parse("2026-09-28T14:00:00Z"),
  });
  const a = alert("AAPL", "2026-09-28T14:00:00Z");
  box.enqueue(a);
  await box.drain();
  assert.deepEqual(t.topics, []);
  assert.equal(t.sent[0]!.threadId, undefined);
  assert.equal(box.threadId(a.ticker, a.end), null);
  assert.equal(
    topicName({ ...a, direction: "down", move: -0.5, synthetic: true }),
    "🧪 AAPL ▼ -0.50% · 28/09, 17:00",
  );
  box.close();
  rmSync(dir, { recursive: true });
});
