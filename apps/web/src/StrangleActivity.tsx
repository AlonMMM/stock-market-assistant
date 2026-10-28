import { useState, type RefObject } from "react";
import {
  coreClose,
  newYork,
  newYorkToUtc,
} from "../../../packages/market-data/src/calendar.js";
import {
  alertCloseness,
  alertRule,
} from "../../../packages/trading/src/strangle/alert.js";
import type { StrangleSettings } from "../../../packages/trading/src/strangle/settings.js";
import type {
  StrangleScanRow,
  StrangleTradeView,
  StrangleView,
} from "../../../packages/trading/src/strangle/view.js";
import type { Portfolio as PortfolioData } from "../../../packages/trading/src/portfolio.js";
import { EntryBanners, InTradeSign, type HeldTrade } from "./BotEntries.js";
import { BotMap, useMapPick, type MapPoint } from "./BotMap.js";
import { byCorner, cornerGap } from "./bot-map-model.js";
import {
  FindStock,
  Meter,
  ago,
  rowKeys,
  useNow,
  withPicked,
} from "./BotPanel.js";
import { usePolling } from "./Live.js";
import {
  TradeRow,
  legWords,
  outcomeWords,
  result,
  signedUsd,
  tone,
  usd,
} from "./StranglePanel.js";
import { israelClock, israelLabel, israelShortDate } from "./time.js";

// The volume bot's activity page (the approved design, modeled on the Main
// bot's BotPanel.tsx and reusing its bot-* classes): today's session, the
// funnel from watched stocks to buys, the alert map, the trades waiting for
// their side, the legs held and the activity log. Read-only for everyone.

const ignore = () => {};
type Signal = StrangleView["signals"][number];

// From this share of both ratio checks, a stock counts as close to an alert.
const closeShare = 0.6;
const needVolume = alertRule.threshold;
const needMove = alertRule.priceMultiple;

/** Israel clock time of a session minute (09:30 New York = 0) on a date. */
function israelAt(day: string, sessionMinute: number): string {
  return israelClock(newYorkToUtc(day, 570 + sessionMinute));
}

/** Session minutes of the day's close (390 on a regular day). */
function closeOf(day: string): number {
  try {
    return (coreClose(day) ?? 960) - 570;
  } catch {
    return 390; // outside the calendar's years: a regular day
  }
}

const pctText = (v: number, digits = 1) => `${v.toFixed(digits)}%`;
function signedPct(v: number, digits = 1): string {
  let sign = "";
  if (v > 0) sign = "+";
  if (v < 0) sign = "−";
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
}

// Outcomes reached only after the stock showed its side (the limits and the
// leg's checks run in buyLeg, after sideOf).
const afterSide = new Set([
  "traded",
  "would-trade",
  "no_strikes",
  "too_cheap",
  "thin",
  "too_small",
  "max_trades",
  "max_open",
  "day_loss",
  "strength",
  "refused",
]);
const isBought = (outcome: string) =>
  outcome === "traded" || outcome === "would-trade";

/** The colour of an alert's tick: the leg it bought, waiting, or no trade. */
function alertTone(a: Signal, trades: StrangleTradeView[]): string {
  if (a.outcome === "watching") return "wait";
  if (!isBought(a.outcome)) return "quiet";
  const t = trades.find(
    (x) => x.symbol === a.symbol && x.alertMinute === a.minute,
  );
  if (t?.side === "P") return "down";
  if (t?.side === "C") return "up";
  return a.side === "up" ? "up" : "down";
}

/** Today's trades of the bot's mode, open and closed, once each. */
function todaysTrades(v: StrangleView, day: string): StrangleTradeView[] {
  const byId = new Map<string, StrangleTradeView>();
  for (const t of [...v.trades, ...v.open])
    if (t.day === day && t.leg && t.leg.bought > 0) byId.set(t.id, t);
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Today's session

function sessionPhase(day: string, now: number, s: StrangleSettings): string {
  const close = closeOf(day);
  const ny = newYork(now);
  const m = ny.minute - 570;
  if (ny.date !== day || m > close) return "Closed.";
  if (m < 0) return "Before the open: warming up with 20 sessions of bars.";
  if (m < s.firstMinute)
    return `Open. Alerts count from ${s.firstMinute} minutes in.`;
  if (m <= s.lastMinute) return "Checking every stock each minute.";
  if (m < Math.min(s.endMinute, close - 30))
    return "No new trades. Held legs run their give-back.";
  return "All out.";
}

/** A limit's bar: fills toward the limit, amber once it is reached. */
function LimitMeter({
  value,
  of,
  label,
}: {
  value: number;
  of: number;
  label: string;
}) {
  const share = Math.max(0, Math.min(1, value / of));
  let fill = "bot-meter-fill";
  if (share >= 1) fill += " limit";
  return (
    <span className="bot-meter" title={label}>
      <span className="bot-meter-bar">
        <span className={fill} style={{ width: `${share * 100}%` }} />
      </span>
      <span className="num">{label}</span>
    </span>
  );
}

function SessionStrip({
  v,
  day,
  now,
  dayChangePct,
}: {
  v: StrangleView;
  day: string;
  now: number;
  dayChangePct: number | null;
}) {
  const s = v.settings;
  const close = closeOf(day);
  const end = Math.min(s.endMinute, close - 30);
  const at = (m: number) => `${(m / close) * 100}%`;
  const ny = newYork(now);
  const nowMinute = ny.minute - 570;
  const inSession = ny.date === day && nowMinute >= 0 && nowMinute <= close;
  const phase = sessionPhase(day, now, s);
  const openMs = newYorkToUtc(day, 570);
  const hours: number[] = [];
  for (
    let ms = Math.ceil(openMs / 3600000) * 3600000;
    ms <= openMs + close * 60000;
    ms += 3600000
  )
    hours.push(ms);
  const all = [...v.trades, ...v.open];
  const today = todaysTrades(v, day);
  const dry = v.mode === "dry";
  const tradedToday = today.filter((t) => t.dry === dry).length;
  const openNow = v.open.filter((t) => t.dry === dry && t.leg !== null).length;
  const pnl = today.reduce((sum, t) => sum + result(t).pnl, 0);
  const lossNow = Math.max(0, -(dayChangePct ?? 0));
  let dayLabel = "—";
  if (dayChangePct !== null)
    dayLabel = `${signedPct(dayChangePct)} of −${s.dayLossPct}%`;
  return (
    <section className="bot-card" aria-labelledby="vb-session-title">
      <div className="bot-card-head">
        <h3 id="vb-session-title">Today's session</h3>
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
              left: at(s.firstMinute),
              width: `${((s.lastMinute - s.firstMinute) / close) * 100}%`,
            }}
          />
          <span
            className="bot-strip-exit"
            style={{ left: at(end), right: 0 }}
          />
          {v.signals.map((a) => (
            <span
              key={`${a.symbol}-${a.minute}`}
              className={`bot-strip-signal ${alertTone(a, all)}`}
              style={{ left: at(a.minute) }}
              title={`${a.symbol} at ${israelAt(day, a.minute)}: ${outcomeWords[a.outcome] ?? a.outcome}`}
            />
          ))}
          {inSession && (
            <span className="bot-strip-now" style={{ left: at(nowMinute) }}>
              <span>Now</span>
            </span>
          )}
        </div>
        <div className="bot-strip-marks num" aria-hidden="true">
          {hours.map((ms) => (
            <span
              key={ms}
              style={{ left: `${((ms - openMs) / (close * 60000)) * 100}%` }}
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
            {israelAt(day, s.firstMinute)}–{israelAt(day, s.lastMinute)}
          </b>
        </span>
        <span>
          <span className="key exit" /> All out{" "}
          <b className="num">{israelAt(day, end)}</b>
        </span>
        <span>
          Open <b className="num">{israelAt(day, 0)}</b> · close{" "}
          <b className="num">{israelAt(day, close)}</b>
        </span>
        <span>
          <span className="key up" /> call <span className="key down" /> put{" "}
          <span className="key wait" /> waiting for the side{" "}
          <span className="key quiet" /> no trade
        </span>
        <span>{israelLabel}</span>
      </p>
      <div className="vb-limits">
        <span>
          <span className="muted small">Trades today</span>
          <LimitMeter
            value={tradedToday}
            of={s.maxTradesPerDay}
            label={`${tradedToday} of ${s.maxTradesPerDay}`}
          />
        </span>
        <span>
          <span className="muted small">Open</span>
          <LimitMeter
            value={openNow}
            of={s.maxOpen}
            label={`${openNow} of ${s.maxOpen}`}
          />
        </span>
        <span>
          <span className="muted small">The day vs its loss stop</span>
          <LimitMeter value={lossNow} of={s.dayLossPct} label={dayLabel} />
        </span>
        <span>
          <span className="muted small">Today's P&amp;L, closed + open</span>
          <b className={`num${tone(pnl)}`}>{signedUsd(pnl)}</b>
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The funnel

function Funnel({ v }: { v: StrangleView }) {
  const close = v.scan.filter((r) => alertCloseness(r) >= closeShare).length;
  const sided = v.signals.filter((a) => afterSide.has(a.outcome)).length;
  const bought = v.signals.filter((a) => isBought(a.outcome)).length;
  const added = v.settings.added.length;
  let watchedFrom = `${added} of yours`;
  if (v.favorites && v.settings.followFavorites)
    watchedFrom = `${v.favorites.count} favorites + ${added} of yours`;
  const steps = [
    { n: v.watching.length, label: "Watching", sub: watchedFrom },
    {
      n: close,
      label: "Close to an alert",
      sub: `${Math.round(closeShare * 100)}%+ of both checks now`,
    },
    {
      n: v.signals.length,
      label: "Alerts today",
      sub: `up to ${v.settings.maxPerStock} a stock`,
    },
    {
      n: sided,
      label: "Found a side",
      sub: `within ${v.settings.waitMinutes} minutes`,
    },
    {
      n: bought,
      label: v.mode === "dry" ? "Would buy" : "Bought",
      sub: `${sided - bought} skipped`,
    },
  ];
  return (
    <ol
      className="bot-funnel vb-funnel"
      aria-label="From watched stocks to buys"
    >
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
// What the bot sees: each stock by its two ratio checks

const signedMove = (r: StrangleScanRow) =>
  r.side === "up" ? r.moveRatio : -r.moveRatio;

/** What a stock still lacks for an alert, in words. */
function lacking(r: StrangleScanRow): string {
  const needs: string[] = [];
  if (r.volRatio < needVolume)
    needs.push(`volume ${r.volRatio.toFixed(1)}× of ${needVolume}×`);
  if (r.moveRatio < needMove)
    needs.push(`move ${r.moveRatio.toFixed(1)}× of ${needMove}×`);
  if (r.shares < alertRule.minVolume)
    needs.push(
      `${r.shares.toLocaleString("en-US")} of ${alertRule.minVolume.toLocaleString("en-US")} shares`,
    );
  if (r.movePct < alertRule.minMovePercent)
    needs.push(
      `a ${pctText(r.movePct, 2)} move of ${alertRule.minMovePercent}%`,
    );
  if (needs.length === 0)
    return "All four checks met: it alerts when its last 1-minute bar also closes the same way (up: above its open and the minute before)";
  return `Needs ${needs.join(", ")}`;
}

/** The stocks in the order of the map: the nearest its corner first (user 2026-10-28). */
function nearestFirst(scan: StrangleScanRow[]): StrangleScanRow[] {
  const { maxVol, maxMove } = alertRange(scan);
  return byCorner(
    scan,
    (r) =>
      cornerGap(r.volRatio, r.moveRatio, needVolume, needMove, maxVol, maxMove),
    (r) => Math.min(r.volRatio / needVolume, r.moveRatio / needMove),
  );
}

/** The map's axes' ends, from the stocks on it. */
function alertRange(scan: StrangleScanRow[]) {
  return {
    maxVol: Math.min(10, Math.max(6, ...scan.map((r) => r.volRatio * 1.1))),
    maxMove: Math.min(8, Math.max(4.5, ...scan.map((r) => r.moveRatio * 1.1))),
  };
}

function AlertMap({
  scan,
  waiting,
  selected,
  trades,
  onSelect,
}: {
  scan: StrangleScanRow[];
  waiting: ReadonlySet<string>;
  selected: string | null;
  trades: ReadonlyMap<string, "C" | "P">;
  onSelect: (symbol: string) => void;
}) {
  const { maxVol, maxMove } = alertRange(scan);
  const points: MapPoint[] = scan.map((r) => ({
    symbol: r.symbol,
    x: r.volRatio,
    y: signedMove(r),
    tone: r.side === "up" ? "up" : "down",
    ring: waiting.has(r.symbol),
    trade: trades.get(r.symbol) ?? null,
    title: `${r.symbol}: volume ${r.volRatio.toFixed(1)}×, move ${r.moveRatio.toFixed(1)}× (${pctText(r.movePct, 2)}). ${lacking(r)}`,
  }));
  return (
    <BotMap
      points={points}
      selected={selected}
      onSelect={onSelect}
      axes={{
        xMax: maxVol,
        yMax: maxMove,
        needX: needVolume,
        needY: needMove,
        xTicks: [0, 1, 2, needVolume, 6, 8, 10].filter((v) => v <= maxVol),
        yTicks: [-6, -needMove, 0, needMove, 6].filter(
          (m) => Math.abs(m) <= maxMove,
        ),
        yTick: (m) => (m === 0 ? "0" : `${Number(Math.abs(m).toFixed(2))}×`),
        zones: ["Alert, moving up", "Alert, moving down"],
        xTitle: "Volume, last 3 minutes vs usual →",
        yTitle: "↓ down · move vs its usual 3 minutes · up ↑",
        label:
          "Each watched stock by its last 3 minutes' volume and move against its usual. A stock in a shaded corner alerts.",
      }}
    />
  );
}

function StockFocus({
  r,
  traded,
  maxPerStock,
  onOpen,
}: {
  r: StrangleScanRow;
  traded: number;
  maxPerStock: number;
  onOpen?: (symbol: string) => void;
}) {
  const up = r.side === "up";
  // Less text (user 2026-10-27): the meters say what is missing; words only
  // for what they cannot show.
  let today = "";
  if (traded > 0) today = `Traded ${traded} today.`;
  if (traded >= maxPerStock)
    today = `Traded ${traded} today: no more today (most ${maxPerStock}).`;
  const fewShares = r.shares < alertRule.minVolume;
  const smallMove = r.movePct < alertRule.minMovePercent;
  return (
    <div className="bot-focus" aria-live="polite">
      <div className="bot-focus-head">
        <strong>{r.symbol}</strong>
        <span className={`bot-lean ${up ? "up" : "down"}`}>
          {up ? "▲ moving up" : "▼ moving down"}
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
          <span className="muted small">Volume (need {needVolume}×)</span>
          <Meter
            value={r.volRatio}
            of={needVolume}
            label={`${r.volRatio.toFixed(1)}×`}
          />
        </span>
        <span>
          <span className="muted small">Move (need {needMove}×)</span>
          <Meter
            value={r.moveRatio}
            of={needMove}
            label={`${r.moveRatio.toFixed(1)}×`}
          />
        </span>
        {fewShares && (
          <span>
            <span className="muted small">
              Shares (need {alertRule.minVolume.toLocaleString("en-US")})
            </span>
            <Meter
              value={r.shares}
              of={alertRule.minVolume}
              label={r.shares.toLocaleString("en-US")}
            />
          </span>
        )}
        {smallMove && (
          <span>
            <span className="muted small">
              Price move (need {alertRule.minMovePercent}%)
            </span>
            <Meter
              value={r.movePct}
              of={alertRule.minMovePercent}
              label={pctText(r.movePct, 2)}
            />
          </span>
        )}
      </div>
      {today && <p className="small muted">{today}</p>}
    </div>
  );
}

// Alert outcomes that end a stock's day: no later burst can trade it (user
// 2026-10-26: "maybe it's good to remove it from the map, because now it's
// confusing").
const dayEnders: Record<string, string> = {
  earnings: "earnings day",
  premarket: "busy pre-market",
  no_expiry: "no expiry today or next session",
};

/** The stocks out for the rest of today, with why: filtered, or their trades used. */
function outToday(v: StrangleView, day: string): Map<string, string> {
  const out = new Map<string, string>();
  // Known from the day's start: no option expiring today or the next session.
  for (const symbol of v.noExpiry ?? [])
    out.set(symbol, "no option expiring today or the next session");
  for (const a of v.signals) {
    const why = dayEnders[a.outcome];
    if (why) out.set(a.symbol, why);
  }
  const traded = new Map<string, number>();
  for (const t of todaysTrades(v, day))
    if (t.leg && t.leg.bought > 0)
      traded.set(t.symbol, (traded.get(t.symbol) ?? 0) + 1);
  for (const [symbol, n] of traded)
    if (n >= v.settings.maxPerStock) out.set(symbol, `${n} trades today: done`);
  return out;
}

/** A stock's latest alert that found no side: it can try again on a new burst. */
function noSides(v: StrangleView, day: string): Map<string, string> {
  const last = new Map<string, Signal>();
  for (const a of v.signals) {
    const seen = last.get(a.symbol);
    if (!seen || a.minute > seen.minute) last.set(a.symbol, a);
  }
  const out = new Map<string, string>();
  for (const [symbol, a] of last)
    if (a.outcome === "no_side")
      out.set(
        symbol,
        `No side after the ${israelAt(day, a.minute)} alert · a new burst can retry`,
      );
  return out;
}

function StockList({
  scan,
  out,
  waiting,
  notes,
  selected,
  onSelect,
  listRef,
}: {
  scan: StrangleScanRow[];
  // the stocks out for today: on the map, in the list only when searched
  // for or picked on the map (user 2026-10-27)
  out: ReadonlyMap<string, string>;
  waiting: ReadonlySet<string>;
  // why a stock is out today, or its last alert found no side
  notes: ReadonlyMap<string, string>;
  selected: string | null;
  onSelect: (symbol: string) => void;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const [all, setAll] = useState(false);
  const [find, setFind] = useState("");
  const query = find.trim().toUpperCase();
  const ordered = nearestFirst(scan);
  const live = query
    ? ordered.filter((r) => r.symbol.startsWith(query))
    : ordered.filter((r) => !out.has(r.symbol));
  const rows = withPicked(
    all || query ? live : live.slice(0, 12),
    scan,
    selected,
  );
  return (
    <div className="bot-stocks" ref={listRef}>
      <FindStock value={find} onChange={setFind} />
      <div className="bot-stocks-head muted small" aria-hidden="true">
        <span>Stock</span>
        <span>Volume</span>
        <span>Move</span>
      </div>
      <ul>
        {rows.map((r) => {
          const up = r.side === "up";
          // Words only for what the bars cannot show (user 2026-10-27).
          let state = notes.get(r.symbol) ?? "";
          if (waiting.has(r.symbol)) state = "Alerted · waiting for the side";
          return (
            <li key={r.symbol} data-symbol={r.symbol}>
              <div
                role="button"
                tabIndex={0}
                className="bot-stock-row"
                aria-pressed={selected === r.symbol}
                aria-label={`Find ${r.symbol} on the map`}
                onClick={() => onSelect(r.symbol)}
                onKeyDown={rowKeys(() => onSelect(r.symbol))}
              >
                <span className="bot-stock-name">
                  <span
                    className={`bot-lean ${up ? "up" : "down"}`}
                    aria-label={up ? "moving up" : "moving down"}
                  >
                    {up ? "▲" : "▼"}
                  </span>
                  <strong>{r.symbol}</strong>
                </span>
                <Meter
                  value={r.volRatio}
                  of={needVolume}
                  label={`${r.volRatio.toFixed(1)}×`}
                />
                <Meter
                  value={r.moveRatio}
                  of={needMove}
                  label={`${r.moveRatio.toFixed(1)}×`}
                />
                {state && <span className="bot-stock-state">{state}</span>}
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
          {all ? "Show the closest 12" : `Show all ${live.length}`}
        </button>
      )}
    </div>
  );
}

function WhatItSees({
  v,
  day,
  trades,
  onOpen,
}: {
  v: StrangleView;
  day: string;
  trades: ReadonlyMap<string, "C" | "P">;
  onOpen?: (symbol: string) => void;
}) {
  const { picked, fromMap, fromList, mapRef, listRef } = useMapPick();
  const [showOut, setShowOut] = useState(false);
  const out = outToday(v, day);
  const notes = new Map([...noSides(v, day), ...out]);
  const scan = showOut ? v.scan : v.scan.filter((r) => !out.has(r.symbol));
  const selected =
    picked ??
    nearestFirst(v.scan).find((r) => !out.has(r.symbol))?.symbol ??
    null;
  const row = v.scan.find((r) => r.symbol === selected);
  const waiting = new Set(
    v.open.filter((t) => t.phase === "watching").map((t) => t.symbol),
  );
  const traded = todaysTrades(v, day).filter(
    (t) => t.symbol === selected,
  ).length;
  const first = v.scan[0];
  const outLabel = showOut
    ? `Hide the ${out.size} out for today`
    : `Show the ${out.size} out for today`;
  return (
    <section className="bot-card" aria-labelledby="vb-sees-title">
      <div className="bot-card-head">
        <h3 id="vb-sees-title">What the bot sees</h3>
        {first && (
          <span className="muted small">
            Minute of {israelAt(day, first.minute)}
          </span>
        )}
      </div>
      <p className="muted small bot-explain">
        Last 3 minutes against usual. A shaded corner alerts · ○ waiting for its
        side · ◆ held · tap a stock to pick it on the map and in the list.
      </p>
      {out.size > 0 && (
        <button
          type="button"
          className="bot-more"
          aria-pressed={showOut}
          onClick={() => setShowOut(!showOut)}
        >
          {outLabel}
        </button>
      )}
      {v.scan.length === 0 ? (
        <p className="notice">
          The map fills from the first minutes after the US open on trading
          days.
        </p>
      ) : (
        <div className="bot-sees">
          <div className="bot-sees-map" ref={mapRef}>
            <AlertMap
              scan={scan}
              waiting={waiting}
              selected={selected}
              trades={trades}
              onSelect={fromMap}
            />
            {row && (
              <StockFocus
                r={row}
                traded={traded}
                maxPerStock={v.settings.maxPerStock}
                onOpen={onOpen}
              />
            )}
          </div>
          <StockList
            scan={v.scan}
            out={out}
            waiting={waiting}
            notes={notes}
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
// Waiting for the side

function SideGauge({
  t,
  s,
  now,
}: {
  t: StrangleTradeView;
  s: StrangleSettings;
  now: number;
}) {
  const ref = t.stockRef;
  const step = s.confirmUnits * t.unit * ref;
  const put = ref - step;
  const call = ref + step;
  const price = t.marks?.stock ?? null;
  // The gauge spans 1.6 steps each way; a price beyond it sits at the edge.
  const span = step * 1.6;
  const share = (p: number) =>
    Math.max(0, Math.min(1, (p - (ref - span)) / (2 * span)));
  const at = (p: number) => `${share(p) * 100}%`;
  const deadline = newYorkToUtc(t.day, 570 + t.alertMinute + s.waitMinutes);
  const left = Math.max(0, deadline - now);
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  let countdown = `${mins}:${String(secs).padStart(2, "0")} left`;
  if (left === 0) countdown = "time is up";
  let where = "No price yet";
  if (price !== null) {
    const move = (price / ref - 1) * 100;
    where = `Now ${price.toFixed(2)} (${signedPct(move, 2)} from the alert)`;
  }
  return (
    <li className="vb-wait">
      <div className="bot-hold-head">
        <strong>{t.symbol}</strong>
        <span className="muted small">
          alert {t.alertSide} at {israelAt(t.day, t.alertMinute)}
        </span>
        <span className="vb-countdown num">{countdown}</span>
      </div>
      <div
        className="vb-gauge"
        role="img"
        aria-label={`${t.symbol}: put at ${put.toFixed(2)}, call at ${call.toFixed(2)}. ${where}`}
      >
        <span
          className="vb-gauge-zone down"
          style={{ left: 0, width: at(put) }}
        />
        <span
          className="vb-gauge-zone up"
          style={{ left: at(call), right: 0 }}
        />
        <span className="vb-gauge-mid" style={{ left: "50%" }} />
        {price !== null && (
          <span className="vb-gauge-dot" style={{ left: at(price) }} />
        )}
      </div>
      <div className="vb-gauge-marks num small">
        <span className="down">Put {put.toFixed(2)}</span>
        <span className="muted">Alert {ref.toFixed(2)}</span>
        <span className="up">Call {call.toFixed(2)}</span>
      </div>
      <p className="muted small">{where}</p>
    </li>
  );
}

function Waiting({ v, now }: { v: StrangleView; now: number }) {
  const watching = v.open.filter((t) => t.phase === "watching");
  return (
    <section className="bot-card" aria-labelledby="vb-wait-title">
      <div className="bot-card-head">
        <h3 id="vb-wait-title">Waiting for the side</h3>
        <span className="muted small">
          The leg of the side the stock moves {v.settings.confirmUnits}× its
          typical 30-minute move, within {v.settings.waitMinutes} minutes
        </span>
      </div>
      {watching.length === 0 ? (
        <p className="muted">Nothing waiting.</p>
      ) : (
        <ul className="bot-holds">
          {watching.map((t) => (
            <SideGauge key={t.id} t={t} s={v.settings} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Holding

/** The stock since the buy and its trailing sale line (decide.ts giveBackExit). */
function trail(t: StrangleTradeView, s: StrangleSettings) {
  const from = t.sideMinute ?? t.alertMinute;
  const points = (t.path ?? []).filter(([m]) => m >= from);
  const isCall = t.side === "C";
  const back = s.giveBackUnits * t.unit;
  let best = points[0]?.[1] ?? t.best ?? t.stockRef;
  const sale: [number, number][] = [];
  for (const [m, c] of points) {
    if (isCall) best = Math.max(best, c);
    else best = Math.min(best, c);
    sale.push([m, isCall ? best * (1 - back) : best * (1 + back)]);
  }
  return { points, sale };
}

function HoldChart({ t, s }: { t: StrangleTradeView; s: StrangleSettings }) {
  const { points, sale } = trail(t, s);
  if (points.length < 2)
    return <p className="muted small">The chart fills from the next minute.</p>;
  const w = 320;
  const h = 90;
  const p = 4;
  const values = [...points.map((x) => x[1]), ...sale.map((x) => x[1])];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const m0 = points[0]![0];
  const m1 = points.at(-1)![0];
  const x = (m: number) => p + ((m - m0) / Math.max(1, m1 - m0)) * (w - 2 * p);
  const y = (v: number) =>
    p + ((hi - v) / Math.max(1e-9, hi - lo)) * (h - 2 * p);
  const line = (xs: [number, number][]) =>
    xs
      .map(
        ([m, v], i) => `${i ? "L" : "M"}${x(m).toFixed(1)} ${y(v).toFixed(1)}`,
      )
      .join(" ");
  const last = points.at(-1)!;
  return (
    <svg
      className="vb-hold-chart"
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      role="img"
      aria-label={`${t.symbol} since the buy, with the trailing sale line`}
    >
      <path className="vb-sale-line" d={line(sale)} />
      <path className="vb-stock-line" d={line(points)} />
      <circle className="vb-stock-dot" cx={x(last[0])} cy={y(last[1])} r={4}>
        <title>{`${israelAt(t.day, last[0])}: ${last[1].toFixed(2)}`}</title>
      </circle>
    </svg>
  );
}

function Holding({ v }: { v: StrangleView }) {
  const s = v.settings;
  const held = v.open.filter((t) => t.phase !== "watching");
  return (
    <section className="bot-card" aria-labelledby="vb-hold-title">
      <div className="bot-card-head">
        <h3 id="vb-hold-title">Holding</h3>
        <span className="muted small">
          Sold when the stock gives back {s.giveBackUnits}× its typical
          30-minute move from its best
        </span>
      </div>
      {held.length === 0 ? (
        <p className="muted">Nothing held.</p>
      ) : (
        <ul className="bot-holds vb-holds">
          {held.map((t) => {
            const isCall = t.side === "C";
            const back = s.giveBackUnits * t.unit;
            const stock = t.marks?.stock ?? null;
            const best = t.best;
            let saleAt: number | null = null;
            if (best !== null)
              saleAt = isCall ? best * (1 - back) : best * (1 + back);
            let distance = "";
            if (stock !== null && saleAt !== null) {
              const gap = Math.abs(stock / saleAt - 1) * 100;
              const above = stock >= saleAt;
              distance = `${pctText(gap, 2)} ${above ? "above" : "below"} the sale`;
            }
            const r = result(t);
            const sideClass = isCall ? "up" : "down";
            let contract = "—";
            if (t.leg) contract = `${t.leg.qty} × ${legWords(t.leg.contract)}`;
            let state = "";
            if (t.phase === "buying") state = "buying…";
            if (t.phase === "closing") state = "selling…";
            return (
              <li key={t.id}>
                <div className="bot-hold-head">
                  <span className={`bot-side ${sideClass}`}>
                    {isCall ? "Call" : "Put"}
                  </span>
                  <strong>{t.symbol}</strong>
                  <span className="muted small">{contract}</span>
                  {t.dry && <span className="pill amber">dry run</span>}
                  {state && <span className="muted small">{state}</span>}
                </div>
                <HoldChart t={t} s={s} />
                <p className="vb-hold-legend muted small">
                  <span>
                    <span className="key stock" /> stock
                  </span>
                  <span>
                    <span className="key sale" /> sale line
                  </span>
                </p>
                <dl className="vb-hold-stats num small">
                  <div>
                    <dt>Best</dt>
                    <dd>{best !== null ? best.toFixed(2) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Now</dt>
                    <dd>{stock !== null ? stock.toFixed(2) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Sale at</dt>
                    <dd>
                      {saleAt !== null ? saleAt.toFixed(2) : "—"}
                      {distance && <span className="muted"> · {distance}</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>Paid</dt>
                    <dd>{usd(t.paid)}</dd>
                  </div>
                  <div>
                    <dt>P&amp;L</dt>
                    <dd className={tone(r.pnl).trim()}>{signedUsd(r.pnl)}</dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Trades and the activity log

function Trades({ v }: { v: StrangleView }) {
  const closed = v.trades.filter((t) => t.phase === "closed");
  const total = closed.reduce((sum, t) => sum + (t.got - t.paid), 0);
  const winners = closed.filter((t) => t.got > t.paid).length;
  return (
    <section className="bot-card" aria-labelledby="vb-trades-title">
      <div className="bot-card-head">
        <h3 id="vb-trades-title">Trades, last 30 days</h3>
        <span className="muted small">
          {closed.length} closed, {winners} winners ·{" "}
          <b className={`num${tone(total)}`}>{signedUsd(total)}</b> · tap a
          trade for its fills
        </span>
      </div>
      {v.trades.length === 0 ? (
        <p className="muted">No trades yet.</p>
      ) : (
        <div className="st-table-wrap">
          <table className="st-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Stock</th>
                <th>Alert</th>
                <th>Leg</th>
                <th>State</th>
                <th className="num">Paid</th>
                <th className="num">Result</th>
              </tr>
            </thead>
            <tbody>
              {v.trades.map((t) => (
                <TradeRow key={t.id} t={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const kindLabel: Record<string, string> = {
  info: "•",
  signal: "⚡",
  skip: "–",
  order: "$",
  error: "!",
};

function Activity({ items }: { items: StrangleView["events"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 15);
  return (
    <section className="bot-card" aria-labelledby="vb-act-title">
      <div className="bot-card-head">
        <h3 id="vb-act-title">Activity</h3>
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
                  {kindLabel[e.kind] ?? "•"}
                </span>
                <span>{e.text}</span>
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

function statusPill(v: StrangleView) {
  if (!v.enabled) return <span className="pill grey">Off</span>;
  if (v.mode === "dry")
    return <span className="pill amber">On · dry run, no orders</span>;
  return <span className="pill green">On · trading its paper account</span>;
}

export function StrangleActivity({
  onSettings,
  onOpenTicker,
}: {
  onSettings?: () => void;
  // A stock's own page (the Watchlist's), from the map.
  onOpenTicker?: (symbol: string) => void;
}) {
  // Every second (user 2026-10-28), while the page is in view; its scan
  // moves once a minute, when each minute's bar closes.
  const { value: v, error } = usePolling<StrangleView>(
    "/api/strangle",
    1000,
    ignore,
  );
  // The account's day change, for the day-loss meter (the Trades page's source).
  const { value: account } = usePolling<PortfolioData>(
    "/api/portfolio/strangle",
    30000,
    ignore,
  );
  const now = useNow(1000);
  if (!v)
    return (
      <p className={error ? "notice error" : "chart-status"}>
        {error
          ? `The volume bot is unavailable: ${error}`
          : "Loading the volume bot…"}
      </p>
    );
  const day = v.day ?? newYork(now).date;
  let lastCheck = "";
  if (v.lastWork !== null) lastCheck = ` · last check ${ago(v.lastWork, now)}`;
  let favorites = "";
  if (v.favorites) favorites = ` from "${v.favorites.name}"`;
  // The legs held: bought, or being bought or sold.
  const held: HeldTrade[] = v.open.flatMap((t) =>
    t.phase !== "watching" && t.side
      ? [
          {
            id: t.id,
            symbol: t.symbol,
            side: t.side,
            at: t.openedAt,
            what: `${t.leg ? `${t.leg.qty} × ${legWords(t.leg.contract)}` : "buying the leg"}${t.paid > 0 ? ` · paid ${usd(t.paid)}` : ""}${t.dry ? " · dry run" : ""}`,
          },
        ]
      : [],
  );
  const trades = new Map(held.map((t) => [t.symbol, t.side]));
  return (
    <div className="bot-panel">
      <div className="bot-head">
        <div>
          <h2 className="portfolio-title">🎯 Volume bot</h2>
          <p className="muted small">
            Its own paper account ({v.account}) · {v.settings.sizePct}% a trade
            · watching {v.watching.length} stocks{favorites}
            {lastCheck}
          </p>
        </div>
        <div className="bot-head-side">
          <InTradeSign trades={held} target="vb-hold-title" />
          {statusPill(v)}
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
      <EntryBanners bot="Volume bot" trades={held} />
      <SessionStrip
        v={v}
        day={day}
        now={now}
        dayChangePct={account?.account.dayChangePct ?? null}
      />
      <Funnel v={v} />
      <WhatItSees v={v} day={day} trades={trades} onOpen={onOpenTicker} />
      <div className="bot-two">
        <Waiting v={v} now={now} />
        <Holding v={v} />
      </div>
      <Activity items={v.events} />
      <Trades v={v} />
      <details className="bot-card bot-rules">
        <summary>How the bot decides</summary>
        <ol>
          {v.steps.map((s) => (
            <li key={s.name}>
              <b>{s.name}.</b> {s.text}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
