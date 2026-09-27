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
} from "../packages/notifications/src/outbox.js";
import {
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
  rule: "rvol-v3",
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
      "<b>AAPL</b> ▲ +1.23% in 3 min",
      "17:00 Israel time · regular",
      "Volume 123,456 · 4.1× usual",
      "Last 187.5",
      "https://x.test",
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
  // Winter: Israel is UTC+2.
  assert.match(down, /16:31 Israel time · pre-market/);
  assert.match(down, /Volume 123,456 · 3.5× today's pace\n/);
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
