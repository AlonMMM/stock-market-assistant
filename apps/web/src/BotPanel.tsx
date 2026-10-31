import {
  createContext,
  useContext,
  useEffect,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  coreClose,
  newYork,
  newYorkToUtc,
} from "../../../packages/market-data/src/calendar.js";
import type { BotView } from "../../../packages/trading/src/bot-api.js";
import { isEntry, withEntries } from "./bot-view-model.js";
import {
  defaultSettings,
  type BotSettings,
} from "../../../packages/trading/src/bot/settings.js";
import { algorithmSteps } from "../../../packages/trading/src/bot/algorithm.js";
import {
  canonicalVersion,
  versionById,
} from "../../../packages/trading/src/bot/versions.js";
import {
  contractWords,
  contractsInWords,
  parseOccSymbol,
} from "../../../packages/trading/src/options.js";
import { BotMap, useMapPick, type MapPoint } from "./BotMap.js";
import { byCorner, cornerGap } from "./bot-map-model.js";
import { EntryBanners, InTradeSign, type HeldTrade } from "./BotEntries.js";
import { usePolling } from "./Live.js";
import { israelClock, israelLabel, israelShortDate } from "./time.js";

// The Indi bot on the Portfolio page (docs/tasks/backend-indi-bot.md): what it
// looks at and what it did. Read-only, for every signed-in user; it trades in
// the same paper account, so its positions also appear under Live trades and
// History, marked with the Bot chip.

// Every second (user 2026-10-28: "1 second, 2 second refreshing"), while
// the page is in view. The bot's scan itself moves once a minute, when each
// minute's bar closes.
const refreshMs = 1000;
const ignore = () => {};

// The bot's settings as it reports them (the defaults from a trading service
// before settings): the signal's two conditions, the exits' numbers.
const RulesContext = createContext<BotSettings>(defaultSettings);
const useRules = () => useContext(RulesContext);
// From this share of both conditions, a stock counts as close to a signal.
const closeShare = 0.75;

type ScanRow = BotView["scan"][number];
type Signal = BotView["signals"][number];
type Position = BotView["positions"][number];

const outcomeText: Record<string, string> = {
  bought: "Bought",
  "would-buy": "Would buy (dry run)",
  no_expiry: "Skipped: no expiry in the window",
  no_strikes: "Skipped: no strikes",
  no_prices: "Skipped: no prices",
  too_cheap: "Skipped: contract under the cheapest price",
  too_small: "Skipped: the trade size buys less than one contract",
  thin: "Skipped: too few contracts traded",
  held: "Skipped: you hold this contract",
  refused: "Refused by the risk rules",
  earnings: "Skipped: earnings reaction day",
  premarket: "Skipped: pre-market volume 4× normal or more",
  max_buys: "Skipped: the most bot buys for today",
  max_open: "Skipped: the most open positions",
  day_loss: "Skipped: the daily loss limit",
  error: "Failed",
  new: "Working",
};

/** The colour family of a signal's outcome. */
function outcomeTone(outcome: string): "good" | "warn" | "bad" | "quiet" {
  if (isEntry(outcome)) return "good";
  if (outcome === "refused" || outcome === "new") return "warn";
  if (outcome === "error") return "bad";
  return "quiet";
}

const reasonText: Record<string, string> = {
  "check-10": "10-min check",
  "check-20": "20-min check",
  "stop-30": "stop",
  "rest-stop": "stop on the rest",
  "strength-gone": "strength gone",
  "stage-half": "staged exit, half",
  "stage-full": "staged exit, the rest",
  "close-1550": "end-of-day close",
  "morning-gap-keep": "morning, gap our way",
  "morning-gap-against": "morning, no gap",
  "expiry-day": "expiry day",
  "night-cap": "overnight cap",
  "night-no-equity": "day exit, no account value for the cap",
  "failed-break": "failed break",
};

/** Contracts the bot opened in the last sessions, for the Bot chip. */
export function useBotContracts(): ReadonlySet<string> {
  const { value } = usePolling<BotView>("/api/bot", 30000, ignore);
  return new Set((value?.positions ?? []).map((p) => p.contract));
}

export function BotChip() {
  return (
    <span className="bot-chip" title="Opened by the main bot">
      🤖 Main bot
    </span>
  );
}

/** "MU Put 75 · 2DTE": days to expiry from the entry date. */
function contractName(contract: string, entryDay: string): string {
  const words = contractWords(contract, entryDay);
  if (words === contract) return contract;
  return `${parseOccSymbol(contract).underlying} ${words}`;
}

// Older feed lines and signal details may carry OCC symbols: in words, from that day.
const nyDay = (at: number) => newYork(at).date;

/** Israel clock time of a New York wall-clock minute on a session date. */
function israelAt(day: string, nyMinute: number): string {
  return israelClock(newYorkToUtc(day, nyMinute));
}

/** The session's key minutes in New York time; an early close moves the end. */
function sessionPlan(day: string, rules: BotSettings) {
  let close = 960;
  try {
    close = coreClose(day) ?? 960;
  } catch {
    // Outside the calendar's years: a regular day.
  }
  return {
    open: 570,
    firstEntry: 570 + rules.firstEntryMin,
    lastEntry: Math.min(944, close - 16),
    dayExit: close - 10,
    close,
  };
}

// How near a stock is to the signal: both conditions full means a signal.
const nearness = (r: { t: number; rvol: number }, rules: BotSettings) =>
  Math.min(r.t / rules.minT, r.rvol / rules.minRvol);

const blockedText: Record<string, string> = {
  earnings: "earnings reaction day",
  premarket: "pre-market volume 4× normal",
};

/** Whether the D2 bonus covers the strength check (t from d2T with D2 minD2+). */
function d2Covers(r: ScanRow, rules: BotSettings): boolean {
  if (!rules.d2Entry || r.d2 === undefined || r.d2 === null) return false;
  return r.t >= rules.d2T && r.d2 >= rules.minD2;
}

/** What a stock still lacks, in words. */
function lacking(r: ScanRow, rules: BotSettings): string {
  if (r.blocked) return `Blocked today: ${blockedText[r.blocked]}`;
  const { minT: needT, minRvol: needVolume } = rules;
  const bonus = r.t < needT && d2Covers(r, rules);
  const strong = r.t >= needT || bonus;
  const heavy = r.rvol >= needVolume;
  if (strong && heavy)
    return bonus
      ? "Both conditions met, by the D2 bonus"
      : "Both conditions met";
  if (strong) return `Needs volume: ${r.rvol.toFixed(1)}× of ${needVolume}×`;
  let orBonus = "";
  if (rules.d2Entry) orBonus = ` (or t ${rules.d2T} with D2 ${rules.minD2})`;
  if (heavy) return `Needs strength: t ${r.t.toFixed(1)} of ${needT}${orBonus}`;
  return "Needs strength and volume";
}

/**
 * Words under a stock only for what its bars cannot show (user 2026-10-27:
 * "too much text"): blocked today, or met by the D2 bonus.
 */
function note(r: ScanRow, rules: BotSettings): string {
  if (r.blocked) return `Blocked today: ${blockedText[r.blocked]}`;
  if (r.t < rules.minT && d2Covers(r, rules) && r.rvol >= rules.minRvol)
    return "Met by the D2 bonus";
  return "";
}

/** D2 in words for a bar: "D2 1.3", or "D2 —" without the stock's typical move. */
const d2Label = (d2: number | null | undefined) =>
  d2 === undefined || d2 === null ? "D2 —" : `D2 ${d2.toFixed(1)}`;

function statusPill(v: BotView) {
  if (!v.enabled) return <span className="pill grey">Off</span>;
  if (v.mode === "dry")
    return <span className="pill amber">On · dry run, no orders</span>;
  return <span className="pill green">On · trading the paper account</span>;
}

/** "12 s ago", "4 min ago": how fresh the bot's last check is. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `at ${israelClock(at)}`;
}

/** Re-renders every few seconds, for "ago" labels and the now line. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

// ---------------------------------------------------------------------------
// The session: where today stands against the bot's own clock

function sessionPhase(day: string, now: number, rules: BotSettings): string {
  const plan = sessionPlan(day, rules);
  const ny = newYork(now);
  if (ny.date !== day || ny.minute > plan.close)
    return `Closed. The scan starts ${rules.firstEntryMin} minutes after the next open.`;
  if (ny.minute < plan.open)
    return "Before the open: warming up with 20 sessions of bars.";
  if (ny.minute < plan.firstEntry)
    return `Open. Entries start ${rules.firstEntryMin} minutes in.`;
  if (ny.minute <= plan.lastEntry) return "Scanning every minute for a signal.";
  if (ny.minute < plan.dayExit)
    return "No new entries. Holdings run their exits.";
  if (rules.maxNights === 0) return "Day exit: everything is sold.";
  return `Day exit: winners up ${rules.holdFromPct}%+ stay overnight, the rest are sold.`;
}

function SessionStrip({
  day,
  signals,
  now,
}: {
  day: string;
  signals: Signal[];
  now: number;
}) {
  const rules = useRules();
  const plan = sessionPlan(day, rules);
  const span = plan.close - plan.open;
  const at = (minute: number) => `${((minute - plan.open) / span) * 100}%`;
  const ny = newYork(now);
  const inSession =
    ny.date === day && ny.minute >= plan.open && ny.minute <= plan.close;
  const phase = sessionPhase(day, now, rules);
  // Whole Israel hours under the track (Israel's offset is whole hours).
  const openMs = newYorkToUtc(day, plan.open);
  const hours: number[] = [];
  for (
    let ms = Math.ceil(openMs / 3600000) * 3600000;
    ms <= openMs + span * 60000;
    ms += 3600000
  )
    hours.push(ms);
  return (
    <section className="bot-card" aria-labelledby="bot-session-title">
      <div className="bot-card-head">
        <h3 id="bot-session-title">Today's session</h3>
        <span className="muted small">{phase}</span>
      </div>
      <div
        className="bot-strip"
        role="img"
        aria-label={`Session in ${israelLabel}. ${phase}`}
      >
        <div className="bot-strip-track">
          <span
            className="bot-strip-window"
            style={{
              left: at(plan.firstEntry),
              width: `${((plan.lastEntry - plan.firstEntry) / span) * 100}%`,
            }}
          />
          <span
            className="bot-strip-exit"
            style={{ left: at(plan.dayExit), right: 0 }}
          />
          {signals.map((s) => (
            <span
              key={s.symbol}
              className={`bot-strip-signal ${s.right === "C" ? "up" : "down"}${isEntry(s.outcome) ? "" : " skipped"}`}
              style={{ left: at(plan.open + s.minute) }}
              title={`${s.symbol} ${s.right === "C" ? "call" : "put"} at ${israelAt(day, plan.open + s.minute)}: ${outcomeText[s.outcome] ?? s.outcome}`}
            />
          ))}
          {inSession && (
            <span className="bot-strip-now" style={{ left: at(ny.minute) }}>
              <span>Now</span>
            </span>
          )}
        </div>
        <div className="bot-strip-marks num" aria-hidden="true">
          {hours.map((ms) => (
            <span
              key={ms}
              style={{ left: `${((ms - openMs) / (span * 60000)) * 100}%` }}
            >
              {israelClock(ms)}
            </span>
          ))}
        </div>
      </div>
      <p className="bot-strip-legend muted small">
        <span>
          <span className="key window" /> Entries{" "}
          <b className="num">
            {israelAt(day, plan.firstEntry)}–{israelAt(day, plan.lastEntry)}
          </b>
        </span>
        <span>
          <span className="key exit" /> Day exit{" "}
          <b className="num">{israelAt(day, plan.dayExit)}</b>
        </span>
        <span>
          Open <b className="num">{israelAt(day, plan.open)}</b> · close{" "}
          <b className="num">{israelAt(day, plan.close)}</b>
        </span>
        <span>
          <span className="key up" /> call <span className="key down" /> put
          signal, bought; <span className="key up skipped" /> faded: not bought
        </span>
        <span>{israelLabel}</span>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The funnel: from the watched stocks to today's buys

function Funnel({ v }: { v: BotView }) {
  const rules = useRules();
  const close = v.scan.filter(
    (r) => !r.blocked && nearness(r, rules) >= closeShare,
  );
  const bought = v.signals.filter((s) => isEntry(s.outcome)).length;
  const blocked = v.scan.filter((r) => r.blocked).length;
  const favorites = v.favorites
    ? ` + ${v.favorites.tickers.length} favorites`
    : "";
  const blockedNote = blocked ? ` · ${blocked} blocked` : "";
  const steps = [
    {
      n: v.watching.length,
      label: "Watching",
      sub: `${v.universe.length} core stocks${favorites}`,
    },
    {
      n: close.length,
      label: "Close to a signal",
      sub: `${Math.round(closeShare * 100)}%+ of both checks${blockedNote}`,
    },
    {
      n: v.signals.length,
      label: "Signals today",
      sub: "one per stock a day",
    },
    {
      n: bought,
      label: v.mode === "dry" ? "Would buy" : "Bought",
      sub: `${v.signals.length - bought} skipped or refused`,
    },
  ];
  return (
    <ol className="bot-funnel" aria-label="From watched stocks to buys">
      {steps.map((s) => (
        <li key={s.label}>
          <span className="bot-funnel-n num">{s.n}</span>
          <span className="bot-funnel-label">{s.label}</span>
          <span className="muted small">{s.sub}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// The signal map: every stock placed by the two things the bot checks

/**
 * The stocks in the order of the map: the nearest its corner first (user
 * 2026-10-28), the strength needed being the D2 bonus's when D2 covers it.
 */
function nearestFirst(scan: ScanRow[], rules: BotSettings): ScanRow[] {
  const { maxVol, maxT } = signalRange(scan);
  return byCorner(
    scan,
    (r) =>
      cornerGap(
        r.rvol,
        r.t,
        rules.minRvol,
        d2Covers(r, rules) ? rules.d2T : rules.minT,
        maxVol,
        maxT,
      ),
    (r) => Math.min(r.t / rules.minT, r.rvol / rules.minRvol),
  );
}

/** The map's axes' ends, from the stocks on it. */
function signalRange(scan: ScanRow[]) {
  return {
    maxVol: Math.min(6, Math.max(3, ...scan.map((r) => r.rvol * 1.1))),
    maxT: Math.min(6, Math.max(3, ...scan.map((r) => r.t * 1.1))),
  };
}

function SignalMap({
  scan,
  signals,
  selected,
  trades,
  onSelect,
}: {
  scan: ScanRow[];
  signals: Signal[];
  selected: string | null;
  trades: ReadonlyMap<string, "C" | "P">;
  onSelect: (symbol: string) => void;
}) {
  const rules = useRules();
  const { minT: needT, minRvol: needVolume } = rules;
  const { maxVol, maxT } = signalRange(scan);
  const fired = new Set(signals.map((s) => s.symbol));
  const points: MapPoint[] = scan.map((r) => ({
    symbol: r.symbol,
    x: r.rvol,
    // Leaning up (a call) is above the middle, down (a put) below it.
    y: r.side === "C" ? r.t : -r.t,
    tone: r.blocked ? "blocked" : r.side === "C" ? "up" : "down",
    ring: fired.has(r.symbol),
    trade: trades.get(r.symbol) ?? null,
    title: `${r.symbol}: t ${r.t.toFixed(1)}, volume ${r.rvol.toFixed(1)}×. ${lacking(r, rules)}`,
  }));
  return (
    <BotMap
      points={points}
      selected={selected}
      onSelect={onSelect}
      axes={{
        xMax: maxVol,
        yMax: maxT,
        needX: needVolume,
        needY: needT,
        xTicks: [0, 1, needVolume, 2, 3, 4, 5, 6].filter((v) => v <= maxVol),
        yTicks: [-4, -needT, 0, needT, 4].filter((t) => Math.abs(t) <= maxT),
        yTick: (t) =>
          t === 0
            ? "0"
            : `${t > 0 ? "+" : "−"}${Number(Math.abs(t).toFixed(2))}`,
        zones: ["Call signal", "Put signal"],
        xTitle: "Volume since the open vs normal →",
        yTitle: "↓ weaker · strength vs SPY (t) · stronger ↑",
        label:
          "Each watched stock by strength against SPY and volume against normal. A stock in a shaded corner signals.",
      }}
    />
  );
}

export function Meter({
  value,
  of,
  label,
}: {
  value: number;
  of: number;
  label: string;
}) {
  const share = Math.min(1, value / of);
  return (
    <span className="bot-meter" title={label}>
      <span className="bot-meter-bar">
        <span
          className={share >= 1 ? "bot-meter-fill full" : "bot-meter-fill"}
          style={{ width: `${share * 100}%` }}
        />
      </span>
      <span className="num">{label}</span>
    </span>
  );
}

/** The selected stock in words, under the map. */
function StockFocus({
  r,
  signal,
  day,
  onOpen,
}: {
  r: ScanRow;
  signal: Signal | undefined;
  day: string;
  onOpen?: (symbol: string) => void;
}) {
  const rules = useRules();
  const { minT: needT, minRvol: needVolume } = rules;
  const lean = r.side === "C" ? "up vs SPY → a call" : "down vs SPY → a put";
  let state = note(r, rules);
  if (signal)
    state = `Signaled ${israelAt(day, 570 + signal.minute)}: ${outcomeText[signal.outcome] ?? signal.outcome}.`;
  return (
    <div className="bot-focus" aria-live="polite">
      <div className="bot-focus-head">
        <strong>{r.symbol}</strong>
        <span className={`bot-lean ${r.side === "C" ? "up" : "down"}`}>
          {r.side === "C" ? "▲" : "▼"} {lean}
        </span>
        {onOpen && (
          <button
            type="button"
            className="bot-open"
            onClick={() => onOpen(r.symbol)}
          >
            {r.symbol}&apos;s page ›
          </button>
        )}
      </div>
      <div className="bot-focus-meters">
        <span>
          <span className="muted small">Strength (need t {needT})</span>
          <Meter value={r.t} of={needT} label={`t ${r.t.toFixed(1)}`} />
        </span>
        <span>
          <span className="muted small">Volume (need {needVolume}×)</span>
          <Meter
            value={r.rvol}
            of={needVolume}
            label={`${r.rvol.toFixed(1)}×`}
          />
        </span>
        {rules.d2Entry && (
          <span>
            <span className="muted small">
              D2 (need {rules.minD2}, with t {rules.d2T}+)
            </span>
            <Meter
              value={Math.max(0, r.d2 ?? 0)}
              of={rules.minD2}
              label={d2Label(r.d2)}
            />
          </span>
        )}
      </div>
      {state && <p className="small">{state}</p>}
    </div>
  );
}

/** A box to find one stock in a bot's list, the ones out for today too. */
export function FindStock({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="bot-find">
      <span className="sr-only">Find a stock</span>
      <input
        type="search"
        placeholder="Find a stock"
        autoCapitalize="characters"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Enter or Space on a list row picks it, as a click does. */
export function rowKeys(pick: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    pick();
  };
}

/** The rows to show, with the picked stock always among them. */
export function withPicked<T extends { symbol: string }>(
  rows: T[],
  all: T[],
  selected: string | null,
): T[] {
  if (!selected || rows.some((r) => r.symbol === selected)) return rows;
  const picked = all.find((r) => r.symbol === selected);
  return picked ? [picked, ...rows] : rows;
}

/** Every stock's two conditions as bars, closest to a signal first. */
function StockList({
  scan,
  signals,
  selected,
  onSelect,
  listRef,
}: {
  scan: ScanRow[];
  signals: Signal[];
  selected: string | null;
  onSelect: (symbol: string) => void;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const rules = useRules();
  const { minT: needT, minRvol: needVolume } = rules;
  const [all, setAll] = useState(false);
  const [find, setFind] = useState("");
  const fired = new Map(signals.map((s) => [s.symbol, s]));
  // The stocks the news filter blocks for today stay on the map but leave
  // the list; a search finds them (user 2026-10-27). A stock that signaled
  // today stays, with its outcome (user 2026-10-28: META, at the corner, was
  // missing).
  const query = find.trim().toUpperCase();
  const ordered = nearestFirst(scan, rules);
  const live = query
    ? ordered.filter((r) => r.symbol.startsWith(query))
    : ordered.filter((r) => !r.blocked);
  // A stock picked on the map shows here even when it is out for today.
  const rows = withPicked(
    all || query ? live : live.slice(0, 12),
    scan,
    selected,
  );
  return (
    <div className="bot-stocks" ref={listRef}>
      <FindStock value={find} onChange={setFind} />
      <div
        className={`bot-stocks-head muted small${rules.d2Entry ? " d2" : ""}`}
        aria-hidden="true"
      >
        <span>Stock</span>
        <span>Strength</span>
        <span>Volume</span>
        {rules.d2Entry && <span>D2</span>}
      </div>
      <ul>
        {rows.map((r) => {
          const s = fired.get(r.symbol);
          let state = note(r, rules);
          if (s) state = `Signaled · ${outcomeText[s.outcome] ?? s.outcome}`;
          return (
            <li key={r.symbol} data-symbol={r.symbol}>
              <div
                role="button"
                tabIndex={0}
                className={rules.d2Entry ? "bot-stock-row d2" : "bot-stock-row"}
                aria-pressed={selected === r.symbol}
                aria-label={`Find ${r.symbol} on the map`}
                onClick={() => onSelect(r.symbol)}
                onKeyDown={rowKeys(() => onSelect(r.symbol))}
              >
                <span className="bot-stock-name">
                  <span
                    className={`bot-lean ${r.side === "C" ? "up" : "down"}`}
                    aria-label={r.side === "C" ? "leaning up" : "leaning down"}
                  >
                    {r.side === "C" ? "▲" : "▼"}
                  </span>
                  <strong>{r.symbol}</strong>
                </span>
                <Meter value={r.t} of={needT} label={`t ${r.t.toFixed(1)}`} />
                <Meter
                  value={r.rvol}
                  of={needVolume}
                  label={`${r.rvol.toFixed(1)}×`}
                />
                {rules.d2Entry && (
                  <Meter
                    value={Math.max(0, r.d2 ?? 0)}
                    of={rules.minD2}
                    label={d2Label(r.d2)}
                  />
                )}
                {state && (
                  <span
                    className={
                      r.blocked ? "bot-stock-state blocked" : "bot-stock-state"
                    }
                  >
                    {state}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {query && rows.length === 0 && (
        <p className="muted small">No watched stock starts with {query}.</p>
      )}
      {!query && live.length > 12 && (
        <button type="button" className="bot-more" onClick={() => setAll(!all)}>
          {all ? "Show the closest 12" : `Show all ${live.length} stocks`}
        </button>
      )}
    </div>
  );
}

const newsStateText: Record<string, string> = {
  pending: "waiting for 09:30 New York",
  failed: "failed today, not applied",
  off: "not set up",
};

/** The news filter's sources, when one is not working. */
function newsNote(news: BotView["news"]) {
  if (!news) return null;
  const parts: string[] = [];
  if (news.earnings !== "ok")
    parts.push(`earnings calendar ${newsStateText[news.earnings]}`);
  const preFine = news.premarket === "ok" || news.premarket === "pending";
  if (!preFine)
    parts.push(`pre-market volume ${newsStateText[news.premarket]}`);
  if (parts.length === 0) return null;
  return <p className="bot-warn small">News filter: {parts.join("; ")}.</p>;
}

function WhatItSees({
  v,
  trades,
  onOpen,
}: {
  v: BotView;
  trades: ReadonlyMap<string, "C" | "P">;
  onOpen?: (symbol: string) => void;
}) {
  const rules = useRules();
  const { picked, fromMap, fromList, mapRef, listRef } = useMapPick();
  const first = nearestFirst(v.scan, rules).find((r) => !r.blocked);
  const selected = picked ?? (first ?? v.scan[0])?.symbol ?? null;
  const row = v.scan.find((r) => r.symbol === selected);
  const signal = v.signals.find((s) => s.symbol === selected);
  return (
    <section className="bot-card" aria-labelledby="bot-sees-title">
      <div className="bot-card-head">
        <h3 id="bot-sees-title">What the bot sees</h3>
        {v.scan.length > 0 && (
          <span className="muted small">
            Minute of {israelAt(v.day, 570 + v.scan[0]!.minute)}
          </span>
        )}
      </div>
      <p className="muted small bot-explain">
        Strength vs SPY and volume vs usual. A shaded corner signals: up a call,
        down a put · ○ today&apos;s signals · ◆ held · tap a stock to pick it on
        the map and in the list.
      </p>
      {newsNote(v.news)}
      {v.scan.length === 0 ? (
        <p className="notice">
          The scan starts {rules.firstEntryMin} minutes after the US open on
          trading days.
        </p>
      ) : (
        <div className="bot-sees">
          <div className="bot-sees-map" ref={mapRef}>
            <SignalMap
              scan={v.scan}
              signals={v.signals}
              selected={selected}
              trades={trades}
              onSelect={fromMap}
            />
            {row && (
              <StockFocus r={row} signal={signal} day={v.day} onOpen={onOpen} />
            )}
          </div>
          <StockList
            scan={v.scan}
            signals={v.signals}
            selected={selected}
            onSelect={fromList}
            listRef={listRef}
          />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Holdings: each open position and the exits still ahead of it

interface ExitStep {
  label: string;
  at: string;
  state: "done" | "next" | "later";
  note: string | null;
}

function dayExitLabel(rules: BotSettings): string {
  if (rules.maxNights === 0) return "Day exit: all out";
  if (rules.nightCapPct > 0)
    return `Day exit: only winners up ${rules.holdFromPct}%+ stay, at most ${rules.nightCapPct}% of the account`;
  return `Day exit: only winners up ${rules.holdFromPct}%+ stay`;
}

/** The exit rules ahead of an open position (packages/trading/src/bot/exits.ts). */
function exitPlan(
  p: Position,
  day: string,
  now: number,
  rules: BotSettings,
): ExitStep[] {
  const plan = sessionPlan(day, rules);
  const steps: { label: string; ms: number; reasons: string[] }[] = [];
  if (p.nights === 0) {
    if (rules.checks)
      steps.push(
        {
          label: "10-min check: half out if the stock is against",
          ms: p.openedAt + 600000,
          reasons: ["check-10"],
        },
        {
          label: "20-min check: the rest out if still against",
          ms: p.openedAt + 1200000,
          reasons: ["check-20"],
        },
      );
    if (rules.stockStages)
      steps.push({
        label: `Staged exit: half out at ${rules.stageHalfS30}, the rest at ${rules.stageFullS30} of the stock's usual 30-min move against the signal price`,
        ms: newYorkToUtc(day, plan.dayExit),
        reasons: ["stage-half", "stage-full"],
      });
    if (rules.sellOnWeakness)
      steps.push({
        label: `Strength gone: all out if its edge over SPY falls to t ${rules.weaknessT}`,
        ms: newYorkToUtc(day, plan.dayExit),
        reasons: ["strength-gone"],
      });
    const w = p.breakWatch;
    if (
      rules.sellFailedBreak &&
      w &&
      (w.state === "watching" || w.state === "failed")
    )
      steps.push({
        label: `Failed break: all out if it reaches ${w.name} (${w.level.toFixed(2)}) and falls back`,
        ms: w.state === "failed" ? now : newYorkToUtc(day, plan.dayExit),
        reasons: ["failed-break"],
      });
  } else if (p.nights > 0) {
    steps.push({
      label: "Morning: half if it gapped our way, else all",
      ms: newYorkToUtc(day, plan.firstEntry),
      reasons: ["morning-gap-keep", "morning-gap-against"],
    });
  }
  steps.push({
    label: dayExitLabel(rules),
    ms: newYorkToUtc(day, plan.dayExit),
    reasons: ["close-1550", "night-cap", "night-no-equity"],
  });
  let nextGiven = false;
  return steps.map((s) => {
    const sale = p.sales.find((x) => s.reasons.includes(x.reason));
    const passed = now >= s.ms;
    let state: ExitStep["state"] = "later";
    if (sale || passed) state = "done";
    else if (!nextGiven) {
      state = "next";
      nextGiven = true;
    }
    let note: string | null = null;
    if (sale) note = `sold ${sale.qty}`;
    else if (passed) note = "kept";
    return { label: s.label, at: israelClock(s.ms), state, note };
  });
}

function Holdings({
  open,
  day,
  now,
}: {
  open: Position[];
  day: string;
  now: number;
}) {
  const rules = useRules();
  return (
    <section className="bot-card" aria-labelledby="bot-hold-title">
      <div className="bot-card-head">
        <h3 id="bot-hold-title">Holding</h3>
        <span className="muted small">Prices are under Live trades</span>
      </div>
      {open.length === 0 ? (
        <p className="muted">Nothing open.</p>
      ) : (
        <ul className="bot-holds">
          {open.map((p) => (
            <li key={p.id}>
              <div className="bot-hold-head">
                <span className={`bot-side ${p.right === "C" ? "up" : "down"}`}>
                  {p.right === "C" ? "Call" : "Put"}
                </span>
                <strong>{contractName(p.contract, p.day)}</strong>
                {p.dry && <span className="pill amber">dry run</span>}
                {p.version && <VersionTag version={p.version} />}
              </div>
              <div className="muted small">
                {p.status === "buying"
                  ? "Buying…"
                  : `${p.qty} contracts at $${p.cost.toFixed(2)} · bought ${israelClock(p.openedAt)}`}
                {p.nights > 0 &&
                  ` · held ${p.nights} night${p.nights === 1 ? "" : "s"}`}
              </div>
              {p.status === "open" && (
                <ol className="bot-plan" aria-label="Exits ahead">
                  {exitPlan(p, day, now, rules).map((s) => (
                    <li key={s.label} className={s.state}>
                      <span className="num">{s.at}</span>
                      <span>{s.label}</span>
                      {s.note && <span className="muted">{s.note}</span>}
                    </li>
                  ))}
                  <li className="always">
                    <span className="num">any time</span>
                    <span>
                      −{rules.stopPct}% with the stock against: all out
                    </span>
                  </li>
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Today's signals, the activity feed and closed trades

function Signals({ v }: { v: BotView }) {
  return (
    <section className="bot-card" aria-labelledby="bot-sig-title">
      <div className="bot-card-head">
        <h3 id="bot-sig-title">Today's signals</h3>
      </div>
      {v.signals.length === 0 ? (
        <p className="muted">No signal yet today.</p>
      ) : (
        <ul className="bot-signals">
          {v.signals.map((s) => (
            <li key={s.symbol}>
              <span className="num bot-signal-time">
                {israelAt(v.day, 570 + s.minute)}
              </span>
              <span className={`bot-side ${s.right === "C" ? "up" : "down"}`}>
                {s.right === "C" ? "Call" : "Put"}
              </span>
              <span className="bot-signal-what">
                <strong>{s.symbol}</strong>
                <span className="muted small">
                  {" "}
                  t {s.t.toFixed(1)} · volume {s.rvol.toFixed(1)}×
                  {s.version && ` · bot ${s.version}`}
                </span>
                {s.detail && (
                  <span className="muted small bot-signal-detail">
                    {contractsInWords(s.detail, s.day)}
                  </span>
                )}
              </span>
              <span className={`bot-outcome ${outcomeTone(s.outcome)}`}>
                {outcomeText[s.outcome] ?? s.outcome}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const kindLabel: Record<BotView["activity"][number]["kind"], string> = {
  info: "•",
  signal: "⚡",
  skip: "–",
  order: "$",
  error: "!",
};

/** What the bot did, newest first. */
function Activity({ items }: { items: BotView["activity"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 15);
  return (
    <section className="bot-card" aria-labelledby="bot-act-title">
      <div className="bot-card-head">
        <h3 id="bot-act-title">Activity</h3>
      </div>
      {items.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <>
          <ul className="bot-activity">
            {shown.map((e, i) => (
              <li key={`${e.at}-${i}`} className={`bot-ev ${e.kind}`}>
                <span className="bot-ev-time num">
                  {israelShortDate(e.at)} {israelClock(e.at)}
                </span>
                <span className="bot-ev-kind" aria-hidden="true">
                  {kindLabel[e.kind]}
                </span>
                <span>{contractsInWords(e.text, nyDay(e.at))}</span>
              </li>
            ))}
          </ul>
          {items.length > 15 && (
            <button
              type="button"
              className="bot-more"
              onClick={() => setAll(!all)}
            >
              {all ? "Show less" : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function Closed({ closed }: { closed: Position[] }) {
  return (
    <section className="bot-card" aria-labelledby="bot-closed-title">
      <div className="bot-card-head">
        <h3 id="bot-closed-title">Closed, last 5 sessions</h3>
        <span className="muted small">Results are under History</span>
      </div>
      {closed.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="bot-signals">
          {closed.map((p) => (
            <li key={p.id}>
              <span className="num bot-signal-time">
                {israelShortDate(p.openedAt)}
              </span>
              <span className={`bot-side ${p.right === "C" ? "up" : "down"}`}>
                {p.right === "C" ? "Call" : "Put"}
              </span>
              <span className="bot-signal-what">
                <strong>{contractName(p.contract, p.day)}</strong>
                <span className="muted small">
                  {" "}
                  {p.bought} at ${p.cost.toFixed(2)}
                  {p.dry && " · dry run"}
                  {p.version && ` · bot ${p.version}`}
                </span>
                <span className="muted small bot-signal-detail">
                  {p.sales
                    .map(
                      (s) =>
                        `${israelClock(s.at)} sold ${s.qty} (${reasonText[s.reason] ?? s.reason})`,
                    )
                    .join(" · ") || "Closed outside the bot"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "v2.1": the version of the rules that entered a position. */
function VersionTag({ version }: { version: string }) {
  const id = canonicalVersion(version); // "2.6*" stamped before MAJOR.MINOR.PATCH reads "2.6.0*"
  let title = `Entered by bot version ${id}`;
  if (id.endsWith("*"))
    title = `Entered by bot version ${id.slice(0, -1)} with changed rules`;
  return (
    <span className="bot-version" title={title}>
      v{id}
    </span>
  );
}

/** The version in words for the rules list: name, date and what it changed. */
function versionWords(id: string): string {
  const known = versionById(id.replace(/\*$/, ""));
  if (!known) return `Your own rule set “${id}”.`;
  let edited = "";
  if (id.endsWith("*")) edited = ", with rules changed below";
  return `${known.id} · ${known.name} (since ${known.since}${edited}). ${known.notes}`;
}

function Rules({ v }: { v: BotView }) {
  const r = useRules();
  let stocks = " (no favorites list received yet)";
  if (v.favorites && r.followFavorites)
    stocks = `, and your "${v.favorites.name}" list (${v.favorites.tickers.length})`;
  if (!r.followFavorites) stocks = ", not following your favorites";
  return (
    <details className="bot-card bot-rules">
      <summary>How the bot decides</summary>
      <ol>
        {v.version && (
          <li>
            <b>Version.</b> {versionWords(v.version)} Every entry is stamped
            with the version that made it.
          </li>
        )}
        <li>
          <b>Stocks.</b> {v.universe.length} core stocks from the backtested
          list{stocks}
          {r.added.length > 0 && `, ${r.added.length} added by you`}
          {r.off.length > 0 && `; ${r.off.length} turned off`}.
        </li>
        {algorithmSteps(r).map((step) => (
          <li key={step.name}>
            <b>{step.name}.</b> {step.text}
          </li>
        ))}
        <li>
          <b>Size.</b> {r.sizePct}% of the account, at most {r.maxBuysPerDay}{" "}
          buys a day and {r.maxOpen} open; no new buys after a {r.dayLossPct}%
          day loss. The same risk rules as your own buys apply. A broker stop at
          −{r.safetyStopPct}% backs the exits up.
        </li>
        <li>
          <b>Pause.</b> The bot switches itself off when its trades are down{" "}
          {r.drawdownPausePct}% of the account from their best.
        </li>
      </ol>
    </details>
  );
}

export function BotPanel({
  onSettings,
  onOpenTicker,
}: {
  onSettings?: () => void;
  // A stock's own page (the Watchlist's), from the map.
  onOpenTicker?: (symbol: string) => void;
}) {
  const { value: answer, error } = usePolling<BotView>(
    "/api/bot",
    refreshMs,
    ignore,
  );
  const value = answer && withEntries(answer);
  const now = useNow(5000);
  if (!value)
    return (
      <p className="notice">
        {error ? "The bot's status is not available." : "Loading…"}
      </p>
    );
  const open = value.positions.filter((p) => p.status !== "closed");
  const closed = value.positions.filter((p) => p.status === "closed").reverse();
  const held: HeldTrade[] = open.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    side: p.right,
    at: p.openedAt,
    what: `${contractName(p.contract, p.day)} · ${p.bought} contract${p.bought === 1 ? "" : "s"} at $${p.cost.toFixed(2)}${p.dry ? " · dry run" : ""}`,
  }));
  const trades = new Map(held.map((t) => [t.symbol, t.side]));
  return (
    <RulesContext.Provider value={value.settings ?? defaultSettings}>
      <div className="bot-panel">
        <div className="bot-head">
          <div>
            <h2 className="portfolio-title">🤖 Main bot</h2>
            <p className="muted small">
              {value.version && `Version ${value.version} · `}
              Delta {value.delta} · {value.sizePct}% a trade · paper account
              {value.lastRun !== null &&
                ` · last check ${ago(value.lastRun, now)}`}
            </p>
          </div>
          <div className="bot-head-side">
            <InTradeSign trades={held} target="bot-hold-title" />
            {statusPill(value)}
            {onSettings && (
              <button type="button" className="bot-more" onClick={onSettings}>
                Settings
              </button>
            )}
          </div>
        </div>
        {error && (
          <p className="bot-warn small">
            Could not refresh; showing the last answer.
          </p>
        )}
        <EntryBanners bot="Main bot" trades={held} />
        <SessionStrip day={value.day} signals={value.signals} now={now} />
        <Funnel v={value} />
        <WhatItSees v={value} trades={trades} onOpen={onOpenTicker} />
        <div className="bot-two">
          <Holdings open={open} day={value.day} now={now} />
          <Signals v={value} />
        </div>
        <Activity items={value.activity} />
        <Closed closed={closed} />
        <Rules v={value} />
      </div>
    </RulesContext.Provider>
  );
}
