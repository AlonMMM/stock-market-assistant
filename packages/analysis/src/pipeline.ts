import { DatabaseSync } from "node:sqlite";
import type { AlertEvent, AlertEvents } from "../../alerts/src/events.js";
import type { AlpacaFeed } from "../../market-data/src/alpaca.js";
import { normalize, type PriceBar } from "../../market-data/src/bars.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "../../market-data/src/calendar.js";
import { benchmark as market } from "../../market-data/src/beta.js";
import {
  catalystAgent,
  runAgent,
  sentimentAgent,
  technicalAgent,
  type AgentAlert,
  type AgentOutcome,
  type CatalystView,
  type CreateMessage,
  type PromptNews,
  type SentimentView,
  type TechnicalView,
} from "./agents.js";
import type { NewsItem } from "./news.js";
import { scoreAgainst, type BenchmarkScore } from "./relative-strength.js";
import {
  runTechnicalScan,
  type Chart,
  type ScriptRunner,
  type TechnicalScan,
} from "./technical.js";

// Daily history for the technical scan (≈ IBKR SIX_MONTHS) and the score.
const dailySessions = 125;

export interface AnalysisResult {
  // SPY first, then the sector benchmark when the watchlist names one.
  scores: BenchmarkScore[];
  technical: AgentOutcome<TechnicalView>;
  // technical-scan summary.json; null when the scan failed.
  technicalSummary: Record<string, unknown> | null;
  // Chart files stored with the analysis (GET /analyses/chart). Absent in
  // analyses stored before charts were kept.
  charts?: string[];
  sentiment: AgentOutcome<SentimentView>;
  news: AgentOutcome<CatalystView & { item: NewsItem | null }>;
  completedAt: string;
}

export interface MarketData {
  date: string;
  previous: string;
  sessions: string[];
  minutes: PriceBar[];
  benchmarks: {
    symbol: string;
    kind: "market" | "sector";
    minutes: PriceBar[];
    daily: Awaited<ReturnType<AlpacaFeed["history"]>>;
  }[];
  daily: Awaited<ReturnType<AlpacaFeed["history"]>>;
}

export interface AnalysisDeps {
  // Alpaca REST client for benchmark minutes and daily bars (no stream).
  feed: Pick<AlpacaFeed, "history" | "multiHistory">;
  // The collector's stored one-minute bars for a ticker, from a date.
  bars: (ticker: string, from: string) => PriceBar[];
  // Sector benchmark per symbol from the synced watchlist.
  sector: (ticker: string) => string | undefined;
  news: (symbol: string, start: string, end: string) => Promise<NewsItem[]>;
  claude: CreateMessage | null;
  script: ScriptRunner;
}

export async function loadMarketData(
  alert: AlertEvent,
  deps: AnalysisDeps,
): Promise<MarketData> {
  const end = Date.parse(alert.end);
  const date = newYork(end - 60000).date;
  const sessions = previousSessions(date, dailySessions);
  const previous = sessions.at(-1)!;
  const sector = deps.sector(alert.ticker);
  const symbols = [
    ...(alert.ticker === market
      ? []
      : [{ symbol: market, kind: "market" as const }]),
    ...(sector && sector !== market && sector !== alert.ticker
      ? [{ symbol: sector, kind: "sector" as const }]
      : []),
  ];
  const upTo = (bars: PriceBar[]) =>
    bars.filter((bar) => Date.parse(bar.end) <= end);
  const [daily, minutes] = await Promise.all([
    // Ends at the alert day's midnight UTC, before its daily bar.
    deps.feed.multiHistory(
      [alert.ticker, ...symbols.map((s) => s.symbol)],
      `${sessions[0]}T00:00:00Z`,
      `${date}T00:00:00Z`,
      "1Day",
      "split",
    ),
    Promise.all(
      symbols.map(async ({ symbol }) =>
        upTo(
          (await deps.feed.history(symbol, `${previous}T00:00:00Z`, alert.end))
            .map((row) => normalize(symbol, row, "shares"))
            .filter((bar): bar is PriceBar => bar !== null),
        ),
      ),
    ),
  ]);
  return {
    date,
    previous,
    sessions,
    minutes: upTo(deps.bars(alert.ticker, sessions.at(-20)!)),
    daily: daily.get(alert.ticker) ?? [],
    benchmarks: symbols.map((s, i) => ({
      ...s,
      minutes: minutes[i]!,
      daily: daily.get(s.symbol) ?? [],
    })),
  };
}

const unavailable = (error: string) => ({ ok: false as const, error });

function promptNews(items: NewsItem[], end: number): PromptNews[] {
  return items.map((n) => ({
    id: n.id,
    minutesBefore: Math.floor((end - Date.parse(n.createdAt)) / 60000),
    source: n.source,
    headline: n.headline,
    summary: n.summary,
  }));
}

/** Score, technical scan and the three agents for one alert. */
export async function analyze(
  alert: AlertEvent,
  data: MarketData,
  deps: AnalysisDeps,
): Promise<{ result: AnalysisResult; charts: Chart[] }> {
  const end = Date.parse(alert.end);
  const scores = data.benchmarks.map((b) =>
    scoreAgainst({
      alert,
      stockBars: data.minutes,
      benchmark: b.symbol,
      kind: b.kind,
      benchmarkBars: b.minutes,
      stockDaily: data.daily,
      benchmarkDaily: b.daily,
      sessions: data.sessions,
      previous: data.previous,
    }),
  );
  const agentAlert: AgentAlert = {
    ticker: alert.ticker,
    direction: alert.direction,
    move: alert.move,
    window: alert.config.window,
    close: alert.close,
    session: alert.session,
    ratio: alert.ratio,
    paceRatio: alert.paceRatio,
  };
  const previousClose = newYorkToUtc(
    data.previous,
    coreClose(data.previous) ?? 960,
  );
  const news = deps
    .news(alert.ticker, new Date(end - 3 * 86400000).toISOString(), alert.end)
    .catch(() => null);
  // The sector benchmark fits better when the watchlist names one.
  const scanBenchmark = data.benchmarks.at(-1);
  const scan: Promise<TechnicalScan | string> = scanBenchmark
    ? runTechnicalScan(
        {
          ticker: alert.ticker,
          benchmark: scanBenchmark.symbol,
          daily: data.daily,
          benchmarkDaily: scanBenchmark.daily,
          minutes: data.minutes,
          benchmarkMinutes: scanBenchmark.minutes,
        },
        deps.script,
      ).catch((error: unknown) =>
        error instanceof Error ? error.message : "Technical scan failed",
      )
    : Promise.resolve("No benchmark for a technical scan");
  const claude = deps.claude;
  const [technical, sentiment, catalyst] = await Promise.all([
    scan.then(async (s) => ({
      scan: s,
      outcome:
        typeof s === "string"
          ? unavailable(s)
          : claude
            ? await runAgent(claude, technicalAgent(agentAlert, s.summary))
            : unavailable("Claude is not configured"),
    })),
    news.then(async (items) =>
      !claude
        ? unavailable("Claude is not configured")
        : items === null
          ? unavailable("News unavailable")
          : runAgent(
              claude,
              sentimentAgent(agentAlert, promptNews(items, end)),
            ),
    ),
    news.then(async (items) => {
      if (!claude) return unavailable("Claude is not configured");
      if (items === null) return unavailable("News unavailable");
      const recent = items.filter(
        (n) => Date.parse(n.createdAt) >= previousClose,
      );
      const outcome = await runAgent(
        claude,
        catalystAgent(agentAlert, promptNews(recent, end)),
      );
      return outcome.ok
        ? {
            ...outcome,
            value: {
              ...outcome.value,
              item: recent.find((n) => n.id === outcome.value.newsId) ?? null,
            },
          }
        : outcome;
    }),
  ]);
  return {
    result: {
      scores,
      technical: technical.outcome,
      technicalSummary:
        typeof technical.scan === "string" ? null : technical.scan.summary,
      charts:
        typeof technical.scan === "string"
          ? []
          : technical.scan.charts.map((c) => c.name),
      sentiment,
      news: catalyst,
      completedAt: new Date().toISOString(),
    },
    charts: typeof technical.scan === "string" ? [] : technical.scan.charts,
  };
}

// pending → running → done | failed | expired. `done` may hold failed agents;
// each agent's outcome says so.
export type AnalysisStatus =
  "pending" | "running" | "done" | "failed" | "expired";

export type DeliveryStatus = "sent" | "partial" | "failed" | "muted" | "off";

export interface AnalysisRow {
  ticker: string;
  end: string;
  status: AnalysisStatus;
  attempts: number;
  error: string | null;
  delivery: DeliveryStatus | null;
  result: AnalysisResult | null;
}

export type Deliver = (
  alert: AlertEvent,
  result: AnalysisResult,
  charts: Chart[],
) => Promise<DeliveryStatus>;

export interface QueueOptions {
  // An analysis requested longer ago than this is no longer useful.
  maxAgeMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  // Wait after the alert so the benchmark's same-minute bar is published.
  startDelayMs?: number;
  concurrency?: number;
  now?: () => number;
}

// Durable analysis queue in the collector's SQLite file, keyed like `alerts`.
export class AnalysisQueue {
  private db: DatabaseSync;
  private active = 0;
  private idle: (() => void)[] = [];
  private maxAgeMs: number;
  private maxAttempts: number;
  private baseDelayMs: number;
  private startDelayMs: number;
  private concurrency: number;
  private now: () => number;
  constructor(
    path: string,
    private deps: AnalysisDeps,
    private deliver: Deliver,
    options: QueueOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? 30 * 60000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 15000;
    this.startDelayMs = options.startDelayMs ?? 5000;
    this.concurrency = options.concurrency ?? 2;
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(path);
    // A row left running by a restart runs again; its alert is still fresh
    // or it expires on the next claim.
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS analyses (ticker TEXT, end TEXT, payload TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        requested_at INTEGER NOT NULL, error TEXT, delivery TEXT, result TEXT,
        PRIMARY KEY(ticker,end));
      CREATE TABLE IF NOT EXISTS analysis_charts (ticker TEXT, end TEXT, name TEXT, png BLOB NOT NULL,
        PRIMARY KEY(ticker,end,name));
      UPDATE analyses SET status='pending' WHERE status='running';`);
  }
  // Queues an alert unless it was queued before.
  enqueue(alert: AlertEvent): boolean {
    const now = this.now();
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO analyses (ticker, end, payload, status, next_at, requested_at) VALUES (?,?,?,'pending',?,?)",
        )
        .run(
          alert.ticker,
          alert.end,
          JSON.stringify(alert),
          now + this.startDelayMs,
          now,
        ).changes > 0
    );
  }
  // Runs a stored alert again from scratch (manual re-analysis).
  requeue(alert: AlertEvent) {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO analyses (ticker, end, payload, status, next_at, requested_at) VALUES (?,?,?,'pending',?,?)
         ON CONFLICT(ticker,end) DO UPDATE SET status='pending', attempts=0, next_at=excluded.next_at,
         requested_at=excluded.requested_at, error=NULL, delivery=NULL, result=NULL`,
      )
      .run(alert.ticker, alert.end, JSON.stringify(alert), now, now);
  }
  chart(ticker: string, end: string, name: string): Buffer | null {
    const row = this.db
      .prepare(
        "SELECT png FROM analysis_charts WHERE ticker=? AND end=? AND name=?",
      )
      .get(ticker, end, name);
    return row?.png instanceof Uint8Array ? Buffer.from(row.png) : null;
  }
  // Removes analyses (and their charts) of alerts before `before` (ISO).
  prune(before: string) {
    this.db.prepare("DELETE FROM analysis_charts WHERE end<?").run(before);
    this.db.prepare("DELETE FROM analyses WHERE end<?").run(before);
  }
  recent(limit = 50): AnalysisRow[] {
    return this.db
      .prepare(
        "SELECT ticker, end, status, attempts, error, delivery, result FROM analyses ORDER BY end DESC LIMIT ?",
      )
      .all(limit)
      .map((r) => ({
        ticker: String(r.ticker),
        end: String(r.end),
        status: r.status as AnalysisStatus,
        attempts: Number(r.attempts),
        error: r.error === null ? null : String(r.error),
        delivery: r.delivery === null ? null : (r.delivery as DeliveryStatus),
        result:
          r.result === null
            ? null
            : (JSON.parse(String(r.result)) as AnalysisResult),
      }));
  }
  // Starts workers up to the concurrency limit; resolves when all are idle.
  drain(): Promise<void> {
    while (this.active < this.concurrency && this.claim()) {}
    return this.active === 0
      ? Promise.resolve()
      : new Promise((resolve) => this.idle.push(resolve));
  }
  private claim(): boolean {
    const row = this.db
      .prepare(
        "SELECT ticker, end, payload, attempts, requested_at FROM analyses WHERE status='pending' AND next_at<=? ORDER BY end LIMIT 1",
      )
      .get(this.now());
    if (!row) return false;
    const ticker = String(row.ticker);
    const end = String(row.end);
    const alert = JSON.parse(String(row.payload)) as AlertEvent;
    const fresh = Math.max(Date.parse(alert.end), Number(row.requested_at));
    if (this.now() - fresh > this.maxAgeMs) {
      this.set(ticker, end, "expired", Number(row.attempts), "Too old");
      return true;
    }
    const attempts = Number(row.attempts) + 1;
    this.set(ticker, end, "running", attempts, null);
    this.active++;
    void this.run(alert, attempts).finally(() => {
      this.active--;
      while (this.active < this.concurrency && this.claim()) {}
      if (this.active === 0) for (const done of this.idle.splice(0)) done();
    });
    return true;
  }
  private set(
    ticker: string,
    end: string,
    status: AnalysisStatus,
    attempts: number,
    error: string | null,
    nextAt = 0,
  ) {
    this.db
      .prepare(
        "UPDATE analyses SET status=?, attempts=?, error=?, next_at=? WHERE ticker=? AND end=?",
      )
      .run(status, attempts, error, nextAt, ticker, end);
  }
  private async run(alert: AlertEvent, attempts: number) {
    const { ticker, end } = alert;
    let data: MarketData;
    try {
      data = await loadMarketData(alert, this.deps);
    } catch (error) {
      const message =
        error instanceof Error && error.message.startsWith("Alpaca")
          ? error.message
          : "Market data unavailable";
      const final = attempts >= this.maxAttempts;
      this.set(
        ticker,
        end,
        final ? "failed" : "pending",
        attempts,
        message,
        this.now() + this.baseDelayMs * 3 ** (attempts - 1),
      );
      console.error(
        JSON.stringify({
          event: "analysis-failed",
          ticker,
          end,
          attempts,
          final,
          error: message,
        }),
      );
      return;
    }
    let analysis: Awaited<ReturnType<typeof analyze>>;
    try {
      analysis = await analyze(alert, data, this.deps);
    } catch (error) {
      this.set(ticker, end, "failed", attempts, "Analysis failed");
      console.error(
        JSON.stringify({
          event: "analysis-failed",
          ticker,
          end,
          attempts,
          final: true,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    const { result, charts } = analysis;
    this.db
      .prepare(
        "UPDATE analyses SET status='done', error=NULL, result=? WHERE ticker=? AND end=?",
      )
      .run(JSON.stringify(result), ticker, end);
    this.db
      .prepare("DELETE FROM analysis_charts WHERE ticker=? AND end=?")
      .run(ticker, end);
    const insert = this.db.prepare(
      "INSERT INTO analysis_charts VALUES (?,?,?,?)",
    );
    for (const chart of charts) insert.run(ticker, end, chart.name, chart.png);
    let delivery: DeliveryStatus = "failed";
    try {
      delivery = await this.deliver(alert, result, charts);
    } catch {
      // Reported as failed below.
    }
    this.db
      .prepare("UPDATE analyses SET delivery=? WHERE ticker=? AND end=?")
      .run(delivery, ticker, end);
    console.log(
      JSON.stringify({
        event: "analysis-done",
        ticker,
        end,
        delivery,
        failedAgents: (["technical", "sentiment", "news"] as const).filter(
          (k) => !result[k].ok,
        ),
      }),
    );
  }
  close() {
    this.db.close();
  }
}

// Queues every published market alert; synthetic alerts are ignored.
export function analyzeOnAlerts(events: AlertEvents, queue: AnalysisQueue) {
  return events.subscribe("analysis", (alert) => {
    if (!alert.synthetic && queue.enqueue(alert)) return queue.drain();
  });
}
