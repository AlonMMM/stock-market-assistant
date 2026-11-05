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
  classTone,
  classWords,
  closedTradeOf,
  contractWords,
  dayLabel,
  differencesOf,
  inlineSpans,
  isBug,
  markdownBlocks,
  performance,
  price,
  shownVerdict,
  signed,
  statusWords,
  tradeLine,
  verdictCounts,
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

function BotSide({ side }: { side: ReviewRow["live"] }) {
  if (!side)
    return (
      <div className="dr-side bot none">
        <h5>
          <i className="dr-key bot" /> Bot
        </h5>
        <p className="muted small">Did not trade it.</p>
      </div>
    );
  let result = `${signed(side.retReal)}%`;
  if (side.pnlReal !== null) result += ` · ${signedUsd(side.pnlReal)}`;
  return (
    <div className="dr-side bot">
      <h5>
        <i className="dr-key bot" /> Bot
      </h5>
      <dl>
        <dt>Contract</dt>
        <dd>
          {side.qty} × {contractWords(side.contract)}
        </dd>
        <dt>Bought</dt>
        <dd>
          {clock(side.entryAt)} · {price(side.paidReal ?? side.paidPaper)}
          <span className="muted"> (paper {price(side.paidPaper)})</span>
        </dd>
        <dt>Sold</dt>
        <dd>
          {side.open && "held overnight"}
          {side.exits.map((e, i) => (
            <div key={i}>
              {clock(e.at)} · {e.qty} @ {price(e.real ?? e.paper)}{" "}
              <span className="muted">{e.reason}</span>
            </div>
          ))}
        </dd>
        <dt>Result</dt>
        <dd className={`num${tone(side.retReal)}`}>{result}</dd>
      </dl>
    </div>
  );
}

function BacktestSide({ side }: { side: ReviewRow["backtest"] }) {
  if (!side)
    return (
      <div className="dr-side bt none">
        <h5>
          <i className="dr-key bt" /> Backtest
        </h5>
        <p className="muted small">Did not trade it.</p>
      </div>
    );
  return (
    <div className="dr-side bt">
      <h5>
        <i className="dr-key bt" /> Backtest
      </h5>
      <dl>
        <dt>Contract</dt>
        <dd>{contractWords(side.contract)}</dd>
        <dt>Bought</dt>
        <dd>
          {clock(side.entryAt)} · {price(side.entryPrice)}
        </dd>
        <dt>Sold</dt>
        <dd>
          {side.open && "held overnight"}
          {side.exits.map((e, i) => (
            <div key={i}>
              {clock(e.at)} · {Math.round(e.share * 100)}% @ {price(e.price)}{" "}
              <span className="muted">{e.reason}</span>
            </div>
          ))}
        </dd>
        <dt>Result</dt>
        <dd className={`num${tone(side.ret)}`}>{signed(side.ret)}%</dd>
      </dl>
    </div>
  );
}

function TradeCard({
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
  const [open, setOpen] = useState(false);
  const [chart, setChart] = useState(false);
  const story = r.live ? closedTradeOf(r.symbol, r.live) : null;
  const account = r.live?.broker ? accountNames[r.live.broker] : null;
  // The gap is the backtest's: more for it is a worse day for the bot.
  const gapTone = r.dollarsGap === null ? "" : tone(-r.dollarsGap);
  let botResult = "—";
  if (r.live) botResult = `${signed(r.live.retReal)}%`;
  let btResult = "—";
  if (r.backtest) btResult = `${signed(r.backtest.ret)}%`;
  return (
    <article className={`dr-trade${open ? " open" : ""}`}>
      <button
        type="button"
        className="dr-trade-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="dr-trade-name">
          <b>
            {r.symbol} {rightWords(r.right)}
          </b>
          {account && <span className="muted small"> · {account}</span>}
        </span>
        <span className="dr-trade-results small">
          <span>
            <i className="dr-key bot" /> Bot{" "}
            <b className={`num${tone(r.live?.retReal ?? null)}`}>{botResult}</b>
          </span>
          <span>
            <i className="dr-key bt dashed" /> Backtest{" "}
            <b className={`num${tone(r.backtest?.ret ?? null)}`}>{btResult}</b>
          </span>
        </span>
        <span className={`dr-trade-line num${gapTone}`}>{tradeLine(r)}</span>
        <span className="dr-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <div className="dr-trade-body">
          {causes.length > 0 && (
            <p className="dr-trade-why">
              {causes.map((d) => (
                <span key={d.title}>
                  <span className={`pill ${classTone[d.class]}`}>
                    {classWords[d.class]}
                  </span>{" "}
                  {d.title}
                </span>
              ))}
            </p>
          )}
          <div className="dr-sides">
            <BotSide side={r.live} />
            <BacktestSide side={r.backtest} />
          </div>
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
            {r.backtest?.priced === "trades" && (
              <span className="muted small">
                The backtest priced this on the option's trades: an estimate.
              </span>
            )}
          </div>
          {chart && <TradeChartMini r={r} date={date} />}
        </div>
      )}
    </article>
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
  const status = statusWords(r);
  return (
    <div className="dr-detail">
      {r.analysis && <p className="dr-headline">{r.analysis.headline}</p>}
      {status && <p className="muted small">{status}</p>}
      {differences.length > 0 && (
        <section aria-label="Why they differ">
          <h4 className="dr-h">Why the bot and the backtest differ</h4>
          {!written && (
            <p className="muted small">
              Found by the comparison; the causes come with the written
              analysis.
            </p>
          )}
          <ul className="dr-causes">
            {differences.map((d) => (
              <li
                key={d.title}
                className={`dr-cause${isBug(d.class) ? " bug" : ""}`}
              >
                <span className={`pill ${classTone[d.class]}`}>
                  {isBug(d.class) && "⚠ "}
                  {classWords[d.class]}
                </span>
                <div>
                  <b>{d.title}</b>
                  <p>{d.why}</p>
                  {d.action && (
                    <p className="small">
                      <b>Next:</b> {d.action}
                    </p>
                  )}
                  {d.evidence && (
                    <details className="dr-evidence small">
                      <summary>Evidence</summary>
                      <p className="muted">{d.evidence}</p>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rows.length > 0 && (
        <section aria-label="Trade by trade">
          <h4 className="dr-h">Trade by trade</h4>
          {rows.map((x) => (
            <TradeCard
              key={x.key}
              r={x}
              date={r.date}
              causes={(r.analysis?.differences ?? []).filter((d) =>
                d.symbols.includes(x.symbol),
              )}
              onStory={onStory}
            />
          ))}
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
            {full ? "Hide the full analysis" : "Read the full analysis"}
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

function DayRow({
  r,
  account,
  open,
  onToggle,
  onStory,
}: {
  r: DayReview;
  account: string | null;
  open: boolean;
  onToggle: () => void;
  onStory: (t: ClosedTrade) => void;
}) {
  const verdict = shownVerdict(r);
  const a =
    r.comparison?.accounts?.find((x) => x.broker === account) ??
    r.comparison?.accounts?.[0];
  const bugs = bugCount(r);
  const differences = differencesOf(r).length;
  return (
    <li className={`dr-day${open ? " open" : ""}`}>
      <button
        type="button"
        className="dr-day-row"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="dr-day-date">{dayLabel(r.date)}</span>
        {verdict && (
          <span className={`pill ${verdictTone[verdict]}`}>
            {verdictWords[verdict]}
          </span>
        )}
        {!verdict && <span className="pill grey">{r.status}</span>}
        <span className="dr-day-money">
          {a && (
            <>
              <span>
                <i className="dr-key bot" /> Bot{" "}
                <b className={`num${tone(a.bot)}`}>{signedUsd(a.bot)}</b>
              </span>
              <span>
                <i className="dr-key bt dashed" /> Backtest{" "}
                <b className={`num${tone(a.backtest)}`}>
                  {signedUsd(a.backtest)}
                </b>
              </span>
            </>
          )}
        </span>
        <span className="dr-day-flags small">
          {bugs > 0 && (
            <span className="pill red">⚠ {plural(bugs, "bug")}</span>
          )}
          {differences > 0 && (
            <span className="muted">{plural(differences, "difference")}</span>
          )}
        </span>
        <span className="dr-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {open && <DayDetail r={r} account={account} onStory={onStory} />}
    </li>
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
        <ul className="dr-days">
          {days.map((r) => (
            <DayRow
              key={r.date}
              r={r}
              account={account}
              open={shownDay === r.date}
              onToggle={() => setOpenDay(shownDay === r.date ? "" : r.date)}
              onStory={setStory}
            />
          ))}
        </ul>
      </section>
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
