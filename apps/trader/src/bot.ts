import { randomUUID } from "node:crypto";
import type { AlpacaTrade } from "../../../packages/market-data/src/alpaca.js";
import { bookOf, lastBookOf, type OptionBook } from "./option-book.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import {
  nextAction,
  nightCapSell,
  type ExitReason,
  type ExitRules,
} from "../../../packages/trading/src/bot/exits.js";
import {
  advanceWatch,
  priorLevels,
  watchFor,
  type PriorLevels,
} from "../../../packages/trading/src/bot/levels.js";
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
  sizeAt,
  watchedStocks,
  withDefaults,
  botBrokers,
  brokerNames,
  entryBrokers,
  type BotBroker,
  type BotBrokerChoice,
  type BotSettings,
} from "../../../packages/trading/src/bot/settings.js";
import { versionLabel } from "../../../packages/trading/src/bot/versions.js";
import {
  cSignal,
  cState,
  priorFrom,
  type MinuteBar,
  type Prior,
} from "../../../packages/trading/src/bot/signal.js";
import { yearsToExpiry } from "../../../packages/trading/src/bot/backtest.js";
import {
  contractWords,
  parseOccSymbol,
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
  /**
   * The last trade price of each symbol now, for the exit checks between
   * minute bars. Optional: without it the checks use the last closed minute.
   */
  lastPrices?(symbols: string[]): Promise<Map<string, number>>;
  /**
   * Every SIP trade of the symbols from `startMs` to `endMs`, handed over a
   * page at a time in time order (the 60-second alert's 10-second bars).
   * Optional: without it there is no 60-second alert.
   */
  trades?(
    symbols: string[],
    startMs: number,
    endMs: number,
    onPage: (symbol: string, trades: AlpacaTrade[]) => void,
  ): Promise<void>;
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
  /** Many contracts' quotes at once (the alert books); absent: one by one. */
  quotes?(contracts: string[]): Promise<OptionQuote[]>;
  held(
    contract: string,
  ): Promise<{ qty: number; avgEntryPrice: number } | null>;
  equity(): Promise<number>;
  // `repeatOk`: the pyramid's add to the bot's own position (the trading
  // service's "not a repeat" check passes for it).
  buy(
    body: Record<string, unknown>,
    options?: { repeatOk?: boolean },
  ): Promise<{
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
  /** The trading service and account at one broker; throws when that broker is not connected. */
  trading: (broker: BotBroker) => BotTrading;
  /** The brokers that are connected; the owner may choose among them. */
  brokers: BotBroker[];
  /** Where new entries go until the owner saves a choice (BOT_BROKER). */
  broker: BotBrokerChoice;
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

export const botTag = "🤖 Main bot";
// A buy keeps raising its price to the ask for up to this long; a sale is
// re-priced at the bid for up to this long (docs/tasks/backend-indi-bot.md,
// "Orders").
export const chaseBuyMs = 10 * 60_000;
export const sellWaitMs = 10 * 60_000;

/** Why the bot sold, in words, with the settings' numbers. */
function reasonText(reason: ExitReason, s: BotSettings): string {
  const words: Record<ExitReason, string> = {
    "check-10": "10-min check: the stock is against the entry",
    "check-20": "20-min check: the stock is still against the entry",
    "stop-30": `Down ${s.stopPct}% with the stock against the entry`,
    "rest-stop": `The rest after the 10-min half: down ${s.restStopPct}% with the stock against the entry`,
    "strength-gone": `Strength gone: the stock's edge over SPY since the open fell to t ${s.weaknessT}`,
    "stage-half": `Staged exit: the stock is ${s.stageHalfS30} of its usual 30-min move against the signal price, sold half`,
    "stage-full": `Staged exit: the stock is ${s.stageFullS30} of its usual 30-min move against the signal price, sold all`,
    "break-even-lock": `Break-even lock: the option was up ${s.lockArmPct}% and the stock came back to where it is worth its cost, sold all`,
    "close-1550": "Sold at 15:50",
    carry: `Held overnight (up ${s.holdFromPct}% or more)`,
    "morning-gap-keep": "Morning: gapped our way, sold half",
    "morning-gap-against": "Morning: no gap our way, sold all",
    "expiry-day": "Expiry day, out by 15:30",
    "night-cap": `Overnight cap: sold what is above ${s.nightCapPct}% of the account`,
    "night-no-equity":
      "Sold at 15:50: no account value today for the overnight cap",
    "failed-break": "Failed break: the stock reached a level and fell back",
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

/** The contract's strike, or null when it is not an OCC symbol. */
const strikeOf = (contract: string): number | null => {
  try {
    return parseOccSymbol(contract).strike;
  } catch {
    return null;
  }
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
  // The 5 sessions before today's levels and unit, for the failed break.
  private levels = new Map<string, PriorLevels | null>();
  private today = new Map<string, Map<number, MinuteBar>>();
  private done = -1; // the last session minute processed today
  private summarized: string | null = null;
  private busy = false;
  // Today's stocks: the configured list and the user's favorites list.
  private symbols: string[] = [];
  // Where each stock stands at the last minute, for the live scan.
  private scan = new Map<
    string,
    {
      side: "C" | "P";
      t: number;
      rvol: number;
      d2: number | null;
      minute: number;
    }
  >();
  private lastWork: number | null = null;
  // The news filter's data for today (docs/tasks/backend-indi-bot.md).
  private priorDays: string[] = [];
  private openClose = new Map<string, Map<string, { o: number; c: number }>>();
  private reports: EarningsReport[] | null = null; // null: no calendar today
  private earningsState: NewsState = "off";
  private preRatio = new Map<string, number | null>();
  private preState: NewsState = "off";
  // Each account at warm-up, for the daily loss limit; null until read.
  private dayStartEquity = new Map<BotBroker, number | null>();
  // The last value read successfully of each account, and its day: the
  // overnight cap falls back to it when the read at 15:50 fails.
  private lastEquity = new Map<BotBroker, { day: string; value: number }>();

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

  /** The trading service at one broker. */
  private trading(broker: BotBroker): BotTrading {
    return this.o.trading(broker);
  }

  /**
   * The broker a position was bought at. One from before the setting was
   * bought at the start-up default (Alpaca when that default is "both").
   */
  private brokerOf(p: Pick<BotPosition, "broker">): BotBroker {
    if (p.broker) return p.broker;
    return this.o.broker === "both" ? "alpaca" : this.o.broker;
  }

  /** The brokers new entries go to: the chosen one, or every connected one. */
  private entryBrokers(s: BotSettings): BotBroker[] {
    return entryBrokers(s.broker, this.o.brokers);
  }

  /**
   * The bot's live positions at one account: the open ones, or, with `since`
   * (a date), also those closed since then (the Bot trades tab).
   */
  positionsAt(broker: BotBroker, since?: string): BotPosition[] {
    const list = since
      ? this.o.store.recentPositions(since)
      : this.o.store.openPositions();
    return list.filter((p) => !p.dry && this.brokerOf(p) === broker);
  }

  /** Whether the owner may choose this for new entries: its brokers are connected. */
  canTrade(choice: BotBrokerChoice): boolean {
    if (choice === "both")
      return botBrokers.every((b) => this.o.brokers.includes(b));
    return this.o.brokers.includes(choice);
  }

  /** One account's equity; a good read is kept for the overnight cap's fallback. */
  private async equity(broker: BotBroker): Promise<number> {
    const value = await this.trading(broker).equity();
    if (Number.isFinite(value) && value > 0)
      this.lastEquity.set(broker, { day: newYork(this.o.now()).date, value });
    return value;
  }

  /** The accounts' equity added up (the drawdown pause measures against it). */
  private async equityTotal(brokers: BotBroker[]): Promise<number> {
    const values = await Promise.all(brokers.map((b) => this.equity(b)));
    return values.reduce((sum, v) => sum + v, 0);
  }

  /** The owner's settings over the defaults; on/off and the mode as set. */
  settings(): BotSettings {
    const base = {
      ...defaultSettings,
      mode: this.o.mode,
      broker: this.o.broker,
    };
    const saved = this.o.store.setting("settings");
    let s = base;
    if (saved) s = withDefaults(JSON.parse(saved), base);
    return { ...s, enabled: this.enabled };
  }

  /** Saves the owner's settings; stocks count from the next warm-up. */
  setSettings(next: BotSettings): BotSettings {
    if (!this.canTrade(next.broker))
      throw new Error(`The bot has no ${next.broker} account connected`);
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
      for (let m = Math.max(this.done + 1, last - 2); m <= last; m++)
        if (this.enabled) {
          await this.entries(date, m, closeMinute);
          await this.pyramids(date, m, closeMinute);
        }
      this.done = last;
    }
    // The exits run every tick, in the minute now, on the stocks' last trades
    // and fresh option quotes (user 2026-10-23: "check every 10 seconds and
    // not every 1 minute"). With early entry (2.7) the entries are checked on
    // every tick too, on the minute so far; otherwise on closed bars only.
    const current = Math.min(wall - 570, closeMinute - 1);
    if (current >= 0 && this.enabled && current === this.done + 1)
      await this.earlyEntries(date, current, closeMinute);
    if (current >= 0) await this.exits(date, current, closeMinute);
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
    this.levels.clear();
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
      this.levels.set(
        s,
        priorLevels(days.slice(-5).map((d) => byDay.get(d) ?? [])),
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
      `Ready for ${date}: watching ${this.symbols.length} stocks (${parts}); bot version ${versionLabel(s)}`,
    );
    // Each account's value at the open, for the day's loss limit.
    this.dayStartEquity.clear();
    for (const broker of this.entryBrokers(this.settings()))
      this.dayStartEquity.set(
        broker,
        await this.equity(broker).catch(() => null),
      );
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
      const now = cState(this.barsOf(symbol), spy, prior, m, params.d2Window);
      if (now)
        this.scan.set(symbol, {
          side: now.t < 0 ? "P" : "C",
          t: Math.abs(now.t),
          rvol: now.rvol,
          d2: now.d2,
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
        version: versionLabel(this.settings()),
      });
      // The D2 bonus entered under the usual strength: say why.
      let held = "";
      if (sig.bonus && sig.d2 !== null)
        held = `, held up on SPY's down minutes (D2 ${sig.d2.toFixed(1)})`;
      if (added)
        this.event(
          "signal",
          `${symbol} ${sig.right === "C" ? "call" : "put"} signal at ${clock(sig.minute)}: strength t ${sig.t.toFixed(1)}${held}, volume ${sig.rvol.toFixed(1)}× normal`,
        );
      if (added)
        await this.enter(date, symbol, sig.right, sig.minute, sig.t, sig.rvol, {
          bonus: sig.bonus,
        }).catch((error) => {
          const why = error instanceof Error ? error.message : String(error);
          this.outcome(date, symbol, "error", why);
        });
    }
  }

  // ---- early entry (version 2.7) ----

  /**
   * The signal on the minute so far: each stock's and SPY's latest trade as
   * the forming minute's close (its volume not yet counted), bought at the
   * first tick the rule holds (research: sec_timing.py "early"). The closed
   * minute then finds the signal taken and passes.
   */
  private async earlyEntries(date: string, m: number, closeMinute: number) {
    const s = this.settings();
    if (!s.earlyEntry || !this.o.market.lastPrices) return;
    const params = signalParams(s);
    if (m < params.firstMinute || m > Math.min(374, closeMinute - 16)) return;
    const open = this.symbols.filter(
      (x) => this.prior.has(x) && !this.o.store.signal(date, x),
    );
    if (!open.length) return;
    let live: Map<string, number>;
    try {
      live = await this.o.market.lastPrices([...open, "SPY"]);
    } catch (error) {
      this.o.log(
        `early entry: last prices failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const forming = (symbol: string): MinuteBar[] | null => {
      const price = live.get(symbol);
      // The closed minutes only: the bars request can already hold the forming
      // minute (live, its part so far; in a replay, the whole of it).
      const bars = this.barsOf(symbol).filter((b) => b.m < m);
      const prev = bars.at(-1);
      if (price === undefined || !prev || prev.m !== m - 1) return null;
      // An odd print (out of sequence, off the market) is not the minute so far.
      if (Math.abs(price / prev.c - 1) > 0.03) return null;
      const now: MinuteBar = {
        m,
        o: prev.c,
        h: Math.max(prev.c, price),
        l: Math.min(prev.c, price),
        c: price,
        v: 0,
      };
      return [...bars, now];
    };
    const spy = forming("SPY");
    if (!spy) return;
    for (const symbol of open) {
      const bars = forming(symbol);
      if (!bars) continue;
      const sig = cSignal(bars, spy, this.prior.get(symbol)!, m, params);
      if (!sig || sig.minute !== m) continue;
      const added = this.o.store.addSignal({
        day: date,
        symbol,
        right: sig.right,
        minute: m,
        t: sig.t,
        rvol: sig.rvol,
        outcome: "new",
        detail: "",
        at: this.o.now(),
        version: versionLabel(s),
      });
      if (!added) continue;
      let held = "";
      if (sig.bonus && sig.d2 !== null)
        held = `, held up on SPY's down minutes (D2 ${sig.d2.toFixed(1)})`;
      const sec = Math.floor((this.o.now() % 60_000) / 1000);
      this.event(
        "signal",
        `${symbol} ${sig.right === "C" ? "call" : "put"} signal at ${clock(m)}:${String(sec).padStart(2, "0")}, inside the minute: strength t ${sig.t.toFixed(1)}${held}, volume ${sig.rvol.toFixed(1)}× normal`,
      );
      await this.enter(date, symbol, sig.right, m, sig.t, sig.rvol, {
        bonus: sig.bonus,
        spotNow: live.get(symbol)!,
      }).catch((error) => {
        const why = error instanceof Error ? error.message : String(error);
        this.outcome(date, symbol, "error", why);
      });
    }
  }

  // ---- the pyramid (version 2.7) ----

  /**
   * After a D2 bonus entry, the first minute that day the stock reaches the
   * full signal (t >= minT, the bonus off): on the same side, with the first
   * position held and its option above what it cost, one more position of
   * pyramidSharePct of the size in a fresh pick (research: export_champ.py).
   * Decided once a position: an opposite side, a position not up, or a missed
   * minute ends it.
   */
  private async pyramids(date: string, m: number, closeMinute: number) {
    const s = this.settings();
    if (!s.pyramid) return;
    if (m > Math.min(374, closeMinute - 16)) return;
    const full = { ...signalParams(s), bonusT: null };
    const spy = this.barsOf("SPY");
    const firsts = this.o.store
      .openPositions()
      .filter(
        (p) =>
          p.day === date &&
          p.bonus &&
          !p.addOf &&
          !p.pyramidChecked &&
          p.dry === (s.mode === "dry"),
      );
    for (const p of firsts) {
      const prior = this.prior.get(p.symbol);
      if (!prior) continue;
      const sig = cSignal(this.barsOf(p.symbol), spy, prior, m, full);
      if (!sig) continue;
      const done = (why: string) => {
        this.o.store.savePosition({ ...p, pyramidChecked: true });
        this.event("info", `${p.symbol} pyramid: ${why}`);
      };
      // The day's first full signal came with the entry itself: no add.
      if (sig.minute <= p.entryMinute) {
        done(`the full signal came at the entry (${clock(sig.minute)})`);
        continue;
      }
      if (sig.minute < m - 2) {
        done(`the full signal at ${clock(sig.minute)} was missed`);
        continue;
      }
      if (sig.right !== p.right) {
        done(`the full signal at ${clock(sig.minute)} is the other side`);
        continue;
      }
      if (p.status !== "open" || p.qty <= 0) {
        done(`the first position is not held at ${clock(sig.minute)}`);
        continue;
      }
      const quote = await this.trading(this.brokerOf(p))
        .quote(p.contract)
        .catch(() => null);
      const mid =
        quote && quote.bid > 0 && quote.ask > 0
          ? (quote.bid + quote.ask) / 2
          : null;
      if (mid === null || mid <= p.cost) {
        done(
          `the first position is not up at ${clock(sig.minute)} (${mid === null ? "no quote" : `${mid.toFixed(2)} vs ${p.cost.toFixed(2)} paid`})`,
        );
        continue;
      }
      this.o.store.savePosition({ ...p, pyramidChecked: true });
      await this.addTo(p, date, sig.minute, sig.t, s).catch((error) =>
        this.event(
          "error",
          `${p.symbol} pyramid failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  /** The half-size add: a fresh pick on the first position's side, at its broker. */
  private async addTo(
    first: BotPosition,
    date: string,
    minute: number,
    t: number,
    s: BotSettings,
  ) {
    const broker = this.brokerOf(first);
    const limited = await this.limit(date, s, broker);
    if (limited)
      return this.event(
        "skip",
        `${first.symbol} pyramid: ${outcomeText(limited.outcome, s)} (${limited.detail})`,
      );
    const pick = pickRules(s, first.symbol);
    const spot = this.lastClose(first.symbol, minute);
    if (spot === null)
      return this.event("skip", `${first.symbol} pyramid: no stock price`);
    const side = first.right === "C" ? "call" : "put";
    const [from, to] = expiryWindow(date, pick);
    const picked = pickContract(
      await this.trading(broker).chain(first.symbol, side, from, to),
      spot,
      side,
      date,
      pick,
    );
    if (!picked.ok)
      return this.event(
        "skip",
        `${first.symbol} pyramid: ${outcomeText(picked.reason, s)}`,
      );
    const contract = picked.quote.symbol;
    const volume = await this.o.market.optionVolume30(contract, date, minute);
    if (volume < pick.minVolume30)
      return this.event(
        "skip",
        `${first.symbol} pyramid: ${this.words(contract)} ${volume} contracts in 30 minutes`,
      );
    const version = versionLabel(s);
    const why = `Pyramid ${side} at ${clock(minute)}: the full signal (t ${t.toFixed(1)}) after the D2 entry at ${clock(first.entryMinute)}, which is up · ${s.pyramidSharePct}% of the size · bot ${version}`;
    const base: Omit<BotPosition, "id" | "broker"> = {
      day: date,
      symbol: first.symbol,
      contract,
      right: first.right,
      qty: 0,
      bought: 0,
      cost: picked.mid,
      entryMinute: minute,
      entryStock: spot,
      nights: 0,
      checksDone: [],
      morningDone: false,
      breakWatch: watchFor(
        this.levels.get(first.symbol),
        this.barsOf(first.symbol),
        minute,
        spot,
        first.right,
      ),
      decidedOn: null,
      version,
      status: "buying",
      jobId: null,
      dry: s.mode === "dry",
      sales: [],
      openedAt: this.o.now(),
      closedAt: null,
      addOf: first.id,
    };
    const book = bookOf(picked.quote, this.o.now(), broker);
    const result = await this.enterAt(
      broker,
      base,
      picked.mid,
      s,
      why,
      false,
      book,
      {
        sharePct: s.pyramidSharePct,
      },
    );
    const kind: BotEventKind =
      result.outcome === "bought" || result.outcome === "would-buy"
        ? "order"
        : "skip";
    this.event(
      kind,
      `${first.symbol} pyramid: ${outcomeText(result.outcome, s)}${result.detail ? ` (${result.detail})` : ""}`,
    );
  }

  private async enter(
    date: string,
    symbol: string,
    right: "C" | "P",
    minute: number,
    t: number,
    rvol: number,
    // bonus: entered on the D2 bonus (the pyramid adds to these); spotNow: the
    // stock's latest trade, for an early entry inside the minute (2.7).
    opts: { bonus?: boolean; spotNow?: number } = {},
  ) {
    // The news filter: no new entry on an earnings reaction day or a busy pre-market.
    const blocked = this.newsBlock(date, symbol);
    if (blocked)
      return this.outcome(date, symbol, blocked.outcome, blocked.detail);
    const s = this.settings();
    const brokers = this.entryBrokers(s);
    if (brokers.length === 0)
      return this.outcome(
        date,
        symbol,
        "refused",
        `no ${s.broker} account connected`,
      );
    // Each account has its own limits; one at its limit sits this signal out.
    const legs: BotBroker[] = [];
    let limited: { outcome: string; detail: string } | null = null;
    for (const broker of brokers) {
      const why = await this.limit(date, s, broker);
      if (why) limited = why;
      else legs.push(broker);
    }
    if (legs.length === 0 && limited)
      return this.outcome(date, symbol, limited.outcome, limited.detail);
    const pick = pickRules(s, symbol);
    const spot = opts.spotNow ?? this.lastClose(symbol, minute);
    if (spot === null)
      return this.outcome(date, symbol, "no_prices", "no stock price");
    const side = right === "C" ? "call" : "put";
    const [from, to] = expiryWindow(date, pick);
    // One contract for every leg, picked from the first account's chain, so
    // two accounts can be compared fill for fill (user 2026-10-24).
    const picked = pickContract(
      await this.trading(legs[0]!).chain(symbol, side, from, to),
      spot,
      side,
      date,
      pick,
    );
    // The picked contract's bid / ask, kept with the signal (paper fills are not real ones).
    const chosen = picked.quote;
    const pickedBook = bookOf(chosen, this.o.now(), legs[0]!);
    if (chosen && pickedBook)
      this.o.store.setSignalBook(date, symbol, {
        ...pickedBook,
        contract: chosen.symbol,
      });
    if (!picked.ok)
      return this.outcome(
        date,
        symbol,
        picked.reason,
        picked.reason === "too_cheap" && pick.minPrice !== s.minPrice
          ? `${symbol}'s floor is $${pick.minPrice.toFixed(2)}`
          : "",
      );
    const contract = picked.quote.symbol;
    const volume = await this.o.market.optionVolume30(contract, date, minute);
    // Kept with the signal: the floor is judged against real fills later.
    this.o.store.setSignalPick(date, symbol, {
      volume30: volume,
      ...(picked.fallback ? { fallback: picked.fallback } : {}),
    });
    if (volume < pick.minVolume30)
      return this.outcome(
        date,
        symbol,
        "thin",
        `${this.words(contract)}: ${volume} contracts in 30 minutes`,
      );
    // The entry's note carries the version, so the trade's record has it too.
    const version = versionLabel(s);
    let fallback = "";
    if (picked.fallback === "cheap")
      fallback = ` · the 0.15-delta option was under $${pick.minPrice.toFixed(2)}, so the nearest strike at $${pick.minPrice.toFixed(2)} or more`;
    const why = `Signal ${side} at ${clock(minute)}: strength t ${t.toFixed(1)}, volume ${rvol.toFixed(1)}× normal${fallback} · bot ${version}`;
    const base: Omit<BotPosition, "id" | "broker"> = {
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
      breakWatch: watchFor(
        this.levels.get(symbol),
        this.barsOf(symbol),
        minute,
        spot,
        right,
      ),
      decidedOn: null,
      version,
      status: "buying",
      jobId: null,
      dry: s.mode === "dry",
      sales: [],
      openedAt: this.o.now(),
      closedAt: null,
      ...(opts.bonus ? { bonus: true } : {}),
    };
    const results: { broker: BotBroker; outcome: string; detail: string }[] =
      [];
    for (const [i, broker] of legs.entries()) {
      // The first account's book is the chain's at the pick; another account's is its own quote.
      const book =
        i === 0
          ? pickedBook
          : bookOf(
              await this.trading(broker)
                .quote(contract)
                .catch(() => null),
              this.o.now(),
              broker,
            );
      // A leg that throws (IBKR refusing the contract's market data, user
      // 2026-10-26) is that account's miss; the other account's entry stands.
      const result = await this.enterAt(
        broker,
        base,
        picked.mid,
        s,
        why,
        legs.length > 1,
        book,
      ).catch((error: unknown) => ({
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
      }));
      results.push({ broker, ...result });
    }
    // The signal's one outcome: an entry if any leg entered, else the first miss.
    const entered = results.filter(
      (r) => r.outcome === "bought" || r.outcome === "would-buy",
    );
    const first = entered[0] ?? results[0]!;
    let detail = first.detail;
    if (legs.length > 1)
      detail = results
        .map(
          (r) =>
            `${brokerNames[r.broker]}: ${r.detail || outcomeText(r.outcome, s)}`,
        )
        .join("; ");
    this.outcome(date, symbol, first.outcome, detail);
  }

  /**
   * Buys one leg at one account: the position record and the order, or why
   * not, in the signal's outcome words. `named` adds the account to the notes
   * when a signal is bought at more than one.
   */
  private async enterAt(
    broker: BotBroker,
    base: Omit<BotPosition, "id" | "broker">,
    mid: number,
    s: BotSettings,
    why: string,
    named: boolean,
    book?: OptionBook,
    // A pyramid add (2.7): this share of the size; it may buy more of a
    // contract the bot itself holds (never one the user holds).
    add?: { sharePct: number },
  ): Promise<{ outcome: string; detail: string }> {
    const { symbol, contract } = base;
    const at = named ? ` · ${brokerNames[broker]}` : "";
    // A contract the account already holds is the user's; the bot leaves it
    // alone. An add may join the bot's own position in it: what the account
    // holds must then be exactly what the bot's positions hold.
    const inAccount = await this.trading(broker).held(contract);
    if (inAccount) {
      const own = this.ownQty(broker, contract, s.mode === "dry");
      const onlyOurs = add && own > 0 && inAccount.qty === own;
      if (!onlyOurs)
        return {
          outcome: "held",
          detail: `${this.words(contract)} is already in the account${at}`,
        };
    }
    // The size for the account as the day started (sizeSteps step it down as it grows).
    const dayStart =
      this.dayStartEquity.get(broker) ??
      (await this.equity(broker).catch(() => 0));
    const tradePct = sizeAt(s.sizePct, s.sizeSteps, dayStart);
    const sizePct = add ? (tradePct * add.sharePct) / 100 : tradePct;
    const position: BotPosition = {
      ...base,
      id: randomUUID(),
      broker,
      ...(book ? { entryBook: book } : {}),
    };
    if (s.mode === "dry") {
      const equity = await this.equity(broker);
      const qty = Math.floor((equity * sizePct) / 100 / (mid * 100));
      if (qty < 1)
        return {
          outcome: "too_small",
          detail: `${this.words(contract)} at ${mid.toFixed(2)}${at}`,
        };
      this.o.store.savePosition({
        ...position,
        qty,
        bought: qty,
        status: "open",
      });
      await this.o.notify(`${botTag} (dry run): would buy`, [
        `$${symbol} ${contractLabel(contract)}${at}`,
        `${qty} contracts at ${mid.toFixed(2)}`,
        why,
      ]);
      return {
        outcome: "would-buy",
        detail: `${qty} ${this.words(contract)} at ${mid.toFixed(2)}${at}`,
      };
    }
    const answer = await this.trading(broker).buy(
      {
        contract,
        sizePct,
        stopPct: s.safetyStopPct,
        // Keep raising the price until it fills (user 2026-10-23).
        chase: true,
        chaseMs: chaseBuyMs,
        tag: botTag,
        note: why + at,
      },
      // The pyramid's add comes about a minute after the entry: an intended
      // second buy, so the service's 60-second repeat check lets it through.
      add ? { repeatOk: true } : {},
    );
    if (answer.status !== "started" || !answer.jobId)
      return {
        outcome: "refused",
        detail: `${(answer.refused ?? []).join("; ")}${at}`,
      };
    this.o.store.savePosition({ ...position, jobId: answer.jobId });
    return {
      outcome: "bought",
      detail: `${answer.qty ?? "?"} ${this.words(contract)}${at}`,
    };
  }

  // ---- the owner's limits on new buys ----

  /**
   * Why a new buy at one account waits: today's buys, that account's open
   * positions or its day's loss; null when none.
   */
  private async limit(
    date: string,
    s: BotSettings,
    broker: BotBroker,
  ): Promise<{ outcome: string; detail: string } | null> {
    const dry = s.mode === "dry";
    const entered = this.o.store
      .signals(date)
      .filter((x) => x.outcome === "bought" || x.outcome === "would-buy");
    if (entered.length >= s.maxBuysPerDay)
      return { outcome: "max_buys", detail: `${entered.length} today` };
    const open = this.o.store
      .openPositions()
      .filter(
        (p) =>
          p.dry === dry && p.status !== "closed" && this.brokerOf(p) === broker,
      );
    if (open.length >= s.maxOpen)
      return { outcome: "max_open", detail: `${open.length} open` };
    if (!this.dayStartEquity.has(broker))
      this.dayStartEquity.set(
        broker,
        await this.equity(broker).catch(() => null),
      );
    const start = this.dayStartEquity.get(broker);
    if (start && start > 0) {
      const equity = await this.equity(broker);
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
    const equity = await this.equityTotal(this.entryBrokers(s)).catch(
      () => null,
    );
    if (!equity || equity <= 0) return;
    const pct = (down / equity) * 100;
    if (pct < s.drawdownPausePct) return;
    this.setEnabled(false);
    const text = `Paused: the bot's trades are down $${down.toFixed(0)} (${pct.toFixed(1)}% of the account) from their best, past the ${s.drawdownPausePct}% limit. Turn it back on in Bot settings.`;
    this.event("error", text);
    await this.o.notify(`${botTag}: paused`, [text]);
  }

  // ---- buys and sales that are still working ----

  /**
   * What the bot's open positions in one contract at one account hold, less
   * `except` (a pyramid add can share its first position's contract).
   */
  private ownQty(
    broker: BotBroker,
    contract: string,
    dry: boolean,
    except?: string,
  ): number {
    return this.o.store
      .openPositions()
      .filter(
        (p) =>
          p.id !== except &&
          p.dry === dry &&
          p.contract === contract &&
          this.brokerOf(p) === broker &&
          p.status === "open",
      )
      .reduce((sum, p) => sum + p.qty, 0);
  }

  /** What the account holds of a position's contract that is this position's: the rest is its other bot positions'. */
  private heldFor(
    p: BotPosition,
    held: { qty: number; avgEntryPrice: number } | null,
  ): number {
    if (!held || held.qty <= 0) return 0;
    const others = this.ownQty(this.brokerOf(p), p.contract, p.dry, p.id);
    return Math.max(0, held.qty - others);
  }

  private async settle() {
    for (const p of this.o.store.openPositions()) {
      if (p.dry) continue;
      if (p.status === "buying" && p.jobId) {
        const job = this.trading(this.brokerOf(p)).job(p.jobId);
        if (job.state === "running") continue;
        const held = await this.trading(this.brokerOf(p)).held(p.contract);
        const mine = this.heldFor(p, held);
        if (mine <= 0) {
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
        // An add in a contract the bot already held: the account's average
        // mixes both buys, so the add's own fill price is its cost.
        const shared = mine < held!.qty;
        const cost = shared
          ? (buyPriceOf(job.result) ?? held!.avgEntryPrice)
          : held!.avgEntryPrice;
        const fillBook = lastBookOf(job.result, this.o.now(), this.brokerOf(p));
        this.o.store.savePosition({
          ...p,
          status: "open",
          qty: mine,
          bought: mine,
          cost,
          jobId: null,
          ...(fillBook ? { entryFillBook: fillBook } : {}),
        });
        this.event(
          "order",
          `Bought ${mine} ${p.symbol} ${this.words(p.contract)} at ${cost.toFixed(2)}`,
        );
        continue;
      }
      const pending = p.sales.find((s) => s.jobId !== null && !s.settled);
      if (pending && pending.jobId) {
        const job = this.trading(this.brokerOf(p)).job(pending.jobId);
        if (job.state === "running") continue;
        const sold = soldOf(job.result);
        const price = priceOf(job.result);
        const held = await this.trading(this.brokerOf(p)).held(p.contract);
        const qty = Math.max(0, Math.min(p.qty - sold, this.heldFor(p, held)));
        const fillBook = lastBookOf(job.result, this.o.now(), this.brokerOf(p));
        const sales = p.sales.map((s) =>
          s === pending
            ? {
                ...s,
                qty: sold,
                settled: true,
                ...(price ? { price } : {}),
                ...(fillBook ? { fillBook } : {}),
              }
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
        const held = await this.trading(this.brokerOf(p)).held(p.contract);
        const qty = Math.min(p.qty, this.heldFor(p, held));
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

  /** The last trade of each open position's stock, when the market gives them. */
  private async livePrices(): Promise<Map<string, number>> {
    const symbols = [
      ...new Set(
        this.o.store
          .openPositions()
          .filter((p) => p.status === "open" && p.qty > 0)
          .map((p) => p.symbol),
      ),
    ];
    if (!symbols.length || !this.o.market.lastPrices) return new Map();
    try {
      return await this.o.market.lastPrices(symbols);
    } catch (error) {
      this.o.log(
        `last prices failed, using the last minute: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Map();
    }
  }

  private async exits(date: string, m: number, closeMinute: number) {
    const s = this.settings();
    const live = await this.livePrices();
    const base = exitRules(s);
    const rules: ExitRules = {
      ...base,
      eodMinute: Math.min(base.eodMinute, closeMinute - 10),
      expiryLastMinute: Math.min(base.expiryLastMinute, closeMinute - 30),
    };
    for (const p0 of this.o.store.openPositions()) {
      // The level watch reads closed bars only: `done` is the last one loaded.
      const p = this.watchLevel(p0, date, this.done, rules.eodMinute);
      if (p.status !== "open" || p.qty <= 0) continue;
      if (p.sales.some((s) => s.jobId !== null && !s.settled)) continue;
      const failed =
        s.sellFailedBreak &&
        p.day === date &&
        m < rules.eodMinute &&
        p.breakWatch?.state === "failed";
      if (failed) {
        const quote = await this.trading(this.brokerOf(p))
          .quote(p.contract)
          .catch(() => null);
        const mid =
          quote && quote.bid > 0 && quote.ask > 0
            ? (quote.bid + quote.ask) / 2
            : null;
        await this.sell(
          p,
          p.qty,
          "failed-break",
          mid,
          s,
          bookOf(quote, this.o.now(), this.brokerOf(p)),
        );
        continue;
      }
      const expiry = expiryOf(p.contract);
      const quote = await this.trading(this.brokerOf(p))
        .quote(p.contract)
        .catch(() => null);
      const mid =
        quote && quote.bid > 0 && quote.ask > 0
          ? (quote.bid + quote.ask) / 2
          : null;
      const first = this.barsOf(p.symbol)[0];
      const state = {
        ...p,
        nights: p.day === date ? 0 : p.nights,
        halfSold: p.sales.some((x) => x.reason === "check-10"),
        stageHalfSold: p.sales.some((x) => x.reason === "stage-half"),
      };
      // The signal's strength now, from the closed minutes (the scan's prior data).
      const prior = this.prior.get(p.symbol);
      const strength =
        s.sellOnWeakness && prior && p.day === date
          ? (cState(this.barsOf(p.symbol), this.barsOf("SPY"), prior, this.done)
              ?.t ?? null)
          : null;
      const decision = nextAction(
        state,
        {
          minute: m,
          stock: live.get(p.symbol) ?? this.lastClose(p.symbol, m),
          option: mid,
          strength,
          // The stock's usual 30-minute move, for the staged exit (entry day only).
          unit:
            p.day === date ? (this.levels.get(p.symbol)?.unit ?? null) : null,
          // For the break-even lock (entry day only): the last closed minute, as the research.
          close: this.lastClose(p.symbol, m),
          strike: p.day === date ? strikeOf(p.contract) : null,
          years: p.day === date ? yearsToExpiry(date, m, expiry) : null,
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
        // The overnight cap: sell what is worth more than the cap first, hold the rest.
        const cap = await this.nightCap(p, mid, date, s);
        const keep = p.qty - cap.sell;
        if (cap.sell > 0)
          await this.sell(
            next,
            cap.sell,
            cap.reason,
            mid,
            s,
            bookOf(quote, this.o.now(), this.brokerOf(p)),
          );
        else this.o.store.savePosition(next);
        if (keep <= 0) continue;
        this.event(
          "order",
          `Holding ${keep} ${p.symbol} ${this.words(p.contract)} overnight (up ${s.holdFromPct}% or more)`,
        );
        await this.o.notify(`${botTag}: held overnight`, [
          `$${p.symbol} ${contractLabel(p.contract)}`,
          `${keep} contracts, ${mid === null ? "" : `up ${((mid / p.cost - 1) * 100).toFixed(0)}%`}`,
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
      await this.sell(
        next,
        decision.sell,
        decision.reason,
        mid,
        s,
        bookOf(quote, this.o.now(), this.brokerOf(p)),
      );
    }
  }

  /**
   * Moves the position's level watch to minute `m` on the entry day (also
   * while the buy is still filling) and writes what it saw to the feed. A
   * failed break is noted even with the setting off.
   */
  private watchLevel(
    p: BotPosition,
    date: string,
    m: number,
    eodMinute: number,
  ): BotPosition {
    const w = p.breakWatch;
    if (!w || w.state !== "watching" || p.day !== date) return p;
    if (p.status === "closed") return p;
    const next = advanceWatch(
      w,
      this.barsOf(p.symbol),
      Math.min(m, eodMinute - 1),
      p.right,
    );
    if (next === w || next.through === w.through) return p;
    const saved = { ...p, breakWatch: next };
    this.o.store.savePosition(saved);
    const name = `${p.symbol} ${this.words(p.contract)}`;
    const level = `${w.name} (${w.level.toFixed(2)})`;
    if (next.touch !== null && w.touch === null && next.state === "watching")
      this.event("info", `${name}: the stock reached ${level}`);
    if (next.state === "broken")
      this.event("info", `${name}: the stock broke ${level}`);
    if (next.state === "failed") {
      const off = this.settings().sellFailedBreak
        ? ""
        : " (the failed-break sale is off)";
      this.event(
        "info",
        `${name}: failed break: reached ${level} and fell back${off}`,
      );
    }
    return saved;
  }

  /**
   * What of `p` to sell at 15:50 before the overnight hold, so what is held is
   * worth at most `nightCapPct` of the account at the mid (0: no cap). The
   * account is read now; if that fails, the cap uses the last value read
   * today (warm-up or later); with none, the whole carry is sold. Never more
   * than the bot's count, which is already capped at what the account holds.
   */
  private async nightCap(
    p: BotPosition,
    mid: number | null,
    date: string,
    s: BotSettings,
  ): Promise<{ sell: number; reason: "night-cap" | "night-no-equity" }> {
    if (s.nightCapPct <= 0 || mid === null)
      return { sell: 0, reason: "night-cap" };
    const name = `${p.symbol} ${this.words(p.contract)}`;
    let equity: number | null = await this.equity(this.brokerOf(p)).catch(
      (error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        this.event(
          "error",
          `${name}: the account value could not be read at the day exit (${why})`,
        );
        return null;
      },
    );
    if (equity !== null && !(equity > 0)) equity = null;
    if (equity === null) {
      const last = this.lastEquity.get(this.brokerOf(p));
      const seen = last?.day === date ? last.value : null;
      if (seen === null) {
        this.event(
          "error",
          `${name}: no account value today for the ${s.nightCapPct}% overnight cap, so nothing is held overnight: selling all ${p.qty}`,
        );
        return { sell: p.qty, reason: "night-no-equity" };
      }
      this.event(
        "info",
        `${name}: the overnight cap uses the last account value read today ($${Math.round(seen)})`,
      );
      equity = seen;
    }
    const sell = nightCapSell(p.qty, mid, equity, s.nightCapPct);
    if (sell > 0)
      this.event(
        "info",
        `${name}: ${p.qty} worth $${Math.round(p.qty * mid * 100)} is over the ${s.nightCapPct}% overnight cap ($${Math.round((equity * s.nightCapPct) / 100)}): selling ${sell}, holding ${p.qty - sell}`,
      );
    return { sell, reason: "night-cap" };
  }

  private async sell(
    p: BotPosition,
    qty: number,
    reason: ExitReason,
    mid: number | null,
    s: BotSettings,
    book?: OptionBook,
  ) {
    const ask = Math.min(qty, p.qty);
    let why = reasonText(reason, s);
    const w = p.breakWatch;
    if (reason === "failed-break" && w)
      why = `Failed break: reached ${w.name} (${w.level.toFixed(2)}) and fell back, sold all`;
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
            ...(book ? { book } : {}),
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
    const answer = await this.trading(this.brokerOf(p))
      .sell({
        contract: p.contract,
        qty: String(ask),
        stopPct: s.safetyStopPct,
        // Re-priced at the bid every few seconds for this long (user 2026-10-23).
        waitMs: sellWaitMs,
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
        {
          at: this.o.now(),
          qty: ask,
          reason,
          jobId: answer.jobId,
          ...(book ? { book } : {}),
        },
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
      brokers: this.o.brokers,
      sizePct: s.sizePct,
      delta: s.delta,
      version: versionLabel(s),
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
      entries: this.o.store.entries(since),
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

/** A buy job's average fill price (engine.ts: result.avgPrice), when it has one. */
function buyPriceOf(result: unknown): number | null {
  const r = result as { result?: { avgPrice?: unknown } } | null;
  const v = r?.result?.avgPrice;
  return typeof v === "number" && v > 0 ? v : null;
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
