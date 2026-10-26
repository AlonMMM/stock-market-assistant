import assert from "node:assert/strict";
import test from "node:test";
import {
  BotRoutedNotifier,
  botAccountIds,
} from "../apps/trader/src/bot-channel.js";
import type { Notifier, Sent } from "../packages/trading/src/notifier.js";

function recorder(name: string, calls: string[]): Notifier {
  const sent = (what: string): Promise<Sent> => {
    calls.push(`${name}:${what}`);
    return Promise.resolve({ ok: true, ref: `${name}-1` });
  };
  return {
    entry: () => sent("entry"),
    exit: () => sent("exit"),
    stopped: () => sent("stopped"),
    notice: () => sent("notice"),
    alert: () => sent("alert"),
  };
}

const note = (tag?: string) =>
  ({ symbol: "NVDA", paper: true, ...(tag ? { tag } : {}) }) as never;
const tags = ["🤖 Bot", "🎯 Alert leg"];

test("bots chat: a bot-only account posts everything there, but an urgent alert goes to the owner", async () => {
  const calls: string[] = [];
  const n = new BotRoutedNotifier(
    recorder("owner", calls),
    recorder("bots", calls),
    true,
    tags,
  );
  await n.entry(note(), {} as never);
  await n.exit(note(), {} as never);
  await n.stopped(note(), {} as never);
  await n.notice("t", []);
  await n.alert("short!", []);
  assert.deepEqual(calls, [
    "bots:entry",
    "bots:exit",
    "bots:stopped",
    "bots:notice",
    "owner:alert",
  ]);
});

test("bots chat: on a shared account the order's tag decides; the owner's own trades stay on the owner's channel", async () => {
  const calls: string[] = [];
  const n = new BotRoutedNotifier(
    recorder("owner", calls),
    recorder("bots", calls),
    false,
    tags,
  );
  await n.entry(note("🤖 Bot"), {} as never);
  await n.exit(note("🎯 Alert leg"), {} as never);
  await n.entry(note(), {} as never);
  await n.exit(note("something else"), {} as never);
  await n.notice("t", []);
  assert.deepEqual(calls, [
    "bots:entry",
    "bots:exit",
    "owner:entry",
    "owner:exit",
    "owner:notice",
  ]);
});

test("bots chat: the bot-only accounts are the bot's and the Alert leg's", () => {
  assert.deepEqual(botAccountIds("owner"), ["owner-bot", "owner-strangle"]);
});
