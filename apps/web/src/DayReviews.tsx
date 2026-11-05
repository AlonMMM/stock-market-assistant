import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import type {
  DayReview,
  Difference,
  ReviewBot,
  ReviewRow,
} from "../../../packages/market-data/src/day-review.js";
import { newYorkToUtc } from "../../../packages/market-data/src/calendar.js";
import type { TradeChart } from "../../../packages/market-data/src/trade-chart.js";
import type { ClosedTrade } from "../../../packages/trading/src/portfolio.js";
import { readJson } from "./api.js";
import {
  accountNames,
  accountsIn,
  bugCount,
  classTag,
  classTone,
  closedTradeOf,
  dayLabel,
  differencesOf,
  inlineSpans,
  isBug,
  ledgerRow,
  pctOver,
  strikeWords,
  markdownBlocks,
  performance,
  price,
  shownVerdict,
  signed,
  statusWords,
  tradeLine,
  verdictCounts,
  verdictShort,
  verdictTone,
  verdictWords,
  type PerfPoint,
} from "./day-review-model.js";
import { signedUsd, tone } from "./format.js";
import { usePolling } from "./Live.js";
import { israelClock } from "./time.js";
import { tradeChartUrl } from "./trade-story-model.js";
import { useBoxWidth } from "./use-width.js";

const TradeStory = lazy(() =>
  import("./TradeStory.js").then((m) => ({ default: m.TradeStory })),
);

// The Analyse page of a bot's tab (the user, 2026-11-05: "build a good ux,
// easy to read, link to graphs and easy to understand why the difference ...
// with a graph above for the performance so far for the bot vs his
// backtesting"): the running result of the bot against its backtest, then
// each evening's review: the verdict, why the two differ, each trade side by
// side with its chart, and the written analysis. Read-only, for everyone.

const ignore = () => {};
const botTitle: Record<ReviewBot, string> = {
  main: "🤖 Main bot",
  volume: "🎯 Volume bot",
};
const periods = [
  ["10", "10 days"],
  ["30", "30 days"],
  ["all", "All"],
] as const;
type Period = (typeof periods)[number][0];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---- the performance chart ----

const chartPad = { l: 64, r: 78, t: 16, b: 28 };

function PerformanceChart({ points }: { points: PerfPoint[] }) {
  const box = useBoxWidth(640);
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(300, Math.min(960, box.width));
  const h = w < 520 ? 220 : 260;
  if (points.length === 0)
    return (
      <div ref={box.ref}>
        <p className="muted">No compared day yet.</p>
      </div>
    );
  const values = points.flatMap((p) => [p.cumBot, p.cumBacktest, 0]);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1) {
    hi += 50;
    lo -= 50;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const innerW = w - chartPad.l - chartPad.r;
  const innerH = h - chartPad.t - chartPad.b;
  // One day a step; a single day sits in the middle.
  const x = (i: number) => {
    if (points.length === 1) return chartPad.l + innerW / 2;
    return chartPad.l + (i / (points.length - 1)) * innerW;
  };
  const y = (v: number) => chartPad.t + ((hi - v) / (hi - lo)) * innerH;
  const path = (pick: (p: PerfPoint) => number) =>
    points
      .map(
        (p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`,
      )
      .join(" ");
  // The top, zero and the bottom, without two on each other.
  const ticks = [hi - span * 0.08, 0, lo + span * 0.08].filter(
    (v, i, all) => all.findIndex((u) => Math.abs(u - v) < span * 0.15) === i,
  );
  const last = points.at(-1)!;
  const step = Math.max(1, Math.ceil(points.length / Math.floor(innerW / 70)));
  const shown = hover === null ? null : points[hover]!;
  const pick = (clientX: number, rect: DOMRect) => {
    const at = ((clientX - rect.left) / rect.width) * w;
    let best = 0;
    points.forEach((_, i) => {
      if (Math.abs(x(i) - at) < Math.abs(x(best) - at)) best = i;
    });
    setHover(best);
  };
  // The two end labels never sit on each other.
  let botLabelY = y(last.cumBot);
  let btLabelY = y(last.cumBacktest);
  if (Math.abs(botLabelY - btLabelY) < 14) {
    const mid = (botLabelY + btLabelY) / 2;
    const botAbove = last.cumBot >= last.cumBacktest;
    botLabelY = mid + (botAbove ? -7 : 7);
    btLabelY = mid + (botAbove ? 7 : -7);
  }
  return (
    <div ref={box.ref} className="dr-perf">
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`The bot ${signedUsd(last.cumBot)} against the backtest ${signedUsd(last.cumBacktest)} over ${plural(points.length, "day")}`}
        onPointerMove={(e) =>
          pick(e.clientX, e.currentTarget.getBoundingClientRect())
        }
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              className={v === 0 ? "dr-zero" : "dr-grid"}
              x1={chartPad.l}
              x2={w - chartPad.r}
              y1={y(v)}
              y2={y(v)}
            />
            <text
              className="dr-axis"
              x={chartPad.l - 6}
              y={y(v) + 4}
              textAnchor="end"
            >
              {v === 0 ? "$0" : signedUsd(v)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          if (i % step !== 0 && i !== points.length - 1) return null;
          return (
            <text
              key={p.date}
              className="dr-axis"
              x={x(i)}
              y={h - 8}
              textAnchor="middle"
            >
              {dayLabel(p.date).replace(/^\w+ /, "")}
            </text>
          );
        })}
        <path className="dr-line-bt" d={path((p) => p.cumBacktest)} />
        <path className="dr-line-bot" d={path((p) => p.cumBot)} />
        <circle
          className="dr-dot-bt"
          cx={x(points.length - 1)}
          cy={y(last.cumBacktest)}
          r={4}
        />
        <circle
          className="dr-dot-bot"
          cx={x(points.length - 1)}
          cy={y(last.cumBot)}
          r={4}
        />
        <text className="dr-end" x={w - chartPad.r + 8} y={botLabelY + 4}>
          Bot
        </text>
        <text className="dr-end" x={w - chartPad.r + 8} y={btLabelY + 4}>
          Backtest
        </text>
        {shown && hover !== null && (
          <g>
            <line
              className="dr-cross"
              x1={x(hover)}
              x2={x(hover)}
              y1={chartPad.t}
              y2={h - chartPad.b}
            />
            <circle
              className="dr-dot-bt"
              cx={x(hover)}
              cy={y(shown.cumBacktest)}
              r={4}
            />
            <circle
              className="dr-dot-bot"
              cx={x(hover)}
              cy={y(shown.cumBot)}
              r={4}
            />
          </g>
        )}
      </svg>
      <div className="dr-tip" role="status" aria-live="polite">
        {shown && (
          <>
            <b>{dayLabel(shown.date)}</b>
            <span>
              <i className="dr-key bot" /> Bot {signedUsd(shown.bot)} · so far{" "}
              {signedUsd(shown.cumBot)}
            </span>
            <span>
              <i className="dr-key bt" /> Backtest {signedUsd(shown.backtest)} ·
              so far {signedUsd(shown.cumBacktest)}
            </span>
            {shown.verdict && (
              <span className="muted">{verdictWords[shown.verdict]}</span>
            )}
          </>
        )}
        {!shown && (
          <span className="muted small">
            Move over the chart to see each day.
          </span>
        )}
      </div>
      <p className="dr-legend muted small">
        <span>
          <i className="dr-key bot" /> Bot, at market price
        </span>
        <span>
          <i className="dr-key bt dashed" /> Backtest, at the bot's size
        </span>
      </p>
    </div>
  );
}

// ---- one trade: the two sides and its chart ----

const clock = (ms: number | undefined) =>
  ms === undefined ? "—" : israelClock(ms);

function rightWords(right: ReviewRow["right"]): string {
  if (right === "C") return "Call";
  if (right === "P") return "Put";
  return "";
}

/** The stock's day with where each side bought and sold. */
function TradeChartMini({ r, date }: { r: ReviewRow; date: string }) {
  const [chart, setChart] = useState<TradeChart | null>(null);
  const [error, setError] = useState("");
  const box = useBoxWidth(560);
  const contract = r.live?.contract ?? r.backtest?.contract ?? r.symbol;
  useEffect(() => {
    let active = true;
    fetch(tradeChartUrl(contract, date, date))
      .then((res) => readJson<TradeChart>(res))
      .then((c) => {
        if (active) setChart(c);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [contract, date]);
  if (error)
    return <p className="muted small">The chart is unavailable: {error}</p>;
  const session = chart?.sessions.find((s) => s.date === date);
  if (!session || session.stock.length === 0)
    return (
      <div ref={box.ref} className="dr-mini">
        <p className="chart-status">Loading the chart…</p>
      </div>
    );
  const w = Math.max(280, Math.min(720, box.width));
  const h = 180;
  const pad = { l: 52, r: 10, t: 12, b: 22 };
  const bars = session.stock;
  const closes = bars.map((b) => b[4]);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const len = session.minutes;
  const openMs = newYorkToUtc(date, 570);
  const minuteOf = (ms: number) => Math.floor((ms - openMs) / 60000);
  const x = (m: number) =>
    pad.l + (Math.max(0, Math.min(len, m)) / len) * (w - pad.l - pad.r);
  const y = (v: number) =>
    pad.t + ((hi - v) / (hi - lo || 1)) * (h - pad.t - pad.b);
  const priceAt = (m: number) => {
    let best = bars[0]!;
    for (const b of bars) if (b[0] <= m) best = b;
    return best[4];
  };
  const marks: { m: number; side: "bot" | "bt"; buy: boolean }[] = [];
  if (r.live) {
    marks.push({ m: minuteOf(r.live.entryAt), side: "bot", buy: true });
    for (const e of r.live.exits)
      marks.push({ m: minuteOf(e.at), side: "bot", buy: false });
  }
  if (r.backtest) {
    marks.push({ m: minuteOf(r.backtest.entryAt), side: "bt", buy: true });
    for (const e of r.backtest.exits)
      marks.push({ m: minuteOf(e.at), side: "bt", buy: false });
  }
  const line = bars
    .map(
      (b, i) => `${i ? "L" : "M"}${x(b[0]).toFixed(1)},${y(b[4]).toFixed(1)}`,
    )
    .join(" ");
  const hours = [30, 90, 150, 210, 270, 330].filter((m) => m < len);
  return (
    <div ref={box.ref} className="dr-mini">
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`${r.symbol} on ${date}, with each side's buys and sales`}
      >
        {[hi, lo].map((v) => (
          <text
            key={v}
            className="dr-axis"
            x={pad.l - 6}
            y={y(v) + 4}
            textAnchor="end"
          >
            {v.toFixed(2)}
          </text>
        ))}
        {hours.map((m) => (
          <text
            key={m}
            className="dr-axis"
            x={x(m)}
            y={h - 6}
            textAnchor="middle"
          >
            {israelClock(openMs + m * 60000)}
          </text>
        ))}
        <path className="dr-stock" d={line} />
        {marks.map((k, i) => (
          <path
            key={i}
            className={`dr-mark ${k.side}`}
            transform={`translate(${x(k.m)},${y(priceAt(k.m))})`}
            d={k.buy ? "M0,-8 L7,5 L-7,5 Z" : "M0,8 L7,-5 L-7,-5 Z"}
          />
        ))}
      </svg>
      <p className="dr-legend muted small">
        <span>▲ buy · ▼ sale</span>
        <span>
          <i className="dr-key bot" /> bot
        </span>
        <span>
          <i className="dr-key bt" /> backtest
        </span>
        <span>{r.symbol}'s price that day · Israel time</span>
      </p>
    </div>
  );
}

/** One fill of either side, for a trade's open row. */
interface FillLine {
  who: "bot" | "bt";
  side: "buy" | "sell";
  at: number;
  size: string;
  paper: number | null;
  bid: number | null;
  ask: number | null;
  price: number; // at market (the bot), or the backtest's price
  reason: string;
}

function fillLines(r: ReviewRow): FillLine[] {
  const out: FillLine[] = [];
  const l = r.live;
  const b = r.backtest;
  if (l) {
    out.push({
      who: "bot",
      side: "buy",
      at: l.entryAt,
      size: String(l.qty),
      paper: l.paidPaper,
      bid: l.entryBook?.bid ?? null,
      ask: l.entryBook?.ask ?? null,
      price: l.paidReal ?? l.paidPaper,
      reason: "entry",
    });
    for (const e of l.exits)
      out.push({
        who: "bot",
        side: "sell",
        at: e.at,
        size: String(e.qty),
        paper: e.paper,
        bid: e.book?.bid ?? null,
        ask: e.book?.ask ?? null,
        price: e.real ?? e.paper,
        reason: e.reason,
      });
  }
  if (b) {
    out.push({
      who: "bt",
      side: "buy",
      at: b.entryAt,
      size: "100%",
      paper: null,
      bid: b.entryBook?.bid ?? null,
      ask: b.entryBook?.ask ?? null,
      price: b.entryPrice,
      reason: "entry",
    });
    for (const e of b.exits)
      out.push({
        who: "bt",
        side: "sell",
        at: e.at,
        size: `${Math.round(e.share * 100)}%`,
        paper: null,
        bid: e.book?.bid ?? null,
        ask: e.book?.ask ?? null,
        price: e.price,
        reason: e.reason,
      });
  }
  return out.sort((x, y) => x.at - y.at);
}

/** A signed difference, plain ink, with its unit. */
function Delta({
  v,
  unit,
  digits = 1,
}: {
  v: number | null;
  unit: string;
  digits?: number;
}) {
  if (v === null) return <span className="muted">—</span>;
  return (
    <span className="dr-delta">
      {signed(v, digits)}
      {unit}
    </span>
  );
}

/** Who did better on a trade: a dot of that side's colour, the gap in plain ink. */
function Gap({ v }: { v: number | null }) {
  if (v === null) return <span className="muted">—</span>;
  if (Math.abs(v) < 1) return <span className="muted">$0</span>;
  // A positive gap is the backtest's: it made more than the bot.
  const ahead = v > 0 ? "bt" : "bot";
  return (
    <span className="dr-gap">
      <i className={`dr-dot ${ahead}`} aria-hidden="true" />
      {signedUsd(v)}
    </span>
  );
}

const clockOf = (ms: number | null) => (ms === null ? "—" : israelClock(ms));
const minutesApart = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.round((a - b) / 60000);

function TradeDetail({
  r,
  date,
  causes,
  onStory,
}: {
  r: ReviewRow;
  date: string;
  causes: Difference[];
  onStory: (t: ClosedTrade) => void;
}) {
  const [chart, setChart] = useState(false);
  const story = r.live ? closedTradeOf(r.symbol, r.live) : null;
  const fills = fillLines(r);
  return (
    <div className="dr-trade-detail">
      {causes.map((d) => (
        <p key={d.title} className="dr-why">
          <span className={`dr-tag ${classTone[d.class]}`}>
            {classTag[d.class]}
          </span>
          <span>
            <b>{d.title}.</b> {d.why}
            {d.action && <span className="muted"> Next: {d.action}</span>}
          </span>
        </p>
      ))}
      {r.why && !causes.length && <p className="dr-why muted">{r.why}</p>}
      <table className="dr-fills">
        <thead>
          <tr>
            <th scope="col">Side</th>
            <th scope="col">Time</th>
            <th scope="col">Order</th>
            <th scope="col" className="num">
              Size
            </th>
            <th scope="col" className="num">
              Paper
            </th>
            <th scope="col" className="num">
              Bid
            </th>
            <th scope="col" className="num">
              Ask
            </th>
            <th scope="col" className="num">
              Price
            </th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f, i) => (
            <tr key={i} className={f.who}>
              <td>
                <i
                  className={`dr-key ${f.who}${f.who === "bt" ? " dashed" : ""}`}
                />{" "}
                {f.who === "bot" ? "Bot" : "Backtest"}
              </td>
              <td className="num">{israelClock(f.at)}</td>
              <td>{f.side === "buy" ? "Buy" : "Sell"}</td>
              <td className="num">{f.size}</td>
              <td className="num">{price(f.paper)}</td>
              <td className="num">{price(f.bid)}</td>
              <td className="num">{price(f.ask)}</td>
              <td className="num">
                <b>{price(f.price)}</b>
              </td>
              <td className="muted">{f.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Price: the bot's at market (the mid of its bid and ask), the backtest's
        as it filled.
        {r.backtest?.priced === "trades" &&
          " The backtest priced this on the option's trades: an estimate."}
      </p>
      <div className="dr-trade-actions">
        <button
          type="button"
          className="bot-more"
          aria-expanded={chart}
          onClick={() => setChart(!chart)}
        >
          {chart ? "Hide the chart" : "Show the chart"}
        </button>
        {story && (
          <button
            type="button"
            className="bot-more"
            onClick={() => onStory(story)}
          >
            Open the bot's trade story
          </button>
        )}
      </div>
      {chart && <TradeChartMini r={r} date={date} />}
    </div>
  );
}

/** The day's trades, one row each, the bot's numbers beside the backtest's. */
function Ledger({
  rows,
  date,
  causesOf,
  onStory,
}: {
  rows: ReviewRow[];
  date: string;
  causesOf: (row: ReviewRow) => Difference[];
  onStory: (t: ClosedTrade) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const lines = rows.map(ledgerRow);
  const sum = (xs: (number | null)[]) =>
    xs.reduce<number>((a, x) => a + (x ?? 0), 0);
  const columns = 15;
  return (
    <div className="dr-ledger-wrap">
      <table className="dr-ledger">
        <thead>
          <tr className="dr-groups">
            <th scope="colgroup" colSpan={2} />
            <th scope="colgroup" colSpan={3}>
              Entry time
            </th>
            <th scope="colgroup" colSpan={3}>
              Buy price
            </th>
            <th scope="colgroup" colSpan={3}>
              Sale price
            </th>
            <th scope="colgroup" colSpan={3}>
              Return
            </th>
            <th scope="colgroup" />
          </tr>
          <tr>
            <th scope="col">Trade</th>
            <th scope="col">Cause</th>
            <th scope="col" className="num bot">
              Bot
            </th>
            <th scope="col" className="num bt">
              BT
            </th>
            <th scope="col" className="num">
              Δ min
            </th>
            <th scope="col" className="num bot">
              Bot
            </th>
            <th scope="col" className="num bt">
              BT
            </th>
            <th scope="col" className="num">
              Δ
            </th>
            <th scope="col" className="num bot">
              Bot
            </th>
            <th scope="col" className="num bt">
              BT
            </th>
            <th scope="col" className="num">
              Δ
            </th>
            <th scope="col" className="num bot">
              Bot
            </th>
            <th scope="col" className="num bt">
              BT
            </th>
            <th scope="col" className="num">
              Δ pts
            </th>
            <th scope="col" className="num">
              $ gap
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((x) => {
            const r = x.row;
            const causes = causesOf(r);
            const first = causes[0];
            const isOpen = open === r.key;
            return (
              <Fragment key={r.key}>
                <tr className={`dr-ledger-row${isOpen ? " open" : ""}`}>
                  <th scope="row">
                    <button
                      type="button"
                      className="dr-row-toggle"
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : r.key)}
                    >
                      <span className="dr-chevron" aria-hidden="true">
                        ›
                      </span>
                      <span>
                        <b>{r.symbol}</b> {rightWords(r.right)}
                        <span className="dr-sub">
                          {strikeWords(x.botContract)}
                          {x.otherContract && (
                            <span className="dr-other">
                              {" "}
                              · BT {strikeWords(x.btContract)}
                            </span>
                          )}
                          {!x.botContract &&
                            x.btContract &&
                            ` BT ${strikeWords(x.btContract)}`}
                          {x.account && ` · ${accountNames[x.account]}`}
                        </span>
                      </span>
                    </button>
                  </th>
                  <td>
                    {first && (
                      <span
                        className={`dr-tag ${classTone[first.class]}`}
                        title={first.title}
                      >
                        {classTag[first.class]}
                      </span>
                    )}
                    {!first && r.match !== "both" && (
                      <span className="dr-tag grey" title={r.why ?? ""}>
                        {r.match === "live-only" ? "BOT ONLY" : "BT ONLY"}
                      </span>
                    )}
                    {x.estimate && <span className="dr-sub">BT est.</span>}
                  </td>
                  <td className="num">{clockOf(x.botEntryAt)}</td>
                  <td className="num">{clockOf(x.btEntryAt)}</td>
                  <td className="num">
                    <Delta
                      v={minutesApart(x.btEntryAt, x.botEntryAt)}
                      unit=""
                      digits={0}
                    />
                  </td>
                  <td className="num">
                    {price(x.botBuy)}
                    {x.botBid !== null && (
                      <span className="dr-sub">
                        {price(x.botBid)}×{price(x.botAsk)}
                      </span>
                    )}
                  </td>
                  <td className="num">{price(x.btBuy)}</td>
                  <td className="num">
                    <Delta v={pctOver(x.botBuy, x.btBuy)} unit="%" />
                  </td>
                  <td className="num">
                    {price(x.botSell)}
                    {x.botSales > 1 && (
                      <span className="dr-sub">{x.botSales} sales</span>
                    )}
                  </td>
                  <td className="num">
                    {price(x.btSell)}
                    {x.btSales > 1 && (
                      <span className="dr-sub">{x.btSales} sales</span>
                    )}
                  </td>
                  <td className="num">
                    <Delta v={pctOver(x.botSell, x.btSell)} unit="%" />
                  </td>
                  <td className={`num${tone(x.botRet)}`}>
                    {x.botRet === null ? "—" : `${signed(x.botRet)}%`}
                    {x.botPnl !== null && (
                      <span className="dr-sub">{signedUsd(x.botPnl)}</span>
                    )}
                  </td>
                  <td className={`num${tone(x.btRet)}`}>
                    {x.btRet === null ? "—" : `${signed(x.btRet)}%`}
                  </td>
                  <td className="num">
                    <Delta v={r.retGapPts} unit="" />
                  </td>
                  <td className="num">
                    <Gap v={r.dollarsGap} />
                  </td>
                </tr>
                {isOpen && (
                  <tr className="dr-ledger-detail">
                    <td colSpan={columns}>
                      <TradeDetail
                        r={r}
                        date={date}
                        causes={causes}
                        onStory={onStory}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={11}>
              {plural(lines.length, "trade")} ·{" "}
              {lines.filter((x) => x.row.match === "both").length} on both sides
            </th>
            <td className="num" colSpan={3}>
              Bot {signedUsd(sum(lines.map((x) => x.botPnl)))}
            </td>
            <td className="num">
              <Gap v={sum(rows.map((r) => r.dollarsGap))} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---- one day ----

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineSpans(text).map((s, i) => {
        if (s.kind === "bold") return <b key={i}>{s.text}</b>;
        if (s.kind === "code") return <code key={i}>{s.text}</code>;
        return <Fragment key={i}>{s.text}</Fragment>;
      })}
    </>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="dr-analysis">
      {markdownBlocks(text).map((b, i) => {
        if (b.kind === "heading")
          return (
            <h5 key={i}>
              <Inline text={b.text} />
            </h5>
          );
        if (b.kind === "list")
          return (
            <ul key={i}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        if (b.kind === "table")
          return (
            <div className="st-table-wrap" key={i}>
              <table className="st-table">
                <thead>
                  <tr>
                    {b.head.map((c, j) => (
                      <th key={j}>
                        <Inline text={c} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((c, k) => (
                        <td key={k}>
                          <Inline text={c} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return (
          <p key={i}>
            <Inline text={b.text} />
          </p>
        );
      })}
    </div>
  );
}

function DayDetail({
  r,
  account,
  onStory,
}: {
  r: DayReview;
  account: string | null;
  onStory: (t: ClosedTrade) => void;
}) {
  const [full, setFull] = useState(false);
  const differences = differencesOf(r);
  const written = Boolean(r.analysis?.differences?.length);
  // The chosen account's trades, and the backtest's own.
  const rows = (r.comparison?.rows ?? []).filter(
    (x) => !account || !x.live?.broker || x.live.broker === account,
  );
  const a =
    r.comparison?.accounts?.find((x) => x.broker === account) ??
    r.comparison?.accounts?.[0];
  const s = r.comparison?.summary;
  const status = statusWords(r);
  // A trade's causes: its stock's, and its account's when one is named.
  const causesOf = (row: ReviewRow) =>
    (r.analysis?.differences ?? []).filter(
      (d) =>
        d.symbols.includes(row.symbol) &&
        (!d.accounts?.length ||
          !row.live?.broker ||
          d.accounts.includes(row.live.broker)),
    );
  const ordered = [...differences].sort(
    (x, y) => Number(isBug(y.class)) - Number(isBug(x.class)),
  );
  return (
    <div className="dr-detail">
      {r.analysis && <p className="dr-headline">{r.analysis.headline}</p>}
      {status && <p className="muted small">{status}</p>}
      {a && s && (
        <dl className="dr-strip">
          <div>
            <dt>Bot, paper</dt>
            <dd className={`num${tone(a.botPaper)}`}>
              {signedUsd(a.botPaper)}
            </dd>
          </div>
          <div>
            <dt>
              <i className="dr-key bot" /> Bot, at market
            </dt>
            <dd className={`num${tone(a.bot)}`}>{signedUsd(a.bot)}</dd>
          </div>
          <div>
            <dt>
              <i className="dr-key bt dashed" /> Backtest
            </dt>
            <dd className={`num${tone(a.backtest)}`}>
              {signedUsd(a.backtest)}
            </dd>
          </div>
          <div>
            <dt>Backtest − bot</dt>
            <dd className="num">{signedUsd(a.backtest - a.bot)}</dd>
          </div>
          <div>
            <dt>Paper fills cost</dt>
            <dd className="num">{signedUsd(a.botPaper - a.bot)}</dd>
          </div>
          <div>
            <dt>Trades both / bot / BT</dt>
            <dd className="num">
              {rows.filter((x) => x.match === "both").length} /{" "}
              {rows.filter((x) => x.match === "live-only").length} /{" "}
              {rows.filter((x) => x.match === "backtest-only").length}
            </dd>
          </div>
        </dl>
      )}
      {rows.length > 0 && (
        <>
          <Ledger
            rows={rows}
            date={r.date}
            causesOf={causesOf}
            onStory={onStory}
          />
          <p className="muted small dr-note">
            Δ is the backtest against the bot: minutes later, % above the bot's
            price, return points. Bot prices are at market (the mid of its bid ×
            ask, shown under it). $ gap: the backtest's return on the bot's
            money minus the bot's own result; the dot shows who did better. A
            row opens every fill.
          </p>
        </>
      )}
      {ordered.length > 0 && (
        <section aria-label="Causes">
          <h4 className="dr-h">
            Causes{" "}
            {!written && (
              <span className="muted small">
                (found by the comparison; checked at 23:05)
              </span>
            )}
          </h4>
          <table className="dr-causes-table">
            <tbody>
              {ordered.map((d) => (
                <tr key={d.title}>
                  <td>
                    <span className={`dr-tag ${classTone[d.class]}`}>
                      {classTag[d.class]}
                    </span>
                  </td>
                  <th scope="row">{d.title}</th>
                  <td className="muted">{d.action || d.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {r.analysis && (
        <section aria-label="The written analysis">
          <button
            type="button"
            className="bot-more"
            aria-expanded={full}
            onClick={() => setFull(!full)}
          >
            {full ? "Hide the written analysis" : "Read the written analysis"}
          </button>
          {full && <Markdown text={r.analysis.markdown} />}
        </section>
      )}
      {(r.comparison?.notes.length ?? 0) > 0 && (
        <ul className="muted small">
          {r.comparison!.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The days, one row each; a row opens its day underneath. */
function DayTable({
  days,
  account,
  shownDay,
  onToggle,
}: {
  days: DayReview[];
  account: string | null;
  shownDay: string | null;
  onToggle: (date: string) => void;
}) {
  return (
    <div className="dr-ledger-wrap">
      <table className="dr-ledger dr-day-table">
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Verdict</th>
            <th scope="col" className="num bot">
              Bot
            </th>
            <th scope="col" className="num bt">
              Backtest
            </th>
            <th scope="col" className="num">
              BT − bot
            </th>
            <th scope="col" className="num">
              Trades both / bot / BT
            </th>
            <th scope="col">Causes</th>
          </tr>
        </thead>
        <tbody>
          {days.map((r) => {
            const verdict = shownVerdict(r);
            const a =
              r.comparison?.accounts?.find((x) => x.broker === account) ??
              r.comparison?.accounts?.[0];
            const s = r.comparison?.summary;
            const bugs = bugCount(r);
            const differences = differencesOf(r);
            const isOpen = shownDay === r.date;
            const tags = [...new Set(differences.map((d) => d.class))];
            return (
              <Fragment key={r.date}>
                <tr className={`dr-ledger-row${isOpen ? " open" : ""}`}>
                  <th scope="row">
                    <button
                      type="button"
                      className="dr-row-toggle"
                      aria-expanded={isOpen}
                      onClick={() => onToggle(r.date)}
                    >
                      <span className="dr-chevron" aria-hidden="true">
                        ›
                      </span>
                      <b>{dayLabel(r.date)}</b>
                    </button>
                  </th>
                  <td>
                    {verdict && (
                      <span className={`dr-tag ${verdictTone[verdict]}`}>
                        {verdictShort[verdict]}
                      </span>
                    )}
                    {!verdict && (
                      <span className="dr-tag grey">{r.status}</span>
                    )}
                  </td>
                  <td className={`num${tone(a?.bot ?? null)}`}>
                    {a ? signedUsd(a.bot) : "—"}
                  </td>
                  <td className={`num${tone(a?.backtest ?? null)}`}>
                    {a ? signedUsd(a.backtest) : "—"}
                  </td>
                  <td className="num">
                    {a ? signedUsd(a.backtest - a.bot) : "—"}
                  </td>
                  <td className="num">
                    {s
                      ? `${s.matched} / ${s.liveOnly} / ${s.backtestOnly}`
                      : "—"}
                  </td>
                  <td>
                    {bugs > 0 && (
                      <span className="dr-tag red">
                        ⚠ {plural(bugs, "bug")}
                      </span>
                    )}
                    {tags
                      .filter((c) => !isBug(c))
                      .map((c) => (
                        <span key={c} className={`dr-tag ${classTone[c]}`}>
                          {classTag[c]}
                        </span>
                      ))}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- the page ----

export function DayReviews({ bot }: { bot: ReviewBot }) {
  const { value, error } = usePolling<{ reviews: DayReview[] }>(
    `/api/day-reviews?bot=${bot}&limit=120`,
    60000,
    ignore,
  );
  const [period, setPeriod] = useState<Period>("30");
  const [chosen, setChosen] = useState<string | null>(null);
  // The newest day opens first; "" closes every day.
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [story, setStory] = useState<ClosedTrade | null>(null);
  if (!value)
    return (
      <p className={error ? "notice error" : "chart-status"}>
        {error
          ? `The reviews are unavailable: ${error}`
          : "Loading the reviews…"}
      </p>
    );
  const all = value.reviews;
  const days = period === "all" ? all : all.slice(0, Number(period));
  const accounts = accountsIn(days);
  const account =
    chosen && accounts.includes(chosen) ? chosen : (accounts[0] ?? null);
  const points = account ? performance(days, account) : [];
  const last = points.at(-1);
  const counts = verdictCounts(days);
  const bugs = days.reduce((s, r) => s + bugCount(r), 0);
  const shownDay = openDay ?? days[0]?.date ?? null;
  const promised = last ? last.cumBacktest - last.cumBot : 0;
  const selected = days.find((r) => r.date === shownDay) ?? null;
  const selectedVerdict = selected ? shownVerdict(selected) : null;
  return (
    <div className="bot-panel dr-page">
      <div className="bot-head">
        <div>
          <h2 className="portfolio-title">{botTitle[bot]} · analyse</h2>
          <p className="muted small">
            What the bot really did on its paper account, against what its
            backtest says it should have done the same day. Checked every
            evening at 23:05 Israel time. "At market" is the market's price at
            each fill, since paper fills are not real prices.
          </p>
        </div>
      </div>
      <div className="dr-controls">
        <div className="dr-seg" role="group" aria-label="Period">
          {periods.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={period === key}
              onClick={() => setPeriod(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {accounts.length > 1 && (
          <div className="dr-seg" role="group" aria-label="Account">
            {accounts.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={account === a}
                onClick={() => setChosen(a)}
              >
                {accountNames[a] ?? a}
              </button>
            ))}
          </div>
        )}
      </div>
      <section
        className="bot-card dr-summary"
        aria-labelledby={`dr-perf-${bot}`}
      >
        <div className="bot-card-head">
          <h3 id={`dr-perf-${bot}`}>The bot against its backtest</h3>
          <span className="muted small">
            {plural(points.length, "day")}
            {account && accounts.length > 1 && ` · ${accountNames[account]}`}
          </span>
        </div>
        {last && (
          <ul className="dr-kpis">
            <li>
              <span className="muted small">
                <i className="dr-key bot" /> Bot, at market
              </span>
              <b className={`num${tone(last.cumBot)}`}>
                {signedUsd(last.cumBot)}
              </b>
            </li>
            <li>
              <span className="muted small">
                <i className="dr-key bt dashed" /> Backtest
              </span>
              <b className={`num${tone(last.cumBacktest)}`}>
                {signedUsd(last.cumBacktest)}
              </b>
            </li>
            <li>
              <span className="muted small">Backtest − bot</span>
              <b className="num">{signedUsd(promised)}</b>
              <span className="muted small">
                {promised >= 0
                  ? "the backtest promised more"
                  : "the bot did better"}
              </span>
            </li>
            <li>
              <span className="muted small">The days</span>
              <span className="dr-counts">
                <span className="pill red">
                  {counts.optimistic} too optimistic
                </span>
                <span className="pill amber">
                  {counts.pessimistic} too pessimistic
                </span>
                <span className="pill green">
                  {counts["on target"]} on target
                </span>
                {bugs > 0 && (
                  <span className="pill red">
                    ⚠ {plural(bugs, "bug")} found
                  </span>
                )}
              </span>
            </li>
          </ul>
        )}
        <PerformanceChart points={points} />
      </section>
      <section aria-labelledby={`dr-days-${bot}`}>
        <h3 id={`dr-days-${bot}`} className="dr-h">
          Day by day
        </h3>
        {days.length === 0 && (
          <p className="muted">
            No review yet. The first one comes after the next close.
          </p>
        )}
        <DayTable
          days={days}
          account={account}
          shownDay={shownDay}
          onToggle={(date) => setOpenDay(shownDay === date ? "" : date)}
        />
      </section>
      {/* The chosen day, under the list (not inside it, so its wide tables
          scroll on their own on a phone). */}
      {selected && (
        <section className="dr-day-section" aria-labelledby={`dr-day-${bot}`}>
          <h3 id={`dr-day-${bot}`} className="dr-h">
            {dayLabel(selected.date)}
            {selectedVerdict && (
              <span className={`dr-tag ${verdictTone[selectedVerdict]}`}>
                {verdictShort[selectedVerdict]}
              </span>
            )}
          </h3>
          <DayDetail r={selected} account={account} onStory={setStory} />
        </section>
      )}
      {story && (
        <Suspense fallback={null}>
          <TradeStory
            t={story}
            bot
            source={bot}
            onClose={() => setStory(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
