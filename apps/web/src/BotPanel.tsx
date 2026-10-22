import { useEffect, useRef, useState } from "react";
import {
  coreClose,
  newYork,
  newYorkToUtc,
} from "../../../packages/market-data/src/calendar.js";
import type { BotView } from "../../../packages/trading/src/bot-api.js";
import {
  contractWords,
  contractsInWords,
  parseOccSymbol,
} from "../../../packages/trading/src/options.js";
import { usePolling } from "./Live.js";
import { israelClock, israelLabel, israelShortDate } from "./time.js";

// The Indi bot on the Portfolio page (docs/tasks/backend-indi-bot.md): what it
// looks at and what it did. Read-only, for every signed-in user; it trades in
// the same paper account, so its positions also appear under Live trades and
// History, marked with the Bot chip.

const refreshMs = 15000;
const ignore = () => {};

// The signal's two conditions (packages/trading/src/bot/signal.ts).
const needT = 2;
const needVolume = 1.5;
// From this share of both conditions, a stock counts as close to a signal.
const closeShare = 0.75;

type ScanRow = BotView["scan"][number];
type Signal = BotView["signals"][number];
type Position = BotView["positions"][number];

const outcomeText: Record<string, string> = {
  bought: "Bought",
  "would-buy": "Would buy (dry run)",
  no_expiry: "Skipped: no expiry 1–7 days out",
  no_strikes: "Skipped: no strikes",
  no_prices: "Skipped: no prices",
  too_cheap: "Skipped: contract under $0.20",
  too_small: "Skipped: 2% buys less than one contract",
  thin: "Skipped: too few contracts traded",
  held: "Skipped: you hold this contract",
  refused: "Refused by the risk rules",
  earnings: "Skipped: earnings reaction day",
  premarket: "Skipped: pre-market volume 4× normal or more",
  error: "Failed",
  new: "Working",
};

/** The colour family of a signal's outcome. */
function outcomeTone(outcome: string): "good" | "warn" | "bad" | "quiet" {
  if (outcome === "bought" || outcome === "would-buy") return "good";
  if (outcome === "refused" || outcome === "new") return "warn";
  if (outcome === "error") return "bad";
  return "quiet";
}

const reasonText: Record<string, string> = {
  "check-10": "10-min check",
  "check-20": "20-min check",
  "stop-30": "−30% stop",
  "close-1550": "end-of-day close",
  "morning-gap-keep": "morning, gap our way",
  "morning-gap-against": "morning, no gap",
  "expiry-day": "expiry day",
};

/** Contracts the bot opened in the last sessions, for the Bot chip. */
export function useBotContracts(): ReadonlySet<string> {
  const { value } = usePolling<BotView>("/api/bot", 30000, ignore);
  return new Set((value?.positions ?? []).map((p) => p.contract));
}

export function BotChip() {
  return (
    <span className="bot-chip" title="Opened by the bot">
      🤖 Bot
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
function sessionPlan(day: string) {
  let close = 960;
  try {
    close = coreClose(day) ?? 960;
  } catch {
    // Outside the calendar's years: a regular day.
  }
  return {
    open: 570,
    firstEntry: 580,
    lastEntry: Math.min(944, close - 16),
    dayExit: close - 10,
    close,
  };
}

// How near a stock is to the signal: both conditions full means a signal.
const nearness = (r: { t: number; rvol: number }) =>
  Math.min(r.t / needT, r.rvol / needVolume);

const blockedText: Record<string, string> = {
  earnings: "earnings reaction day",
  premarket: "pre-market volume 4× normal",
};

/** What a stock still lacks, in words. */
function lacking(r: ScanRow): string {
  if (r.blocked) return `Blocked today: ${blockedText[r.blocked]}`;
  const strong = r.t >= needT;
  const heavy = r.rvol >= needVolume;
  if (strong && heavy) return "Both conditions met";
  if (strong) return `Needs volume: ${r.rvol.toFixed(1)}× of ${needVolume}×`;
  if (heavy) return `Needs strength: t ${r.t.toFixed(1)} of ${needT}`;
  return "Needs strength and volume";
}

function statusPill(v: BotView) {
  if (!v.enabled) return <span className="pill grey">Off</span>;
  if (v.mode === "dry")
    return <span className="pill amber">On · dry run, no orders</span>;
  return <span className="pill green">On · trading the paper account</span>;
}

/** "12 s ago", "4 min ago": how fresh the bot's last check is. */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `at ${israelClock(at)}`;
}

/** Re-renders every few seconds, for "ago" labels and the now line. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

// ---------------------------------------------------------------------------
// The session: where today stands against the bot's own clock

function sessionPhase(day: string, now: number): string {
  const plan = sessionPlan(day);
  const ny = newYork(now);
  if (ny.date !== day || ny.minute > plan.close)
    return "Closed. The scan starts 10 minutes after the next open.";
  if (ny.minute < plan.open)
    return "Before the open: warming up with 20 sessions of bars.";
  if (ny.minute < plan.firstEntry) return "Open. Entries start 10 minutes in.";
  if (ny.minute <= plan.lastEntry) return "Scanning every minute for a signal.";
  if (ny.minute < plan.dayExit)
    return "No new entries. Holdings run their exits.";
  return "Day exit: winners up 100%+ stay overnight, the rest are sold.";
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
  const plan = sessionPlan(day);
  const span = plan.close - plan.open;
  const at = (minute: number) => `${((minute - plan.open) / span) * 100}%`;
  const ny = newYork(now);
  const inSession =
    ny.date === day && ny.minute >= plan.open && ny.minute <= plan.close;
  const phase = sessionPhase(day, now);
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
              className={`bot-strip-signal ${s.right === "C" ? "up" : "down"}`}
              style={{ left: at(plan.open + s.minute) }}
              title={`${s.symbol} ${s.right === "C" ? "call" : "put"} at ${israelAt(day, plan.open + s.minute)}`}
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
          signal
        </span>
        <span>{israelLabel}</span>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The funnel: from the watched stocks to today's buys

function Funnel({ v }: { v: BotView }) {
  const close = v.scan.filter((r) => !r.blocked && nearness(r) >= closeShare);
  const bought = v.signals.filter(
    (s) => s.outcome === "bought" || s.outcome === "would-buy",
  ).length;
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

const pad = { l: 40, r: 14, t: 14, b: 34 };

/** The map's drawing width: its box's width, so text keeps its size on phones. */
function useBoxWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const watch = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    watch.observe(box);
    return () => watch.disconnect();
  }, []);
  return { ref, width };
}

function SignalMap({
  scan,
  signals,
  selected,
  onSelect,
}: {
  scan: ScanRow[];
  signals: Signal[];
  selected: string | null;
  onSelect: (symbol: string) => void;
}) {
  const box = useBoxWidth(640);
  const mapW = Math.max(300, Math.min(760, box.width));
  const mapH = mapW < 520 ? 320 : 340;
  const maxVol = Math.min(6, Math.max(3, ...scan.map((r) => r.rvol * 1.1)));
  const maxT = Math.min(6, Math.max(3, ...scan.map((r) => r.t * 1.1)));
  const right = mapW - pad.r;
  const bottom = mapH - pad.b;
  const x = (v: number) =>
    pad.l + (Math.min(v, maxVol) / maxVol) * (right - pad.l);
  // Leaning up (a call) is above the middle, down (a put) below it.
  const y = (t: number) =>
    pad.t +
    ((maxT - Math.max(-maxT, Math.min(maxT, t))) / (2 * maxT)) *
      (bottom - pad.t);
  const fired = new Set(signals.map((s) => s.symbol));
  // Names on the closest stocks only, so the labels stay readable.
  const named = new Set(scan.slice(0, 8).map((r) => r.symbol));
  if (selected) named.add(selected);
  const volTicks = [0, 1, needVolume, 2, 3, 4, 5, 6].filter((v) => v <= maxVol);
  const tTicks = [-4, -needT, 0, needT, 4].filter((t) => Math.abs(t) <= maxT);
  const zoneX = x(needVolume);
  return (
    <div ref={box.ref}>
      <svg
        className="bot-map"
        viewBox={`0 0 ${mapW} ${mapH}`}
        width="100%"
        role="img"
        aria-label="Each watched stock by strength against SPY and volume against normal. A stock in a shaded corner signals."
      >
        <rect
          className="bot-map-zone up"
          x={zoneX}
          y={pad.t}
          width={right - zoneX}
          height={y(needT) - pad.t}
        />
        <rect
          className="bot-map-zone down"
          x={zoneX}
          y={y(-needT)}
          width={right - zoneX}
          height={bottom - y(-needT)}
        />
        <text
          className="bot-map-zone-label up"
          x={right - 6}
          y={pad.t + 16}
          textAnchor="end"
        >
          Call signal
        </text>
        <text
          className="bot-map-zone-label down"
          x={right - 6}
          y={bottom - 8}
          textAnchor="end"
        >
          Put signal
        </text>
        {tTicks.map((t) => (
          <g key={`t${t}`}>
            <line
              className={
                Math.abs(t) === needT ? "bot-map-need" : "bot-map-grid"
              }
              x1={pad.l}
              x2={right}
              y1={y(t)}
              y2={y(t)}
            />
            <text
              className="bot-map-tick"
              x={pad.l - 6}
              y={y(t) + 4}
              textAnchor="end"
            >
              {t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t)}`}
            </text>
          </g>
        ))}
        {volTicks.map((v) => (
          <g key={`v${v}`}>
            <line
              className={v === needVolume ? "bot-map-need" : "bot-map-grid"}
              x1={x(v)}
              x2={x(v)}
              y1={pad.t}
              y2={bottom}
            />
            <text
              className="bot-map-tick"
              x={x(v)}
              y={bottom + 14}
              textAnchor="middle"
            >
              {v}×
            </text>
          </g>
        ))}
        <text
          className="bot-map-axis"
          x={(pad.l + right) / 2}
          y={mapH - 3}
          textAnchor="middle"
        >
          Volume since the open vs normal →
        </text>
        <text
          className="bot-map-axis"
          transform={`translate(11 ${(pad.t + bottom) / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          ↓ weaker · strength vs SPY (t) · stronger ↑
        </text>
        {scan.map((r) => {
          const cx = x(r.rvol);
          const cy = y(r.side === "C" ? r.t : -r.t);
          const isSelected = selected === r.symbol;
          let tone = r.side === "C" ? "up" : "down";
          if (r.blocked) tone = "blocked";
          return (
            <g
              key={r.symbol}
              className={`bot-dot ${tone}${isSelected ? " selected" : ""}`}
              onClick={() => onSelect(r.symbol)}
            >
              <title>{`${r.symbol}: t ${r.t.toFixed(1)}, volume ${r.rvol.toFixed(1)}×. ${lacking(r)}`}</title>
              {fired.has(r.symbol) && (
                <circle className="bot-dot-ring" cx={cx} cy={cy} r={10} />
              )}
              <circle cx={cx} cy={cy} r={isSelected ? 7 : 5} />
              {named.has(r.symbol) && (
                <text x={cx + 9} y={cy + 4}>
                  {r.symbol}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Meter({
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
}: {
  r: ScanRow;
  signal: Signal | undefined;
  day: string;
}) {
  const lean = r.side === "C" ? "up vs SPY → a call" : "down vs SPY → a put";
  let state = lacking(r);
  if (signal)
    state = `Signaled at ${israelAt(day, 570 + signal.minute)}: ${outcomeText[signal.outcome] ?? signal.outcome}. No second signal today.`;
  return (
    <div className="bot-focus" aria-live="polite">
      <div className="bot-focus-head">
        <strong>{r.symbol}</strong>
        <span className={`bot-lean ${r.side === "C" ? "up" : "down"}`}>
          {r.side === "C" ? "▲" : "▼"} {lean}
        </span>
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
      </div>
      <p className="small">{state}</p>
    </div>
  );
}

/** Every stock's two conditions as bars, closest to a signal first. */
function StockList({
  scan,
  signals,
  selected,
  onSelect,
}: {
  scan: ScanRow[];
  signals: Signal[];
  selected: string | null;
  onSelect: (symbol: string) => void;
}) {
  const [all, setAll] = useState(false);
  const fired = new Map(signals.map((s) => [s.symbol, s]));
  const rows = all ? scan : scan.slice(0, 12);
  return (
    <div className="bot-stocks">
      <div className="bot-stocks-head muted small" aria-hidden="true">
        <span>Stock</span>
        <span>Strength</span>
        <span>Volume</span>
      </div>
      <ul>
        {rows.map((r) => {
          const s = fired.get(r.symbol);
          let state = lacking(r);
          if (s) state = `Signaled · ${outcomeText[s.outcome] ?? s.outcome}`;
          return (
            <li key={r.symbol}>
              <button
                type="button"
                aria-pressed={selected === r.symbol}
                onClick={() => onSelect(r.symbol)}
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
                <span
                  className={
                    r.blocked ? "bot-stock-state blocked" : "bot-stock-state"
                  }
                >
                  {state}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {scan.length > 12 && (
        <button type="button" className="bot-more" onClick={() => setAll(!all)}>
          {all ? "Show the closest 12" : `Show all ${scan.length} stocks`}
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

function WhatItSees({ v }: { v: BotView }) {
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? v.scan[0]?.symbol ?? null;
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
        Two checks per stock, every minute. <b>Strength</b>: how steadily its
        1-minute moves beat SPY × its beta (a t-stat, {needT} or more).{" "}
        <b>Volume</b>: shares since the open against its usual by this time (
        {needVolume}× or more). A stock that reaches a shaded corner signals: up
        buys a call, down a put. A ring marks today's signals.
      </p>
      {newsNote(v.news)}
      {v.scan.length === 0 ? (
        <p className="notice">
          The scan starts 10 minutes after the US open on trading days.
        </p>
      ) : (
        <div className="bot-sees">
          <div className="bot-sees-map">
            <SignalMap
              scan={v.scan}
              signals={v.signals}
              selected={selected}
              onSelect={setPicked}
            />
            {row && <StockFocus r={row} signal={signal} day={v.day} />}
          </div>
          <StockList
            scan={v.scan}
            signals={v.signals}
            selected={selected}
            onSelect={setPicked}
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

/** The exit rules ahead of an open position (packages/trading/src/bot/exits.ts). */
function exitPlan(p: Position, day: string, now: number): ExitStep[] {
  const plan = sessionPlan(day);
  const steps: { label: string; ms: number; reasons: string[] }[] = [];
  if (p.nights === 0) {
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
  } else {
    steps.push({
      label: "Morning: half if it gapped our way, else all",
      ms: newYorkToUtc(day, plan.firstEntry),
      reasons: ["morning-gap-keep", "morning-gap-against"],
    });
  }
  steps.push({
    label: "Day exit: only winners up 100%+ stay",
    ms: newYorkToUtc(day, plan.dayExit),
    reasons: ["close-1550"],
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
                  {exitPlan(p, day, now).map((s) => (
                    <li key={s.label} className={s.state}>
                      <span className="num">{s.at}</span>
                      <span>{s.label}</span>
                      {s.note && <span className="muted">{s.note}</span>}
                    </li>
                  ))}
                  <li className="always">
                    <span className="num">any time</span>
                    <span>−30% with the stock against: all out</span>
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

function Rules({ v }: { v: BotView }) {
  return (
    <details className="bot-card bot-rules">
      <summary>How the bot decides</summary>
      <ol>
        <li>
          <b>Stocks.</b> {v.universe.length} core stocks from the backtested
          list
          {v.favorites
            ? `, and your "${v.favorites.name}" list (${v.favorites.tickers.length})`
            : " (no favorites list received yet)"}
          .
        </li>
        <li>
          <b>Signal.</b> From 10 minutes after the open to 16 minutes before the
          close: strength t {needT}+ and volume {needVolume}×+. One per stock a
          day, on the side that comes first.
        </li>
        <li>
          <b>News filter.</b> No entry on the stock's earnings reaction day, or
          when its pre-market volume is 4× normal or more.
        </li>
        <li>
          <b>Contract.</b> Nearest expiry 1–7 days out, delta closest to{" "}
          {v.delta}; skipped under $0.20 or when few contracts trade.
        </li>
        <li>
          <b>Size.</b> {v.sizePct}% of the account, through the same risk rules
          as your own buys.
        </li>
        <li>
          <b>Exits.</b> Half at +10 min and the rest at +20 min if the stock is
          against; all out at −30% with the stock against; at the day exit only
          winners up 100%+ stay overnight (2 nights at most). A broker stop at
          −50% backs it up.
        </li>
      </ol>
    </details>
  );
}

export function BotPanel({ onSettings }: { onSettings?: () => void }) {
  const { value, error } = usePolling<BotView>("/api/bot", refreshMs, ignore);
  const now = useNow(5000);
  if (!value)
    return (
      <p className="notice">
        {error ? "The bot's status is not available." : "Loading…"}
      </p>
    );
  const open = value.positions.filter((p) => p.status !== "closed");
  const closed = value.positions.filter((p) => p.status === "closed").reverse();
  return (
    <div className="bot-panel">
      <div className="bot-head">
        <div>
          <h2 className="portfolio-title">🤖 Bot</h2>
          <p className="muted small">
            Delta {value.delta} · {value.sizePct}% a trade · paper account
            {value.lastRun !== null &&
              ` · last check ${ago(value.lastRun, now)}`}
          </p>
        </div>
        <div className="bot-head-side">
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
      <SessionStrip day={value.day} signals={value.signals} now={now} />
      <Funnel v={value} />
      <WhatItSees v={value} />
      <div className="bot-two">
        <Holdings open={open} day={value.day} now={now} />
        <Signals v={value} />
      </div>
      <Activity items={value.activity} />
      <Closed closed={closed} />
      <Rules v={value} />
    </div>
  );
}
