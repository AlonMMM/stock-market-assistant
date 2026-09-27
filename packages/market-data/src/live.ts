import type { Evaluation } from "../../alerts/src/relative-volume.js";
import type { CollectorAccess } from "./watchlist.js";

export interface LiveAlert extends Evaluation {
  close?: number;
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
    const [health, alerts] = (await Promise.all([
      get("/health"),
      get("/alerts"),
    ])) as [
      {
        state?: string;
        feed?: string;
        failure?: string | null;
        symbols?: Record<string, { lastBar?: string | null }>;
      },
      { alerts?: LiveAlert[] },
    ];
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
      alerts: Array.isArray(alerts.alerts) ? alerts.alerts : [],
    };
  } catch (error) {
    return unavailable(
      error instanceof Error && error.message.startsWith("Collector")
        ? error.message
        : "Live collector is unreachable",
    );
  }
}
