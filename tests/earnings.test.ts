import assert from "node:assert/strict";
import test from "node:test";
import {
  EarningsCache,
  earningsBadge,
  earningsDates,
  groupReports,
  referenceSession,
} from "../packages/market-data/src/earnings.js";

// Synthetic calendar rows. Thursday 2026-10-29, noon New York (UTC−4).
const thursday = Date.parse("2026-10-29T12:00:00-04:00");
const saturday = Date.parse("2026-10-31T12:00:00-04:00");
const reports = (date: string, time = "time-after-hours") =>
  groupReports([{ symbol: "NVDA", date, time }]).NVDA;

test("earnings: the dates read, from the session before to 5 sessions ahead", () => {
  assert.deepEqual(earningsDates(thursday), [
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
  ]);
  // A weekend counts from the next trading day.
  assert.equal(referenceSession(saturday), "2026-11-02");
});

test("earnings: today, after (one trading day only), this week", () => {
  assert.deepEqual(
    earningsBadge(reports("2026-10-29", "time-pre-market"), thursday),
    {
      kind: "today",
      date: "2026-10-29",
      time: "before open",
    },
  );
  assert.equal(earningsBadge(reports("2026-10-28"), thursday)?.kind, "after");
  // Two days after: no badge.
  assert.equal(earningsBadge(reports("2026-10-27"), thursday), null);
  // Friday's report: over the weekend the next trading day (Monday) is the
  // reference, so it already reads "after"; on Tuesday it is gone.
  assert.equal(earningsBadge(reports("2026-10-30"), saturday)?.kind, "after");
  assert.equal(
    earningsBadge(
      reports("2026-10-30"),
      Date.parse("2026-11-03T10:00:00-05:00"),
    ),
    null,
  );
  const ahead = earningsBadge(reports("2026-11-05", ""), thursday);
  assert.deepEqual(ahead, { kind: "week", date: "2026-11-05", time: "" });
  // The 6th trading day ahead is past "this week".
  assert.equal(earningsBadge(reports("2026-11-06"), thursday), null);
  assert.equal(earningsBadge(undefined, thursday), null);
  // Today wins over a report later in the window.
  const both = groupReports([
    { symbol: "X", date: "2026-11-03", time: "" },
    { symbol: "X", date: "2026-10-29", time: "time-after-hours" },
  ]).X;
  assert.equal(earningsBadge(both, thursday)?.kind, "today");
});

test("earnings cache: reads each date once, keeps a copy through a failure", async () => {
  const asked: string[] = [];
  let fail = false;
  const cache = new EarningsCache(async (date) => {
    asked.push(date);
    if (fail) throw new Error("blocked");
    return date === "2026-10-29"
      ? [{ symbol: "NVDA", date, time: "time-after-hours" }]
      : [];
  });
  const first = await cache.window(thursday);
  assert.equal(asked.length, 9);
  assert.deepEqual(first.reports.NVDA, [
    { date: "2026-10-29", time: "after close" },
  ]);
  assert.deepEqual(first.missing, []);
  // Within six hours nothing is asked again.
  await cache.window(thursday + 3600_000);
  assert.equal(asked.length, 9);
  // Later, a failed read keeps the copy it has.
  fail = true;
  const later = await cache.window(thursday + 7 * 3600_000);
  assert.deepEqual(later.reports.NVDA, [
    { date: "2026-10-29", time: "after close" },
  ]);
  // With nothing held and every date failing, the read fails.
  const empty = new EarningsCache(async () => {
    throw new Error("blocked");
  });
  await assert.rejects(empty.window(thursday), /could not be read/);
});

test("the site reads the calendar from the trading service with its read-only token", async () => {
  const { handleEarnings } =
    await import("../packages/trading/src/earnings-api.js");
  const calls: { url: string; auth: string | null }[] = [];
  const body = {
    from: "2026-10-28",
    to: "2026-11-05",
    reports: {},
    missing: [],
    at: 1,
  };
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get("Authorization"),
    });
    return Response.json(body);
  }) as typeof fetch;
  const ok = await handleEarnings(
    { url: "https://trader.test", token: "read" },
    fetcher,
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, body);
  assert.deepEqual(calls, [
    { url: "https://trader.test/v1/earnings", auth: "Bearer read" },
  ]);
  assert.equal((await handleEarnings({}, fetcher)).status, 503);
  const down = (async () =>
    new Response("no", { status: 502 })) as typeof fetch;
  assert.equal(
    (await handleEarnings({ url: "https://trader.test", token: "read" }, down))
      .status,
    502,
  );
});
