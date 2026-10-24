import assert from "node:assert/strict";
import test from "node:test";
import {
  coreClose,
  newYorkToUtc,
} from "../packages/market-data/src/calendar.js";
import {
  chartSessions,
  handleTradeChart,
} from "../packages/market-data/src/trade-chart.js";

// Synthetic Alpaca answers: the stock has a bar every regular minute (and a
// pre-market one to be ignored), closing at 100 + the minute's index in cents;
// the contract trades every third minute from 10:00, closing at 0.40 + the
// index in cents. Both answer for whatever range is asked.
const credentials = { key: "k", secret: "s", sipDelayMinutes: 0 };
const contract = "RKLB261003C00080000";
const day = "2026-09-30";
const afterClose = Date.parse("2026-09-30T21:00:00Z");

function sessions(start: number, end: number): string[] {
  const out: string[] = [];
  const d = new Date(start);
  d.setUTCHours(12, 0, 0, 0);
  for (; d.getTime() < end + 86400000; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    if (coreClose(date) !== null) out.push(date);
  }
  return out;
}

function fetcher(seen: URL[] = []) {
  return (async (input: URL) => {
    seen.push(input);
    const start = Date.parse(input.searchParams.get("start")!);
    const end = Date.parse(input.searchParams.get("end")!);
    const stock = input.pathname.startsWith("/v2/stocks/");
    const bars = [];
    for (const date of sessions(start, end)) {
      const close = coreClose(date)!;
      const at = (minute: number) =>
        new Date(newYorkToUtc(date, minute)).toISOString();
      if (stock)
        bars.push({ t: at(480), o: 1, h: 1, l: 1, c: 1, v: 10, vw: 1 });
      for (let minute = 570, k = 0; minute < close; minute += 1, k++) {
        if (!stock && (minute < 600 || k % 3 !== 0)) continue;
        const c = stock ? 100 + k / 100 : 0.4 + k / 100;
        bars.push({ t: at(minute), o: c, h: c, l: c, c, v: 10, vw: c });
      }
    }
    const kept = bars.filter((b) => {
      const t = Date.parse(b.t);
      return t >= start && t < end;
    });
    return Response.json({
      bars: stock ? kept : { [contract]: kept },
      next_page_token: null,
    });
  }) as unknown as typeof fetch;
}

test("trade chart: the stock and the contract by session minute, regular hours only", async () => {
  const seen: URL[] = [];
  const out = await handleTradeChart(
    { symbol: contract, from: day, to: day },
    credentials,
    fetcher(seen),
    afterClose,
  );
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok("sessions" in out.body);
  assert.equal(out.body.underlying, "RKLB");
  assert.equal(out.body.option, true);
  assert.equal(out.body.skipped, 0);
  assert.equal(out.body.sessions.length, 1);
  const s = out.body.sessions[0]!;
  assert.equal(s.date, day);
  assert.equal(s.minutes, 390);
  assert.equal(s.stock.length, 390); // the 08:00 bar is not a session minute
  assert.deepEqual(s.stock[0], [0, 100]);
  assert.deepEqual(s.stock[389], [389, 103.89]);
  assert.equal(s.option.length, 120); // every third minute from 10:00
  assert.deepEqual(s.option[0], [30, 0.7]);
  // One read of each: the stock's split-adjusted minute bars, the contract's bars.
  assert.deepEqual(
    seen.map((u) => u.pathname),
    ["/v2/stocks/RKLB/bars", "/v1beta1/options/bars"],
  );
  assert.equal(seen[1]!.searchParams.get("symbols"), contract);
  assert.equal(seen[1]!.searchParams.get("timeframe"), "1Min");
});

test("trade chart: a stock trade has no option pane; a held trade spans its sessions", async () => {
  const stock = await handleTradeChart(
    { symbol: "nvda", from: "2026-09-29", to: "2026-10-01" },
    credentials,
    fetcher(),
    Date.parse("2026-10-01T21:00:00Z"),
  );
  assert.equal(stock.status, 200);
  assert.ok("sessions" in stock.body);
  assert.equal(stock.body.option, false);
  assert.equal(stock.body.symbol, "NVDA");
  assert.deepEqual(
    stock.body.sessions.map((s) => s.date),
    ["2026-09-29", "2026-09-30", "2026-10-01"],
  );
  for (const s of stock.body.sessions) assert.deepEqual(s.option, []);
});

test("trade chart: a long hold shows its first session and the last four", () => {
  assert.deepEqual(chartSessions(day, day), { dates: [day], skipped: 0 });
  assert.deepEqual(chartSessions("2026-09-28", "2026-10-02"), {
    dates: [
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ],
    skipped: 0,
  });
  // Nine sessions from 2026-09-21: the 21st, then the 28th to the 2nd; three left out.
  assert.deepEqual(chartSessions("2026-09-21", "2026-10-02"), {
    dates: [
      "2026-09-21",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ],
    skipped: 5,
  });
});

test("trade chart: the request is checked before anything is read", async () => {
  const bad = async (query: Record<string, string>) =>
    (await handleTradeChart(query, credentials, fetcher(), afterClose)).status;
  assert.equal(await bad({ symbol: "?rklb", from: day, to: day }), 400);
  assert.equal(
    await bad({ symbol: contract, from: "2026-09-27", to: day }),
    400,
  ); // a Sunday
  assert.equal(
    await bad({ symbol: contract, from: day, to: "2026-09-29" }),
    400,
  ); // ends before it starts
  assert.equal(
    await bad({ symbol: contract, from: day, to: "2026-10-02" }),
    400,
  ); // not yet traded
  const none = await handleTradeChart(
    { symbol: contract, from: day, to: day },
    { key: "", secret: "" },
    fetcher(),
    afterClose,
  );
  assert.equal(none.status, 503);
});
