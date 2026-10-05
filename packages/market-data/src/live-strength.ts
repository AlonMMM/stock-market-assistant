// The collector's marked-sections score vs SPY
// (docs/features/marks-vs-spy.md): β per watchlist symbol prepared once per
// US session date from daily bars, a σ curve per symbol and date from the
// stored minute bars of the previous 20 sessions (both stored in the
// collector's SQLite), and the stored minute bars of the stock and SPY for
// the session being scored (and the previous one, for the previous close).
import type { AlertEvent } from "../../alerts/src/events.js";
import { defaults } from "../../alerts/src/relative-volume.js";
import type { StrengthNow, AlertVsSpy } from "../../contracts/src/vs-spy.js";
import { alertVsSpy } from "./alert-vs-spy.js";
import type { PriceBar } from "./bars.js";
import { benchmark } from "./beta.js";
import { newYork, previousSessions } from "./calendar.js";
import { strengths, type MultiHistory, type StrengthStore } from "./board.js";
import {
  byDate,
  dayMarks,
  daySeries,
  fromPriceBar,
  marksAt,
  marksSigmaSessions,
  type MarkBar,
  type MarksSigma,
} from "./marks-vs-spy.js";
import { sigmaFromBars } from "./marks-sigma.js";
import type { SpyStrength } from "./rs-score.js";
import type { DailyStore } from "./volume-baseline.js";

/** Longest wait for SPY's bar of the scored minute (spec: ≤ 3 s). */
export const spyWaitMs = 3000;

export interface LiveStrengthDeps {
  // Split-adjusted daily bars (several symbols per request).
  multi: MultiHistory;
  store: StrengthStore;
  // σ curves per symbol and date; absent → kept in memory only.
  sigmas?: DailyStore<MarksSigma>;
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
  private curves = new Map<string, Map<string, MarksSigma>>();
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
    const dates = previousSessions(date, marksSigmaSessions);
    const inRange = (bars: PriceBar[]) =>
      bars.filter((b) => b.date < date).map(fromPriceBar);
    const spy = byDate(inRange(this.deps.bars(benchmark, dates[0]!)));
    // Without SPY's history every curve would be empty: retry later.
    if (!spy.size) return missing.length + unprepared;
    const fresh = new Map<string, MarksSigma>();
    for (const ticker of missing)
      fresh.set(
        ticker,
        sigmaFromBars(
          ticker,
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

  sigma(date: string, ticker: string): MarksSigma | undefined {
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

  /** The stored bars of `date` and of the previous session (its close). */
  private session(ticker: string, date: string): MarkBar[] {
    const previous = previousSessions(date, 1)[0]!;
    return this.deps
      .bars(ticker, previous)
      .filter((b) => b.date <= date)
      .map(fromPriceBar);
  }

  /**
   * Score at the alert's end minute E (the last minute before its own
   * `config.window` minutes). Waits at most `waitMs` for SPY's bar of E
   * (normally long arrived), then carries SPY's last close (`spyLagged`).
   * Never throws: any failure yields a null score.
   */
  async atAlert(alert: {
    ticker: string;
    end: string;
    direction: "up" | "down" | null;
    close?: number;
    config?: { window: number };
  }): Promise<AlertVsSpy> {
    try {
      const window = alert.config?.window ?? defaults.window;
      // The alert bar started one minute before its end.
      const { date, minute } = newYork(Date.parse(alert.end) - 60000);
      await this.waitForSpy(
        new Date(Date.parse(alert.end) - window * 60000).toISOString(),
      );
      const strength = this.strength(date, alert.ticker);
      return alertVsSpy({
        ticker: alert.ticker,
        date,
        minute,
        window,
        stock: this.session(alert.ticker, date),
        spy: this.session(benchmark, date),
        beta: strength?.beta ?? 1,
        betaAssumed: strength?.betaAssumed ?? true,
        sigma: this.sigma(date, alert.ticker) ?? null,
      });
    } catch {
      return {
        score: null,
        sum: null,
        beta: 1,
        betaAssumed: true,
        spyLagged: true,
      };
    }
  }

  /**
   * Score now per ticker, with E = its latest bar, or its last regular bar
   * of that date once the latest is after-hours (the day's closing score);
   * null while the latest is pre-market (Product + UX, 2026-10-05). SPY's
   * later bars are ignored. `at` is the end of the bar behind E. Tickers
   * without a bar are left out.
   */
  current(tickers: string[]): Record<string, StrengthNow> {
    const result: Record<string, StrengthNow> = {};
    const spy = new Map<string, Map<string, MarkBar[]>>();
    for (const ticker of tickers) {
      try {
        const bar = this.latestBar(ticker);
        if (!bar) continue;
        let spyDays = spy.get(bar.date);
        if (!spyDays)
          spy.set(
            bar.date,
            (spyDays = byDate(this.session(benchmark, bar.date))),
          );
        const strength = this.strength(bar.date, ticker);
        const stockDays = byDate(this.session(ticker, bar.date));
        const marks = dayMarks(
          daySeries(ticker, stockDays, bar.date),
          daySeries(benchmark, spyDays, bar.date),
          bar.date,
        );
        // After the close: the last regular bar of that date.
        const lastRegular =
          bar.session === "post"
            ? stockDays.get(bar.date)?.findLast((b) => b.session === "regular")
            : undefined;
        const end = lastRegular
          ? newYork(lastRegular.start * 1000).minute
          : bar.minute - 1;
        const value = marksAt(
          ticker,
          marks,
          end,
          strength?.beta ?? 1,
          this.sigma(bar.date, ticker),
        );
        result[ticker] = {
          score: value.score,
          at: lastRegular
            ? new Date((lastRegular.start + 60) * 1000).toISOString()
            : bar.end,
        };
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
