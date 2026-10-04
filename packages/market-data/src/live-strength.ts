// The collector's area score vs SPY (docs/features/area-vs-spy.md): β per
// watchlist symbol prepared once per US session date from daily bars, a σ
// curve per symbol and date from the stored minute bars of the previous 20
// sessions (both stored in the collector's SQLite), and the stored minute
// bars of the stock and SPY for the session being scored.
import type { AlertEvent } from "../../alerts/src/events.js";
import type { StrengthNow, AlertVsSpy } from "../../contracts/src/vs-spy.js";
import { alertVsSpy } from "./alert-vs-spy.js";
import {
  areaSigmaSessions,
  byDate,
  fromPriceBar,
  sigmaCurve,
  type AreaBar,
  type SigmaCurve,
} from "./area-vs-spy.js";
import type { PriceBar } from "./bars.js";
import { benchmark } from "./beta.js";
import { newYork, previousSessions } from "./calendar.js";
import { strengths, type MultiHistory, type StrengthStore } from "./board.js";
import type { SpyStrength } from "./rs-score.js";
import type { DailyStore } from "./volume-baseline.js";

/** Longest wait for SPY's bar of the alert minute (spec: ≤ 3 s). */
export const spyWaitMs = 3000;

export interface LiveStrengthDeps {
  // Split-adjusted daily bars (several symbols per request).
  multi: MultiHistory;
  store: StrengthStore;
  // σ curves per symbol and date; absent → kept in memory only.
  sigmas?: DailyStore<SigmaCurve>;
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
  private curves = new Map<string, Map<string, SigmaCurve>>();
  private latest = new Map<string, PriceBar>();
  private spyEnd: string | null = null;
  private waiters = new Set<Waiter>();
  private waitMs: number;
  private now: () => number;
  constructor(private deps: LiveStrengthDeps) {
    this.waitMs = deps.waitMs ?? spyWaitMs;
    this.now = deps.now ?? Date.now;
  }

  /**
   * β for `tickers` on session `date`: stored values first, then one daily
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

  /**
   * σ curves for `tickers` (not SPY) on `date` from the stored minute bars of
   * the previous 20 sessions, with the date's β (symbols whose β is not
   * prepared yet are skipped and counted). Call once the warmup history is
   * stored: stored curves are reused for the rest of the day. Returns how
   * many have no curve.
   */
  async prepareSigma(date: string, tickers: string[]): Promise<number> {
    let known = this.curves.get(date);
    if (!known) {
      for (const d of this.curves.keys()) if (d < date) this.curves.delete(d);
      this.curves.set(date, (known = new Map()));
    }
    const wanted = tickers.filter((t) => t !== benchmark && !known.has(t));
    if (!wanted.length) return 0;
    try {
      for (const [t, c] of (await this.deps.sigmas?.get(date, wanted)) ?? [])
        known.set(t, c);
    } catch {
      // Recomputed below.
    }
    // Computed only with the date's β (a curve is kept for the whole day);
    // symbols whose β is not prepared yet are retried on a later run.
    const unprepared = wanted.filter(
      (t) => !known.has(t) && !this.strength(date, t),
    ).length;
    const missing = wanted.filter(
      (t) => !known.has(t) && this.strength(date, t),
    );
    if (!missing.length) return unprepared;
    const dates = previousSessions(date, areaSigmaSessions);
    const inRange = (bars: PriceBar[]) =>
      bars.filter((b) => b.date < date).map(fromPriceBar);
    const spy = byDate(inRange(this.deps.bars(benchmark, dates[0]!)));
    // Without SPY's history every curve would be empty: retry later.
    if (!spy.size) return missing.length + unprepared;
    const fresh = new Map<string, SigmaCurve>();
    for (const ticker of missing)
      fresh.set(
        ticker,
        sigmaCurve(
          inRange(this.deps.bars(ticker, dates[0]!)),
          spy,
          dates,
          this.strength(date, ticker)!.beta,
        ),
      );
    for (const [t, c] of fresh) known.set(t, c);
    await this.deps.sigmas?.put(date, fresh);
    return unprepared;
  }

  strength(date: string, ticker: string): SpyStrength | undefined {
    return this.values.get(date)?.get(ticker);
  }

  sigma(date: string, ticker: string): SigmaCurve | undefined {
    return this.curves.get(date)?.get(ticker);
  }

  /** Every live bar (watchlist symbols and SPY), after it is stored. */
  bar(bar: PriceBar) {
    const previous = this.latest.get(bar.ticker);
    if (!previous || bar.end >= previous.end) this.latest.set(bar.ticker, bar);
    if (bar.ticker !== benchmark) return;
    if (!this.spyEnd || bar.end > this.spyEnd) this.spyEnd = bar.end;
    for (const waiter of this.waiters)
      if (bar.end >= waiter.end) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
  }

  private waitForSpy(end: string): Promise<void> {
    if (this.spyEnd !== null && this.spyEnd >= end) return Promise.resolve();
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

  private session(ticker: string, date: string): AreaBar[] {
    return this.deps
      .bars(ticker, date)
      .filter((b) => b.date === date)
      .map(fromPriceBar);
  }

  private score(
    ticker: string,
    date: string,
    minute: number,
    spy: AreaBar[],
  ): AlertVsSpy {
    const strength = this.strength(date, ticker);
    return alertVsSpy({
      ticker,
      date,
      minute,
      stock: this.session(ticker, date),
      spy,
      beta: strength?.beta ?? 1,
      betaAssumed: strength?.betaAssumed ?? true,
      sigma: this.sigma(date, ticker) ?? null,
    });
  }

  /**
   * Area score ending at the alert bar. Waits at most `waitMs` for SPY's
   * bar of that minute, then carries SPY's last close (`spyLagged`). Never
   * throws: any failure yields a null score.
   */
  async atAlert(alert: {
    ticker: string;
    end: string;
    direction: "up" | "down" | null;
    close?: number;
  }): Promise<AlertVsSpy> {
    try {
      // The alert bar started one minute before its end.
      const { date, minute } = newYork(Date.parse(alert.end) - 60000);
      await this.waitForSpy(alert.end);
      return this.score(
        alert.ticker,
        date,
        minute,
        this.session(benchmark, date),
      );
    } catch {
      return {
        score: null,
        area: null,
        beta: 1,
        betaAssumed: true,
        spyLagged: true,
      };
    }
  }

  /**
   * Area score now per ticker, ending at its latest bar (SPY's later bars
   * are ignored). Tickers without a bar are left out.
   */
  current(tickers: string[]): Record<string, StrengthNow> {
    const result: Record<string, StrengthNow> = {};
    const spy = new Map<string, AreaBar[]>();
    for (const ticker of tickers) {
      try {
        const bar = this.latestBar(ticker);
        if (!bar) continue;
        let spyBars = spy.get(bar.date);
        if (!spyBars)
          spy.set(bar.date, (spyBars = this.session(benchmark, bar.date)));
        const value = this.score(ticker, bar.date, bar.minute - 1, spyBars);
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
