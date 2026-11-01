import assert from "node:assert/strict";
import test from "node:test";
import {
  earningsTag,
  handleTags,
  stockTags,
  tagDates,
  weekFriday,
} from "../packages/market-data/src/tags.js";
import { newYorkToUtc } from "../packages/market-data/src/calendar.js";

// Synthetic calendars and headlines. Tuesday 2026-11-03, 10:00 New York.
const now = newYorkToUtc("2026-11-03", 600);
const row = (symbol: string, date: string, time = "") => ({
  symbol,
  date,
  time,
});

test("this week ends on Friday; on a weekend it is the coming week", () => {
  assert.equal(weekFriday(now), "2026-11-06");
  assert.equal(weekFriday(newYorkToUtc("2026-11-07", 600)), "2026-11-13");
  assert.equal(weekFriday(newYorkToUtc("2026-11-08", 600)), "2026-11-13");
  assert.deepEqual(tagDates(now), [
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
  ]);
});

test("each earnings window gets its own tag", () => {
  // After today's close: within 24 hours.
  assert.equal(
    earningsTag([row("A", "2026-11-03", "time-after-hours")], now)?.kind,
    "earnings-soon",
  );
  // Yesterday after the close: in the last 24 hours.
  assert.equal(
    earningsTag([row("A", "2026-11-02", "time-after-hours")], now)?.kind,
    "earnings-past",
  );
  // Thursday before the open: later this week.
  assert.equal(
    earningsTag([row("A", "2026-11-05", "time-pre-market")], now)?.kind,
    "earnings-week",
  );
  // Next Monday: not this week.
  assert.equal(earningsTag([row("A", "2026-11-09")], now), null);
  // Yesterday before the open: more than 24 hours ago.
  assert.equal(
    earningsTag([row("A", "2026-11-02", "time-pre-market")], now),
    null,
  );
});

test("one earnings tag, the most urgent", () => {
  const tag = earningsTag(
    [
      row("A", "2026-11-05", "time-pre-market"),
      row("A", "2026-11-04", "time-pre-market"),
    ],
    now,
  );
  assert.equal(tag?.kind, "earnings-soon");
  assert.equal(tag?.date, "2026-11-04");
});

test("big news takes 3 headlines in 24 hours", () => {
  const tags = stockTags(
    ["A", "B", "C"],
    [row("C", "2026-11-03", "time-after-hours")],
    new Map([
      ["A", 3],
      ["B", 2],
      ["C", 5],
    ]),
    now,
  );
  assert.deepEqual(tags.A, [{ kind: "big-news", headlines: 3 }]);
  assert.deepEqual(tags.B, []);
  assert.deepEqual(
    tags.C?.map((t) => t.kind),
    ["earnings-soon", "big-news"],
  );
});

test("the endpoint counts headlines and names a failed calendar", async () => {
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("nasdaq")) return new Response("blocked", { status: 403 });
    return Response.json({
      news: [
        { symbols: ["NVDA", "AMD"] },
        { symbols: ["NVDA"] },
        { symbols: ["NVDA"] },
      ],
      next_page_token: null,
    });
  }) as typeof fetch;
  const result = await handleTags(
    { symbols: "nvda,AMD,bad!" },
    { key: "k", secret: "s", sipDelayMinutes: 0 },
    fetcher,
    now,
  );
  assert.equal(result.status, 200);
  const body = result.body as Awaited<ReturnType<typeof handleTags>>["body"] & {
    stocks: Record<string, unknown[]>;
  };
  assert.equal("earnings" in body && body.earnings, "unavailable");
  assert.equal("news" in body && body.news, "ok");
  assert.deepEqual(body.stocks.NVDA, [{ kind: "big-news", headlines: 3 }]);
  assert.deepEqual(body.stocks.AMD, []);
  assert.equal(
    (await handleTags({}, { key: "", secret: "" } as never)).status,
    400,
  );
});
