import { Fragment, useState } from "react";
import type {
  DayReview,
  ReviewBot,
  ReviewRow,
} from "../../../packages/market-data/src/day-review.js";
import {
  averageExit,
  inlineSpans,
  markdownBlocks,
  matchWords,
  price,
  shownVerdict,
  signed,
  statusWords,
  verdictTone,
  verdictWords,
} from "./day-review-model.js";
import { signedUsd, tone } from "./format.js";
import { usePolling } from "./Live.js";
import { israelClock } from "./time.js";

// The Analyse page of a bot's tab (the user, 2026-11-05): each evening's
// end-of-day review, the live trades against the app's backtest of the same
// day, with the written analysis. Read-only, for everyone.

const ignore = () => {};
const botTitle: Record<ReviewBot, string> = {
  main: "🤖 Main bot",
  volume: "🎯 Volume bot",
};

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
        if (b.kind === "heading") {
          if (b.level === 2)
            return (
              <h4 key={i}>
                <Inline text={b.text} />
              </h4>
            );
          return (
            <h5 key={i}>
              <Inline text={b.text} />
            </h5>
          );
        }
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
                    {b.head.map((h, j) => (
                      <th key={j}>
                        <Inline text={h} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
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

const clock = (ms: number | undefined) =>
  ms === undefined ? "—" : israelClock(ms);

function TradeRows({ rows }: { rows: ReviewRow[] }) {
  return (
    <div className="st-table-wrap">
      <table className="st-table dr-trades">
        <thead>
          <tr>
            <th>Stock</th>
            <th>Found by</th>
            <th>Entry live / bt</th>
            <th className="num">Buy paper / real / bt</th>
            <th className="num">Sale real / bt</th>
            <th className="num">Return real / bt</th>
            <th className="num">$ gap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const l = r.live;
            const b = r.backtest;
            const liveExit = l
              ? averageExit(
                  l.exits.map((e) => ({
                    price: e.real ?? e.paper,
                    qty: e.qty,
                  })),
                )
              : null;
            const btExit = b ? averageExit(b.exits) : null;
            const side = r.right ?? "";
            const open = l?.open || b?.open;
            return (
              <tr key={r.key}>
                <td>
                  <b>{r.symbol}</b> {side}
                  {r.kind !== "entry" && r.kind !== "plan" && (
                    <span className="muted small"> {r.kind}</span>
                  )}
                </td>
                <td>
                  {matchWords[r.match]}
                  {r.why && <div className="muted small">{r.why}</div>}
                  {open && <div className="muted small">held overnight</div>}
                </td>
                <td>
                  {clock(l?.entryAt)} / {clock(b?.entryAt)}
                  {r.entryMinutes !== null && (
                    <div className="muted small">
                      {signed(r.entryMinutes, 0)} min
                    </div>
                  )}
                </td>
                <td className="num">
                  {price(l?.paidPaper)} / {price(l?.paidReal)} /{" "}
                  {price(b?.entryPrice)}
                </td>
                <td className="num">
                  {price(liveExit)} / {price(btExit)}
                </td>
                <td className="num">
                  {signed(l?.retReal)}% / {signed(b?.ret)}%
                </td>
                <td className={`num${tone(r.dollarsGap)}`}>
                  {r.dollarsGap === null ? "—" : signedUsd(r.dollarsGap)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReviewCard({ r, first }: { r: DayReview; first: boolean }) {
  const [open, setOpen] = useState(first);
  const verdict = shownVerdict(r);
  const s = r.comparison?.summary;
  const status = statusWords(r);
  return (
    <section
      className="bot-card dr-day"
      aria-labelledby={`dr-${r.bot}-${r.date}`}
    >
      <div className="bot-card-head">
        <h3 id={`dr-${r.bot}-${r.date}`}>{r.date}</h3>
        {verdict && (
          <span className={`pill ${verdictTone[verdict]}`}>
            {verdictWords[verdict]}
          </span>
        )}
      </div>
      {r.analysis && <p className="dr-headline">{r.analysis.headline}</p>}
      {status && <p className="muted small">{status}</p>}
      {s && (
        <ul className="vb-kpis dr-kpis">
          <li>
            <span className="muted small">Live, real prices</span>
            <b className={`num${tone(s.liveReal)}`}>{signedUsd(s.liveReal)}</b>
            <span className="muted small">paper {signedUsd(s.livePaper)}</span>
          </li>
          <li>
            <span className="muted small">Backtest at live size</span>
            <b className={`num${tone(s.backtestAtLiveSize)}`}>
              {signedUsd(s.backtestAtLiveSize)}
            </b>
            <span className="muted small">
              same trades, live {signedUsd(s.liveRealMatched)}
            </span>
          </li>
          <li>
            <span className="muted small">Gap (backtest − live)</span>
            <b className={`num${tone(s.gapDollars)}`}>
              {signedUsd(s.gapDollars)}
            </b>
            <span className="muted small">
              {signed(s.gapPts)} pts of the money paid
            </span>
          </li>
          <li>
            <span className="muted small">Trades</span>
            <b className="num">
              {s.matched} / {s.liveTrades} / {s.backtestTrades}
            </b>
            <span className="muted small">both / live / backtest</span>
          </li>
        </ul>
      )}
      {(r.analysis || r.comparison) && (
        <button
          type="button"
          className="bot-more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide the details" : "Show the analysis and trades"}
        </button>
      )}
      {open && r.analysis && <Markdown text={r.analysis.markdown} />}
      {open && r.comparison && r.comparison.rows.length > 0 && (
        <TradeRows rows={r.comparison.rows} />
      )}
      {open && r.comparison && r.comparison.notes.length > 0 && (
        <ul className="muted small">
          {r.comparison.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DayReviews({ bot }: { bot: ReviewBot }) {
  const { value, error } = usePolling<{ reviews: DayReview[] }>(
    `/api/day-reviews?bot=${bot}&limit=30`,
    60000,
    ignore,
  );
  if (!value)
    return (
      <p className={error ? "notice error" : "chart-status"}>
        {error
          ? `The reviews are unavailable: ${error}`
          : "Loading the reviews…"}
      </p>
    );
  return (
    <div className="bot-panel">
      <div className="bot-head">
        <div>
          <h2 className="portfolio-title">{botTitle[bot]} · analyse</h2>
          <p className="muted small">
            Each evening at 23:05 Israel time: the day's live trades against the
            app's backtest of the same day, priced at the real market (the
            book's mid at each fill). Times are Israel time.
          </p>
        </div>
      </div>
      {value.reviews.length === 0 && (
        <p className="muted">
          No review yet. The first one comes after the next close.
        </p>
      )}
      {value.reviews.map((r, i) => (
        <ReviewCard key={r.date} r={r} first={i === 0} />
      ))}
    </div>
  );
}
