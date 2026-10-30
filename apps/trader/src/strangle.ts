import { randomUUID } from "node:crypto";
import { bookOf, lastBookOf } from "./option-book.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import { priorLevels } from "../../../packages/trading/src/bot/levels.js";
import {
  premarketBlocks,
  premarketRatio,
  reactionReport,
  reportDates,
  type EarningsReport,
  type NewsCalendar,
} from "../../../packages/trading/src/bot/news.js";
import type { OptionQuote } from "../../../packages/trading/src/options.js";
import {
  liquidOrder,
  pickContract,
  type Picked,
} from "../../../packages/trading/src/bot/picker.js";
import {
  cState,
  priorFrom,
  type MinuteBar,
  type Prior,
} from "../../../packages/trading/src/bot/signal.js";
import {
  alertCloseness,
  alerts,
  firstAlert,
  measureAt,
  windows,
  type Windows,
} from "../../../packages/trading/src/strangle/alert.js";
import {
  bestOf,
  burstAgrees,
  burstAtSecond,
  burstOf,
  giveBackExit,
  legQty,
  minuteCloseExit,
  sideOf,
  strengthAgrees,
  waitedOut,
  type Leg,
} from "../../../packages/trading/src/strangle/decide.js";
import {
  clockOf,
  defaultStrangleSettings,
  strangleSteps,
  strangleStocks,
  strangleWithDefaults,
  type StrangleSettings,
} from "../../../packages/trading/src/strangle/settings.js";
import { contractWords } from "../../../packages/trading/src/options.js";
import type {
  StrangleLiveDay,
  StrangleScanRow,
  StrangleView,
} from "../../../packages/trading/src/strangle/view.js";
import {
  carried,
  fastBaseline,
  FastFire,
  fastRule,
  fastState,
  shockRule,
  fastWindows,
  paceSums,
  type FastBaseline,
  type FastWindows,
} from "../../../packages/trading/src/strangle/fast.js";
import type { BotMarket, BotTrading } from "./bot.js";
import { FastTape, fetchFastDay } from "./strangle-fast.js";
import {
  tradeCash,
  type StrangleEventKind,
  type StrangleOrder,
  type StrangleStore,
  type StrangleTrade,
} from "./strangle-store.js";

// The alert leg (docs/tasks/backend-strangle-bot.md): a second bot, separate
// from the Indi bot, on its own Alpaca paper account. On the first volume
// alert of a stock's day (a day with a same-day expiry, or 1DTE: one the next session) it watches; when the
// stock has moved a share of its typical 30-minute move either way, it buys
// only that side's leg (the 0.35-delta call or put of that expiry) and
// sells it when the stock gives back a share of that move from its best since
// the buy. The decisions are the backtest's (strangle_more.py), checked trade
// by trade by scripts/strangle-parity.ts. Every order goes through the owner's
// trading service at its account, as the Indi bot's do at its own. The module
// keeps the name "strangle", the first version of the strategy.

export interface StrangleOptions {
  store: StrangleStore;
  market: BotMarket;
  trading: BotTrading;
  account: string; // the account's id, for the status
  notify: (title: string, lines: string[]) => Promise<unknown>;
  earnings?: (date: string) => Promise<EarningsReport[]>;
  now?: () => number;
  log?: (line: string) => void;
}

export const strangleTag = "🎯 Volume bot";
const chaseBuyMs = 3 * 60_000;
const sellWaitMs = 3 * 60_000;

type NewsState = "off" | "pending" | "ok" | "failed";

/** The last session of the date's week (Friday, or earlier on a holiday). */
export function weekEnd(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  let end = new Date(d.getTime() + (5 - d.getUTCDay()) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  while (end > date && coreClose(end) === null)
    end = new Date(Date.parse(`${end}T12:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
  return end;
}

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

const legName = (leg: Leg) => (leg === "C" ? "call" : "put");
const priceOf = (result: unknown): number | null => {
  const r = result as { result?: { price?: unknown } } | null;
  return typeof r?.result?.price === "number" ? r.result.price : null;
};
const soldOf = (result: unknown): number => {
  const r = result as { result?: { sold?: unknown } } | null;
  return typeof r?.result?.sold === "number" ? r.result.sold : 0;
};

// The shock alert's entry (volume-bot.md 2026-10-30): the side held on 5
// 1-second checks in a row within 300 s of the alert; the leg stepped toward
// the money up to 0.35 delta; no buy over a 30% spread.
const shockHoldChecks = 5;
const shockHoldWithin = 300;
const shockMaxDelta = 0.35;
const shockMaxSpread = 0.3;

/** Calendar days from `date` to `expiry` (both YYYY-MM-DD). */
const daysBetween = (date: string, expiry: string) =>
  Math.round(
    (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
      86_400_000,
  );

/** The alert's name at the start of a watch's detail. */
function alertWords(fast?: { shock?: boolean }): string {
  if (!fast) return "";
  return fast.shock ? "shock alert; " : "60-second alert; ";
}

const outcomeWords: Record<string, string> = {
  watching: "watching for the side",
  traded: "bought the leg",
  "would-trade": "would buy the leg (dry run)",
  no_side: "no side in time",
  no_expiry: "no expiry today, the next session or later this week",
  no_strikes: "no strikes near the stock",
  no_prices: "no prices",
  too_cheap: "the leg is too cheap",
  thin: "the leg is too thin",
  too_small: "the size buys no contract",
  max_trades: "the day's trades are used",
  max_open: "too many trades open",
  day_loss: "the day's loss limit is reached",
  earnings: "skipped, earnings reaction day",
  premarket: "skipped, pre-market volume 4× normal or more",
  strength: "skipped, the strength disagrees with the side",
  slow_cross: "no side fast enough after the alert",
  burst: "skipped, the burst before the alert is not the side's way",
  wide_spread: "skipped, the leg's spread is over 30% of its mid",
  refused: "refused by the risk rules",
  error: "failed",
};

export class StrangleBot {
  private readonly o: Required<Omit<StrangleOptions, "earnings">> & {
    earnings?: StrangleOptions["earnings"];
  };
  private day: string | null = null;
  private symbols: string[] = [];
  private hist = new Map<string, Windows[]>();
  private prior = new Map<string, Prior>();
  private unit = new Map<string, number | null>();
  // Today's watched stocks with no expiry the rule can use (expiryFor).
  private noExpiry = new Set<string>();
  private priorClose = new Map<string, number>();
  private openClose = new Map<string, Map<string, { o: number; c: number }>>();
  private priorDays: string[] = [];
  private today = new Map<string, Map<number, MinuteBar>>();
  private done = -1;
  private busy = false;
  // Trades whose leg is being bought (the 10-second tick and the 1-second watch both look).
  private entering = new Set<string>();
  private summarized: string | null = null;
  private lastWork: number | null = null;
  private dayStartEquity: number | null = null;
  private reports: EarningsReport[] | null = null;
  private earningsState: NewsState = "off";
  private preRatio = new Map<string, number | null>();
  private preState: NewsState = "off";
  // Every watched stock's alert checks at the last closed minute (the app's map).
  private scanned: StrangleScanRow[] = [];
  // Each open trade's live marks, for the status (not stored).
  // The 60-second alert (strangle/fast.ts): today's 10-second tape, each
  // stock's 20-session medians once its history is in, its crossing state.
  private tape: FastTape | null = null;
  private fastBase = new Map<string, FastBaseline>();
  private fastFire = new Map<string, FastFire>();
  private shockFire = new Map<string, FastFire>();
  // A shock trade's side seen on consecutive 1-second checks: bought at 5.
  private holds = new Map<string, { side: Leg; n: number }>();
  private fastDone = new Map<string, number>();
  private fastBusy = false;
  private marks = new Map<
    string,
    { leg: number | null; stock: number | null; at: number }
  >();

  constructor(options: StrangleOptions) {
    this.o = { now: Date.now, log: () => {}, ...options };
  }

  // ---- settings ----

  settings(): StrangleSettings {
    const saved = this.o.store.setting("settings");
    return saved
      ? strangleWithDefaults(JSON.parse(saved))
      : { ...defaultStrangleSettings };
  }

  setSettings(next: StrangleSettings): StrangleSettings {
    const before = this.settings();
    this.o.store.setSetting("settings", JSON.stringify(next));
    const changed = (Object.keys(next) as (keyof StrangleSettings)[])
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]))
      .map(
        (k) => `${k} ${JSON.stringify(before[k])} → ${JSON.stringify(next[k])}`,
      );
    if (changed.length)
      this.event("info", `Settings changed: ${changed.join("; ")}`);
    return this.settings();
  }

  /** The favorites list, sent by the site before each session. */
  setWatchlist(name: string, tickers: string[]): string[] {
    const clean = [
      ...new Set(
        tickers
          .map((t) => t.toUpperCase())
          .filter((t) => /^[A-Z.]{1,6}$/.test(t) && t !== "SPY"),
      ),
    ];
    const before = this.o.store.setting("watchlist");
    this.o.store.setSetting(
      "watchlist",
      JSON.stringify({ name, tickers: clean, at: this.o.now() }),
    );
    const was = before ? (JSON.parse(before) as { tickers: string[] }) : null;
    if (!was || was.tickers.join() !== clean.join())
      this.event(
        "info",
        `Favorites list "${name}" received: ${clean.length} stocks`,
      );
    return clean;
  }

  private watchlist(): { name: string; tickers: string[]; at: number } | null {
    const saved = this.o.store.setting("watchlist");
    return saved ? JSON.parse(saved) : null;
  }

  private event(kind: StrangleEventKind, text: string) {
    this.o.store.addEvent(this.o.now(), kind, text);
    this.o.log(`strangle: ${text}`);
  }

  private words(contract: string): string {
    return contractWords(contract, newYork(this.o.now()).date);
  }

  // ---- the loop ----

  /** Called every few seconds; each closed minute's entries once, the trades every tick. */
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
    const closeMinute = close - 570;
    if (wall < 565 || wall > close + 15) return;
    this.lastWork = now;
    const s = this.settings();
    if (this.day !== date) await this.warmUp(date);
    if (this.preState === "pending" && wall >= 570)
      await this.loadPremarket(date);
    const last = Math.min(wall - 570 - 1, closeMinute - 1);
    await this.settle();
    if (last > this.done && last >= 0) {
      await this.refresh(date, Math.max(0, this.done - 2), last);
      for (let m = Math.max(this.done + 1, last - 2); m <= last; m++)
        if (s.enabled) await this.entries(date, m);
      this.done = last;
    }
    // Every tick: the minute's bars arrive a few seconds after it closes.
    if (last >= 0) this.scanned = this.scan(last);
    // The minute-close exit reads the open trades' last closed minute: fetch
    // it again until it is in, so a sale is not a minute late.
    if (s.exitOnMinuteClose && last >= 0) {
      const missing = [
        ...new Set(
          this.o.store
            .openTrades()
            .filter((t) => t.phase === "open" && t.day === date)
            .map((t) => t.symbol)
            .filter((sym) => !this.today.get(sym)?.has(last)),
        ),
      ];
      if (missing.length)
        await this.refreshSome(missing, date, Math.max(0, last - 2), last);
    }
    // The trades every tick (10 s), on the stock's last trade and fresh quotes.
    const current = Math.min(wall - 570, closeMinute - 1);
    const end = Math.min(s.endMinute, closeMinute - 30);
    if (current >= 0)
      await this.manage(date, current, { ...s, endMinute: end });
    if (wall >= close + 5 && this.summarized !== date) {
      this.summarized = date;
      await this.summary(date);
    }
  }

  /**
   * Called every second: the stocks waiting for their side, on their last
   * trade, so the leg is bought within seconds of the stock crossing the line,
   * not at the next 10-second tick (backtest: leg_seconds.py, 2026-10-27).
   */
  async watchSides(): Promise<void> {
    if (this.day === null || !this.o.market.lastPrices) return;
    const { date, minute: wall } = newYork(this.o.now());
    const close = coreClose(date);
    if (close === null || date !== this.day) return;
    const closeMinute = close - 570;
    const m = Math.min(wall - 570, closeMinute - 1);
    if (m < 0) return;
    const waiting = this.o.store
      .openTrades()
      .filter(
        (t) =>
          t.phase === "watching" &&
          t.day === date &&
          !this.pending(t) &&
          !this.entering.has(t.id),
      );
    if (!waiting.length) return;
    const saved = this.settings();
    const s = {
      ...saved,
      endMinute: Math.min(saved.endMinute, closeMinute - 30),
    };
    let prices: Map<string, number>;
    try {
      prices = await this.o.market.lastPrices([
        ...new Set(waiting.map((t) => t.symbol)),
      ]);
    } catch {
      return; // the tick checks again within 10 seconds
    }
    try {
      for (const t of waiting) {
        const stock = prices.get(t.symbol);
        if (this.tooLate(t, s)) {
          this.slowCross(t, s);
          continue;
        }
        // Past the wait or the end the tick closes it; only the side here.
        if (!stock || waitedOut(m, t.alertMinute, s) || m >= s.endMinute)
          continue;
        const side = sideOf(stock, t.stockRef, t.unit, s);
        if (t.shock) {
          // The shock buys once the side has held 5 checks in a row (leg_seconds.py hold5).
          const held = this.holds.get(t.id);
          const n = side && held?.side === side ? held.n + 1 : 1;
          if (side) this.holds.set(t.id, { side, n });
          else this.holds.delete(t.id);
          if (side && n >= shockHoldChecks)
            await this.enter(t.id, side, m, stock, s);
          continue;
        }
        if (side) await this.enter(t.id, side, m, stock, s);
      }
    } catch (error) {
      this.event(
        "error",
        `Side watch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Called every 2 seconds: the 60-second alert (F60x2) and the shock alert
   * (the same rule at 15x). Reads the stocks' new trades into today's
   * 10-second bars, checks each finished slot in order, and on a fresh alert
   * in the rule's hours watches the stock for its side, as a minute alert does.
   */
  async watchFast(): Promise<void> {
    const tape = this.tape;
    const date = this.day;
    if (this.fastBusy || !tape || date === null) return;
    const s = this.settings();
    if (!s.fastAlert && !s.shockAlert) return;
    const now = this.o.now();
    if (newYork(now).date !== date || now < tape.openMs) return;
    this.fastBusy = true;
    try {
      await tape.poll(this.o.market, now);
      // A slot is checked 3 seconds after it ends, once its trades are in.
      const ready = Math.min(
        Math.floor((tape.cursor - 3_000 - tape.openMs) / 10_000) - 1,
        fastRule.slots - 1,
      );
      for (const symbol of this.symbols) {
        const base = this.fastBase.get(symbol);
        const done = this.fastDone.get(symbol) ?? -1;
        if (!base || ready <= done) continue;
        const day = tape.day(symbol);
        const cf = carried(day.c);
        const cum = paceSums(day.v);
        let fire = this.fastFire.get(symbol);
        if (!fire) this.fastFire.set(symbol, (fire = new FastFire()));
        let shock = this.shockFire.get(symbol);
        if (!shock) this.shockFire.set(symbol, (shock = new FastFire()));
        const rules = [
          { rule: fastRule, fire, on: s.fastAlert, isShock: false },
          { rule: shockRule, fire: shock, on: s.shockAlert, isShock: true },
        ];
        for (let t = done + 1; t <= ready; t++) {
          for (const r of rules) {
            if (!r.on) continue;
            const st = fastState(day, cf, base, t, cum, r.rule);
            if (!r.fire.step(t, st.on)) continue;
            if (t < r.rule.firstSlot || t > r.rule.lastSlot) continue;
            const second = (t + 1) * 10;
            // A slot passed while catching up (a start mid-session): no trade.
            if (this.sessionSecond() - second > 30) continue;
            await this.fastEntry(
              date,
              symbol,
              second,
              cf[t]!,
              st.up,
              s,
              r.isShock,
            );
          }
        }
        this.fastDone.set(symbol, ready);
      }
    } catch (error) {
      this.event(
        "error",
        `60-second alert failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.fastBusy = false;
    }
  }

  private async fastEntry(
    date: string,
    symbol: string,
    second: number,
    price: number,
    up: boolean,
    s: StrangleSettings,
    shock = false,
  ) {
    if (!s.enabled) return;
    if (this.o.store.openTrades().some((t) => t.symbol === symbol)) return;
    let traded = 0;
    for (const t of this.o.store.recentTrades(date))
      if (t.day === date && t.symbol === symbol && t.leg && t.leg.bought > 0)
        traded++;
    if (traded >= s.maxPerStock) return;
    const minute = Math.floor(second / 60);
    const side = up ? "up" : "down";
    // One alert a stock a minute: a minute alert of the same minute keeps it.
    const added = this.o.store.addSignal({
      day: date,
      symbol,
      minute,
      side,
      outcome: "",
      detail: "",
      at: this.o.now(),
    });
    if (!added) return;
    const clock = `${clockOf(Math.floor(second / 60))}:${String(second % 60).padStart(2, "0")}`;
    const name = shock ? "shock alert" : "60-second volume alert";
    this.event("signal", `${symbol}: ${name} ${side} at ${clock}`);
    try {
      const r = await this.watch(date, symbol, minute, side, s, {
        second,
        price,
        shock,
      });
      this.outcome(date, symbol, r.outcome, r.detail);
    } catch (error) {
      this.outcome(
        date,
        symbol,
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * The 60-second alert's history: each stock's 20 prior sessions in
   * 10-second bars, from the store or fetched once from its trades; a stock's
   * alert starts once all 20 are in.
   */
  private async fillFast(date: string) {
    const s = this.settings();
    if (!this.o.market.trades || (!s.fastAlert && !s.shockAlert)) return;
    const days = previousSessions(date, fastRule.days);
    const queue = [...this.symbols];
    let ready = 0;
    let failed = 0;
    const one = async (symbol: string) => {
      const prior: FastWindows[] = [];
      for (const d of days) {
        if (this.day !== date) return;
        let w = this.o.store.fastDay(symbol, d);
        const close = coreClose(d);
        if (!w && close !== null) {
          const got = await fetchFastDay(
            this.o.market,
            symbol,
            newYorkToUtc(d, 570),
            newYorkToUtc(d, close),
            fastWindows,
          );
          if (got) {
            this.o.store.saveFastDay(symbol, d, got);
            w = got;
          }
        }
        if (w) prior.push(w);
      }
      const base = fastBaseline(prior);
      if (base && this.day === date) {
        this.fastBase.set(symbol, base);
        ready++;
      }
    };
    const worker = async () => {
      for (let symbol = queue.shift(); symbol; symbol = queue.shift())
        await one(symbol).catch(() => {
          failed++;
        });
    };
    await Promise.all([worker(), worker(), worker()]);
    if (this.day === date)
      this.event(
        "info",
        `60-second alert: 20 sessions of 10-second bars in for ${ready} of ${this.symbols.length} stocks${failed ? ` (${failed} failed, again at the next start)` : ""}`,
      );
  }

  /** Buys the side's leg once, whichever loop saw the side first. */
  private async enter(
    id: string,
    side: Leg,
    m: number,
    stock: number,
    s: StrangleSettings,
  ) {
    if (this.entering.has(id)) return;
    this.entering.add(id);
    try {
      const t = this.o.store.openTrades().find((x) => x.id === id);
      if (t?.phase !== "watching") return;
      await this.buyLeg(t, side, m, stock, s);
    } finally {
      this.entering.delete(id);
    }
  }

  private async warmUp(date: string) {
    const s = this.settings();
    this.symbols = strangleStocks(s, this.watchlist()?.tickers ?? []);
    const days = previousSessions(date, 20);
    const bars = await this.o.market.sessions([...this.symbols, "SPY"], days);
    const spy = bars.get("SPY") ?? new Map<string, MinuteBar[]>();
    this.hist.clear();
    this.prior.clear();
    this.unit.clear();
    this.priorClose.clear();
    this.openClose.clear();
    this.priorDays = days;
    for (const sym of this.symbols) {
      const byDay = bars.get(sym) ?? new Map<string, MinuteBar[]>();
      this.hist.set(
        sym,
        days.map((d) => windows(byDay.get(d) ?? [])),
      );
      this.prior.set(
        sym,
        priorFrom(
          days.map((d) => ({
            stock: byDay.get(d) ?? [],
            spy: spy.get(d) ?? [],
          })),
        ),
      );
      this.unit.set(
        sym,
        priorLevels(days.slice(-5).map((d) => byDay.get(d) ?? []))?.unit ??
          null,
      );
      const oc = new Map<string, { o: number; c: number }>();
      for (const [d, list] of byDay)
        if (list.length) oc.set(d, { o: list[0]!.o, c: list.at(-1)!.c });
      this.openClose.set(sym, oc);
      const lastDay = byDay.get(days.at(-1)!);
      if (lastDay?.length) this.priorClose.set(sym, lastDay.at(-1)!.c);
    }
    this.today.clear();
    this.scanned = [];
    this.done = -1;
    this.day = date;
    this.dayStartEquity = await this.o.trading.equity().catch(() => null);
    this.event(
      "info",
      `Ready for ${date}: watching ${this.symbols.length} stocks${this.watchlist() ? ` (favorites "${this.watchlist()!.name}"${s.added.length ? ` and ${s.added.length} of yours` : ""})` : ""}; ${s.mode === "dry" ? "dry run" : "live"}, ${s.enabled ? "on" : "off"}`,
    );
    this.preRatio.clear();
    this.preState = this.o.market.premarket ? "pending" : "off";
    await this.loadEarnings(date);
    // In the background: one chain read a stock, so the warm-up does not wait.
    this.noExpiry = new Set();
    void this.findNoExpiry(date, s);
    this.tape = null;
    this.fastBase.clear();
    this.fastFire.clear();
    this.shockFire.clear();
    this.holds.clear();
    this.fastDone.clear();
    const closeAt = coreClose(date);
    if (this.o.market.trades && closeAt !== null) {
      this.tape = new FastTape(
        [...this.symbols],
        newYorkToUtc(date, 570),
        newYorkToUtc(date, closeAt),
      );
      void this.fillFast(date);
    }
  }

  private async loadEarnings(date: string) {
    this.reports = null;
    if (!this.o.earnings) {
      this.earningsState = "off";
      return;
    }
    try {
      const rows: EarningsReport[] = [];
      for (const d of reportDates(date, previousSessions(date, 1)[0]!))
        rows.push(...(await this.o.earnings(d)));
      const watched = new Set(this.symbols);
      this.reports = rows.filter((r) => watched.has(r.symbol));
      this.earningsState = "ok";
    } catch (error) {
      this.earningsState = "failed";
      this.event(
        "error",
        `Earnings calendar failed (${error instanceof Error ? error.message : String(error)}): trading today without the earnings filter`,
      );
    }
  }

  private async loadPremarket(date: string) {
    try {
      const got = await this.o.market.premarket!(this.symbols, [
        ...this.priorDays,
        date,
      ]);
      for (const sym of this.symbols) {
        const byDay = got.get(sym);
        this.preRatio.set(
          sym,
          premarketRatio(
            byDay?.get(date),
            this.priorDays.map((d) => byDay?.get(d)),
          ),
        );
      }
      this.preState = "ok";
    } catch (error) {
      this.preState = "failed";
      this.event(
        "error",
        `Pre-market volume failed (${error instanceof Error ? error.message : String(error)}): trading today without the pre-market filter`,
      );
    }
  }

  private gap(symbol: string, date: string, today: string): number | null {
    if (date === today) {
      const open = this.barsOf(symbol)[0]?.o;
      const before = this.priorClose.get(symbol);
      return open === undefined || before === undefined
        ? null
        : Math.abs(open / before - 1);
    }
    const oc = this.openClose.get(symbol);
    const d = oc?.get(date);
    const before = oc?.get(previousSessions(date, 1)[0]!);
    return d && before ? Math.abs(d.o / before.c - 1) : null;
  }

  private newsBlock(
    date: string,
    symbol: string,
    s: StrangleSettings,
  ): { outcome: string; detail: string } | null {
    if (this.reports && s.skipEarnings) {
      const report = reactionReport(
        this.reports.filter((r) => r.symbol === symbol),
        date,
        newsCalendar,
        (d) => this.gap(symbol, d, date),
      );
      if (report)
        return { outcome: "earnings", detail: `report listed ${report.date}` };
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
    const got = await this.o.market.bars(
      [...this.symbols, "SPY"],
      date,
      from,
      to,
    );
    for (const [sym, list] of got) {
      let byMinute = this.today.get(sym);
      if (!byMinute) this.today.set(sym, (byMinute = new Map()));
      for (const b of list) byMinute.set(b.m, b);
    }
  }

  private async refreshSome(
    symbols: string[],
    date: string,
    from: number,
    to: number,
  ) {
    try {
      const got = await this.o.market.bars(symbols, date, from, to);
      for (const [sym, list] of got) {
        let byMinute = this.today.get(sym);
        if (!byMinute) this.today.set(sym, (byMinute = new Map()));
        for (const b of list) byMinute.set(b.m, b);
      }
    } catch {
      // the next tick asks again
    }
  }

  private barsOf(symbol: string): MinuteBar[] {
    return [...(this.today.get(symbol)?.values() ?? [])].sort(
      (a, b) => a.m - b.m,
    );
  }

  private lastClose(symbol: string, m: number): number | null {
    return (
      this.barsOf(symbol)
        .filter((b) => b.m <= m)
        .at(-1)?.c ?? null
    );
  }

  /** Every watched stock's alert checks at minute m, closest to an alert first. */
  private scan(m: number): StrangleScanRow[] {
    const rows: StrangleScanRow[] = [];
    for (const symbol of this.symbols) {
      const hist = this.hist.get(symbol);
      if (!hist) continue;
      // The latest minute with its whole window, at most two back: the last
      // closed minute's bar may not be in yet.
      const bars = this.barsOf(symbol);
      let got = null;
      for (let k = m; k >= m - 2 && !got; k--) got = measureAt(bars, hist, k);
      if (got) rows.push({ symbol, ...got });
    }
    return rows.sort((a, b) => alertCloseness(b) - alertCloseness(a));
  }

  // ---- the alert: watch for the side ----

  private async entries(date: string, m: number) {
    const s = this.settings();
    if (m < s.firstMinute || m > s.lastMinute) return;
    // A stock is busy while a trade of it is watching, buying, open or
    // closing; it is done for the day once it took maxPerStock trades.
    const busy = new Set(this.o.store.openTrades().map((t) => t.symbol));
    const traded = new Map<string, number>();
    for (const t of this.o.store.recentTrades(date))
      if (t.day === date && t.leg && t.leg.bought > 0)
        traded.set(t.symbol, (traded.get(t.symbol) ?? 0) + 1);
    for (const symbol of this.symbols) {
      if (busy.has(symbol)) continue;
      if ((traded.get(symbol) ?? 0) >= s.maxPerStock) continue;
      const hist = this.hist.get(symbol);
      if (!hist) continue;
      // A new burst at m: an alert now and none the minute before (the day's
      // first counts from firstMinute), as leg_twice.py counted them.
      const sides = alerts(this.barsOf(symbol), hist);
      const now = sides[m];
      if (!now) continue;
      const first = firstAlert(sides, s.firstMinute, m);
      const isFirst = first !== null && first.minute === m;
      if (!isFirst && sides[m - 1]) continue;
      const added = this.o.store.addSignal({
        day: date,
        symbol,
        minute: m,
        side: now,
        outcome: "",
        detail: "",
        at: this.o.now(),
      });
      if (!added) continue;
      this.event("signal", `${symbol}: volume alert ${now} at ${clockOf(m)}`);
      try {
        const r = await this.watch(date, symbol, m, now, s);
        this.outcome(date, symbol, r.outcome, r.detail);
      } catch (error) {
        this.outcome(
          date,
          symbol,
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private outcome(
    date: string,
    symbol: string,
    outcome: string,
    detail: string,
  ) {
    this.o.store.updateSignal(date, symbol, outcome, detail);
    const kind: StrangleEventKind =
      outcome === "traded" || outcome === "would-trade"
        ? "order"
        : outcome === "watching"
          ? "info"
          : "skip";
    this.event(
      kind,
      `${symbol}: ${outcomeWords[outcome] ?? outcome}${detail ? ` (${detail})` : ""}`,
    );
  }

  private async limit(
    date: string,
    s: StrangleSettings,
  ): Promise<{ outcome: string; detail: string } | null> {
    const dry = s.mode === "dry";
    const traded = this.o.store
      .recentTrades(date)
      .filter(
        (t) =>
          t.day === date && t.dry === dry && t.leg !== null && t.leg.bought > 0,
      ).length;
    if (traded >= s.maxTradesPerDay)
      return { outcome: "max_trades", detail: `${traded} today` };
    const open = this.o.store
      .openTrades()
      .filter((t) => t.dry === dry && t.leg !== null).length;
    if (open >= s.maxOpen)
      return { outcome: "max_open", detail: `${open} open` };
    if (!dry && this.dayStartEquity && this.dayStartEquity > 0) {
      const equity = await this.o.trading.equity();
      const down = ((this.dayStartEquity - equity) / this.dayStartEquity) * 100;
      if (down >= s.dayLossPct)
        return {
          outcome: "day_loss",
          detail: `the account is down ${down.toFixed(1)}% today`,
        };
    }
    return null;
  }

  /** The alert came: check what can be checked now, then watch the stock for the side. */
  private async watch(
    date: string,
    symbol: string,
    m: number,
    side: "up" | "down",
    s: StrangleSettings,
    fast?: { second: number; price: number; shock?: boolean },
  ): Promise<{ outcome: string; detail: string }> {
    const blocked = this.newsBlock(date, symbol, s);
    if (blocked) return blocked;
    const unit = this.unit.get(symbol);
    if (!unit)
      return {
        outcome: "no_prices",
        detail: "fewer than 5 sessions of history",
      };
    // An expiry today, or (1DTE, when the setting allows) the next session's
    // when there is none today; none of them ends it now.
    const expiry = await this.expiryFor(symbol, date, s);
    if (!expiry) return { outcome: "no_expiry", detail: "" };
    // The shock alert: an expiry at most 2 calendar days out (volume-bot.md
    // 2026-10-30: its 3-4 DTE trades lost in both halves).
    if (fast?.shock && daysBetween(date, expiry) > 2)
      return {
        outcome: "no_expiry",
        detail: "the shock alert trades an expiry at most 2 days out",
      };
    // The 60-second alert was tested on 0/1 DTE only.
    if (fast && !fast.shock && expiry > nextSession(date))
      return {
        outcome: "no_expiry",
        detail:
          "the 60-second alert trades a same-day or next-session expiry only",
      };
    // The side lines start at the alert minute's close, as the backtest's
    // (leg_seconds.py stock0), not at a trade read seconds later: a print a few
    // cents off moves both lines and can pick the other side (the replay of
    // 2026-10-08, CRM). The latest trade only when that bar is missing.
    // The 60-second alert's lines start at its 10-second bar's close.
    const ref =
      fast?.price ??
      this.barsOf(symbol).find((b) => b.m === m)?.c ??
      (await this.stockNow(symbol, m));
    if (ref === null) return { outcome: "no_prices", detail: "no stock price" };
    const burst = fast
      ? burstAtSecond(this.barsOf(symbol), fast.second, fast.price, unit)
      : burstOf(this.barsOf(symbol), m, unit);
    const trade: StrangleTrade = {
      id: randomUUID(),
      day: date,
      symbol,
      alertMinute: m,
      alertSide: side,
      unit,
      stockRef: ref,
      burst,
      ...(fast ? { alertSecond: fast.second, fast: true } : {}),
      ...(fast?.shock ? { shock: true } : {}),
      side: null,
      sideMinute: null,
      best: null,
      leg: null,
      expiry,
      phase: "watching",
      closeReason: null,
      dry: s.mode === "dry",
      openedAt: this.o.now(),
      closedAt: null,
    };
    this.o.store.saveTrade(trade);
    const pct = (s.confirmUnits * unit * 100).toFixed(2);
    return {
      outcome: "watching",
      detail: `${alertWords(fast)}stock ${ref.toFixed(2)}; the side at ${pct}% either way${burst === null ? "" : `; burst ${burst.toFixed(2)}×`}${expiry === date ? "" : expiry === nextSession(date) ? "; 1DTE" : `; expiry ${expiry}`}`,
    };
  }

  /** The watched stocks with no usable expiry today, for the activity map. */
  private async findNoExpiry(date: string, s: StrangleSettings) {
    for (const symbol of this.symbols) {
      if (this.day !== date) return;
      const expiry = await this.expiryFor(symbol, date, s).catch(
        () => undefined,
      );
      if (expiry === null) this.noExpiry.add(symbol);
    }
  }

  /** The day's expiry: today's, else the next session's when nextDay is on. */
  private async expiryFor(
    symbol: string,
    date: string,
    s: StrangleSettings,
  ): Promise<string | null> {
    const next = nextSession(date);
    const chain = await this.o.trading.chain(
      symbol,
      "call",
      date,
      s.nextDay ? next : date,
    );
    if (chain.some((q) => q.expiry === date)) return date;
    if (s.nextDay && chain.some((q) => q.expiry === next)) return next;
    if (!s.weekExpiry) return null;
    // The nearest expiry later this week (2-4 DTE), never past its last session.
    const end = weekEnd(date);
    if (end <= next) return null;
    const week = await this.o.trading.chain(symbol, "call", next, end);
    const later = [...new Set(week.map((q) => q.expiry))]
      .filter((e) => e > next && e <= end)
      .sort();
    return later[0] ?? null;
  }

  // ---- orders: the fills, as the account reports them ----

  private pending(t: StrangleTrade): boolean {
    return (t.leg?.orders ?? []).some((o) => o.jobId !== null && !o.settled);
  }

  private async settle() {
    for (const t of this.o.store.openTrades()) {
      if (t.dry || !t.leg) continue;
      const leg = t.leg;
      let changed = false;
      for (const o of leg.orders) {
        if (o.settled || !o.jobId) continue;
        const job = this.o.trading.job(o.jobId);
        if (job.state === "running") continue;
        const held = await this.o.trading.held(leg.contract);
        const now = held?.qty ?? 0;
        if (o.side === "buy") {
          const filled = Math.max(0, now - leg.qty);
          const price = priceOf(job.result) ?? held?.avgEntryPrice ?? leg.cost;
          o.qty = filled;
          o.price = price;
          const fillBook = lastBookOf(job.result, this.o.now(), "alpaca");
          if (fillBook) o.fillBook = fillBook;
          leg.bought += filled;
          leg.qty = now;
          if (held) leg.cost = held.avgEntryPrice;
          this.event(
            "order",
            filled > 0
              ? `Bought ${filled} ${t.symbol} ${this.words(leg.contract)} at ${price.toFixed(2)}`
              : `${t.symbol} ${this.words(leg.contract)}: the buy did not fill`,
          );
        } else {
          const sold = soldOf(job.result);
          o.qty = sold;
          const price = priceOf(job.result);
          if (price !== null) o.price = price;
          const fillBook = lastBookOf(job.result, this.o.now(), "alpaca");
          if (fillBook) o.fillBook = fillBook;
          leg.qty = Math.max(0, Math.min(leg.qty - sold, now));
          this.event(
            "order",
            `Sold ${sold} ${t.symbol} ${this.words(leg.contract)} (${o.reason}); ${leg.qty} left`,
          );
        }
        o.settled = true;
        changed = true;
      }
      // A stop or a sale by hand: the bot never counts more than the account holds.
      if (!this.pending(t) && leg.qty > 0) {
        const held = await this.o.trading.held(leg.contract);
        if ((held?.qty ?? 0) < leg.qty) {
          this.event(
            "info",
            `${t.symbol} ${this.words(leg.contract)}: the account holds ${held?.qty ?? 0}, so the bot counts that`,
          );
          leg.qty = held?.qty ?? 0;
          changed = true;
        }
      }
      if (t.phase === "buying" && !this.pending(t)) {
        if (leg.qty > 0) {
          t.phase = "open";
          t.best = (await this.stockNow(t.symbol, null)) ?? t.best;
        } else {
          t.phase = "closed";
          t.closeReason = "the buy did not fill";
          t.closedAt = this.o.now();
        }
        changed = true;
      }
      if (
        (t.phase === "open" || t.phase === "closing") &&
        !this.pending(t) &&
        leg.qty === 0
      ) {
        t.phase = "closed";
        t.closedAt = this.o.now();
        t.closeReason ??= "sold";
        changed = true;
        const { paid, got } = tradeCash(t);
        this.event(
          "order",
          `${t.symbol} closed: paid ${paid.toFixed(0)}, got ${got.toFixed(0)} (${paid > 0 ? ((got / paid - 1) * 100).toFixed(0) : "—"}%)`,
        );
      }
      if (changed) this.o.store.saveTrade(t);
    }
  }

  /**
   * The call and the put a watching trade would pick if the side came now:
   * the delta closest to the setting's, of the trade's expiry, without the
   * price and volume checks (the price recorder quotes both while it watches).
   */
  async watchLegs(
    id: string,
  ): Promise<{ call: string | null; put: string | null }> {
    const t = this.o.store.openTrades().find((x) => x.id === id);
    if (!t) return { call: null, put: null };
    const stock = await this.stockNow(t.symbol, null);
    if (stock === null) throw new Error(`no price for ${t.symbol}`);
    const s = this.settings();
    const expiry = t.expiry ?? t.day;
    const dte = Math.round(
      (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${t.day}T00:00:00Z`)) /
        86_400_000,
    );
    const pick = {
      delta: s.delta,
      dteMin: dte,
      dteMax: dte,
      otmScanMax: 0.2,
      maxStrikes: 16,
      minPrice: 0,
      minVolume30: 0,
      cheapFallback: false,
    };
    const one = async (right: "call" | "put") => {
      const quotes = await this.o.trading.chain(
        t.symbol,
        right,
        expiry,
        expiry,
      );
      const got = pickContract(quotes, stock, right, t.day, pick);
      return (got as { quote?: OptionQuote }).quote?.symbol ?? null;
    };
    const [call, put] = await Promise.all([one("call"), one("put")]);
    return { call, put };
  }

  // ---- the trades: the side, the buy, the give-back ----

  private async stockNow(
    symbol: string,
    m: number | null,
  ): Promise<number | null> {
    if (this.o.market.lastPrices) {
      try {
        const got = (await this.o.market.lastPrices([symbol])).get(symbol);
        if (got && got > 0) return got;
      } catch {
        // the last closed minute below
      }
    }
    return this.lastClose(symbol, m ?? 389);
  }

  private async mark(
    contract: string,
  ): Promise<{ mid: number; ask: number; bid: number } | null> {
    try {
      const q = await this.o.trading.quote(contract);
      if (!(q.bid >= 0) || !(q.ask > 0)) return null;
      return { mid: (q.bid + q.ask) / 2, ask: q.ask, bid: q.bid };
    } catch {
      return null;
    }
  }

  /** Seconds since 09:30 New York now. */
  private sessionSecond(): number {
    const now = this.o.now();
    return (newYork(now).minute - 570) * 60 + (Math.floor(now / 1000) % 60);
  }

  /** Seconds from the alert to now: a minute alert is read at its minute's close, the 60-second one at its own second. */
  private lateBy(t: StrangleTrade): number {
    return this.sessionSecond() - (t.alertSecond ?? (t.alertMinute + 1) * 60);
  }

  /**
   * With the cross filter, the side has to come within crossMaxSeconds of the
   * alert; a shock trade's side has to hold within shockHoldWithin seconds.
   */
  private tooLate(t: StrangleTrade, s: StrangleSettings): boolean {
    if (t.shock) return this.lateBy(t) > shockHoldWithin;
    return s.crossFilter && this.lateBy(t) > s.crossMaxSeconds;
  }

  /** The cross filter: no side within crossMaxSeconds of the alert ends the watch. */
  private slowCross(t: StrangleTrade, s: StrangleSettings) {
    this.close(t, "no side fast enough after the alert");
    this.o.store.updateSignal(t.day, t.symbol, "slow_cross", "");
    const within = t.shock ? shockHoldWithin : s.crossMaxSeconds;
    this.event(
      "skip",
      `${t.symbol}: no side within ${within} s of the alert, no trade`,
    );
  }

  private close(t: StrangleTrade, reason: string) {
    t.phase = "closed";
    t.closeReason = reason;
    t.closedAt = this.o.now();
    this.o.store.saveTrade(t);
  }

  private async manage(date: string, m: number, s: StrangleSettings) {
    for (const t of this.o.store.openTrades()) {
      if (
        t.phase === "buying" ||
        t.phase === "closing" ||
        this.pending(t) ||
        this.entering.has(t.id)
      )
        continue;
      const stock = await this.stockNow(t.symbol, m);
      if (t.phase === "watching") {
        // The stock's price for the app's side gauge (not stored).
        this.marks.set(t.id, { leg: null, stock, at: this.o.now() });
        if (t.day !== date) {
          this.close(t, "no side in time");
          continue;
        }
        if (this.tooLate(t, s)) {
          this.slowCross(t, s);
          continue;
        }
        const side =
          stock !== null ? sideOf(stock, t.stockRef, t.unit, s) : null;
        // A shock trade is bought by the 1-second watch, once its side holds.
        if (side && !t.shock) {
          await this.enter(t.id, side, m, stock!, s);
          continue;
        }
        if (waitedOut(m, t.alertMinute, s) || m >= s.endMinute) {
          this.close(t, "no side in time");
          this.o.store.updateSignal(t.day, t.symbol, "no_side", "");
          this.event(
            "skip",
            `${t.symbol}: no side within ${s.waitMinutes} minutes, no trade`,
          );
        }
        continue;
      }
      if (t.phase !== "open" || !t.leg || !t.side) continue;
      const lm = await this.mark(t.leg.contract);
      this.marks.set(t.id, { leg: lm?.mid ?? null, stock, at: this.o.now() });
      // Never carried, 1DTE legs too (sold by endMinute). Anything left from a past day is sold now.
      if (t.day !== date) {
        await this.sellLeg(t, "left from a past day", lm);
        continue;
      }
      const held = m - (t.sideMinute ?? m);
      let exit: "giveback" | "end" | null;
      if (s.exitOnMinuteClose) {
        // The backtest's walk: the best and the give-back on closed minutes.
        const got = minuteCloseExit(
          this.barsOf(t.symbol).filter((b) => b.m < m),
          t.stockAtBuy ?? t.best ?? stock ?? 0,
          t.side,
          t.unit,
          t.sideMinute ?? m,
          m,
          s,
        );
        t.best = got.best;
        exit = got.exit;
      } else {
        if (stock !== null) t.best = bestOf(t.best ?? stock, stock, t.side);
        exit = giveBackExit(
          stock ?? 0,
          t.best ?? 0,
          t.side,
          t.unit,
          m,
          s,
          held,
          s.noStopMinutes,
        );
      }
      if (exit) {
        const closeWords = s.exitOnMinuteClose ? " (a minute close)" : "";
        const reason =
          exit === "end"
            ? `the end of the day (${clockOf(s.endMinute)})`
            : `the stock gave back ${s.giveBackUnits} of its 30-minute move from ${t.best!.toFixed(2)}${closeWords}`;
        await this.sellLeg(t, reason, lm);
        continue;
      }
      this.o.store.saveTrade(t);
    }
  }

  /** The liquid fallback: the first strike in liquidOrder's order with enough volume, or null. */
  private async liquidLeg(
    quotes: OptionQuote[],
    stock: number,
    right: "call" | "put",
    expiry: string,
    picked: { quote: OptionQuote; delta: number },
    rules: { otmScanMax: number; maxStrikes: number; minPrice: number },
    day: string,
    minute: number,
    minVolume: number,
  ): Promise<{ quote: OptionQuote; mid: number; delta: number } | null> {
    for (const c of liquidOrder(quotes, stock, right, expiry, picked, rules)) {
      const volume = await this.o.market.optionVolume30(
        c.quote.symbol,
        day,
        minute,
      );
      if (volume >= minVolume) return c;
    }
    return null;
  }

  /** The side came: pick that leg and buy it, or end the trade with why not. */
  /**
   * The leg at one delta: the pick, the picked leg's book kept with the
   * signal, then the volume check with the liquid fallback.
   */
  private async legAt(
    t: StrangleTrade,
    quotes: OptionQuote[],
    stock: number,
    right: "call" | "put",
    expiry: string,
    dte: number,
    delta: number,
    m: number,
    s: StrangleSettings,
  ): Promise<
    | {
        ok: true;
        got: Extract<Picked, { ok: true }>;
        fallback: string;
        book: ReturnType<typeof bookOf>;
      }
    | { ok: false; outcome: string; detail: string }
  > {
    const pick = {
      delta,
      dteMin: dte,
      dteMax: dte,
      otmScanMax: 0.2,
      maxStrikes: 16,
      minPrice: s.minPrice,
      minVolume30: s.minVolume,
      cheapFallback: false, // the Volume bot keeps its own legs: no fallback
    };
    let got = pickContract(quotes, stock, right, t.day, pick);
    // The picked leg's bid / ask, kept with the signal (paper fills are not real ones).
    const chosen = got.quote;
    const book = bookOf(chosen, this.o.now(), "alpaca"); // its own Alpaca paper account
    if (chosen && book)
      this.o.store.setSignalBook(t.day, t.symbol, {
        ...book,
        contract: chosen.symbol,
      });
    if (!got.ok) return { ok: false, outcome: got.reason, detail: right };
    let fallback = "";
    if (s.minVolume > 0) {
      const first = got.quote.symbol;
      const volume = await this.o.market.optionVolume30(first, t.day, m);
      if (volume < s.minVolume) {
        const liquid = s.liquidFallback
          ? await this.liquidLeg(
              quotes,
              stock,
              right,
              expiry,
              got,
              pick,
              t.day,
              m,
              s.minVolume,
            )
          : null;
        if (!liquid)
          return {
            ok: false,
            outcome: "thin",
            detail: `${this.words(first)}: ${volume} contracts in 30 minutes`,
          };
        got = { ok: true, ...liquid };
        fallback = ` (liquid fallback: ${this.words(first)} traded ${volume})`;
      }
    }
    if (delta !== s.delta)
      fallback += ` (the ${s.delta.toFixed(2)} leg too cheap or thin: ${delta.toFixed(2)} delta)`;
    return { ok: true, got, fallback, book };
  }

  private async buyLeg(
    t: StrangleTrade,
    side: Leg,
    m: number,
    stock: number,
    s: StrangleSettings,
  ) {
    const fail = (outcome: string, detail: string) => {
      this.close(t, outcomeWords[outcome] ?? outcome);
      this.outcome(t.day, t.symbol, outcome, detail);
    };
    t.side = side;
    t.sideMinute = m;
    const late = this.lateBy(t);
    if (this.tooLate(t, s))
      return fail("slow_cross", `the side ${late} s after the alert`);
    // A same-week expiry (later than the next session) asks for the stronger burst.
    const weekly = !t.shock && (t.expiry ?? t.day) > nextSession(t.day);
    let burstRule = s;
    if (weekly) burstRule = { ...s, burstMin: s.burstMinWeek };
    // The shock: any burst the side's way (>= 0), whatever the expiry.
    if (t.shock) burstRule = { ...s, burstFilter: true, burstMin: 0 };
    if (!burstAgrees(side, t.burst, burstRule))
      return fail(
        "burst",
        `burst ${t.burst === null || t.burst === undefined ? "—" : t.burst.toFixed(2)}× for a ${legName(side)}${weekly ? ` (a same-week expiry needs ${s.burstMinWeek})` : ""}`,
      );
    if (s.strengthFilter) {
      const prior = this.prior.get(t.symbol);
      const st = prior
        ? cState(
            this.barsOf(t.symbol),
            this.barsOf("SPY"),
            prior,
            Math.max(1, m - 1),
          )
        : null;
      if (!strengthAgrees(side, st?.t ?? null))
        return fail("strength", `t ${st?.t.toFixed(1) ?? "—"}`);
    }
    const limited = await this.limit(t.day, s);
    if (limited) return fail(limited.outcome, limited.detail);
    const right = legName(side);
    const expiry = t.expiry ?? t.day;
    const dte = Math.round(
      (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${t.day}T00:00:00Z`)) /
        86_400_000,
    );
    const quotes = await this.o.trading.chain(t.symbol, right, expiry, expiry);
    // The shock steps 0.05 toward the money, up to 0.35, while the leg is too
    // cheap or too thin (volume-bot.md 2026-10-30, "step35"); the rest pick once.
    const deltas = [s.delta];
    if (t.shock)
      for (let d = s.delta + 0.05; d <= shockMaxDelta + 1e-9; d += 0.05)
        deltas.push(Math.round(d * 100) / 100);
    let leg: Awaited<ReturnType<typeof this.legAt>> | null = null;
    for (const delta of deltas) {
      leg = await this.legAt(t, quotes, stock, right, expiry, dte, delta, m, s);
      if (leg.ok) break;
    }
    if (!leg || !leg.ok)
      return fail(leg?.outcome ?? "no_prices", leg?.detail ?? right);
    const { got, fallback, book } = leg;
    if (t.shock) {
      const spread = (got.quote.ask - got.quote.bid) / got.mid;
      if (spread > shockMaxSpread)
        return fail(
          "wide_spread",
          `${this.words(got.quote.symbol)}: bid ${got.quote.bid.toFixed(2)}, ask ${got.quote.ask.toFixed(2)} (${(spread * 100).toFixed(0)}% of the mid)`,
        );
    }
    const contract = got.quote.symbol;
    if (await this.o.trading.held(contract))
      return fail("refused", `${this.words(contract)} is already held`);
    const equity = await this.o.trading.equity();
    const qty = legQty(equity, s.sizePct, got.quote.ask);
    if (qty < 1)
      return fail(
        "too_small",
        `${this.words(contract)} at ${got.quote.ask.toFixed(2)}`,
      );
    t.leg = {
      contract,
      strike: got.quote.strike,
      qty: 0,
      bought: 0,
      cost: got.mid,
      orders: [],
    };
    const why = `Volume alert ${t.alertSide} at ${clockOf(t.alertMinute)}; the side (${right}) at ${clockOf(m)}, stock ${stock.toFixed(2)} from ${t.stockRef.toFixed(2)}${fallback}`;
    if (t.dry) {
      t.leg.qty = t.leg.bought = qty;
      t.leg.cost = got.quote.ask;
      t.leg.orders.push({
        at: this.o.now(),
        side: "buy",
        qty,
        reason: "the side",
        jobId: null,
        settled: true,
        price: got.quote.ask,
        ...(book ? { book } : {}),
      });
      t.phase = "open";
      t.best = stock;
      t.stockAtBuy = stock;
      this.o.store.saveTrade(t);
      this.outcome(
        t.day,
        t.symbol,
        "would-trade",
        `${qty} × ${this.words(contract)} at ${got.quote.ask.toFixed(2)}`,
      );
      await this.o.notify(`${strangleTag} (dry run): would buy`, [
        `$${t.symbol} ${this.words(contract)}`,
        `${qty} at ${got.quote.ask.toFixed(2)}`,
        why,
      ]);
      return;
    }
    const answer = await this.o.trading
      .buy({
        contract,
        qty,
        chase: true,
        chaseMs: chaseBuyMs,
        stopPct: s.safetyStopPct,
        tag: strangleTag,
        note: why,
      })
      .catch(
        (error: unknown) =>
          ({
            status: "error",
            refused: [error instanceof Error ? error.message : String(error)],
          }) as { status: string; jobId?: string; refused?: string[] },
      );
    if (answer.status !== "started" || !answer.jobId)
      return fail("refused", (answer.refused ?? [answer.status]).join("; "));
    t.leg.orders.push({
      at: this.o.now(),
      side: "buy",
      qty,
      reason: "the side",
      jobId: answer.jobId,
      settled: false,
      ...(book ? { book } : {}),
    });
    t.phase = "buying";
    t.best = stock;
    t.stockAtBuy = stock;
    this.o.store.saveTrade(t);
    this.outcome(t.day, t.symbol, "traded", `${qty} × ${this.words(contract)}`);
  }

  private async sellLeg(
    t: StrangleTrade,
    reason: string,
    mark: { mid: number; bid: number; ask: number } | null,
  ) {
    const mid = mark?.mid ?? null;
    const book = bookOf(mark, this.o.now(), "alpaca");
    const leg = t.leg!;
    const qty = leg.qty;
    if (qty <= 0) {
      this.o.store.saveTrade(t);
      return;
    }
    t.closeReason = reason;
    if (t.dry) {
      const price = mid ?? 0;
      leg.orders.push({
        at: this.o.now(),
        side: "sell",
        qty,
        reason,
        jobId: null,
        settled: true,
        price,
        ...(book ? { book } : {}),
      });
      leg.qty = 0;
      t.phase = "closed";
      t.closedAt = this.o.now();
      this.o.store.saveTrade(t);
      const { paid, got } = tradeCash(t);
      this.event(
        "order",
        `Would sell ${qty} ${t.symbol} ${this.words(leg.contract)} at ${price.toFixed(2)}: ${reason}`,
      );
      await this.o.notify(`${strangleTag} (dry run): would sell`, [
        `$${t.symbol} ${this.words(leg.contract)}`,
        `paid ${paid.toFixed(0)}, got ${got.toFixed(0)} (${paid > 0 ? ((got / paid - 1) * 100).toFixed(0) : "—"}%)`,
        reason,
      ]);
      return;
    }
    const answer = await this.o.trading
      .sell({
        contract: leg.contract,
        qty: String(qty),
        waitMs: sellWaitMs,
        tag: strangleTag,
        note: reason,
      })
      .catch((error: unknown) => ({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    if (answer.status !== "started" || !("jobId" in answer) || !answer.jobId) {
      this.event(
        "error",
        `Selling ${t.symbol} ${this.words(leg.contract)} failed: ${"error" in answer ? answer.error : answer.status}`,
      );
      this.o.store.saveTrade(t);
      return;
    }
    leg.orders.push({
      at: this.o.now(),
      side: "sell",
      qty,
      reason,
      jobId: answer.jobId,
      settled: false,
      ...(book ? { book } : {}),
    });
    t.phase = "closing";
    this.o.store.saveTrade(t);
    this.event(
      "order",
      `Selling ${qty} ${t.symbol} ${this.words(leg.contract)}: ${reason}`,
    );
  }

  private async summary(date: string) {
    const trades = this.o.store
      .recentTrades(date)
      .filter((t) => t.day === date && t.leg);
    const signals = this.o.store.signals(date);
    let paid = 0;
    let got = 0;
    for (const t of trades) {
      const c = tradeCash(t);
      paid += c.paid;
      got += c.got;
    }
    const line = `${signals.length} alerts, ${trades.length} trades; paid ${paid.toFixed(0)}, got ${got.toFixed(0)}`;
    this.event("info", `Day ${date}: ${line}`);
    if (trades.length)
      await this.o.notify(`${strangleTag}: the day`, [date, line]);
  }

  // ---- the app ----

  status(): StrangleView {
    const s = this.settings();
    const day = newYork(this.o.now()).date;
    const since = previousSessions(day, 30)[0]!;
    const view = (t: StrangleTrade) => {
      const cash = tradeCash(t);
      const marks = this.marks.get(t.id) ?? null;
      const openValue =
        marks && t.leg ? t.leg.qty * (marks.leg ?? 0) * 100 : null;
      return { ...t, paid: cash.paid, got: cash.got, marks, openValue };
    };
    const fav = this.watchlist();
    const pathOf = (t: StrangleTrade): [number, number][] => {
      if (t.day !== this.day) return [];
      return this.barsOf(t.symbol)
        .filter((b) => b.m >= t.alertMinute)
        .map((b) => [b.m, b.c]);
    };
    // The live trades' result by day since the first (the app's benchmark).
    const byDay = new Map<string, StrangleLiveDay>();
    for (const t of this.o.store.recentTrades("")) {
      if (t.dry || !t.leg || t.leg.bought <= 0) continue;
      const v = view(t);
      let value = v.got;
      if (t.phase !== "closed") value += v.openValue ?? 0;
      const pnl = value - v.paid;
      const d = byDay.get(t.day) ?? {
        day: t.day,
        pnl: 0,
        trades: 0,
        winners: 0,
      };
      d.pnl += pnl;
      d.trades += 1;
      if (pnl > 0) d.winners += 1;
      byDay.set(t.day, d);
    }
    const live = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    return {
      enabled: s.enabled,
      mode: s.mode,
      account: this.o.account,
      settings: s,
      steps: strangleSteps(s),
      lastWork: this.lastWork,
      day: this.day,
      watching: this.symbols,
      noExpiry: [...this.noExpiry],
      favorites: fav
        ? { name: fav.name, count: fav.tickers.length, at: fav.at }
        : null,
      news: { earnings: this.earningsState, premarket: this.preState },
      signals: this.o.store.signals(day),
      open: this.o.store
        .openTrades()
        .map((t) => ({ ...view(t), path: pathOf(t) })),
      trades: this.o.store
        .recentTrades(since)
        .filter((t) => t.leg !== null && t.leg.bought > 0)
        .map(view),
      events: this.o.store.events(200),
      scan: this.scanned,
      dayStartEquity: this.dayStartEquity,
      live,
    };
  }
}

export type StrangleStatus = ReturnType<StrangleBot["status"]>;
export type { StrangleOrder };
