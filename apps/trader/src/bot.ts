import { randomUUID } from "node:crypto";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import {
  defaultExitRules,
  nextAction,
  type ExitReason,
  type ExitRules,
} from "../../../packages/trading/src/bot/exits.js";
import {
  defaultPickRules,
  expiryWindow,
  pickContract,
  type PickRules,
} from "../../../packages/trading/src/bot/picker.js";
import {
  cSignal,
  cState,
  priorFrom,
  type MinuteBar,
  type Prior,
} from "../../../packages/trading/src/bot/signal.js";
import type { OptionQuote } from "../../../packages/trading/src/options.js";
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
  mode: "dry" | "live";
  enabled: boolean; // the default until someone switches it
  sizePct?: number;
  stopPct?: number; // the broker stop kept as a safety net
  pick?: PickRules;
  exits?: ExitRules;
  now?: () => number;
  log?: (line: string) => void;
}

export const botTag = "🤖 Bot";

const reasonText: Record<ExitReason, string> = {
  "check-10": "10-min check: the stock is against the entry",
  "check-20": "20-min check: the stock is still against the entry",
  "stop-30": "Down 30% with the stock against the entry",
  "close-1550": "Sold at 15:50",
  carry: "Held overnight (up 100% or more)",
  "morning-gap-keep": "Morning: gapped our way, sold half",
  "morning-gap-against": "Morning: no gap our way, sold all",
  "expiry-day": "Expiry day, out by 15:30",
};

// A signal's outcome in words (the app's Bot tab has the same list).
const outcomeText: Record<string, string> = {
  bought: "buying",
  "would-buy": "would buy (dry run)",
  no_expiry: "skipped, no expiry 1–7 days out",
  no_strikes: "skipped, no strikes",
  no_prices: "skipped, no prices",
  too_cheap: "skipped, contract under $0.20",
  too_small: "skipped, 2% buys less than one contract",
  thin: "skipped, too few contracts traded",
  held: "skipped, you hold this contract",
  refused: "refused by the risk rules",
  error: "failed",
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

const expiryOf = (contract: string) => {
  const m = /(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(contract);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : "";
};

export class IndiBot {
  private readonly o: Required<Omit<BotOptions, "now" | "log">> & {
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

  constructor(options: BotOptions) {
    this.o = {
      sizePct: 2,
      stopPct: 50,
      pick: defaultPickRules,
      exits: defaultExitRules,
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
    this.event("info", `Switched ${on ? "on" : "off"}`);
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

  /** The configured stocks and the favorites list, without duplicates. */
  private universe(): string[] {
    return [
      ...new Set([...this.o.universe, ...(this.watchlist()?.tickers ?? [])]),
    ];
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
    const what = outcomeText[outcome] ?? outcome;
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
    // A minute's bar is complete once the next minute has started.
    const last = Math.min(wall - 570 - 1, closeMinute - 1);
    await this.settle();
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
    for (const s of symbols) {
      const byDay = bars.get(s) ?? new Map<string, MinuteBar[]>();
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
    const extra = this.symbols.length - this.o.universe.length;
    this.event(
      "info",
      `Ready for ${date}: watching ${this.symbols.length} stocks (${this.o.universe.length} from Indi's list${fav ? `, ${extra} more from "${fav.name}"` : ""})`,
    );
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
    if (m < 10 || m > Math.min(374, closeMinute - 16)) return;
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
      const sig = cSignal(this.barsOf(symbol), spy, prior, m);
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
    const spot = this.lastClose(symbol, minute);
    if (spot === null)
      return this.outcome(date, symbol, "no_prices", "no stock price");
    const side = right === "C" ? "call" : "put";
    const [from, to] = expiryWindow(date, this.o.pick);
    const picked = pickContract(
      await this.o.trading.chain(symbol, side, from, to),
      spot,
      side,
      date,
      this.o.pick,
    );
    if (!picked.ok) return this.outcome(date, symbol, picked.reason, "");
    const contract = picked.quote.symbol;
    const volume = await this.o.market.optionVolume30(contract, date, minute);
    if (volume < this.o.pick.minVolume30)
      return this.outcome(
        date,
        symbol,
        "thin",
        `${contract}: ${volume} contracts in 30 minutes`,
      );
    // A contract the account already holds is the user's; the bot leaves it alone.
    if (await this.o.trading.held(contract))
      return this.outcome(
        date,
        symbol,
        "held",
        `${contract} is already in the account`,
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
      dry: this.o.mode === "dry",
      sales: [],
      openedAt: this.o.now(),
      closedAt: null,
    };
    if (this.o.mode === "dry") {
      const equity = await this.o.trading.equity();
      const qty = Math.floor(
        (equity * this.o.sizePct) / 100 / (picked.mid * 100),
      );
      if (qty < 1)
        return this.outcome(
          date,
          symbol,
          "too_small",
          `${contract} at ${picked.mid.toFixed(2)}`,
        );
      this.o.store.savePosition({ ...base, qty, bought: qty, status: "open" });
      this.outcome(
        date,
        symbol,
        "would-buy",
        `${qty} ${contract} at ${picked.mid.toFixed(2)}`,
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
      sizePct: this.o.sizePct,
      stopPct: this.o.stopPct,
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
    this.outcome(date, symbol, "bought", `${answer.qty ?? "?"} ${contract}`);
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
            `${p.symbol} ${contractLabel(p.contract)}: the buy did not fill`,
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
          `Bought ${held.qty} ${p.symbol} ${contractLabel(p.contract)} at ${held.avgEntryPrice.toFixed(2)}`,
        );
        continue;
      }
      const pending = p.sales.find((s) => s.jobId !== null && !s.settled);
      if (pending && pending.jobId) {
        const job = this.o.trading.job(pending.jobId);
        if (job.state === "running") continue;
        const sold = soldOf(job.result);
        const held = await this.o.trading.held(p.contract);
        const qty = Math.max(0, Math.min(p.qty - sold, held?.qty ?? 0));
        const sales = p.sales.map((s) =>
          s === pending ? { ...s, qty: sold, settled: true } : s,
        );
        this.event(
          "order",
          `Sold ${sold} ${p.symbol} ${contractLabel(p.contract)} (${reasonText[pending.reason as ExitReason] ?? pending.reason}); ${qty} left`,
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
            `${p.symbol} ${contractLabel(p.contract)}: the account holds ${qty}, so the bot counts ${qty} (was ${p.qty}): a stop or a sale by hand`,
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
    const rules: ExitRules = {
      ...this.o.exits,
      eodMinute: Math.min(this.o.exits.eodMinute, closeMinute - 10),
      expiryLastMinute: Math.min(
        this.o.exits.expiryLastMinute,
        closeMinute - 30,
      ),
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
          `Holding ${p.qty} ${p.symbol} ${contractLabel(p.contract)} overnight (up 100% or more)`,
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
      await this.sell(next, decision.sell, decision.reason, mid);
    }
  }

  private async sell(
    p: BotPosition,
    qty: number,
    reason: ExitReason,
    mid: number | null,
  ) {
    const ask = Math.min(qty, p.qty);
    if (p.dry) {
      const left = p.qty - ask;
      this.o.store.savePosition({
        ...p,
        qty: left,
        sales: [
          ...p.sales,
          { at: this.o.now(), qty: ask, reason, jobId: null },
        ],
        ...(left === 0
          ? { status: "closed" as const, closedAt: this.o.now() }
          : {}),
      });
      const pnl =
        mid === null ? "" : ` (${((mid / p.cost - 1) * 100).toFixed(0)}%)`;
      this.event(
        "order",
        `Would sell ${ask} of ${p.qty} ${p.symbol} ${contractLabel(p.contract)} at ${mid?.toFixed(2) ?? "—"}${pnl}: ${reasonText[reason]}`,
      );
      await this.o.notify(`${botTag} (dry run): would sell`, [
        `$${p.symbol} ${contractLabel(p.contract)}`,
        `${ask} of ${p.qty} at ${mid?.toFixed(2) ?? "—"}${pnl}`,
        reasonText[reason],
      ]);
      return;
    }
    const answer = await this.o.trading
      .sell({
        contract: p.contract,
        qty: String(ask),
        stopPct: this.o.stopPct,
        tag: botTag,
        note: reasonText[reason],
      })
      .catch((error: unknown) => ({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    if (answer.status !== "started" || !("jobId" in answer) || !answer.jobId) {
      this.event(
        "error",
        `Selling ${p.symbol} ${contractLabel(p.contract)} failed: ${"error" in answer ? answer.error : answer.status}`,
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
      `Selling ${ask} of ${p.qty} ${p.symbol} ${contractLabel(p.contract)}: ${reasonText[reason]}`,
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
    const lines = [
      `${signals.length} signals: ${count("bought") + count("would-buy")} entered, ${signals.length - count("bought") - count("would-buy")} skipped`,
      ...positions.map(
        (p) =>
          `$${p.symbol} ${contractLabel(p.contract)}: ${standing(p, date)}`,
      ),
    ];
    this.event("info", `Day summary: ${lines.join("; ")}`);
    await this.o.notify(`${botTag}: day summary ${date}`, lines);
  }

  /** What the app shows (GET /v1/bot). */
  status() {
    const day = newYork(this.o.now()).date;
    const since = previousSessions(day, 5)[0]!;
    return {
      enabled: this.enabled,
      mode: this.o.mode,
      sizePct: this.o.sizePct,
      delta: this.o.pick.delta,
      universe: this.o.universe,
      favorites: this.watchlist(),
      watching: this.symbols.length ? this.symbols : this.universe(),
      lastRun: this.lastWork,
      day,
      scan: [...this.scan]
        .map(([symbol, v]) => ({ symbol, ...v }))
        // Closest to a signal first: the weaker of the two conditions.
        .sort((a, b) => closeness(b) - closeness(a)),
      signals: this.o.store.signals(day),
      positions: this.o.store.recentPositions(since),
      activity: this.o.store.events(150),
    };
  }
}

// How near a stock is to the signal: 1 means both conditions hold.
function closeness(v: { t: number; rvol: number }): number {
  return Math.min(v.t / 2, v.rvol / 1.5);
}

// How a position ends the day, for the summary.
function standing(p: BotPosition, date: string): string {
  if (p.status === "closed") return "closed";
  const overnight = p.nights > 0 || p.decidedOn === date;
  if (overnight) return `${p.qty} held overnight`;
  return `${p.qty} held`;
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

/** Session minute bars from raw provider bars (start time in ms). */
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
    const { date, minute } = newYork(r.start);
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
