import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type {
  ChartSeries,
  DayChart as DayChartData,
} from "../../../packages/market-data/src/day-chart.js";
import {
  israelClock,
  israelLabel,
  israelWallSeconds,
  usSessionDate,
} from "./time.js";
import { readJson } from "./api.js";

// Categorical slots 1–2 of the validated dataviz palette for the lines. Volume
// follows the trading convention: green for an up minute, red for a down one,
// at full strength inside the alert window and muted elsewhere.
const colors = {
  ticker: "#2a78d6",
  benchmark: "#eb6834",
  up: ["#16a34a", "rgba(22, 163, 74, 0.45)"],
  down: ["#dc2626", "rgba(220, 38, 38, 0.45)"],
  session: "#6b7280",
  surface: "#fafbf8",
  text: "#52514e",
  grid: "#e7ece6",
};

const cache = new Map<string, Promise<DayChartData>>();
function load(
  ticker: string,
  date: string,
  benchmark: string,
): Promise<DayChartData> {
  const key = `${ticker}/${date}/${benchmark}`;
  let request = cache.get(key);
  if (!request) {
    request = fetch("/api/day-chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, date, benchmark }),
      signal: AbortSignal.timeout(60000),
    }).then((response) => readJson<DayChartData>(response));
    request.catch(() => cache.delete(key));
    cache.set(key, request);
  }
  return request;
}

const signed = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2);
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const sessionName = {
  pre: "Pre-market",
  regular: "Regular",
  post: "After-hours",
};

const label = (data: DayChartData | null) => {
  const bench = data?.series[1]?.ticker ?? "SPY";
  return data?.beta.value == null
    ? bench
    : `${bench} × β ${data.beta.value.toFixed(2)}`;
};

interface Point {
  time: UTCTimestamp;
  instant: number; // ms, bar close (alerts are stamped at minute close)
  percent: number;
  close: number;
  up: boolean;
  volume: number;
  session: keyof typeof sessionName;
}

// % change against the previous regular close, or the day's first trade
// when the previous session has no bars.
function points(series: ChartSeries): Point[] {
  const reference = series.previousClose ?? series.bars[0]?.close ?? 1;
  return series.bars.map((b) => ({
    time: israelWallSeconds(b.start + 60) as UTCTimestamp,
    instant: (b.start + 60) * 1000,
    percent: (b.close / reference - 1) * 100,
    close: b.close,
    up: b.close >= b.open,
    volume: b.volume,
    session: b.session,
  }));
}

// "overlay": each symbol's price on its own auto-fitted axis (ticker right,
// SPY left), matching trading platforms, to compare the shape and timing of
// moves. "beta": one % axis with SPY × beta, to compare the size of moves.
type Mode = "overlay" | "beta";
const modeKey = "sma.chart.mode.v1";
function savedMode(): Mode {
  try {
    return localStorage.getItem(modeKey) === "beta" ? "beta" : "overlay";
  } catch {
    return "overlay";
  }
}

interface Readout {
  time: number;
  session: string;
  rows: { label: string; percent: number; detail: string; color: string }[];
  volume: number;
}

export function DayChart({
  ticker,
  alertEnd,
  window = 0,
  date: day,
  sector,
  className = "",
}: {
  ticker: string;
  alertEnd?: string; // ISO time the alert window closed, if charting an alert
  window?: number; // alert window length in minutes
  date?: string; // US session date when there is no alert
  sector?: string; // the symbol's sector/theme benchmark ETF, if known
  className?: string;
}) {
  const alertMs = alertEnd ? Date.parse(alertEnd) : NaN;
  const viewed = useRef<{ from: UTCTimestamp; to: UTCTimestamp } | null>(null);
  const date = alertEnd ? usSessionDate(alertMs - 60000) : day!;
  const host = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<DayChartData | null>(null);
  const [error, setError] = useState("");
  const [readout, setReadout] = useState<Readout | null>(null);
  const [latest, setLatest] = useState<Readout | null>(null);
  const [mode, setModeState] = useState<Mode>(savedMode);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(modeKey, m);
    } catch {
      // Remembered for this visit only.
    }
  };
  const overlay = mode === "overlay";
  // Compare with SPY or the symbol's sector benchmark.
  const hasSector = !!sector && sector !== ticker && sector !== "SPY";
  const [against, setAgainst] = useState("SPY");
  const benchmark = hasSector ? against : "SPY";

  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    load(ticker, date, benchmark).then(
      (d) => live && setData(d),
      (e: Error) =>
        live &&
        setError(
          e.name === "TimeoutError" ? "The chart took too long." : e.message,
        ),
    );
    return () => {
      live = false;
    };
  }, [ticker, date, benchmark]);

  useEffect(() => {
    if (!data || !host.current) return;
    const [main, bench] = data.series;
    if (!main || main.bars.length === 0) return;
    const chart: IChartApi = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.surface },
        textColor: colors.text,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: colors.grid, enableResize: false },
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: { borderVisible: false },
      leftPriceScale: { borderVisible: false, visible: overlay && !!bench },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: { vertTouchDrag: false },
    });
    const percentFormat = {
      type: "custom" as const,
      formatter: (p: number) => `${signed(p)}%`,
      minMove: 0.01,
    };
    const priceFormat = { type: "price" as const, precision: 2, minMove: 0.01 };
    const m = points(main);
    const tickerLine = chart.addSeries(LineSeries, {
      color: colors.ticker,
      lineWidth: 2,
      priceScaleId: "right",
      priceFormat: overlay ? priceFormat : percentFormat,
      priceLineVisible: false,
      crosshairMarkerRadius: 4,
    });
    tickerLine.setData(
      m.map((p) => ({ time: p.time, value: overlay ? p.close : p.percent })),
    );
    // Beta mode: SPY × beta on the same % axis, so the gap between the lines is
    // the ticker's own move. Overlay mode: SPY's price on the left axis.
    const beta = overlay ? 1 : (data.beta.value ?? 1);
    const b = bench ? points(bench) : null;
    if (b) {
      const benchLine = chart.addSeries(LineSeries, {
        color: colors.benchmark,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceScaleId: overlay ? "left" : "right",
        priceFormat: overlay ? priceFormat : percentFormat,
        priceLineVisible: false,
        crosshairMarkerRadius: 4,
      });
      benchLine.setData(
        b.map((p) => ({
          time: p.time,
          value: overlay ? p.close : p.percent * beta,
        })),
      );
    }
    const windowStart = alertMs - window * 60000;
    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1,
    );
    volume.setData(
      m.map((p) => ({
        time: p.time,
        value: p.volume,
        color: (p.up ? colors.up : colors.down)[
          // Without an alert every bar is drawn at full strength.
          Number.isNaN(alertMs) ||
          (p.instant > windowStart && p.instant <= alertMs)
            ? 0
            : 1
        ],
      })),
    );
    chart.panes()[0]?.setStretchFactor(3);
    chart.panes()[1]?.setStretchFactor(1.6);
    const alertBar = m.find((p) => p.instant === alertMs);
    // Regular session open and close (from the bars' session labels, so
    // early closes are right), plus the alert, as markers on the price line.
    const regular = m.filter((p) => p.session === "regular");
    const firstRegular = regular[0];
    const lastRegular = regular.at(-1);
    const markers: SeriesMarker<Time>[] = [];
    if (firstRegular)
      markers.push({
        time: firstRegular.time,
        position: "belowBar",
        shape: "arrowUp",
        color: colors.session,
        text: `Open ${israelClock(firstRegular.instant - 60000)}`,
      });
    if (lastRegular && lastRegular !== firstRegular)
      markers.push({
        time: lastRegular.time,
        position: "belowBar",
        shape: "square",
        color: colors.session,
        text: `Close ${israelClock(lastRegular.instant)}`,
      });
    if (alertBar)
      markers.push({
        time: alertBar.time,
        position: "aboveBar",
        shape: "arrowDown",
        color: colors.ticker,
        text: `Alert ${israelClock(alertMs)}`,
      });
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    if (markers.length) createSeriesMarkers(tickerLine, markers);
    // Open on two hours around the alert so minute volume bars stay legible;
    // pinch or scroll zooms out to the whole day.
    // Applied after the first layout; autoSize would otherwise shift it.
    // Switching modes rebuilds the chart; keep the range the user was viewing.
    const frame = requestAnimationFrame(() =>
      viewed.current
        ? chart.timeScale().setVisibleRange(viewed.current)
        : alertBar
          ? chart.timeScale().setVisibleRange({
              from: (alertBar.time - 3600) as UTCTimestamp,
              to: (alertBar.time + 3600) as UTCTimestamp,
            })
          : chart.timeScale().fitContent(),
    );

    const benchByTime = new Map(b?.map((p) => [p.time, p]));
    const readoutAt = (p: Point): Readout => {
      const q = benchByTime.get(p.time);
      return {
        time: p.instant,
        session: sessionName[p.session],
        volume: p.volume,
        rows: [
          {
            label: main.ticker,
            percent: p.percent,
            detail: `$${p.close.toFixed(2)}`,
            color: colors.ticker,
          },
          ...(q && bench
            ? [
                {
                  label: overlay ? bench.ticker : label(data),
                  percent: q.percent * beta,
                  detail:
                    overlay || data.beta.value === null
                      ? `$${q.close.toFixed(2)}`
                      : `(${bench.ticker} ${signed(q.percent)}%)`,
                  color: colors.benchmark,
                },
              ]
            : []),
        ],
      };
    };
    const byTime = new Map(m.map((p) => [p.time, p]));
    setLatest(readoutAt((alertBar ?? m[m.length - 1])!));
    const onMove = (param: MouseEventParams) => {
      const p = param.time ? byTime.get(param.time as UTCTimestamp) : undefined;
      setReadout(p ? readoutAt(p) : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      const range = chart.timeScale().getVisibleRange();
      if (range)
        viewed.current = {
          from: range.from as UTCTimestamp,
          to: range.to as UTCTimestamp,
        };
      cancelAnimationFrame(frame);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
    };
  }, [data, alertMs, window, overlay]);

  const shown = readout ?? latest;
  const main = data?.series[0];
  const benchLabel = overlay
    ? (data?.series[1]?.ticker ?? benchmark)
    : label(data);
  const base = main?.previousClose === null ? "first trade" : "previous close";
  return (
    <figure className={`day-chart ${className}`} aria-busy={!data && !error}>
      {hasSector && (
        <div
          className="chips chart-modes"
          role="group"
          aria-label="Compare with"
        >
          {["SPY", sector!].map((symbol) => (
            <button
              type="button"
              key={symbol}
              className="chip"
              aria-pressed={benchmark === symbol}
              onClick={() => setAgainst(symbol)}
            >
              vs {symbol}
            </button>
          ))}
        </div>
      )}
      {error && <p className="notice error">{error}</p>}
      {!data && !error && <p className="chart-status">Loading day chart…</p>}
      {data && main?.bars.length === 0 && (
        <p className="chart-status">
          No {ticker} bars for {date}.
        </p>
      )}
      {data && main && main.bars.length > 0 && (
        <>
          {data.series[1] && (
            <div
              className="chips chart-modes"
              role="group"
              aria-label="Chart view"
            >
              <button
                type="button"
                className="chip"
                aria-pressed={overlay}
                onClick={() => setMode("overlay")}
              >
                Overlay
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={!overlay}
                onClick={() => setMode("beta")}
              >
                % vs {benchmark}×β
              </button>
            </div>
          )}
          <figcaption>
            <span className="chart-legend">
              {data.series.map((s, i) => (
                <span key={s.ticker}>
                  <i
                    className={i === 0 ? "key" : "key dashed"}
                    style={{
                      borderColor: i === 0 ? colors.ticker : colors.benchmark,
                    }}
                  />
                  {i === 0 ? s.ticker : benchLabel}
                  {overlay &&
                    data.series[1] &&
                    (i === 0 ? " · right" : " · left")}
                </span>
              ))}
              {!overlay && data.series[1] && data.beta.value === null && (
                <span>β unavailable, {benchmark} unscaled</span>
              )}
              <span>
                {overlay && data.series[1]
                  ? "Price, each axis fitted to its own range"
                  : `% vs ${base}`}
              </span>
            </span>
            {shown && (
              <span className="chart-readout" aria-live="off">
                <span className="chart-time">
                  {israelClock(shown.time)} {israelLabel} · {shown.session}
                </span>
                {shown.rows.map((r) => (
                  <span key={r.label}>
                    <i className="key" style={{ borderColor: r.color }} />
                    <strong>{signed(r.percent)}%</strong> {r.label} {r.detail}
                  </span>
                ))}
                <span>
                  <strong>{compact.format(shown.volume)}</strong> {ticker} vol
                </span>
              </span>
            )}
          </figcaption>
          <div
            className="chart-canvas"
            ref={host}
            role="img"
            aria-label={`${ticker}${data.series[1] ? ` and ${benchLabel}` : ""} ${overlay ? "price" : "percent change"} and ${ticker} one-minute volume on ${date}, times in ${israelLabel}`}
          />
        </>
      )}
    </figure>
  );
}
