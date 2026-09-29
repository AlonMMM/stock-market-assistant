import type { Evaluation } from "../../alerts/src/relative-volume.js";
import type {
  AnalysisResult,
  AnalysisStatus,
} from "../../analysis/src/pipeline.js";
import type { CollectorAccess } from "./watchlist.js";

// The collector's analysis of one alert (score, technical scan, sentiment,
// news); absent when analysis is off or has not started.
export interface LiveAnalysis {
  status: AnalysisStatus;
  error: string | null;
  result: AnalysisResult | null;
}

export interface LiveAlert extends Evaluation {
  close?: number;
  analysis?: LiveAnalysis;
}

export interface LiveStatus {
  // "unavailable" when the collector cannot be reached or is not configured.
  state: string;
  feed: string | null;
  failure: string | null;
  symbols: number;
  receiving: number; // symbols that have delivered at least one live bar
  lastBarAt: string | null; // newest live bar across symbols (UTC ISO)
  alerts: LiveAlert[];
}

const unavailable = (failure: string): LiveStatus => ({
  state: "unavailable",
  feed: null,
  failure,
  symbols: 0,
  receiving: 0,
  lastBarAt: null,
  alerts: [],
});

/** Collector health and recent live alerts, for the site's Live view. */
export async function loadLive(
  collector: CollectorAccess,
  fetcher: typeof fetch = fetch,
): Promise<LiveStatus> {
  if (!collector.url || !collector.token)
    return unavailable("Live collector is not configured");
  const base = collector.url.replace(/\/+$/, "");
  const get = async (path: string) => {
    const response = await fetcher.call(globalThis, `${base}${path}`, {
      headers: { Authorization: `Bearer ${collector.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Collector HTTP ${response.status}`);
    return response.json();
  };
  try {
    // Analyses are optional: an older collector or analysis being off
    // leaves the alerts as they are.
    const analyses = get("/analyses").catch(() => null) as Promise<{
      analyses?: ({ ticker: string; end: string } & LiveAnalysis)[];
    } | null>;
    const [health, alerts, analyzed] = (await Promise.all([
      get("/health"),
      get("/alerts"),
      analyses,
    ])) as [
      {
        state?: string;
        feed?: string;
        failure?: string | null;
        symbols?: Record<string, { lastBar?: string | null }>;
      },
      { alerts?: LiveAlert[] },
      Awaited<typeof analyses>,
    ];
    const byAlert = new Map(
      (Array.isArray(analyzed?.analyses) ? analyzed.analyses : []).map((a) => [
        a.ticker + a.end,
        { status: a.status, error: a.error, result: a.result },
      ]),
    );
    const symbols = Object.values(health.symbols ?? {});
    const bars = symbols
      .map((s) => s.lastBar)
      .filter((t): t is string => typeof t === "string")
      .sort();
    return {
      state: typeof health.state === "string" ? health.state : "unknown",
      feed: typeof health.feed === "string" ? health.feed : null,
      failure: typeof health.failure === "string" ? health.failure : null,
      symbols: symbols.length,
      receiving: bars.length,
      lastBarAt: bars.at(-1) ?? null,
      alerts: (Array.isArray(alerts.alerts) ? alerts.alerts : []).map((a) => {
        const analysis = byAlert.get(a.ticker + a.end);
        return analysis ? { ...a, analysis } : a;
      }),
    };
  } catch (error) {
    return unavailable(
      error instanceof Error && error.message.startsWith("Collector")
        ? error.message
        : "Live collector is unreachable",
    );
  }
}

/** One technical-scan chart of an analysis, proxied from the collector. */
export async function loadAnalysisChart(
  collector: CollectorAccess,
  query: { ticker?: unknown; end?: unknown; name?: unknown },
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; png?: ArrayBuffer; error?: string }> {
  const { ticker, end, name } = query;
  if (
    typeof ticker !== "string" ||
    typeof end !== "string" ||
    typeof name !== "string" ||
    !/^[A-Z][A-Z0-9. -]{0,9}$/.test(ticker) ||
    !Number.isFinite(Date.parse(end)) ||
    !/^0\d_[a-z_]+\.png$/.test(name)
  )
    return { status: 400, error: "Expected ticker, end and chart name" };
  if (!collector.url || !collector.token)
    return { status: 503, error: "Live collector is not configured" };
  const url = new URL(
    "/analyses/chart",
    collector.url.replace(/\/+$/, "") + "/",
  );
  url.search = new URLSearchParams({ ticker, end, name }).toString();
  try {
    const response = await fetcher.call(globalThis, url, {
      headers: { Authorization: `Bearer ${collector.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return { status: 404, error: "No such chart" };
    if (!response.ok)
      return { status: 502, error: `Collector HTTP ${response.status}` };
    return { status: 200, png: await response.arrayBuffer() };
  } catch {
    return { status: 502, error: "Live collector is unreachable" };
  }
}
