import { randomUUID } from "node:crypto";
import {
  coreClose,
  newYork,
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
import { pickContract } from "../../../packages/trading/src/bot/picker.js";
import {
  cState,
  priorFrom,
  type MinuteBar,
  type Prior,
} from "../../../packages/trading/src/bot/signal.js";
import {
  alerts,
  firstAlert,
  windows,
  type Windows,
} from "../../../packages/trading/src/strangle/alert.js";
import {
  keptExit,
  other,
  pairQty,
  recycleQty,
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
import type { StrangleView } from "../../../packages/trading/src/strangle/view.js";
import type { BotMarket, BotTrading } from "./bot.js";
import {
  tradeCash,
  type StrangleEventKind,
  type StrangleLeg,
  type StrangleOrder,
  type StrangleStore,
  type StrangleTrade,
} from "./strangle-store.js";

// The alert strangle (docs/tasks/backend-strangle-bot.md): a second bot,
// separate from the Indi bot, on its own Alpaca paper account. On the first
// volume alert of a stock's day (a day with a same-day expiry), it buys the
// call and the put at one delta; when the stock has moved a share of its
// typical 30-minute move, it sells the wrong leg (and, with `recycle`, puts
// that money into the right one) and trails the right one to the end. The
// decisions are the backtest's (zero9.py), checked trade by trade by
// scripts/strangle-parity.ts. Every order goes through the owner's trading
// service at the strangle's account, as the Indi bot's do at its own.

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

export const strangleTag = "🎯 Strangle";
const chaseBuyMs = 3 * 60_000;
const sellWaitMs = 3 * 60_000;

type NewsState = "off" | "pending" | "ok" | "failed";

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

const outcomeWords: Record<string, string> = {
  traded: "bought the strangle",
  "would-trade": "would buy the strangle (dry run)",
  no_expiry: "no same-day expiry today",
  no_strikes: "no strikes near the stock",
  no_prices: "no prices",
  too_cheap: "a leg is too cheap",
  thin: "a leg is too thin",
  too_small: "the size buys less than one pair",
  max_trades: "the day's trades are used",
  max_open: "too many trades open",
  day_loss: "the day's loss limit is reached",
  earnings: "skipped, earnings reaction day",
  premarket: "skipped, pre-market volume 4× normal or more",
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
  private priorClose = new Map<string, number>();
  private openClose = new Map<string, Map<string, { o: number; c: number }>>();
  private priorDays: string[] = [];
  private today = new Map<string, Map<number, MinuteBar>>();
  private done = -1;
  private busy = false;
  private summarized: string | null = null;
  private lastWork: number | null = null;
  private dayStartEquity: number | null = null;
  private reports: EarningsReport[] | null = null;
  private earningsState: NewsState = "off";
  private preRatio = new Map<string, number | null>();
  private preState: NewsState = "off";
  // Each open trade's live marks, for the status (not stored).
  private marks = new Map<
    string,
    { C: number | null; P: number | null; stock: number | null; at: number }
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

  // ---- entries ----

  private async entries(date: string, m: number) {
    const s = this.settings();
    if (m < s.firstMinute || m > s.lastMinute) return;
    for (const symbol of this.symbols) {
      if (this.o.store.signal(date, symbol)) continue;
      const hist = this.hist.get(symbol);
      if (!hist) continue;
      // Only the day's first alert counts, as in the backtest.
      const first = firstAlert(
        alerts(this.barsOf(symbol), hist),
        s.firstMinute,
        m,
      );
      if (!first || first.minute !== m) continue;
      this.o.store.addSignal({
        day: date,
        symbol,
        minute: m,
        side: first.side,
        outcome: "",
        detail: "",
        at: this.o.now(),
      });
      this.event(
        "signal",
        `${symbol}: volume alert ${first.side} at ${clockOf(m)}`,
      );
      try {
        const r = await this.enter(date, symbol, m, first.side, s);
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
      outcome === "traded" || outcome === "would-trade" ? "order" : "skip";
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
      .signals(date)
      .filter(
        (x) => x.outcome === "traded" || x.outcome === "would-trade",
      ).length;
    if (traded >= s.maxTradesPerDay)
      return { outcome: "max_trades", detail: `${traded} today` };
    const open = this.o.store.openTrades().filter((t) => t.dry === dry).length;
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

  private async enter(
    date: string,
    symbol: string,
    m: number,
    side: "up" | "down",
    s: StrangleSettings,
  ): Promise<{ outcome: string; detail: string }> {
    const blocked = this.newsBlock(date, symbol, s);
    if (blocked) return blocked;
    const limited = await this.limit(date, s);
    if (limited) return limited;
    const unit = this.unit.get(symbol);
    if (!unit)
      return {
        outcome: "no_prices",
        detail: "fewer than 5 sessions of history",
      };
    const spot = this.lastClose(symbol, m);
    if (spot === null)
      return { outcome: "no_prices", detail: "no stock price" };
    const pick = {
      delta: s.delta,
      dteMin: 0,
      dteMax: 0,
      otmScanMax: 0.2,
      maxStrikes: 16,
      minPrice: s.minPrice,
      minVolume30: s.minVolume,
    };
    const picked: Record<
      Leg,
      { contract: string; strike: number; mid: number; ask: number }
    > = {} as never;
    for (const leg of ["C", "P"] as const) {
      const right = legName(leg);
      const got = pickContract(
        await this.o.trading.chain(symbol, right, date, date),
        spot,
        right,
        date,
        pick,
      );
      if (!got.ok) return { outcome: got.reason, detail: legName(leg) };
      const contract = got.quote.symbol;
      if (s.minVolume > 0) {
        const volume = await this.o.market.optionVolume30(contract, date, m);
        if (volume < s.minVolume)
          return {
            outcome: "thin",
            detail: `${this.words(contract)}: ${volume} contracts in 30 minutes`,
          };
      }
      if (await this.o.trading.held(contract))
        return {
          outcome: "refused",
          detail: `${this.words(contract)} is already held`,
        };
      picked[leg] = {
        contract,
        strike: got.quote.strike,
        mid: got.mid,
        ask: got.quote.ask,
      };
    }
    const equity = await this.o.trading.equity();
    const qty = pairQty(equity, s.sizePct, picked.C.mid, picked.P.mid);
    const pair = `${this.words(picked.C.contract)} + ${this.words(picked.P.contract)}`;
    if (qty < 1)
      return {
        outcome: "too_small",
        detail: `${pair} at ${(picked.C.mid + picked.P.mid).toFixed(2)}`,
      };
    const leg = (l: Leg): StrangleLeg => ({
      contract: picked[l].contract,
      strike: picked[l].strike,
      qty: 0,
      bought: 0,
      cost: picked[l].mid,
      orders: [],
    });
    const trade: StrangleTrade = {
      id: randomUUID(),
      day: date,
      symbol,
      alertMinute: m,
      alertSide: side,
      unit,
      stockAtFill: null,
      legs: { C: leg("C"), P: leg("P") },
      phase: "buying",
      kept: null,
      confirmMinute: null,
      peak: null,
      recycled: false,
      closeReason: null,
      dry: s.mode === "dry",
      openedAt: this.o.now(),
      closedAt: null,
    };
    const why = `Volume alert ${side} at ${clockOf(m)}: the strangle`;
    if (trade.dry) {
      for (const l of ["C", "P"] as const) {
        const L = trade.legs[l];
        L.qty = L.bought = qty;
        L.cost = picked[l].mid;
        L.orders.push({
          at: this.o.now(),
          side: "buy",
          qty,
          reason: "entry",
          jobId: null,
          settled: true,
          price: picked[l].mid,
        });
      }
      trade.phase = "open";
      trade.stockAtFill = (await this.stockNow(symbol, m)) ?? spot;
      this.o.store.saveTrade(trade);
      await this.o.notify(`${strangleTag} (dry run): would buy`, [
        `$${symbol} ${pair}`,
        `${qty} of each at ${picked.C.mid.toFixed(2)} + ${picked.P.mid.toFixed(2)}`,
        why,
      ]);
      return { outcome: "would-trade", detail: `${qty} × ${pair}` };
    }
    const refused: string[] = [];
    for (const l of ["C", "P"] as const) {
      const answer = await this.o.trading.buy({
        contract: picked[l].contract,
        qty,
        chase: true,
        chaseMs: chaseBuyMs,
        stopPct: s.safetyStopPct,
        tag: strangleTag,
        note: `${why}, ${legName(l)}`,
      });
      if (answer.status !== "started" || !answer.jobId) {
        refused.push(
          `${legName(l)}: ${(answer.refused ?? [answer.status]).join("; ")}`,
        );
        continue;
      }
      trade.legs[l].orders.push({
        at: this.o.now(),
        side: "buy",
        qty,
        reason: "entry",
        jobId: answer.jobId,
        settled: false,
      });
    }
    if (refused.length === 2)
      return { outcome: "refused", detail: refused.join("; ") };
    // One leg refused: the other is sold once it fills (settle).
    this.o.store.saveTrade(trade);
    if (refused.length)
      this.event(
        "error",
        `${symbol}: ${refused.join("; ")}; the other leg is sold once it fills`,
      );
    return { outcome: "traded", detail: `${qty} × ${pair}` };
  }

  // ---- orders: the fills, as the account reports them ----

  private pending(t: StrangleTrade): boolean {
    return [t.legs.C, t.legs.P].some((l) =>
      l.orders.some((o) => o.jobId !== null && !o.settled),
    );
  }

  private async settle() {
    for (const t of this.o.store.openTrades()) {
      if (t.dry) continue;
      let changed = false;
      for (const l of ["C", "P"] as const) {
        const leg = t.legs[l];
        for (const o of leg.orders) {
          if (o.settled || !o.jobId) continue;
          const job = this.o.trading.job(o.jobId);
          if (job.state === "running") continue;
          const held = await this.o.trading.held(leg.contract);
          const now = held?.qty ?? 0;
          if (o.side === "buy") {
            const filled = Math.max(0, now - leg.qty);
            const price =
              priceOf(job.result) ?? held?.avgEntryPrice ?? leg.cost;
            o.qty = filled;
            o.price = price;
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
            leg.qty = Math.max(0, Math.min(leg.qty - sold, now));
            this.event(
              "order",
              `Sold ${sold} ${t.symbol} ${this.words(leg.contract)} (${o.reason}); ${leg.qty} left`,
            );
          }
          o.settled = true;
          changed = true;
        }
        // A sale by hand: the bot never counts more than the account holds.
        if (!leg.orders.some((o) => !o.settled) && leg.qty > 0) {
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
      }
      if (t.phase === "buying" && !this.pending(t)) {
        const c = t.legs.C.qty,
          p = t.legs.P.qty;
        if (c > 0 && p > 0) {
          t.phase = "open";
          t.stockAtFill = await this.stockNow(t.symbol, null);
          this.event(
            "info",
            `${t.symbol}: the strangle is on, stock at ${t.stockAtFill?.toFixed(2) ?? "—"}; the side at ${t.stockAtFill ? (t.unit * this.settings().confirmUnits * 100).toFixed(2) : "—"}% either way`,
          );
        } else if (c === 0 && p === 0) {
          t.phase = "closed";
          t.closeReason = "did not fill";
          t.closedAt = this.o.now();
        } else {
          t.phase = "closing";
          t.closeReason = "one leg did not fill";
          await this.sellLeg(
            t,
            c > 0 ? "C" : "P",
            "one leg did not fill",
            null,
          );
        }
        changed = true;
      }
      if (
        t.phase !== "buying" &&
        t.phase !== "closed" &&
        !this.pending(t) &&
        t.legs.C.qty === 0 &&
        t.legs.P.qty === 0
      ) {
        t.phase = "closed";
        t.closedAt = this.o.now();
        changed = true;
        const { paid, got } = tradeCash(t);
        this.event(
          "order",
          `${t.symbol} strangle closed: paid ${paid.toFixed(0)}, got ${got.toFixed(0)} (${paid > 0 ? ((got / paid - 1) * 100).toFixed(0) : "—"}%)`,
        );
      }
      if (changed) this.o.store.saveTrade(t);
    }
  }

  // ---- the trades: the side, the wrong leg, the trail ----

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

  private async manage(date: string, m: number, s: StrangleSettings) {
    for (const t of this.o.store.openTrades()) {
      if (t.phase === "buying" || t.phase === "closed") continue;
      if (this.pending(t)) continue;
      const stock = await this.stockNow(t.symbol, m);
      const mc = t.legs.C.qty > 0 ? await this.mark(t.legs.C.contract) : null;
      const mp = t.legs.P.qty > 0 ? await this.mark(t.legs.P.contract) : null;
      this.marks.set(t.id, {
        C: mc?.mid ?? null,
        P: mp?.mid ?? null,
        stock,
        at: this.o.now(),
      });
      const markOf = (l: Leg) => (l === "C" ? mc : mp);
      if (t.day !== date) {
        // Never carried: a same-day expiry. Anything left from a past day is sold now.
        for (const l of ["C", "P"] as const)
          if (t.legs[l].qty > 0)
            await this.sellLeg(
              t,
              l,
              "left from a past day",
              markOf(l)?.mid ?? null,
            );
        continue;
      }
      if (t.phase === "open") {
        const side =
          stock !== null && t.stockAtFill !== null
            ? sideOf(stock, t.stockAtFill, t.unit, s)
            : null;
        if (side) {
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
            if (!strengthAgrees(side, st?.t ?? null)) {
              t.phase = "closing";
              t.closeReason = "the side and the strength disagree";
              for (const l of ["C", "P"] as const)
                await this.sellLeg(t, l, t.closeReason, markOf(l)?.mid ?? null);
              continue;
            }
          }
          t.kept = side;
          t.confirmMinute = m;
          t.peak = markOf(side)?.mid ?? null;
          t.phase = "kept";
          this.event(
            "order",
            `${t.symbol}: the side is the ${legName(side)} at ${clockOf(m)} (stock ${stock!.toFixed(2)} from ${t.stockAtFill!.toFixed(2)}); selling the ${legName(other(side))}`,
          );
          await this.sellLeg(
            t,
            other(side),
            "the wrong leg",
            markOf(other(side))?.mid ?? null,
          );
          continue;
        }
        if (waitedOut(m, t.alertMinute, s) || m >= s.endMinute) {
          t.phase = "closing";
          t.closeReason = "no side in time";
          for (const l of ["C", "P"] as const)
            await this.sellLeg(t, l, t.closeReason, markOf(l)?.mid ?? null);
        }
        continue;
      }
      if (t.phase === "kept" && t.kept) {
        const keep = t.kept;
        const wrong = t.legs[other(keep)];
        // The wrong leg's money into the right one, once its sale settled.
        if (s.recycle && !t.recycled && wrong.qty === 0) {
          t.recycled = true;
          const proceeds = wrong.orders
            .filter(
              (o) => o.side === "sell" && o.settled && o.price !== undefined,
            )
            .reduce((sum, o) => sum + o.qty * o.price! * 100, 0);
          const km = markOf(keep);
          const n = km ? recycleQty(proceeds, km.ask) : 0;
          if (n >= 1) {
            await this.buyMore(t, keep, n, km!);
            continue;
          }
          this.o.store.saveTrade(t);
        }
        const km = markOf(keep);
        if (!km) continue;
        t.peak = Math.max(t.peak ?? km.mid, km.mid);
        const exit = keptExit(km.mid, t.peak, m, s);
        if (exit) {
          t.phase = "closing";
          t.closeReason =
            exit === "trail"
              ? `the ${legName(keep)} fell ${s.trailPct}% from its high`
              : `the end of the day (${clockOf(s.endMinute)})`;
          await this.sellLeg(t, keep, t.closeReason, km.mid);
          continue;
        }
        this.o.store.saveTrade(t);
      }
    }
  }

  private async buyMore(
    t: StrangleTrade,
    l: Leg,
    n: number,
    m: { mid: number; ask: number },
  ) {
    const leg = t.legs[l];
    if (t.dry) {
      leg.orders.push({
        at: this.o.now(),
        side: "buy",
        qty: n,
        reason: "the wrong leg's money",
        jobId: null,
        settled: true,
        price: m.ask,
      });
      leg.cost = (leg.cost * leg.bought + m.ask * n) / (leg.bought + n);
      leg.bought += n;
      leg.qty += n;
      this.o.store.saveTrade(t);
      this.event(
        "order",
        `Would buy ${n} more ${t.symbol} ${this.words(leg.contract)} at ${m.ask.toFixed(2)} with the wrong leg's money`,
      );
      return;
    }
    const answer = await this.o.trading
      .buy({
        contract: leg.contract,
        qty: n,
        chase: true,
        chaseMs: chaseBuyMs,
        stopPct: this.settings().safetyStopPct,
        tag: strangleTag,
        note: `The ${legName(other(l))}'s money into the ${legName(l)}`,
      })
      .catch(
        (error: unknown) =>
          ({
            status: "error",
            refused: [error instanceof Error ? error.message : String(error)],
          }) as { status: string; jobId?: string; refused?: string[] },
      );
    if (answer.status !== "started" || !answer.jobId) {
      this.event(
        "error",
        `${t.symbol}: buying more of the ${legName(l)} was refused (${(answer.refused ?? []).join("; ")})`,
      );
      this.o.store.saveTrade(t);
      return;
    }
    leg.orders.push({
      at: this.o.now(),
      side: "buy",
      qty: n,
      reason: "the wrong leg's money",
      jobId: answer.jobId,
      settled: false,
    });
    this.o.store.saveTrade(t);
    this.event(
      "order",
      `Buying ${n} more ${t.symbol} ${this.words(leg.contract)} with the wrong leg's money`,
    );
  }

  private async sellLeg(
    t: StrangleTrade,
    l: Leg,
    reason: string,
    mid: number | null,
  ) {
    const leg = t.legs[l];
    const qty = leg.qty;
    if (qty <= 0) {
      this.o.store.saveTrade(t);
      return;
    }
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
      });
      leg.qty = 0;
      if (t.legs.C.qty === 0 && t.legs.P.qty === 0) {
        t.phase = "closed";
        t.closedAt = this.o.now();
      }
      this.o.store.saveTrade(t);
      this.event(
        "order",
        `Would sell ${qty} ${t.symbol} ${this.words(leg.contract)} at ${price.toFixed(2)}: ${reason}`,
      );
      if (t.phase === "closed") {
        const { paid, got } = tradeCash(t);
        await this.o.notify(`${strangleTag} (dry run): closed`, [
          `$${t.symbol}`,
          `paid ${paid.toFixed(0)}, got ${got.toFixed(0)} (${paid > 0 ? ((got / paid - 1) * 100).toFixed(0) : "—"}%)`,
          reason,
        ]);
      }
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
    });
    this.o.store.saveTrade(t);
    this.event(
      "order",
      `Selling ${qty} ${t.symbol} ${this.words(leg.contract)}: ${reason}`,
    );
  }

  private async summary(date: string) {
    const trades = this.o.store
      .recentTrades(date)
      .filter((t) => t.day === date);
    const signals = this.o.store.signals(date);
    let paid = 0,
      got = 0;
    for (const t of trades) {
      const c = tradeCash(t);
      paid += c.paid;
      got += c.got;
    }
    const line = `${signals.length} first alerts, ${trades.length} strangles; paid ${paid.toFixed(0)}, got ${got.toFixed(0)}`;
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
      const openValue = marks
        ? (t.legs.C.qty * (marks.C ?? 0) + t.legs.P.qty * (marks.P ?? 0)) * 100
        : null;
      return { ...t, paid: cash.paid, got: cash.got, marks, openValue };
    };
    const fav = this.watchlist();
    return {
      enabled: s.enabled,
      mode: s.mode,
      account: this.o.account,
      settings: s,
      steps: strangleSteps(s),
      lastWork: this.lastWork,
      day: this.day,
      watching: this.symbols,
      favorites: fav
        ? { name: fav.name, count: fav.tickers.length, at: fav.at }
        : null,
      news: { earnings: this.earningsState, premarket: this.preState },
      signals: this.o.store.signals(day),
      open: this.o.store.openTrades().map(view),
      trades: this.o.store.recentTrades(since).map(view),
      events: this.o.store.events(200),
    };
  }
}

export type StrangleStatus = ReturnType<StrangleBot["status"]>;
export type { StrangleOrder };
