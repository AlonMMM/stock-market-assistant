// Small overlay chart: the symbol and SPY, each scaled to its own range like
// the day chart's Overlay view, on a shared time axis for the session.
const colors = { ticker: "#2a78d6", benchmark: "#eb6834" };

function path(
  points: [number, number][],
  from: number,
  to: number,
  width: number,
  height: number,
) {
  if (points.length < 2) return "";
  let low = Infinity;
  let high = -Infinity;
  for (const [, v] of points) {
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  const span = high - low || 1;
  const pad = 2;
  return points
    .map(([t, v], i) => {
      const x = ((t - from) / (to - from || 1)) * width;
      const y = pad + (1 - (v - low) / span) * (height - 2 * pad);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("");
}

export function Sparkline({
  ticker,
  benchmark,
  marks = [],
}: {
  ticker: [number, number][];
  benchmark?: [number, number][];
  marks?: number[]; // session open/close instants (Unix s) to draw as lines
}) {
  const width = 120;
  const height = 40;
  const times = [...ticker, ...(benchmark ?? [])].map(([t]) => t);
  if (ticker.length < 2) return <span className="spark-empty">No data</span>;
  const from = Math.min(...times);
  const to = Math.max(...times);
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {marks
        .filter((t) => t > from && t < to)
        .map((t) => {
          const x = ((t - from) / (to - from)) * width;
          return (
            <line
              key={t}
              x1={x}
              x2={x}
              y1={0}
              y2={height}
              stroke="#9ca3af"
              strokeWidth="1"
              strokeDasharray="1 2"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      {benchmark && benchmark.length > 1 && (
        <path
          d={path(benchmark, from, to, width, height)}
          fill="none"
          stroke={colors.benchmark}
          strokeWidth="1.2"
          strokeDasharray="3 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={path(ticker, from, to, width, height)}
        fill="none"
        stroke={colors.ticker}
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Watchlist row chart: today's line, green above the previous close and red
 * below (the dashed line), with the last point marked. The y-range always
 * includes the previous close, so the line's side of it reads at a glance.
 */
export function DaySpark({
  points,
  previousClose,
  width = 64,
  height = 30,
  tight = false,
}: {
  points: [number, number][];
  previousClose: number | null;
  width?: number;
  height?: number;
  // Scaled to the day's own range and stretched to its box (the SPY/QQQ
  // cards): the previous close is drawn only when it falls inside.
  tight?: boolean;
}) {
  if (points.length < 2) return <span className="spark-empty">—</span>;
  let low = Infinity;
  let high = -Infinity;
  for (const [, v] of points) {
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  if (previousClose !== null && !tight) {
    low = Math.min(low, previousClose);
    high = Math.max(high, previousClose);
  }
  const span = high - low || 1;
  const pad = 2.5;
  const from = points[0]![0];
  const to = points.at(-1)![0];
  const x = (t: number) =>
    pad + ((t - from) / (to - from || 1)) * (width - 2 * pad);
  const y = (v: number) => pad + (1 - (v - low) / span) * (height - 2 * pad);
  const last = points.at(-1)!;
  const up = previousClose === null || last[1] >= previousClose;
  const d = points
    .map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`)
    .join("");
  return (
    <svg
      className={`day-spark ${up ? "up" : "down"}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      {...(tight ? { preserveAspectRatio: "none" } : {})}
      aria-hidden="true"
    >
      {previousClose !== null &&
        previousClose >= low &&
        previousClose <= high && (
          <line
            className="day-spark-base"
            x1={pad}
            x2={width - pad}
            y1={y(previousClose)}
            y2={y(previousClose)}
          />
        )}
      <path className="day-spark-line" d={d} />
      <circle
        className="day-spark-dot"
        cx={x(last[0])}
        cy={y(last[1])}
        r={2.2}
      />
    </svg>
  );
}
