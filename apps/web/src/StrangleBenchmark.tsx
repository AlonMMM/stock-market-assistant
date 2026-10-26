import benchmark from "../../../config/volume-bot-benchmark.json";
import type {
  StrangleTradeView,
  StrangleView,
} from "../../../packages/trading/src/strangle/view.js";
import { useBoxWidth } from "./BotPanel.js";
import { usePolling } from "./Live.js";
import { legWords, result, signedUsd, tone } from "./StranglePanel.js";

// The volume bot's benchmark (the approved design): its live paper account's
// result by trading day since its first trade, drawn over the backtest's
// expected band (config/volume-bot-benchmark.json: the cumulative return
// after n trading days, p25 / p50 / p75). Read-only, for everyone.

interface Benchmark {
  source: string;
  rule: string;
  startEquity: number;
  days: { n: number; p25: number; p50: number; p75: number }[];
}
const bench: Benchmark = benchmark;
const ignore = () => {};

/** The average price of a leg's settled orders on one side, or null. */
function avgPrice(t: StrangleTradeView, side: "buy" | "sell"): number | null {
  let qty = 0;
  let cost = 0;
  for (const o of t.leg?.orders ?? []) {
    if (o.side !== side || !o.settled || o.price === undefined) continue;
    qty += o.qty;
    cost += o.qty * o.price;
  }
  return qty > 0 ? cost / qty : null;
}

const pad = { l: 56, r: 14, t: 14, b: 30 };

function shortUsd(v: number): string {
  const abs = Math.abs(v);
  let sign = "";
  if (v < 0) sign = "−";
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function BandChart({ live }: { live: StrangleView["live"] }) {
  const box = useBoxWidth(640);
  const w = Math.max(300, Math.min(900, box.width));
  const h = w < 520 ? 240 : 280;
  const start = bench.startEquity;
  let cum = 0;
  const points = live.map((d, i) => {
    cum += d.pnl;
    return { n: i + 1, day: d.day, value: cum };
  });
  const band = bench.days.map((d) => ({
    n: d.n,
    lo: d.p25 * start,
    mid: d.p50 * start,
    hi: d.p75 * start,
  }));
  const maxN = Math.max(5, points.length, ...band.map((b) => b.n));
  const values = [
    0,
    ...points.map((p) => p.value),
    ...band.flatMap((b) => [b.lo, b.hi]),
  ];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 100) {
    hi += 50;
    lo -= 50;
  }
  const right = w - pad.r;
  const bottom = h - pad.b;
  const x = (n: number) =>
    pad.l + ((n - 1) / Math.max(1, maxN - 1)) * (right - pad.l);
  const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * (bottom - pad.t);
  const area =
    band.map((b, i) => `${i ? "L" : "M"}${x(b.n)} ${y(b.hi)}`).join(" ") +
    " " +
    [...band]
      .reverse()
      .map((b) => `L${x(b.n)} ${y(b.lo)}`)
      .join(" ") +
    " Z";
  const mid = band
    .map((b, i) => `${i ? "L" : "M"}${x(b.n)} ${y(b.mid)}`)
    .join(" ");
  const liveLine = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.n)} ${y(p.value)}`)
    .join(" ");
  const yTicks = [lo, (lo + hi) / 2, hi, 0].filter(
    (v, i, all) => all.indexOf(v) === i,
  );
  const step = Math.max(1, Math.ceil(maxN / 6 / 5) * 5);
  const xTicks: number[] = [1];
  for (let n = step; n <= maxN; n += step) xTicks.push(n);
  return (
    <div ref={box.ref}>
      <svg
        className="bot-map vb-bench"
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        role="img"
        aria-label="The live account's cumulative P&L by trading day over the backtest's expected band"
      >
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              className={v === 0 ? "bot-map-need" : "bot-map-grid"}
              x1={pad.l}
              x2={right}
              y1={y(v)}
              y2={y(v)}
            />
            <text
              className="bot-map-tick"
              x={pad.l - 6}
              y={y(v) + 4}
              textAnchor="end"
            >
              {shortUsd(v)}
            </text>
          </g>
        ))}
        {xTicks.map((n) => (
          <text
            key={`x${n}`}
            className="bot-map-tick"
            x={x(n)}
            y={bottom + 14}
            textAnchor="middle"
          >
            {n}
          </text>
        ))}
        <text
          className="bot-map-axis"
          x={(pad.l + right) / 2}
          y={h - 2}
          textAnchor="middle"
        >
          Trading day since the first live trade →
        </text>
        {band.length > 1 && <path className="vb-band" d={area} />}
        {band.length > 1 && <path className="vb-band-mid" d={mid} />}
        {points.length > 1 && <path className="vb-live-line" d={liveLine} />}
        {points.map((p) => (
          <circle
            key={p.day}
            className="vb-live-dot"
            cx={x(p.n)}
            cy={y(p.value)}
            r={4}
          >
            <title>{`Day ${p.n} (${p.day}): ${signedUsd(p.value)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

export function StrangleBenchmark() {
  const { value: v, error } = usePolling<StrangleView>(
    "/api/strangle",
    30000,
    ignore,
  );
  if (!v)
    return (
      <p className={error ? "notice error" : "chart-status"}>
        {error
          ? `The volume bot is unavailable: ${error}`
          : "Loading the volume bot…"}
      </p>
    );
  const pnl = v.live.reduce((sum, d) => sum + d.pnl, 0);
  const trades = v.live.reduce((sum, d) => sum + d.trades, 0);
  const winners = v.live.reduce((sum, d) => sum + d.winners, 0);
  let winShare = "—";
  if (trades > 0) winShare = `${Math.round((winners / trades) * 100)}%`;
  let since = "No live trade yet";
  if (v.live[0]) since = `Since ${v.live[0].day}, ${v.live.length} days`;
  const liveTrades = v.trades.filter((t) => !t.dry);
  return (
    <div className="bot-panel">
      <div className="bot-head">
        <div>
          <h2 className="portfolio-title">🎯 Volume bot · benchmark</h2>
          <p className="muted small">
            The live paper account against what the backtest expected.
          </p>
        </div>
      </div>
      <ul className="vb-kpis">
        <li className="bot-card">
          <span className="muted small">Live P&amp;L</span>
          <b className={`bot-funnel-n num${tone(pnl)}`}>{signedUsd(pnl)}</b>
          <span className="muted small">{since}</span>
        </li>
        <li className="bot-card">
          <span className="muted small">Trades</span>
          <b className="bot-funnel-n num">{trades}</b>
          <span className="muted small">live, closed and open</span>
        </li>
        <li className="bot-card">
          <span className="muted small">Winners</span>
          <b className="bot-funnel-n num">{winners}</b>
          <span className="muted small">{winShare} of the trades</span>
        </li>
      </ul>
      <section className="bot-card" aria-labelledby="vb-bench-title">
        <div className="bot-card-head">
          <h3 id="vb-bench-title">Live vs the backtest</h3>
          <span className="muted small">
            Cumulative P&amp;L by trading day, on a $
            {bench.startEquity.toLocaleString("en-US")} account
          </span>
        </div>
        <BandChart live={v.live} />
        <p className="bot-strip-legend muted small">
          <span>
            <span className="key live" /> live account
          </span>
          <span>
            <span className="key mid" /> backtest median
          </span>
          <span>
            <span className="key band" /> backtest middle half (25th–75th
            percentile)
          </span>
        </p>
        {bench.source === "placeholder" && (
          <p className="bot-warn small">
            The backtest band is a placeholder (all zeros) until the backtest's
            numbers are filled in.
          </p>
        )}
        <p className="muted small">{bench.rule}</p>
      </section>
      <section className="bot-card" aria-labelledby="vb-bench-trades">
        <div className="bot-card-head">
          <h3 id="vb-bench-trades">Live trades, last 30 days</h3>
          <span className="muted small">
            The backtest's trade-by-trade column is not wired yet.
          </span>
        </div>
        {liveTrades.length === 0 ? (
          <p className="muted">No live trades yet.</p>
        ) : (
          <div className="st-table-wrap">
            <table className="st-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Stock</th>
                  <th>Contract</th>
                  <th className="num">Buy</th>
                  <th className="num">Sale</th>
                  <th className="num">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {liveTrades.map((t) => {
                  const buy = avgPrice(t, "buy");
                  const sale = avgPrice(t, "sell");
                  const r = result(t);
                  let contract = "—";
                  if (t.leg)
                    contract = `${t.leg.bought} × ${legWords(t.leg.contract)}`;
                  return (
                    <tr key={t.id}>
                      <td>{t.day.slice(5)}</td>
                      <td>
                        <b>{t.symbol}</b>
                      </td>
                      <td>{contract}</td>
                      <td className="num">
                        {buy !== null ? buy.toFixed(2) : "—"}
                      </td>
                      <td className="num">
                        {sale !== null ? sale.toFixed(2) : "—"}
                      </td>
                      <td className={`num${tone(r.pnl)}`}>
                        {signedUsd(r.pnl)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
