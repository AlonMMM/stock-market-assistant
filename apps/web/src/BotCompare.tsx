import type {
  BotCompare as Compare,
  CompareRow,
  LegStats,
} from "../../../packages/trading/src/bot/compare.js";
import { israelShortDate } from "./time.js";
import { newYorkToUtc } from "../../../packages/market-data/src/calendar.js";

// Alpaca against IBKR on the Main bot page (the owner, 2026-11-03: "this is
// kind of benchmark. i would like to see how ibkr is against alpaca"): each
// account picks, fills and sells on its own, and this sets them side by side,
// per day and in total, with the misses only one account had.

const brokerName = { alpaca: "Alpaca", ibkr: "IBKR" } as const;

const outcomeWords: Record<string, string> = {
  thin: "too few contracts",
  too_cheap: "under the cheapest price",
  no_prices: "no prices",
  no_strikes: "no strikes",
  no_expiry: "no expiry",
  held: "already held",
  refused: "refused by the risk rules",
  too_small: "less than one contract",
  max_buys: "most buys for today",
  max_open: "most open positions",
  day_loss: "daily loss limit",
  error: "failed",
};

function seconds(ms: number | null): string {
  if (ms === null) return "—";
  return `${(ms / 1000).toFixed(1)} s`;
}

function pct(v: number | null): string {
  if (v === null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function Money({ s }: { s: LegStats }) {
  if (s.closed === 0) return <span className="muted">—</span>;
  const tone = s.pnlUsd >= 0 ? "up" : "down";
  const sign = s.pnlUsd >= 0 ? "+" : "−";
  return (
    <span className={tone}>
      {sign}$
      {Math.abs(s.pnlUsd).toLocaleString("en-US", {
        maximumFractionDigits: 0,
      })}{" "}
      <span className="small">({pct(s.pnlPct)})</span>
    </span>
  );
}

/** The day's label in Israel's short date (the session's noon). */
function dayLabel(day: string): string {
  if (day === "total") return "Total";
  return israelShortDate(newYorkToUtc(day, 720));
}

function Row({ r }: { r: CompareRow }) {
  const total = r.day === "total";
  return (
    <tr className={total ? "bought" : undefined}>
      <td>{dayLabel(r.day)}</td>
      <td className="num">{r.signals}</td>
      <td className="num">
        {r.alpaca.taken} / {r.ibkr.taken}
      </td>
      <td className="num">
        {r.same} / {r.different}
      </td>
      <td className="num">{pct(r.quoteGapPct)}</td>
      <td className="num">{pct(r.fillGapPct)}</td>
      <td className="num">
        {seconds(r.alpaca.pickMs)} / {seconds(r.ibkr.pickMs)}
      </td>
      <td className="num">
        {seconds(r.alpaca.fillMs)} / {seconds(r.ibkr.fillMs)}
      </td>
      <td className="num">
        <Money s={r.alpaca} />
      </td>
      <td className="num">
        <Money s={r.ibkr} />
      </td>
    </tr>
  );
}

export function BotCompare({ compare }: { compare: Compare | undefined }) {
  if (!compare || compare.total.signals === 0) return null;
  const open = compare.total.alpaca.open + compare.total.ibkr.open;
  return (
    <section
      className="bot-card bot-compare"
      aria-labelledby="bot-compare-title"
    >
      <div className="bot-card-head">
        <h3 id="bot-compare-title">Alpaca vs IBKR</h3>
        <span className="muted small">
          Last 5 sessions · each account picks, fills and sells on its own
          {open > 0 && ` · ${open} still open`}
        </span>
      </div>
      <div className="bt-signals-scroll">
        <table className="bt-signals-table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col" title="Signals sent to both accounts">
                Signals
              </th>
              <th scope="col" title="Bought at Alpaca / at IBKR">
                Taken A / I
              </th>
              <th
                scope="col"
                title="Both picked: the same contract / different ones"
              >
                Same / diff
              </th>
              <th
                scope="col"
                title="IBKR's mid against Alpaca's on one contract at the pick (median)"
              >
                Quote gap
              </th>
              <th
                scope="col"
                title="IBKR's fill against Alpaca's on the same contract (median)"
              >
                Fill gap
              </th>
              <th scope="col" title="Chain, pick and volume read (median)">
                Pick A / I
              </th>
              <th scope="col" title="From the signal to the fill (median)">
                To fill A / I
              </th>
              <th scope="col">P&amp;L Alpaca</th>
              <th scope="col">P&amp;L IBKR</th>
            </tr>
          </thead>
          <tbody>
            {compare.days.map((r) => (
              <Row key={r.day} r={r} />
            ))}
            {compare.days.length > 1 && <Row r={compare.total} />}
          </tbody>
        </table>
      </div>
      {compare.oneSided.length > 0 && (
        <>
          <p className="muted small bot-compare-sub">
            Bought by one account only
          </p>
          <ul className="bot-signals">
            {compare.oneSided.map((o) => (
              <li key={`${o.day}-${o.symbol}`}>
                <span className="num bot-signal-time">{dayLabel(o.day)}</span>
                <span className="bot-signal-what">
                  <strong>{o.symbol}</strong>
                  <span className="muted small">
                    {" "}
                    {brokerName[o.took]} bought · {brokerName[o.missed]}:{" "}
                    {outcomeWords[o.outcome] ?? o.outcome}
                  </span>
                  {o.detail && (
                    <span className="muted small bot-signal-detail">
                      {o.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
