import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { AlertEvents } from "../packages/alerts/src/events.js";
import {
  analysisModel,
  catalystAgent,
  runAgent,
  technicalAgent,
  type CreateMessage,
  type CreateParams,
} from "../packages/analysis/src/agents.js";
import {
  formatAnalysis,
  telegramDelivery,
} from "../packages/analysis/src/format.js";
import { alpacaNews, type NewsItem } from "../packages/analysis/src/news.js";
import {
  AnalysisQueue,
  analyzeOnAlerts,
  type AnalysisDeps,
  type AnalysisResult,
} from "../packages/analysis/src/pipeline.js";
import {
  aggregate,
  pythonRunner,
  runTechnicalScan,
  type ScriptRunner,
} from "../packages/analysis/src/technical.js";
import type { PriceBar, RawBar } from "../packages/market-data/src/bars.js";
import { newYorkToUtc } from "../packages/market-data/src/calendar.js";
import type { SendResult } from "../packages/notifications/src/telegram.js";
import {
  alert,
  alertEnd,
  day,
  dayBars,
  minuteBar,
  pairedDaily,
  previous,
  sessions,
} from "./analysis-fixtures.js";

// SYNTHETIC regular-session minute bars: a gentle walk over the given days.
function sessionMinutes(ticker: string, dates: string[], start = 100) {
  const bars: PriceBar[] = [];
  let price = start;
  for (const date of dates)
    for (let minute = 570; minute < 960; minute++) {
      price *= 1 + Math.sin(minute / 17 + bars.length / 997) * 0.0004;
      bars.push(minuteBar(ticker, date, minute, Number(price.toFixed(2))));
    }
  return bars;
}

test("aggregates regular-session minutes like IBKR's RTH bars", () => {
  const bars = [
    minuteBar("AAPL", day, 560, 99), // pre-market: dropped
    minuteBar("AAPL", day, 570, 100, 10),
    minuteBar("AAPL", day, 574, 101, 20),
    minuteBar("AAPL", day, 575, 102, 30),
    minuteBar("AAPL", day, 599, 103, 40),
    minuteBar("AAPL", day, 600, 104, 50),
    minuteBar("AAPL", day, 965, 105), // after-hours: dropped
  ];
  const five = aggregate(bars, (m) => m - (m % 5));
  assert.deepEqual(five.time, [
    new Date(newYorkToUtc(day, 570)).toISOString(),
    new Date(newYorkToUtc(day, 575)).toISOString(),
    new Date(newYorkToUtc(day, 595)).toISOString(),
    new Date(newYorkToUtc(day, 600)).toISOString(),
  ]);
  assert.deepEqual(five.open, [100, 102, 103, 104]);
  assert.deepEqual(five.close, [101, 102, 103, 104]);
  assert.deepEqual(five.high, [101, 102, 103, 104]);
  assert.deepEqual(five.volume, [30, 30, 40, 50]);
  const hour = aggregate(bars, (m) => (m < 600 ? 570 : m - (m % 60)));
  // 9:30–10:00 is the first hourly bar; 10:00 starts the next.
  assert.deepEqual(hour.volume, [100, 50]);
  assert.equal(hour.time[1], new Date(newYorkToUtc(day, 600)).toISOString());
});

function scanInput() {
  const daily = pairedDaily(0.004);
  return {
    ticker: "AAPL",
    benchmark: "SPY",
    daily: daily.stock,
    benchmarkDaily: daily.benchmark,
    minutes: sessionMinutes("AAPL", sessions.slice(-19).concat(day)),
    benchmarkMinutes: sessionMinutes("SPY", [previous, day], 500),
  };
}

test("runs the technical-scan script on converted series and reads its output", async () => {
  let seen: string[] = [];
  const inputs: Record<string, { time: string[] }> = {};
  const run: ScriptRunner = async (args) => {
    seen = args;
    for (const name of ["daily", "hourly", "intraday", "bench-intraday"])
      inputs[name] = JSON.parse(
        readFileSync(args[args.indexOf(`--${name}`) + 1]!, "utf8"),
      );
    const out = args[args.indexOf("--outdir") + 1]!;
    await mkdir(out);
    writeFileSync(join(out, "summary.json"), '{"spot": 101}');
    writeFileSync(join(out, "06_trade_levels.png"), "PNG");
    return { code: 0, stderr: "" };
  };
  const scan = await runTechnicalScan(scanInput(), run);
  assert.deepEqual(scan.summary, { spot: 101 });
  assert.equal(scan.levelsChart?.toString(), "PNG");
  assert.deepEqual(seen.slice(0, 4), [
    "--ticker",
    "AAPL",
    "--benchmark",
    "SPY",
  ]);
  assert.equal(seen.includes("--options"), false);
  // Two sessions of 5-minute bars, a month of hourly bars (7 per session).
  assert.equal(inputs.intraday!.time.length, 2 * 78);
  assert.equal(inputs["bench-intraday"]!.time.length, 2 * 78);
  assert.equal(inputs.hourly!.time.length, 20 * 7);
  assert.equal(inputs.daily!.time.length, 125);
  // The temporary directory is removed afterward.
  const dir = seen[seen.indexOf("--outdir") + 1]!;
  assert.throws(() => readFileSync(join(dir, "summary.json")));
});

test("reports a failing script and refuses too little history", async () => {
  const failing: ScriptRunner = async () => ({
    code: 1,
    stderr: "Traceback\nValueError: bad input",
  });
  await assert.rejects(
    runTechnicalScan(scanInput(), failing),
    /exited 1: ValueError: bad input/,
  );
  const short = { ...scanInput(), daily: scanInput().daily.slice(-30) };
  await assert.rejects(runTechnicalScan(short, failing), /daily bars/);
});

// Opt-in: TECHNICAL_SCAN_PYTHON with matplotlib, numpy, pandas, mplfinance.
test(
  "the vendored technical-scan script accepts the converted series",
  { skip: !process.env.TECHNICAL_SCAN_PYTHON },
  async () => {
    const scan = await runTechnicalScan(
      scanInput(),
      pythonRunner(process.env.TECHNICAL_SCAN_PYTHON!),
    );
    assert.equal(scan.summary.options, null);
    assert.ok(
      Array.isArray(
        (scan.summary.trade_plan as { support_ladder: unknown }).support_ladder,
      ),
    );
    assert.ok(scan.levelsChart && scan.levelsChart.length > 1000);
  },
);

// --- Claude agent loop ---

type Reply = Partial<Anthropic.Beta.BetaMessage>;
function fakeClaude(replies: (Reply | Error)[]) {
  const calls: CreateParams[] = [];
  const create: CreateMessage = async (params) => {
    calls.push(structuredClone(params));
    const next = replies.shift();
    if (!next) throw new Error("no reply");
    if (next instanceof Error) throw next;
    return {
      model: analysisModel,
      content: [],
      ...next,
    } as Anthropic.Beta.BetaMessage;
  };
  return { create, calls };
}
const submit = (input: unknown): Reply => ({
  stop_reason: "tool_use",
  content: [
    {
      type: "tool_use",
      id: "t1",
      name: "submit_report",
      input,
    } as Anthropic.Beta.BetaToolUseBlock,
  ],
});
const agentAlert = {
  ticker: "AAPL",
  direction: "up" as const,
  move: 1,
  window: 3,
  close: 102,
  session: "regular",
  ratio: 5,
  paceRatio: null,
};
const view = {
  lean: "bullish",
  immediate: "Holding above VWAP.",
  followThrough: "A break of 224 opens 228.",
  drivers: ["beta regime shift", "zone at spot", "extra"],
  support: 219.3,
  resistance: null,
  caveat: null,
};

test("an agent resumes paused turns, nudges once, and returns the report", async () => {
  const claude = fakeClaude([
    {
      stop_reason: "pause_turn",
      content: [
        {
          type: "text",
          text: "searching",
          citations: null,
        } as Anthropic.Beta.BetaTextBlock,
      ],
    },
    {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "done",
          citations: null,
        } as Anthropic.Beta.BetaTextBlock,
      ],
    },
    submit(view),
  ]);
  const outcome = await runAgent(
    claude.create,
    technicalAgent(agentAlert, { spot: 101 }),
  );
  assert.deepEqual(outcome, {
    ok: true,
    model: analysisModel,
    value: { ...view, drivers: view.drivers.slice(0, 2) },
  });
  const [first, second, third] = claude.calls;
  assert.equal(first!.model, "claude-sonnet-5-5");
  assert.deepEqual(first!.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(first!.fallbacks, "default");
  assert.deepEqual(first!.tool_choice, { type: "auto" });
  assert.equal(first!.tools!.length, 1); // no web search for the technical agent
  assert.match(
    String(first!.messages[0]!.content),
    /<data source="technical-scan summary.json">/,
  );
  // pause_turn: the assistant content alone; end_turn: plus a nudge.
  assert.equal(second!.messages.length, 2);
  assert.equal(third!.messages.length, 4);
  assert.match(String(third!.messages[3]!.content), /submit_report/);
});

test("an agent reports refusals, invalid reports and API errors plainly", async () => {
  const refusal = await runAgent(
    fakeClaude([
      {
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: null,
        } as Anthropic.Beta.BetaRefusalStopDetails,
      },
    ]).create,
    technicalAgent(agentAlert, {}),
  );
  assert.deepEqual(refusal, { ok: false, error: "Declined (cyber)" });
  const invalid = await runAgent(
    fakeClaude([submit({ lean: "sideways" })]).create,
    technicalAgent(agentAlert, {}),
  );
  assert.deepEqual(invalid, { ok: false, error: "Invalid report" });
  const workspace = await runAgent(
    fakeClaude([
      new Anthropic.BadRequestError(
        400,
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "This API key is not scoped to a workspace",
          },
        },
        undefined,
        new Headers(),
      ),
    ]).create,
    technicalAgent(agentAlert, {}),
  );
  assert.deepEqual(workspace, {
    ok: false,
    error: "Claude API 400: This API key is not scoped to a workspace",
  });
  const failed = await runAgent(
    fakeClaude([new Error("socket hang up sk-ant-SECRET")]).create,
    technicalAgent(agentAlert, {}),
  );
  assert.deepEqual(failed, { ok: false, error: "Agent failed" });
});

test("the news agent keeps only listed item ids and https links", async () => {
  const news = [
    {
      id: 7,
      minutesBefore: 12,
      source: "benzinga",
      headline: "Guidance raised",
      summary: "",
    },
  ];
  const spec = catalystAgent(agentAlert, news);
  assert.match(
    spec.prompt,
    /\[id 7\] 12 min before the alert · benzinga · Guidance raised/,
  );
  const claude = fakeClaude([
    submit({
      explains: "yes",
      catalyst: "Guidance",
      newsId: 99,
      url: "javascript:alert(1)",
      summary: "Raised guidance.",
    }),
  ]);
  const outcome = await runAgent(claude.create, spec);
  assert.ok(outcome.ok);
  assert.equal(outcome.value.newsId, null);
  assert.equal(outcome.value.url, null);
  assert.equal(claude.calls[0]!.tools![0]!.type, "web_search_20260209");
});

// --- Alpaca news ---

test("reads Alpaca news with market-data headers and drops malformed items", async () => {
  let url = "";
  let headers: HeadersInit | undefined;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    url = String(input);
    headers = init?.headers;
    return new Response(
      JSON.stringify({
        news: [
          {
            id: 1,
            headline: "Up",
            summary: "",
            source: "benzinga",
            url: "https://x.test/1",
            created_at: "2026-09-28T14:20:00Z",
            symbols: ["AAPL"],
          },
          { id: "bad", headline: "no id", created_at: "2026-09-28T14:00:00Z" },
          { id: 2, headline: "no time" },
        ],
      }),
    );
  }) as typeof fetch;
  const items = await alpacaNews(
    { key: "K", secret: "S" },
    "AAPL",
    "2026-09-25T00:00:00Z",
    alertEnd,
    fetcher,
  );
  assert.deepEqual(
    items.map((n) => n.id),
    [1],
  );
  assert.match(
    url,
    /^https:\/\/data\.alpaca\.markets\/v1beta1\/news\?symbols=AAPL&/,
  );
  assert.deepEqual(headers, {
    "APCA-API-KEY-ID": "K",
    "APCA-API-SECRET-KEY": "S",
  });
  const failing = (async () =>
    new Response("", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    alpacaNews({ key: "K", secret: "S" }, "AAPL", "a", "b", failing),
    /Alpaca news request failed \(403\)/,
  );
});

// --- Queue, delivery and formatting ---

function raw(bars: PriceBar[]): RawBar[] {
  return bars.map((b) => ({
    start: Date.parse(b.end) / 1000 - 60,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

function deps(overrides: Partial<AnalysisDeps> = {}) {
  const daily = pairedDaily(0.02);
  const calls = { history: 0, news: 0 };
  const replies = [
    submit(view),
    submit({
      sentiment: "positive",
      confidence: "medium",
      summary: "Upbeat.",
      drivers: [],
      sources: [],
    }),
    submit({
      explains: "yes",
      catalyst: "Guidance <raised>",
      newsId: 7,
      url: null,
      summary: "s",
    }),
  ];
  const news: NewsItem[] = [
    {
      id: 7,
      headline: "Guidance",
      summary: "",
      source: "benzinga",
      url: "https://x.test/7",
      createdAt: new Date(Date.parse(alertEnd) - 12 * 60000).toISOString(),
      symbols: ["AAPL"],
    },
  ];
  const value: AnalysisDeps = {
    feed: {
      history: async () => {
        calls.history++;
        return raw(
          dayBars("SPY", 500, [
            [626, 499],
            [629, 497],
            [630, 520],
          ]),
        );
      },
      multiHistory: async (tickers) =>
        new Map(
          tickers.map((t) => [t, t === "AAPL" ? daily.stock : daily.benchmark]),
        ),
    },
    bars: () =>
      dayBars("AAPL", 100, [
        [626, 101],
        [629, 102],
      ]),
    sector: () => undefined,
    news: async () => {
      calls.news++;
      return news;
    },
    // Agents run concurrently; each reply matches whichever agent asks.
    claude: async (params) => {
      const system = String(params.system);
      const reply = system.includes("bottom line")
        ? replies[0]
        : system.includes("sentiment")
          ? replies[1]
          : replies[2];
      return {
        model: analysisModel,
        content: [],
        ...reply,
      } as Anthropic.Beta.BetaMessage;
    },
    script: async () => ({ code: 1, stderr: "no python here" }),
    ...overrides,
  };
  return { value, calls };
}

function queue(d: AnalysisDeps, deliver = async () => "sent" as const) {
  const dir = mkdtempSync(join(tmpdir(), "analysis-"));
  const path = join(dir, "test.sqlite");
  let now = Date.parse(alertEnd);
  const delivered: AnalysisResult[] = [];
  const open = () =>
    new AnalysisQueue(
      path,
      d,
      async (_alert, result) => {
        delivered.push(result);
        return deliver();
      },
      { startDelayMs: 0, baseDelayMs: 1000, now: () => now },
    );
  return {
    path,
    open,
    delivered,
    advance: (ms: number) => (now += ms),
    cleanup: () => rmSync(dir, { recursive: true }),
  };
}

test("analyzes each alert once and stores the outcome of every part", async () => {
  const d = deps();
  const t = queue(d.value);
  const q = t.open();
  assert.equal(q.enqueue(alert()), true);
  assert.equal(q.enqueue(alert()), false);
  await Promise.all([q.drain(), q.drain()]);
  assert.equal(t.delivered.length, 1);
  const [row] = q.recent();
  assert.equal(row!.status, "done");
  assert.equal(row!.delivery, "sent");
  const result = row!.result!;
  assert.deepEqual(
    result.scores.map((s) => [s.benchmark, s.relation]),
    [["SPY", "against"]],
  );
  // SPY's bar after the alert (520) is never used.
  assert.ok(Math.abs(result.scores[0]!.day!.benchmark + 0.6) < 1e-9);
  assert.deepEqual(result.technical, {
    ok: false,
    error: "Too few regular-session bars for a technical scan",
  });
  assert.equal(
    result.sentiment.ok && result.sentiment.value.sentiment,
    "positive",
  );
  assert.equal(result.news.ok && result.news.value.item?.id, 7);
  assert.equal(d.calls.news, 1); // one news request feeds both agents
  q.close();
  const again = t.open();
  assert.equal(again.enqueue(alert()), false);
  again.close();
  t.cleanup();
});

test("adds the sector benchmark and skips SPY for SPY itself", async () => {
  const d = deps({ sector: () => "XLK" });
  const t = queue(d.value);
  const q = t.open();
  q.enqueue(alert());
  q.enqueue(
    alert({
      ticker: "SPY",
      end: new Date(Date.parse(alertEnd) + 60000).toISOString(),
    }),
  );
  await q.drain();
  const rows = q.recent();
  assert.deepEqual(
    rows[1]!.result!.scores.map((s) => [s.benchmark, s.kind]),
    [
      ["SPY", "market"],
      ["XLK", "sector"],
    ],
  );
  // SPY is never scored against itself; its sector benchmark still is.
  assert.deepEqual(
    rows[0]!.result!.scores.map((s) => s.benchmark),
    ["XLK"],
  );
  q.close();
  t.cleanup();
});

test("retries market-data failures, then fails; stale requests expire", async () => {
  let fail = true;
  const d = deps();
  const history = d.value.feed.history;
  d.value.feed.history = async (...args) => {
    if (fail) throw new Error("Alpaca REST request failed (500)");
    return history(...args);
  };
  const t = queue(d.value);
  const q = t.open();
  q.enqueue(alert());
  await q.drain();
  assert.deepEqual(
    [q.recent()[0]!.status, q.recent()[0]!.error],
    ["pending", "Alpaca REST request failed (500)"],
  );
  t.advance(1000);
  await q.drain();
  t.advance(3000);
  await q.drain();
  assert.deepEqual(
    [q.recent()[0]!.status, q.recent()[0]!.attempts],
    ["failed", 3],
  );
  assert.equal(t.delivered.length, 0);
  // A manual re-run starts over and is fresh even for an old alert.
  fail = false;
  t.advance(60 * 60000);
  q.requeue(alert());
  await q.drain();
  assert.equal(q.recent()[0]!.status, "done");
  const late = alert({
    end: new Date(Date.parse(alertEnd) + 60000).toISOString(),
  });
  q.enqueue(late);
  t.advance(31 * 60000);
  await q.drain();
  assert.equal(q.recent()[0]!.status, "expired");
  q.close();
  t.cleanup();
});

test("a restart runs an interrupted analysis again", async () => {
  const t = queue(deps().value);
  const q = t.open();
  q.enqueue(alert());
  q.close();
  // A crash mid-run leaves the row running.
  const db = new DatabaseSync(t.path);
  db.exec("UPDATE analyses SET status='running', attempts=1");
  db.close();
  const reopened = t.open();
  assert.equal(reopened.recent()[0]!.status, "pending");
  await reopened.drain();
  assert.equal(reopened.recent()[0]!.status, "done");
  assert.equal(t.delivered.length, 1);
  reopened.close();
  t.cleanup();
});

test("ignores synthetic alerts on the bus", async () => {
  const d = deps();
  const t = queue(d.value);
  const q = t.open();
  const events = new AlertEvents();
  analyzeOnAlerts(events, q);
  events.publish(alert({ ticker: "TEST", synthetic: true }));
  events.publish(alert());
  await q.drain();
  assert.deepEqual(
    q.recent().map((r) => r.ticker),
    ["AAPL"],
  );
  q.close();
  t.cleanup();
});

async function sampleResult() {
  const d = deps();
  const t = queue(d.value);
  const q = t.open();
  q.enqueue(alert());
  await q.drain();
  const result = q.recent()[0]!.result!;
  q.close();
  t.cleanup();
  return result;
}

test("formats the follow-up in Israel time with escaped agent text", async () => {
  const text = formatAnalysis(alert(), await sampleResult());
  // 14:30 UTC in September is 17:30 in Israel.
  assert.match(text, /📊 <b>AAPL<\/b> ▲ analysis · alert 17:30 Israel time/);
  assert.match(text, /vs SPY: <b>AGAINST the index<\/b> · <b>\d+\/100<\/b>/);
  assert.match(text, /AAPL \+2\.00% vs SPY -0\.60% today/);
  assert.match(text, /stronger than SPY, confirms the alert/);
  assert.match(
    text,
    /Technical<\/b> · unavailable \(Too few regular-session bars/,
  );
  assert.match(text, /Guidance &lt;raised&gt;/);
  assert.match(
    text,
    /benzinga, 12 min before the alert · <a href="https:\/\/x\.test\/7">source<\/a>/,
  );
  assert.ok(text.length < 4096);
});

test("delivers under the alert's message, then the chart under the analysis", async () => {
  const result = await sampleResult();
  const sent: { kind: string; replyTo?: number }[] = [];
  const sender = {
    async send(
      _html: string,
      options?: { replyTo?: number },
    ): Promise<SendResult> {
      sent.push({ kind: "text", replyTo: options?.replyTo });
      return { ok: true, messageId: 50 };
    },
    async sendPhoto(
      _png: Buffer,
      _caption: string,
      options?: { replyTo?: number },
    ): Promise<SendResult> {
      sent.push({ kind: "photo", replyTo: options?.replyTo });
      return { ok: true, messageId: 51 };
    },
  };
  let muted = false;
  const deliver = telegramDelivery(sender, {
    muted: () => muted,
    messageId: () => 40,
  });
  assert.equal(await deliver(alert(), result, Buffer.from("PNG")), "sent");
  assert.deepEqual(sent, [
    { kind: "text", replyTo: 40 },
    { kind: "photo", replyTo: 50 },
  ]);
  muted = true;
  assert.equal(await deliver(alert(), result, null), "muted");
  assert.equal(sent.length, 2);
});
