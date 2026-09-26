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

// Categorical slots 1–2 of the validated dataviz palette; volume uses a light
// step of the ticker's hue, and the alert window the full hue.
const colors = {
  ticker: "#2a78d6",
  benchmark: "#eb6834",
  volume: "#b7d3f6",
  surface: "#fafbf8",
  text: "#52514e",
  grid: "#e7ece6",
};

const cache = new Map<string, Promise<DayChartData>>();
function load(ticker: string, date: string): Promise<DayChartData> {
  const key = `${ticker}/${date}`;
  let request = cache.get(key);
  if (!request) {
    request = fetch("/api/day-chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, date }),
      signal: AbortSignal.timeout(60000),
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Chart failed");
      return payload as DayChartData;
    });
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

interface Point {
  time: UTCTimestamp;
  instant: number; // ms, bar close (alerts are stamped at minute close)
  percent: number;
  close: number;
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
    volume: b.volume,
    session: b.session,
  }));
}

interface Readout {
  time: number;
  session: string;
  rows: { ticker: string; percent: number; close: number; color: string }[];
  volume: number;
}

export function DayChart({
  ticker,
  alertEnd,
  window,
}: {
  ticker: string;
  alertEnd: string; // ISO time the alert window closed
  window: number; // alert window length in minutes
}) {
  const alertMs = Date.parse(alertEnd);
  const date = usSessionDate(alertMs - 60000);
  const host = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<DayChartData | null>(null);
  const [error, setError] = useState("");
  const [readout, setReadout] = useState<Readout | null>(null);
  const [latest, setLatest] = useState<Readout | null>(null);

  useEffect(() => {
    let live = true;
    load(ticker, date).then(
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
  }, [ticker, date]);

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
    const m = points(main);
    const tickerLine = chart.addSeries(LineSeries, {
      color: colors.ticker,
      lineWidth: 2,
      priceFormat: percentFormat,
      priceLineVisible: false,
      crosshairMarkerRadius: 4,
    });
    tickerLine.setData(m.map((p) => ({ time: p.time, value: p.percent })));
    const b = bench ? points(bench) : null;
    if (b) {
      const benchLine = chart.addSeries(LineSeries, {
        color: colors.benchmark,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceFormat: percentFormat,
        priceLineVisible: false,
        crosshairMarkerRadius: 4,
      });
      benchLine.setData(b.map((p) => ({ time: p.time, value: p.percent })));
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
        color:
          p.instant > windowStart && p.instant <= alertMs
            ? colors.ticker
            : colors.volume,
      })),
    );
    chart.panes()[0]?.setStretchFactor(3);
    chart.panes()[1]?.setStretchFactor(1);
    const alertBar = m.find((p) => p.instant === alertMs);
    if (alertBar)
      createSeriesMarkers(tickerLine, [
        {
          time: alertBar.time,
          position: "aboveBar",
          shape: "arrowDown",
          color: colors.ticker,
          text: `Alert ${israelClock(alertMs)}`,
        },
      ]);
    chart.timeScale().fitContent();

    const benchByTime = new Map(b?.map((p) => [p.time, p]));
    const readoutAt = (p: Point): Readout => {
      const q = benchByTime.get(p.time);
      return {
        time: p.instant,
        session: sessionName[p.session],
        volume: p.volume,
        rows: [
          {
            ticker: main.ticker,
            percent: p.percent,
            close: p.close,
            color: colors.ticker,
          },
          ...(q && bench
            ? [
                {
                  ticker: bench.ticker,
                  percent: q.percent,
                  close: q.close,
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
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
    };
  }, [data, alertMs, window]);

  const shown = readout ?? latest;
  const main = data?.series[0];
  const base = main?.previousClose === null ? "first trade" : "previous close";
  return (
    <figure className="day-chart" aria-busy={!data && !error}>
      {error && <p className="notice error">{error}</p>}
      {!data && !error && <p className="chart-status">Loading day chart…</p>}
      {data && main?.bars.length === 0 && (
        <p className="chart-status">
          No {ticker} bars for {date}.
        </p>
      )}
      {data && main && main.bars.length > 0 && (
        <>
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
                  {s.ticker}
                </span>
              ))}
              <span>% vs {base}</span>
            </span>
            {shown && (
              <span className="chart-readout" aria-live="off">
                <span className="chart-time">
                  {israelClock(shown.time)} {israelLabel} · {shown.session}
                </span>
                {shown.rows.map((r) => (
                  <span key={r.ticker}>
                    <i className="key" style={{ borderColor: r.color }} />
                    <strong>{signed(r.percent)}%</strong> {r.ticker} $
                    {r.close.toFixed(2)}
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
            aria-label={`${ticker}${data.series[1] ? " and SPY" : ""} percent change and ${ticker} one-minute volume on ${date}, times in ${israelLabel}`}
          />
        </>
      )}
    </figure>
  );
}
