import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candles } from "../../../packages/market-data/src/candles.js";
import { readJson } from "./api.js";
import {
  israelClock,
  israelLabel,
  israelWallSeconds,
  usSessionDate,
} from "./time.js";

// A plain price chart: one candle per minute and the volume under it, with no
// benchmark. Today's session is read again every few seconds, and the last
// trade moves the candle of the minute that is still forming.

const refreshMs = 3000;
const colors = {
  up: "#16a34a",
  down: "#dc2626",
  upVolume: "rgba(22, 163, 74, 0.35)",
  downVolume: "rgba(220, 38, 38, 0.35)",
  surface: "#fafbf8",
  text: "#52514e",
  grid: "#e7ece6",
};
const clockSeconds = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function CandleChart({
  ticker,
  date,
}: {
  ticker: string;
  date: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const parts = useRef<{
    chart: IChartApi;
    candles: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
    fitted: boolean;
  } | null>(null);
  const [data, setData] = useState<Candles | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    const read = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await readJson<Candles>(
          await fetch(`/api/candles?${new URLSearchParams({ ticker, date })}`, {
            signal: AbortSignal.timeout(15000),
          }),
        );
        if (!live) return;
        setData(next);
        setError("");
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "No chart data");
      }
    };
    void read();
    // A finished session does not change.
    const timer =
      date === usSessionDate(Date.now())
        ? setInterval(read, refreshMs)
        : undefined;
    document.addEventListener("visibilitychange", read);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [ticker, date]);

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.surface },
        textColor: colors.text,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart
      .priceScale("volume")
      .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.06, bottom: 0.22 },
    });
    parts.current = { chart, candles, volume, fitted: false };
    return () => {
      parts.current = null;
      chart.remove();
    };
  }, [ticker, date]);

  useEffect(() => {
    const p = parts.current;
    if (!p || !data) return;
    // Times are shown on the Israel clock, like every other chart here.
    const time = (start: number) => israelWallSeconds(start) as UTCTimestamp;
    p.candles.setData(
      data.candles.map((c) => ({
        time: time(c.start),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    p.volume.setData(
      data.candles.map((c) => ({
        time: time(c.start),
        value: c.volume,
        color: c.close >= c.open ? colors.upVolume : colors.downVolume,
      })),
    );
    // Fitted once: later refreshes keep where the viewer scrolled to.
    if (!p.fitted && data.candles.length > 0) {
      p.chart.timeScale().fitContent();
      p.fitted = true;
    }
  }, [data]);

  const tail = data?.candles.at(-1);
  const price = data?.last?.price ?? tail?.close ?? null;
  const change =
    price !== null && data?.previousClose
      ? (price / data.previousClose - 1) * 100
      : null;
  return (
    <figure className="day-chart candle-chart">
      <figcaption>
        <span className="candle-last">
          <strong>{ticker}</strong>
          {price !== null && <span className="num">{price.toFixed(2)}</span>}
          {change !== null && (
            <span className={`num ${change >= 0 ? "up" : "down"}`}>
              {change >= 0 ? "+" : "−"}
              {Math.abs(change).toFixed(2)}%
            </span>
          )}
        </span>
        <span className="muted">
          {error
            ? `Update failed: ${error}`
            : data
              ? data.candles.length === 0
                ? "No trades yet in this session"
                : `1-minute candles · updated ${clockSeconds.format(data.at)} ${israelLabel}`
              : "Loading chart…"}
          {tail && data?.last && ` · last trade ${israelClock(data.last.at)}`}
        </span>
      </figcaption>
      <div
        ref={host}
        className="chart-canvas"
        role="img"
        aria-label={`${ticker} one-minute candles for ${date}`}
      />
    </figure>
  );
}
