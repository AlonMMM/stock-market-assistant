// The collector's score vs SPY (docs/features/alert-vs-spy.md): β/σ per
// watchlist symbol prepared once per US session date from daily bars (stored
// in the collector's SQLite), the latest live bar per symbol, and SPY's recent
// bars from the same stream.
import type { AlertEvent } from "../../alerts/src/events.js";
import type { StrengthNow, AlertVsSpy } from "../../contracts/src/vs-spy.js";
import { alertVsSpy, regularClose, spyBarFor } from "./alert-vs-spy.js";
import type { PriceBar } from "./bars.js";
import { benchmark } from "./beta.js";
import { newYork, previousSessions } from "./calendar.js";
import { strengths, type MultiHistory, type StrengthStore } from "./board.js";
import type { SpyStrength } from "./rs-score.js";

/** Longest wait for SPY's bar of the alert minute (spec: ≤ 3 s). */
export const spyWaitMs = 3000;
// SPY bars kept in memory; older ones are read from the store when needed.
const keptSpyBars = 120;

export interface LiveStrengthDeps {
  // Split-adjusted daily bars (several symbols per request).
  multi: MultiHistory;
  store: StrengthStore;
  // The collector's stored one-minute bars for a ticker, from a date.
  bars: (ticker: string, from: string) => PriceBar[];
  waitMs?: number;
  now?: () => number;
}

interface Waiter {
  end: string;
  resolve: () => void;
}

export class LiveStrength {
  private values = new Map<string, Map<string, SpyStrength>>();
  private latest = new Map<string, PriceBar>();
  private spy: PriceBar[] = [];
  private waiters = new Set<Waiter>();
  private closes = new Map<string, number>();
  private waitMs: number;
  private now: () => number;
  constructor(private deps: LiveStrengthDeps) {
    this.waitMs = deps.waitMs ?? spyWaitMs;
    this.now = deps.now ?? Date.now;
  }

  /**
   * β/σ for `tickers` on session `date`: stored values first, then one daily
   * request for the missing ones. Returns how many are still missing (a
   * failure leaves them missing, to retry later).
   */
  async prepare(date: string, tickers: string[]): Promise<number> {
    let known = this.values.get(date);
    const missing = tickers.filter((t) => !known?.has(t));
    if (!missing.length) return 0;
    const found = await strengths(
      missing,
      date,
      this.deps.multi,
      this.deps.store,
    );
    if (!known) {
      // A new session date: earlier dates are no longer scored.
      for (const d of this.values.keys()) if (d < date) this.values.delete(d);
      this.values.set(date, (known = new Map()));
    }
    for (const [t, value] of found) known.set(t, value);
    return missing.filter((t) => !found.has(t)).length;
  }

  strength(date: string, ticker: string): SpyStrength | undefined {
    return this.values.get(date)?.get(ticker);
  }

  /** Every live bar (watchlist symbols and SPY), before alert evaluation. */
  bar(bar: PriceBar) {
    const previous = this.latest.get(bar.ticker);
    if (!previous || bar.end >= previous.end) this.latest.set(bar.ticker, bar);
    if (bar.ticker !== benchmark) return;
    this.spy = this.spy.filter((b) => b.end !== bar.end);
    this.spy.push(bar);
    this.spy.sort((a, b) => a.end.localeCompare(b.end));
    if (this.spy.length > keptSpyBars)
      this.spy.splice(0, this.spy.length - keptSpyBars);
    for (const waiter of this.waiters)
      if (bar.end >= waiter.end) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
  }

  // SPY's newest bar ending at or after `end`, if one has arrived.
  private spyReached(end: string) {
    const last = this.spy.at(-1);
    return last !== undefined && last.end >= end;
  }

  private waitForSpy(end: string): Promise<void> {
    if (this.spyReached(end)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter: Waiter = {
        end,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, this.waitMs);
      this.waiters.add(waiter);
    });
  }

  private previousClose(ticker: string, date: string): number | null {
    const previous = previousSessions(date, 1)[0]!;
    const key = `${ticker}|${previous}`;
    const known = this.closes.get(key);
    if (known !== undefined) return known;
    const close = regularClose(this.deps.bars(ticker, previous), previous);
    if (close !== null) {
      if (this.closes.size > 2000) this.closes.clear();
      this.closes.set(key, close);
    }
    return close;
  }

  private spyBar(date: string, end: string) {
    const memory = spyBarFor(this.spy, date, end);
    if (memory.bar) return memory;
    return spyBarFor(this.deps.bars(benchmark, date), date, end);
  }

  private score(
    ticker: string,
    direction: "up" | "down" | null,
    date: string,
    end: string,
    close: number | undefined,
  ): AlertVsSpy {
    const spy = this.spyBar(date, end);
    return alertVsSpy({
      direction,
      close,
      previousClose: this.previousClose(ticker, date),
      spyClose: spy.bar?.close,
      spyPreviousClose: this.previousClose(benchmark, date),
      strength: this.strength(date, ticker) ?? null,
      spyLagged: spy.lagged,
    });
  }

  /**
   * Score at alert time with SPY's close of the alert minute. Waits at most
   * `waitMs` for that SPY bar, then uses SPY's newest earlier bar of the day
   * (`spyLagged`). Never throws: any failure yields a null score.
   */
  async atAlert(alert: {
    ticker: string;
    end: string;
    direction: "up" | "down" | null;
    close?: number;
  }): Promise<AlertVsSpy> {
    const failed = (): AlertVsSpy => ({
      score: null,
      beta: 1,
      betaAssumed: true,
      label: "none",
      spyLagged: true,
    });
    try {
      // The alert bar started one minute before its end.
      const date = newYork(Date.parse(alert.end) - 60000).date;
      await this.waitForSpy(alert.end);
      return this.score(
        alert.ticker,
        alert.direction,
        date,
        alert.end,
        alert.close,
      );
    } catch {
      return failed();
    }
  }

  /**
   * Score now per ticker: its latest bar and SPY's latest bar of the same
   * session date. Tickers without a bar are left out.
   */
  current(tickers: string[]): Record<string, StrengthNow> {
    const result: Record<string, StrengthNow> = {};
    for (const ticker of tickers) {
      try {
        const bar = this.latestBar(ticker);
        if (!bar) continue;
        const spy = this.latestBar(benchmark);
        const value = this.score(
          ticker,
          null,
          bar.date,
          spy && spy.date === bar.date && spy.end > bar.end ? spy.end : bar.end,
          bar.close,
        );
        result[ticker] = { score: value.score, at: bar.end };
      } catch {
        // Calendar or store failure: no entry for this ticker.
      }
    }
    return result;
  }

  private latestBar(ticker: string): PriceBar | undefined {
    const known = this.latest.get(ticker);
    if (known) return known;
    const from = previousSessions(newYork(this.now()).date, 1)[0]!;
    return this.deps.bars(ticker, from).at(-1);
  }
}

/**
 * Attaches the score vs SPY (≤ `waitMs` for SPY's bar), then stores and
 * publishes the alert, so the stored record and every consumer (Telegram
 * included) carry `vsSpy`. A repeated (ticker, end) is not published again.
 */
export async function raiseScored<T extends AlertEvent>(
  alert: T,
  strength: Pick<LiveStrength, "atAlert">,
  store: { alert(alert: T & { vsSpy: AlertVsSpy }): boolean },
  events: { publish(alert: T & { vsSpy: AlertVsSpy }): void },
): Promise<void> {
  const scored = { ...alert, vsSpy: await strength.atAlert(alert) };
  if (store.alert(scored)) events.publish(scored);
}

/** Israel calendar date of a UTC instant (the site's "today"). */
const israel = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const israelDate = (time: number) => israel.format(time);

/** Distinct tickers with an alert on the Israel date of `now`. */
export function alertedToday(
  alerts: { ticker: string; end: string }[],
  now: number,
): string[] {
  const today = israelDate(now);
  return [
    ...new Set(
      alerts
        .filter((a) => israelDate(Date.parse(a.end)) === today)
        .map((a) => a.ticker),
    ),
  ];
}
