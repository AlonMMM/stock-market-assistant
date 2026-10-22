import { randomUUID } from "node:crypto";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import {
  nextAction,
  type ExitReason,
  type ExitRules,
} from "../../../packages/trading/src/bot/exits.js";
import {
  premarketBlocks,
  premarketRatio,
  reactionReport,
  reportDates,
  type EarningsReport,
  type NewsCalendar,
} from "../../../packages/trading/src/bot/news.js";
import {
  expiryWindow,
  pickContract,
} from "../../../packages/trading/src/bot/picker.js";
import {
  defaultSettings,
  drawdown,
  exitRules,
  pickRules,
  signalParams,
  watchedStocks,
  withDefaults,
  type BotSettings,
} from "../../../packages/trading/src/bot/settings.js";
import {
  cSignal,
  cState,
  priorFrom,
  type MinuteBar,
  type Prior,
} from "../../../packages/trading/src/bot/signal.js";
import {
  contractWords,
  type OptionQuote,
} from "../../../packages/trading/src/options.js";
import type { BotEventKind, BotPosition, BotStore } from "./bot-store.js";

// The Indi bot (docs/tasks/backend-indi-bot.md): the backtested C signal on
// the stocks Indi traded in the past year, a 0.15-delta contract 1–7 days out,
// 2% of the account, "your stop" and the overnight hold. It trades through the
// owner's TraderService like any other caller, so every order, stop, post and
// short check is the service's own; it only ever sells contracts it bought.

export interface BotMarket {
  /** Regular-session 1-minute bars of `date` from `from` through `to` (session minutes), by symbol. */
  bars(
    symbols: string[],
    date: string,
    from: number,
    to: number,
  ): Promise<Map<string, MinuteBar[]>>;
  /** Bars of several whole sessions, by symbol and date. */
  sessions(
    symbols: string[],
    dates: string[],
  ): Promise<Map<string, Map<string, MinuteBar[]>>>;
  /**
   * Pre-market volume (04:00–09:30 New York, SIP 5-minute bars) by symbol and
   * date; a date without bars is left out. Optional: without it there is no
   * pre-market filter.
   */
  premarket?(
    symbols: string[],
    dates: string[],
  ): Promise<Map<string, Map<string, number>>>;
  /** Contracts traded in the 30 minutes up to `minute`. */
  optionVolume30(
    contract: string,
    date: string,
    minute: number,
  ): Promise<number>;
}

/** What the bot needs from the owner's trading service and broker. */
export interface BotTrading {
  chain(
    underlying: string,
    right: "call" | "put",
    from: string,
    to: string,
  ): Promise<OptionQuote[]>;
  quote(contract: string): Promise<OptionQuote>;
  held(
    contract: string,
  ): Promise<{ qty: number; avgEntryPrice: number } | null>;
  equity(): Promise<number>;
  buy(body: Record<string, unknown>): Promise<{
    status: string;
    jobId?: string;
    qty?: number;
    refused?: string[];
  }>;
  sell(
    body: Record<string, unknown>,
  ): Promise<{ status: string; jobId?: string }>;
  job(id: string): { state: string; result: unknown };
}

export interface BotOptions {
  store: BotStore;
  market: BotMarket;
  trading: BotTrading;
  notify: (title: string, lines: string[]) => Promise<unknown>;
  universe: string[];
  /** The earnings calendar's reports listed on a date (Nasdaq). Without it there is no earnings filter. */
  earnings?: (date: string) => Promise<EarningsReport[]>;
  // The defaults until the owner saves settings (docs/tasks/backend-bot-settings.md).
  mode: "dry" | "live";
  enabled: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export const botTag = "🤖 Bot";

/** Why the bot sold, in words, with the settings' numbers. */
function reasonText(reason: ExitReason, s: BotSettings): string {
  const words: Record<ExitReason, string> = {
    "check-10": "10-min check: the stock is against the entry",
    "check-20": "20-min check: the stock is still against the entry",
    "stop-30": `Down ${s.stopPct}% with the stock against the entry`,
    "close-1550": "Sold at 15:50",
    carry: `Held overnight (up ${s.holdFromPct}% or more)`,
    "morning-gap-keep": "Morning: gapped our way, sold half",
    "morning-gap-against": "Morning: no gap our way, sold all",
    "expiry-day": "Expiry day, out by 15:30",
  };
  return words[reason] ?? reason;
}

/** A signal's outcome in words (the app's Bot tab has the same list). */
function outcomeText(outcome: string, s: BotSettings): string {
  const words: Record<string, string> = {
    bought: "buying",
    "would-buy": "would buy (dry run)",
    no_expiry: `skipped, no expiry 1–${s.maxDte} days out`,
    no_strikes: "skipped, no strikes",
    no_prices: "skipped, no prices",
    too_cheap: `skipped, contract under $${s.minPrice.toFixed(2)}`,
    too_small: `skipped, ${s.sizePct}% buys less than one contract`,
    thin: "skipped, too few contracts traded",
    held: "skipped, you hold this contract",
    refused: "refused by the risk rules",
    earnings: "skipped, earnings reaction day",
    premarket: "skipped, pre-market volume 4× normal or more",
    max_buys: "skipped, the most bot buys for today",
    max_open: "skipped, the most open positions",
    day_loss: "skipped, the daily loss limit",
    error: "failed",
  };
  return words[outcome] ?? outcome;
}

// How a news source stands today: not configured, read, or failed (no filter).
type NewsState = "off" | "pending" | "ok" | "failed";

const reportTimeText: Record<string, string> = {
  "time-pre-market": "before the open",
  "time-after-hours": "after the close",
};

function nextSession(date: string): string {
  let d = date;
  do
    d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
  while (coreClose(d) === null);
  return d;
}

const newsCalendar: NewsCalendar = {
  isSession: (date) => coreClose(date) !== null,
  nextSession,
};

const expiryOf = (contract: string) => {
  const m = /(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(contract);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : "";
};

export class IndiBot {
  private readonly o: Required<Omit<BotOptions, "now" | "log" | "earnings">> & {
    earnings?: BotOptions["earnings"];
    now: () => number;
    log: (line: string) => void;
  };
  private day: string | null = null;
  private prior = new Map<string, Prior>();
  private priorClose = new Map<string, number>();
  private today = new Map<string, Map<number, MinuteBar>>();
  private done = -1; // the last session minute processed today
  private summarized: string | null = null;
  private busy = false;
  // Today's stocks: the configured list and the user's favorites list.
  private symbols: string[] = [];
  // Where each stock stands at the last minute, for the live scan.
  private scan = new Map<
    string,
    { side: "C" | "P"; t: number; rvol: number; minute: number }
  >();
  private lastWork: number | null = null;
  // The news filter's data for today (docs/tasks/backend-indi-bot.md).
  private priorDays: string[] = [];
  private openClose = new Map<string, Map<string, { o: number; c: number }>>();
  private reports: EarningsReport[] | null = null; // null: no calendar today
  private earningsState: NewsState = "off";
  private preRatio = new Map<string, number | null>();
  private preState: NewsState = "off";
  // The account at warm-up, for the daily loss limit; null until read.
  private dayStartEquity: number | null = null;

  constructor(options: BotOptions) {
    this.o = {
      now: Date.now,
      log: () => {},
      ...options,
    };
  }

  get enabled(): boolean {
    const saved = this.o.store.setting("enabled");
    return saved === undefined ? this.o.enabled : saved === "true";
  }

  setEnabled(on: boolean) {
    this.o.store.setSetting("enabled", String(on));
    // Switched back on, the drawdown pause counts from here.
    if (on) this.o.store.setSetting("countFrom", String(this.o.now()));
    this.event("info", `Switched ${on ? "on" : "off"}`);
  }

  /** The owner's settings over the defaults; on/off and the mode as set. */
  settings(): BotSettings {
    const base = { ...defaultSettings, mode: this.o.mode };
    const saved = this.o.store.setting("settings");
    let s = base;
    if (saved) s = withDefaults(JSON.parse(saved), base);
    return { ...s, enabled: this.enabled };
  }

  /** Saves the owner's settings; stocks count from the next warm-up. */
  setSettings(next: BotSettings): BotSettings {
    const before = this.settings();
    const { enabled, ...rest } = next;
    this.o.store.setSetting("settings", JSON.stringify(rest));
    const changed = settingsChanges(before, next);
    if (changed.length)
      this.event("info", `Settings changed: ${changed.join("; ")}`);
    if (enabled !== before.enabled) this.setEnabled(enabled);
    return this.settings();
  }

  /** The user's favorites list, sent by the site before each session. */
  setWatchlist(name: string, tickers: string[]) {
    const clean = [
      ...new Set(
        tickers
          .map((t) => t.toUpperCase())
          .filter((t) => /^[A-Z.]{1,6}$/.test(t) && t !== "SPY"),
      ),
    ];
    const before = this.o.store.setting("watchlist");
    const value = JSON.stringify({ name, tickers: clean, at: this.o.now() });
    this.o.store.setSetting("watchlist", value);
    const was = before ? (JSON.parse(before) as { tickers: string[] }) : null;
    if (!was || was.tickers.join() !== clean.join())
      this.event(
        "info",
        `Favorites list "${name}" received: ${clean.length} stocks (${clean.join(", ")})`,
      );
    return clean;
  }

  private watchlist(): { name: string; tickers: string[]; at: number } | null {
    const saved = this.o.store.setting("watchlist");
    return saved ? JSON.parse(saved) : null;
  }

  /** The configured stocks, the owner's and the favorites list, less those turned off. */
  private universe(): string[] {
    return watchedStocks(
      this.settings(),
      this.o.universe,
      this.watchlist()?.tickers ?? [],
    );
  }

  /** A contract in words for the activity feed, e.g. "Put 75 · 2DTE" (days from today). */
  private words(contract: string): string {
    return contractWords(contract, newYork(this.o.now()).date);
  }

  private event(kind: BotEventKind, text: string) {
    this.o.store.addEvent(this.o.now(), kind, text);
    this.o.log(`bot: ${text}`);
  }

  /** A signal's outcome, also written to the activity feed. */
  private outcome(
    date: string,
    symbol: string,
    outcome: string,
    detail: string,
  ) {
    this.o.store.updateSignal(date, symbol, outcome, detail);
    const s = this.o.store.signal(date, symbol);
    const what = outcomeText(outcome, this.settings());
    const kind: BotEventKind =
      outcome === "bought" || outcome === "would-buy" ? "order" : "skip";
    this.event(
      kind,
      `${symbol} ${s?.right === "P" ? "put" : "call"}: ${what}${detail ? ` (${detail})` : ""}`,
    );
  }

  /** Called every few seconds; does each closed minute's work once. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.work();
    } catch (error) {
      this.event(
        "error",
        `Tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
  }

  private async work() {
    const now = this.o.now();
    const { date, minute: wall } = newYork(now);
    const close = coreClose(date);
    if (close === null) return;
    const closeMinute = close - 570; // session minutes in today's session
    if (wall < 565 || wall > close + 15) return;
    this.lastWork = now;
    if (this.day !== date) await this.warmUp(date);
    // Pre-market volume is final at 09:30; read once, before the first entry at 09:40.
    if (this.preState === "pending" && wall >= 570)
      await this.loadPremarket(date);
    // A minute's bar is complete once the next minute has started.
    const last = Math.min(wall - 570 - 1, closeMinute - 1);
    await this.settle();
    await this.watchDrawdown();
    if (last > this.done && last >= 0) {
      await this.refresh(date, Math.max(0, this.done - 2), last);
      for (let m = Math.max(this.done + 1, last - 2); m <= last; m++) {
        if (this.enabled) await this.entries(date, m, closeMinute);
        await this.exits(date, m, closeMinute);
      }
      this.done = last;
    }
    if (wall >= close + 5 && this.summarized !== date) {
      this.summarized = date;
      await this.summary(date);
    }
  }

  private async warmUp(date: string) {
    this.symbols = this.universe();
    const symbols = [...this.symbols, "SPY"];
    const days = previousSessions(date, 20);
    const bars = await this.o.market.sessions(symbols, days);
    const spy = bars.get("SPY") ?? new Map<string, MinuteBar[]>();
    this.prior.clear();
    this.priorClose.clear();
    this.openClose.clear();
    this.priorDays = days;
    for (const s of symbols) {
      const byDay = bars.get(s) ?? new Map<string, MinuteBar[]>();
      const oc = new Map<string, { o: number; c: number }>();
      for (const [d, list] of byDay)
        if (list.length) oc.set(d, { o: list[0]!.o, c: list.at(-1)!.c });
      this.openClose.set(s, oc);
      this.prior.set(
        s,
        priorFrom(
          days.map((d) => ({
            stock: byDay.get(d) ?? [],
            spy: spy.get(d) ?? [],
          })),
        ),
      );
      const lastDay = byDay.get(days.at(-1)!);
      if (lastDay?.length) this.priorClose.set(s, lastDay.at(-1)!.c);
    }
    this.today.clear();
    this.scan.clear();
    this.done = -1;
    this.day = date;
    const fav = this.watchlist();
    const s = this.settings();
    const core = this.symbols.filter((t) => this.o.universe.includes(t));
    const own = this.symbols.filter(
      (t) => s.added.includes(t) && !core.includes(t),
    );
    const extra = this.symbols.length - core.length - own.length;
    let parts = `${core.length} from Indi's list`;
    if (fav && extra > 0) parts += `, ${extra} more from "${fav.name}"`;
    if (own.length) parts += `, ${own.length} added by you`;
    this.event(
      "info",
      `Ready for ${date}: watching ${this.symbols.length} stocks (${parts})`,
    );
    this.dayStartEquity = await this.o.trading.equity().catch(() => null);
    this.preRatio.clear();
    this.preState = this.o.market.premarket ? "pending" : "off";
    await this.loadEarnings(date);
  }

  // ---- the news filter: earnings reaction day, pre-market volume ----

  /** Reports listed from the previous session through today, for today's stocks. Fails open. */
  private async loadEarnings(date: string) {
    this.reports = null;
    if (!this.o.earnings) {
      this.earningsState = "off";
      return;
    }
    const dates = reportDates(date, previousSessions(date, 1)[0]!);
    try {
      const rows: EarningsReport[] = [];
      for (const d of dates) rows.push(...(await this.o.earnings(d)));
      const watched = new Set(this.symbols);
      this.reports = rows.filter((r) => watched.has(r.symbol));
      this.earningsState = "ok";
      const names = [...new Set(this.reports.map((r) => r.symbol))];
      this.event(
        "info",
        `Earnings calendar ${dates[0]} to ${date}: ${names.length ? `reports for ${names.join(", ")}` : "no reports for these stocks"}`,
      );
    } catch (error) {
      this.earningsState = "failed";
      const why = error instanceof Error ? error.message : String(error);
      this.event(
        "error",
        `Earnings calendar failed (${why}): trading today without the earnings filter`,
      );
    }
  }

  /** Today's pre-market volume vs the prior 20 sessions'. Fails open. */
  private async loadPremarket(date: string) {
    try {
      const got = await this.o.market.premarket!(this.symbols, [
        ...this.priorDays,
        date,
      ]);
      const high: string[] = [];
      for (const s of this.symbols) {
        const byDay = got.get(s);
        const ratio = premarketRatio(
          byDay?.get(date),
          this.priorDays.map((d) => byDay?.get(d)),
        );
        this.preRatio.set(s, ratio);
        if (premarketBlocks(ratio)) high.push(`${s} ${ratio!.toFixed(1)}×`);
      }
      this.preState = "ok";
      this.event(
        "info",
        `Pre-market volume read: ${high.length ? `4× normal or more, no entry today: ${high.join(", ")}` : "no stock at 4× normal"}`,
      );
    } catch (error) {
      this.preState = "failed";
      const why = error instanceof Error ? error.message : String(error);
      this.event(
        "error",
        `Pre-market volume failed (${why}): trading today without the pre-market filter`,
      );
    }
  }

  /** A session's absolute open gap vs the session before (a fraction), or null. */
  private gap(symbol: string, date: string, today: string): number | null {
    if (date === today) {
      const open = this.barsOf(symbol)[0]?.o;
      const before = this.priorClose.get(symbol);
      if (open === undefined || before === undefined) return null;
      return Math.abs(open / before - 1);
    }
    const oc = this.openClose.get(symbol);
    const day = oc?.get(date);
    const before = oc?.get(previousSessions(date, 1)[0]!);
    if (!day || !before) return null;
    return Math.abs(day.o / before.c - 1);
  }

  /** Why the news filter keeps the bot out of a stock today, or null. */
  private newsBlock(
    date: string,
    symbol: string,
  ): { outcome: "earnings" | "premarket"; detail: string } | null {
    const s = this.settings();
    if (this.reports && s.skipEarnings) {
      const report = reactionReport(
        this.reports.filter((r) => r.symbol === symbol),
        date,
        newsCalendar,
        (d) => this.gap(symbol, d, date),
      );
      if (report) {
        const when = reportTimeText[report.time] ?? "time not given";
        return {
          outcome: "earnings",
          detail: `report listed ${report.date}, ${when}`,
        };
      }
    }
    const ratio = this.preRatio.get(symbol) ?? null;
    if (s.skipPremarket && premarketBlocks(ratio))
      return {
        outcome: "premarket",
        detail: `pre-market volume ${ratio!.toFixed(1)}× normal`,
      };
    return null;
  }

  private async refresh(date: string, from: number, to: number) {
    const symbols = [...this.symbols, "SPY"];
    const got = await this.o.market.bars(symbols, date, from, to);
    for (const [s, list] of got) {
      let byMinute = this.today.get(s);
      if (!byMinute) this.today.set(s, (byMinute = new Map()));
      for (const b of list) byMinute.set(b.m, b);
    }
  }

  private barsOf(symbol: string): MinuteBar[] {
    return [...(this.today.get(symbol)?.values() ?? [])].sort(
      (a, b) => a.m - b.m,
    );
  }

  private lastClose(symbol: string, m: number): number | null {
    const list = this.barsOf(symbol).filter((b) => b.m <= m);
    return list.at(-1)?.c ?? null;
  }

  // ---- entries ----

  private async entries(date: string, m: number, closeMinute: number) {
    const params = signalParams(this.settings());
    if (m < params.firstMinute || m > Math.min(374, closeMinute - 16)) return;
    const spy = this.barsOf("SPY");
    for (const symbol of this.symbols) {
      const prior = this.prior.get(symbol);
      if (!prior) continue;
      const now = cState(this.barsOf(symbol), spy, prior, m);
      if (now)
        this.scan.set(symbol, {
          side: now.t < 0 ? "P" : "C",
          t: Math.abs(now.t),
          rvol: now.rvol,
          minute: m,
        });
      if (this.o.store.signal(date, symbol)) continue;
      const sig = cSignal(this.barsOf(symbol), spy, prior, m, params);
      // Only a signal of this minute (or one missed by a slow minute) trades.
      if (!sig || sig.minute < m - 2) continue;
      const added = this.o.store.addSignal({
        day: date,
        symbol,
        right: sig.right,
        minute: sig.minute,
        t: sig.t,
        rvol: sig.rvol,
        outcome: "new",
        detail: "",
        at: this.o.now(),
      });
      if (added)
        this.event(
          "signal",
          `${symbol} ${sig.right === "C" ? "call" : "put"} signal at ${clock(sig.minute)}: strength t ${sig.t.toFixed(1)}, volume ${sig.rvol.toFixed(1)}× normal`,
        );
      if (added)
        await this.enter(
          date,
          symbol,
          sig.right,
          sig.minute,
          sig.t,
          sig.rvol,
        ).catch((error) => {
          const why = error instanceof Error ? error.message : String(error);
          this.outcome(date, symbol, "error", why);
        });
    }
  }

  private async enter(
    date: string,
    symbol: string,
    right: "C" | "P",
    minute: number,
    t: number,
    rvol: number,
  ) {
    // The news filter: no new entry on an earnings reaction day or a busy pre-market.
    const blocked = this.newsBlock(date, symbol);
    if (blocked)
      return this.outcome(date, symbol, blocked.outcome, blocked.detail);
    const s = this.settings();
    const limited = await this.limit(date, s);
    if (limited)
      return this.outcome(date, symbol, limited.outcome, limited.detail);
    const pick = pickRules(s);
    const spot = this.lastClose(symbol, minute);
    if (spot === null)
      return this.outcome(date, symbol, "no_prices", "no stock price");
    const side = right === "C" ? "call" : "put";
    const [from, to] = expiryWindow(date, pick);
    const picked = pickContract(
      await this.o.trading.chain(symbol, side, from, to),
      spot,
      side,
      date,
      pick,
    );
    if (!picked.ok) return this.outcome(date, symbol, picked.reason, "");
    const contract = picked.quote.symbol;
    const volume = await this.o.market.optionVolume30(contract, date, minute);
    if (volume < pick.minVolume30)
      return this.outcome(
        date,
        symbol,
        "thin",
        `${this.words(contract)}: ${volume} contracts in 30 minutes`,
      );
    // A contract the account already holds is the user's; the bot leaves it alone.
    if (await this.o.trading.held(contract))
      return this.outcome(
        date,
        symbol,
        "held",
        `${this.words(contract)} is already in the account`,
      );
    const why = `Signal ${side} at ${clock(minute)}: strength t ${t.toFixed(1)}, volume ${rvol.toFixed(1)}× normal`;
    const base: BotPosition = {
      id: randomUUID(),
      day: date,
      symbol,
      contract,
      right,
      qty: 0,
      bought: 0,
      cost: picked.mid,
      entryMinute: minute,
      entryStock: spot,
      nights: 0,
      checksDone: [],
      morningDone: false,
      decidedOn: null,
      status: "buying",
      jobId: null,
      dry: s.mode === "dry",
      sales: [],
      openedAt: this.o.now(),
      closedAt: null,
    };
    if (s.mode === "dry") {
      const equity = await this.o.trading.equity();
      const qty = Math.floor((equity * s.sizePct) / 100 / (picked.mid * 100));
      if (qty < 1)
        return this.outcome(
          date,
          symbol,
          "too_small",
          `${this.words(contract)} at ${picked.mid.toFixed(2)}`,
        );
      this.o.store.savePosition({ ...base, qty, bought: qty, status: "open" });
      this.outcome(
        date,
        symbol,
        "would-buy",
        `${qty} ${this.words(contract)} at ${picked.mid.toFixed(2)}`,
      );
      await this.o.notify(`${botTag} (dry run): would buy`, [
        `$${symbol} ${contractLabel(contract)}`,
        `${qty} contracts at ${picked.mid.toFixed(2)}`,
        why,
      ]);
      return;
    }
    const answer = await this.o.trading.buy({
      contract,
      sizePct: s.sizePct,
      stopPct: s.safetyStopPct,
      tag: botTag,
      note: why,
    });
    if (answer.status !== "started" || !answer.jobId)
      return this.outcome(
        date,
        symbol,
        "refused",
        (answer.refused ?? []).join("; "),
      );
    this.o.store.savePosition({ ...base, jobId: answer.jobId });
    this.outcome(
      date,
      symbol,
      "bought",
      `${answer.qty ?? "?"} ${this.words(contract)}`,
    );
  }

  // ---- the owner's limits on new buys ----

  /** Why a new buy waits: today's buys, open positions or the day's loss; null when none. */
  private async limit(
    date: string,
    s: BotSettings,
  ): Promise<{ outcome: string; detail: string } | null> {
    const dry = s.mode === "dry";
    const entered = this.o.store
      .signals(date)
      .filter((x) => x.outcome === "bought" || x.outcome === "would-buy");
    if (entered.length >= s.maxBuysPerDay)
      return { outcome: "max_buys", detail: `${entered.length} today` };
    const open = this.o.store
      .openPositions()
      .filter((p) => p.dry === dry && p.status !== "closed");
    if (open.length >= s.maxOpen)
      return { outcome: "max_open", detail: `${open.length} open` };
    if (this.dayStartEquity === null)
      this.dayStartEquity = await this.o.trading.equity().catch(() => null);
    const start = this.dayStartEquity;
    if (start && start > 0) {
      const equity = await this.o.trading.equity();
      const down = ((start - equity) / start) * 100;
      if (down >= s.dayLossPct)
        return {
          outcome: "day_loss",
          detail: `the account is down ${down.toFixed(1)}% today`,
        };
    }
    return null;
  }

  /**
   * Turns the bot off when its trades since it was last switched on are down
   * `drawdownPausePct` of the account from their best. The owner switches it
   * back on. Sales without a price (before prices were kept) do not count.
   */
  private async watchDrawdown() {
    if (!this.enabled) return;
    const s = this.settings();
    const dry = s.mode === "dry";
    const from = Number(this.o.store.setting("countFrom") ?? 0);
    const sales = this.o.store
      .recentPositions("0000-00-00")
      .filter((p) => p.dry === dry)
      .flatMap((p) =>
        p.sales
          .filter((x) => x.at >= from && typeof x.price === "number")
          .map((x) => ({ at: x.at, pnl: (x.price! - p.cost) * x.qty * 100 })),
      )
      .sort((a, b) => a.at - b.at);
    const down = drawdown(sales.map((x) => x.pnl));
    if (down <= 0) return;
    const equity = await this.o.trading.equity().catch(() => null);
    if (!equity || equity <= 0) return;
    const pct = (down / equity) * 100;
    if (pct < s.drawdownPausePct) return;
    this.setEnabled(false);
    const text = `Paused: the bot's trades are down $${down.toFixed(0)} (${pct.toFixed(1)}% of the account) from their best, past the ${s.drawdownPausePct}% limit. Turn it back on in Bot settings.`;
    this.event("error", text);
    await this.o.notify(`${botTag}: paused`, [text]);
  }

  // ---- buys and sales that are still working ----

  private async settle() {
    for (const p of this.o.store.openPositions()) {
      if (p.dry) continue;
      if (p.status === "buying" && p.jobId) {
        const job = this.o.trading.job(p.jobId);
        if (job.state === "running") continue;
        const held = await this.o.trading.held(p.contract);
        if (!held || held.qty <= 0) {
          this.o.store.savePosition({
            ...p,
            status: "closed",
            closedAt: this.o.now(),
          });
          this.event(
            "skip",
            `${p.symbol} ${this.words(p.contract)}: the buy did not fill`,
          );
          continue;
        }
        this.o.store.savePosition({
          ...p,
          status: "open",
          qty: held.qty,
          bought: held.qty,
          cost: held.avgEntryPrice,
          jobId: null,
        });
        this.event(
          "order",
          `Bought ${held.qty} ${p.symbol} ${this.words(p.contract)} at ${held.avgEntryPrice.toFixed(2)}`,
        );
        continue;
      }
      const pending = p.sales.find((s) => s.jobId !== null && !s.settled);
      if (pending && pending.jobId) {
        const job = this.o.trading.job(pending.jobId);
        if (job.state === "running") continue;
        const sold = soldOf(job.result);
        const price = priceOf(job.result);
        const held = await this.o.trading.held(p.contract);
        const qty = Math.max(0, Math.min(p.qty - sold, held?.qty ?? 0));
        const sales = p.sales.map((s) =>
          s === pending
            ? { ...s, qty: sold, settled: true, ...(price ? { price } : {}) }
            : s,
        );
        this.event(
          "order",
          `Sold ${sold} ${p.symbol} ${this.words(p.contract)} (${reasonText(pending.reason as ExitReason, this.settings())}); ${qty} left`,
        );
        this.o.store.savePosition({
          ...p,
          qty,
          sales,
          ...(qty === 0
            ? { status: "closed" as const, closedAt: this.o.now() }
            : {}),
        });
        continue;
      }
      // A stop or the user may have sold some: the bot never counts more than the account holds.
      if (p.status === "open") {
        const held = await this.o.trading.held(p.contract);
        const qty = Math.min(p.qty, held?.qty ?? 0);
        if (qty < p.qty)
          this.event(
            "info",
            `${p.symbol} ${this.words(p.contract)}: the account holds ${qty}, so the bot counts ${qty} (was ${p.qty}): a stop or a sale by hand`,
          );
        if (qty < p.qty)
          this.o.store.savePosition({
            ...p,
            qty,
            ...(qty === 0
              ? { status: "closed" as const, closedAt: this.o.now() }
              : {}),
          });
      }
    }
  }

  // ---- exits ----

  private async exits(date: string, m: number, closeMinute: number) {
    const s = this.settings();
    const base = exitRules(s);
    const rules: ExitRules = {
      ...base,
      eodMinute: Math.min(base.eodMinute, closeMinute - 10),
      expiryLastMinute: Math.min(base.expiryLastMinute, closeMinute - 30),
    };
    for (const p of this.o.store.openPositions()) {
      if (p.status !== "open" || p.qty <= 0) continue;
      if (p.sales.some((s) => s.jobId !== null && !s.settled)) continue;
      const expiry = expiryOf(p.contract);
      const quote = await this.o.trading.quote(p.contract).catch(() => null);
      const mid =
        quote && quote.bid > 0 && quote.ask > 0
          ? (quote.bid + quote.ask) / 2
          : null;
      const first = this.barsOf(p.symbol)[0];
      const state = { ...p, nights: p.day === date ? 0 : p.nights };
      const decision = nextAction(
        state,
        {
          minute: m,
          stock: this.lastClose(p.symbol, m),
          option: mid,
          isExpiryDay: expiry === date,
          sessionBeforeExpiry: nextSession(date) <= expiry,
          open: first && first.m <= 5 ? first.o : null,
          prevClose: this.priorClose.get(p.symbol) ?? null,
        },
        rules,
        p.decidedOn === date,
      );
      const decided =
        decision.reason === "carry" || decision.reason === "close-1550";
      const next: BotPosition = {
        ...p,
        ...decision.update,
        ...(decided ? { decidedOn: date } : {}),
      };
      if (decision.reason === "carry") {
        this.o.store.savePosition(next);
        this.event(
          "order",
          `Holding ${p.qty} ${p.symbol} ${this.words(p.contract)} overnight (up ${s.holdFromPct}% or more)`,
        );
        await this.o.notify(`${botTag}: held overnight`, [
          `$${p.symbol} ${contractLabel(p.contract)}`,
          `${p.qty} contracts, ${mid === null ? "" : `up ${((mid / p.cost - 1) * 100).toFixed(0)}%`}`,
        ]);
        continue;
      }
      if (decision.sell <= 0 || !decision.reason) {
        if (Object.keys(decision.update).length)
          this.o.store.savePosition(next);
        const passed = decision.update.checksDone?.at(-1);
        if (passed !== undefined)
          this.event(
            "info",
            `${rules.checks[passed]![0]}-min check: ${p.symbol} is with the entry, holding ${p.qty}`,
          );
        continue;
      }
      await this.sell(next, decision.sell, decision.reason, mid, s);
    }
  }

  private async sell(
    p: BotPosition,
    qty: number,
    reason: ExitReason,
    mid: number | null,
    s: BotSettings,
  ) {
    const ask = Math.min(qty, p.qty);
    const why = reasonText(reason, s);
    if (p.dry) {
      const left = p.qty - ask;
      this.o.store.savePosition({
        ...p,
        qty: left,
        sales: [
          ...p.sales,
          {
            at: this.o.now(),
            qty: ask,
            reason,
            jobId: null,
            ...(mid === null ? {} : { price: mid }),
          },
        ],
        ...(left === 0
          ? { status: "closed" as const, closedAt: this.o.now() }
          : {}),
      });
      const pnl =
        mid === null ? "" : ` (${((mid / p.cost - 1) * 100).toFixed(0)}%)`;
      this.event(
        "order",
        `Would sell ${ask} of ${p.qty} ${p.symbol} ${this.words(p.contract)} at ${mid?.toFixed(2) ?? "—"}${pnl}: ${why}`,
      );
      await this.o.notify(`${botTag} (dry run): would sell`, [
        `$${p.symbol} ${contractLabel(p.contract)}`,
        `${ask} of ${p.qty} at ${mid?.toFixed(2) ?? "—"}${pnl}`,
        why,
      ]);
      return;
    }
    const answer = await this.o.trading
      .sell({
        contract: p.contract,
        qty: String(ask),
        stopPct: s.safetyStopPct,
        tag: botTag,
        note: why,
      })
      .catch((error: unknown) => ({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    if (answer.status !== "started" || !("jobId" in answer) || !answer.jobId) {
      this.event(
        "error",
        `Selling ${p.symbol} ${this.words(p.contract)} failed: ${"error" in answer ? answer.error : answer.status}`,
      );
      this.o.store.savePosition(p);
      return;
    }
    this.o.store.savePosition({
      ...p,
      sales: [
        ...p.sales,
        { at: this.o.now(), qty: ask, reason, jobId: answer.jobId },
      ],
    });
    this.event(
      "order",
      `Selling ${ask} of ${p.qty} ${p.symbol} ${this.words(p.contract)}: ${why}`,
    );
  }

  // ---- reporting ----

  private async summary(date: string) {
    const signals = this.o.store.signals(date);
    const positions = this.o.store
      .recentPositions(date)
      .filter((p) => p.day === date || p.status !== "closed");
    if (signals.length === 0 && positions.length === 0) return;
    const count = (o: string) => signals.filter((s) => s.outcome === o).length;
    const head = `${signals.length} signals: ${count("bought") + count("would-buy")} entered, ${signals.length - count("bought") - count("would-buy")} skipped`;
    const lines = [
      head,
      ...positions.map(
        (p) =>
          `$${p.symbol} ${contractLabel(p.contract)}: ${standing(p, date)}`,
      ),
    ];
    const words = positions.map(
      (p) => `${p.symbol} ${this.words(p.contract)}: ${standing(p, date)}`,
    );
    this.event("info", `Day summary: ${[head, ...words].join("; ")}`);
    await this.o.notify(`${botTag}: day summary ${date}`, lines);
  }

  /** What the app shows (GET /v1/bot). */
  status() {
    const day = newYork(this.o.now()).date;
    const since = previousSessions(day, 5)[0]!;
    const s = this.settings();
    return {
      enabled: s.enabled,
      mode: s.mode,
      sizePct: s.sizePct,
      delta: s.delta,
      settings: s,
      universe: this.o.universe,
      favorites: this.watchlist(),
      watching: this.symbols.length ? this.symbols : this.universe(),
      lastRun: this.lastWork,
      day,
      news: { earnings: this.earningsState, premarket: this.preState },
      scan: [...this.scan]
        .map(([symbol, v]) => ({
          symbol,
          ...v,
          blocked:
            this.day === day
              ? (this.newsBlock(day, symbol)?.outcome ?? null)
              : null,
        }))
        // Closest to a signal first: the weaker of the two conditions.
        .sort((a, b) => closeness(b, s) - closeness(a, s)),
      signals: this.o.store.signals(day),
      positions: this.o.store.recentPositions(since),
      activity: this.o.store.events(150),
    };
  }
}

// How near a stock is to the signal: 1 means both conditions hold.
function closeness(v: { t: number; rvol: number }, s: BotSettings): number {
  return Math.min(v.t / s.minT, v.rvol / s.minRvol);
}

/** What changed between two settings, in words for the activity feed. */
function settingsChanges(a: BotSettings, b: BotSettings): string[] {
  const out: string[] = [];
  for (const key of Object.keys(b) as (keyof BotSettings)[]) {
    if (key === "enabled") continue;
    const was = JSON.stringify(a[key]);
    const now = JSON.stringify(b[key]);
    if (was !== now) out.push(`${key} ${was} → ${now}`);
  }
  return out;
}

// How a position ends the day, for the summary.
function standing(p: BotPosition, date: string): string {
  if (p.status === "closed") return "closed";
  const overnight = p.nights > 0 || p.decidedOn === date;
  if (overnight) return `${p.qty} held overnight`;
  return `${p.qty} held`;
}

function priceOf(result: unknown): number | null {
  const r = result as { result?: { price?: unknown } } | null;
  return typeof r?.result?.price === "number" ? r.result.price : null;
}

function soldOf(result: unknown): number {
  const r = result as { result?: { sold?: unknown } } | null;
  return typeof r?.result?.sold === "number" ? r.result.sold : 0;
}

function clock(minute: number): string {
  const wall = 570 + minute;
  return `${String(Math.floor(wall / 60)).padStart(2, "0")}:${String(wall % 60).padStart(2, "0")}`;
}

function contractLabel(contract: string): string {
  const m = /(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(contract);
  if (!m) return contract;
  return `${Number(m[5]) / 1000} ${m[4] === "C" ? "Call" : "Put"} ${Number(m[2])}/${Number(m[3])}`;
}

/** Session minute bars from raw provider bars (start time in seconds, as `RawBar`). */
export function toSessionBars(
  rows: readonly {
    start: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[],
) {
  const byDay = new Map<string, MinuteBar[]>();
  for (const r of rows) {
    const { date, minute } = newYork(r.start * 1000);
    const m = minute - 570;
    if (m < 0 || m >= 390) continue;
    let list = byDay.get(date);
    if (!list) byDay.set(date, (list = []));
    list.push({ m, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
  }
  return byDay;
}

export const sessionStart = (date: string, minute = 0) =>
  new Date(newYorkToUtc(date, 570 + minute)).toISOString();
