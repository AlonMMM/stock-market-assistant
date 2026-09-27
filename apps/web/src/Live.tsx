import { useEffect, useState, type ReactNode } from "react";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import { AlertFeed } from "./AlertFeed.js";
import { readJson } from "./api.js";
import { israelClock, israelDateTime, israelLabel } from "./time.js";

const refreshMs = 30000;

const stateText: Record<string, string> = {
  subscribed: "Connected · waiting for bars",
  "warming-up": "Warming up history…",
  starting: "Starting…",
  "awaiting-watchlist": "Waiting for the first IBKR watchlist sync",
  "awaiting-alpaca-activation": "Alpaca streaming is switched off",
  disconnected: "Disconnected",
  unavailable: "Collector unreachable",
};

export function Live({ modes }: { modes: ReactNode }) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await readJson<LiveStatus>(
          await fetch("/api/live", { signal: AbortSignal.timeout(15000) }),
        );
        if (!active) return;
        setLive(next);
        setError("");
        setCheckedAt(Date.now());
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Live failed");
      }
    };
    void load();
    const timer = setInterval(load, refreshMs);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  // A bar older than 3 minutes while connected usually means the market is
  // closed (or the feed stalled); the bar time is shown so either is visible.
  const receiving =
    live?.state === "subscribed" &&
    live.lastBarAt !== null &&
    Date.now() - Date.parse(live.lastBarAt) < 3 * 60000;
  const status = !live
    ? "Connecting…"
    : receiving
      ? "Live · receiving 1-minute bars"
      : (stateText[live.state] ?? live.state);

  return (
    <>
      <header>
        <span className="brand">
          SMA<span className="brand-dot">.</span>
        </span>
        <span className="badge">
          ALPACA {live?.feed?.toUpperCase() ?? ""} LIVE
        </span>
      </header>
      <h1>Relative volume</h1>
      <p className="lede">Alerts as they happen, from the live collector.</p>
      {modes}
      <section className="live-status" aria-live="polite">
        <p className="live-state">
          <span
            className={
              receiving
                ? "live-dot on"
                : live?.state === "subscribed"
                  ? "live-dot idle"
                  : "live-dot off"
            }
            aria-hidden="true"
          />
          <strong>{status}</strong>
        </p>
        {live && live.state !== "unavailable" && (
          <p className="live-meta">
            {live.symbols} symbols ·{" "}
            {live.lastBarAt
              ? `last bar ${israelDateTime(Date.parse(live.lastBarAt))}`
              : "no live bars yet"}
            {checkedAt && ` · checked ${israelClock(checkedAt)} ${israelLabel}`}
          </p>
        )}
        {live?.failure && <p className="notice error">{live.failure}</p>}
        {error && <p className="notice error">{error}</p>}
      </section>
      {live && live.alerts.length === 0 && (
        <p className="notice">
          No live alerts yet. US pre-market opens 11:00 {israelLabel}, the
          regular session 16:30.
        </p>
      )}
      {live && live.alerts.length > 0 && <AlertFeed alerts={live.alerts} />}
      <footer>
        Alpaca {live?.feed === "iex" ? "IEX (one exchange's volume)" : "live"}{" "}
        data · refreshes every 30 s · charts use 15-minute-delayed SIP data.
      </footer>
    </>
  );
}
