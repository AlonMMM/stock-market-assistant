import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type AutoscaleInfo,
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
  opposite,
  oppositeDefaults,
  type Opposite,
  type OppositeKind,
} from "../../../packages/market-data/src/opposite.js";
import type { Outcome } from "../../../packages/market-data/src/outcome.js";
import {
  bandKinds,
  episodeSummary,
  isStrongVolume,
  outcomeLevels,
  stateText,
  strongVolume,
  typicalRatio,
} from "./chart-model.js";
import {
  israelClock,
  israelLabel,
  israelWallSeconds,
  usSessionDate,
} from "./time.js";
import { readJson } from "./api.js";

// Categorical slots 1–2 of the validated dataviz palette for the lines. Volume
// follows the trading convention: green for an up minute, red for a down one,
// at full strength from 2× typical volume and faded below it. Bands: red =
// held while the benchmark fell, blue = fell while the benchmark held.
const colors = {
  ticker: "#2a78d6",
  tickerText: "#1f5fae",
  benchmark: "#eb6834",
  benchmarkText: "#a8471b",
  up: ["#16a34a", "rgba(22, 163, 74, 0.35)"],
  down: ["#dc2626", "rgba(220, 38, 38, 0.35)"],
  typical: "#142b29",
  session: "#6b7280",
  pre: "rgba(20, 43, 41, 0.06)",
  open: "rgba(107, 114, 128, 0.55)",
  band: { strong: "rgba(220, 38, 38, 0.12)", weak: "rgba(42, 120, 214, 0.14)" },
  strip: { strong: "#dc2626", weak: "#2a78d6" },
  clear: "rgba(0, 0, 0, 0)",
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

interface Point {
  index: number; // bar index in the series
  time: UTCTimestamp;
  instant: number; // ms, bar close (alerts are stamped at minute close)
  percent: number;
  close: number;
  up: boolean;
  volume: number;
  typical: number | null;
  session: keyof typeof sessionName;
}

// % change against the previous regular close, or the day's first trade
// when the previous session has no bars.
function points(series: ChartSeries): Point[] {
  const reference = series.previousClose ?? series.bars[0]?.close ?? 1;
  return series.bars.map((b, index) => ({
    index,
    time: israelWallSeconds(b.start + 60) as UTCTimestamp,
    instant: (b.start + 60) * 1000,
    percent: (b.close / reference - 1) * 100,
    close: b.close,
    up: b.close >= b.open,
    volume: b.volume,
    typical: series.typicalVolume?.[index] ?? null,
    session: b.session,
  }));
}

type Range = "alert" | "day" | "open" | "hour";

interface Readout {
  time: number;
  session: keyof typeof sessionName;
  ticker: number;
  close: number;
  bench: number | null;
  volume: number;
  typical: number | null;
  state: OppositeKind | null;
}

// `alertMs`: the alert's bar close, for the "Around alert" range.
function applyRange(
  chart: IChartApi,
  range: Range,
  m: Point[],
  alertMs: number,
) {
  const last = m.at(-1);
  const open = m.find((p) => p.session === "regular");
  if (!last) return;
  if (range === "alert" && !Number.isNaN(alertMs)) {
    // One hour either side of the alert, so minute bars stay legible.
    const at = israelWallSeconds(alertMs / 1000);
    chart.timeScale().setVisibleRange({
      from: (at - 3600) as UTCTimestamp,
      to: (at + 3600) as UTCTimestamp,
    });
  } else if (range === "hour" || (range === "open" && open))
    chart.timeScale().setVisibleRange({
      from: (range === "hour" ? last.time - 3600 : open!.time) as UTCTimestamp,
      to: last.time,
    });
  else chart.timeScale().fitContent();
}

export function DayChart({
  ticker,
  alertEnd,
  window = 0,
  date: day,
  sector,
  against: initialAgainst = "SPY",
  outcome,
  direction,
  units,
  className = "",
}: {
  ticker: string;
  alertEnd?: string; // ISO time the alert window closed, if charting an alert
  window?: number; // alert window length in minutes
  date?: string; // US session date when there is no alert
  sector?: string; // the symbol's sector/theme benchmark ETF, if known
  against?: string; // benchmark shown first: "SPY" or `sector`
  outcome?: Outcome; // backtest validation of the alert, if scored
  direction?: "up" | "down"; // the alert's direction, for outcome levels
  units?: { goodUnits: number; stopUnits: number }; // backtest scoring
  className?: string;
}) {
  const alertMs = alertEnd ? Date.parse(alertEnd) : NaN;
  const date = alertEnd ? usSessionDate(alertMs - 60000) : day!;
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ chart: IChartApi; m: Point[] } | null>(null);
  const [data, setData] = useState<DayChartData | null>(null);
  const [error, setError] = useState("");
  const [readout, setReadout] = useState<Readout | null>(null);
  const [latest, setLatest] = useState<Readout | null>(null);
  // Alert rows open around the alert; other charts on the whole day.
  const [range, setRange] = useState<Range>(alertEnd ? "alert" : "day");
  const rangeRef = useRef(range);
  rangeRef.current = range;
  // Compare with SPY or the symbol's sector benchmark.
  const hasSector = !!sector && sector !== ticker && sector !== "SPY";
  const [against, setAgainst] = useState(initialAgainst);
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

  const main = data?.series[0];
  const bench = data?.series[1];
  const hasTypical = !!main?.typicalVolume;
  // Opposite-to-benchmark states; the benchmark itself has none.
  const opp: Opposite | null = useMemo(
    () =>
      main && bench && main.ticker !== bench.ticker
        ? opposite(main, bench)
        : null,
    [data],
  );

  useEffect(() => {
    if (!data || !main || !host.current || main.bars.length === 0) return;
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
      rightPriceScale: { borderVisible: false, textColor: colors.tickerText },
      leftPriceScale: {
        borderVisible: false,
        visible: !!bench,
        textColor: colors.benchmarkText,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        // Lets "Today" fit a full day of minute bars on a phone.
        minBarSpacing: 0.05,
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
    const b = bench ? points(bench) : null;
    const kinds = opp ? bandKinds(m.length, opp.episodes) : [];
    const firstRegular = m.find((p) => p.session === "regular");

    // Background: pre-market shade, the regular open, opposite-to-benchmark
    // bands. Drawn first, on its own hidden full-height scale.
    const background = chart.addSeries(HistogramSeries, {
      priceScaleId: "background",
      priceLineVisible: false,
      lastValueVisible: false,
      base: 0,
    });
    chart
      .priceScale("background")
      .applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    background.setData(
      m.map((p, i) => ({
        time: p.time,
        value: 1,
        color: kinds[i]
          ? colors.band[kinds[i]!]
          : p === firstRegular
            ? colors.open
            : p.session === "pre"
              ? colors.pre
              : colors.clear,
      })),
    );

    // Ticker on the right axis, benchmark on the left, both % from the
    // previous close and each fitted to its own range.
    // Backtest scoring levels (entry, good, stop) in % from the same
    // reference; the axis range stretches to keep them visible.
    const levels =
      outcome && direction && units
        ? outcomeLevels(outcome, direction, units)
        : null;
    const reference = main.previousClose ?? main.bars[0]?.close ?? 1;
    const pct = (price: number) => (price / reference - 1) * 100;
    const levelPcts = levels
      ? [levels.entry, levels.good, levels.stop].map(pct)
      : [];
    const tickerLine = chart.addSeries(LineSeries, {
      color: colors.ticker,
      lineWidth: 2,
      priceScaleId: "right",
      priceFormat: percentFormat,
      priceLineVisible: false,
      crosshairMarkerRadius: 4,
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original();
        if (!info?.priceRange || !levelPcts.length) return info;
        return {
          ...info,
          priceRange: {
            minValue: Math.min(info.priceRange.minValue, ...levelPcts),
            maxValue: Math.max(info.priceRange.maxValue, ...levelPcts),
          },
        };
      },
    });
    tickerLine.setData(m.map((p) => ({ time: p.time, value: p.percent })));
    if (b) {
      const benchLine = chart.addSeries(LineSeries, {
        color: colors.benchmark,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceScaleId: "left",
        priceFormat: percentFormat,
        priceLineVisible: false,
        crosshairMarkerRadius: 4,
      });
      benchLine.setData(b.map((p) => ({ time: p.time, value: p.percent })));
    }

    // Strip between the price and volume panes: solid opposite-to-benchmark
    // episodes.
    let volumePane = 1;
    if (opp) {
      const strip = chart.addSeries(
        HistogramSeries,
        {
          priceScaleId: "strip",
          priceLineVisible: false,
          lastValueVisible: false,
          base: 0,
        },
        1,
      );
      chart
        .priceScale("strip", 1)
        .applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
      strip.setData(
        m.map((p, i) => ({
          time: p.time,
          value: 1,
          color: kinds[i] ? colors.strip[kinds[i]!] : colors.clear,
        })),
      );
      volumePane = 2;
    }

    const windowStart = alertMs - window * 60000;
    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      volumePane,
    );
    volume.setData(
      m.map((p) => ({
        time: p.time,
        value: p.volume,
        color: (p.up ? colors.up : colors.down)[
          hasTypical
            ? isStrongVolume(p.volume, p.typical)
              ? 0
              : 1
            : // Without typical volume: the alert window at full strength,
              // or every bar when there is no alert.
              Number.isNaN(alertMs) ||
                (p.instant > windowStart && p.instant <= alertMs)
              ? 0
              : 1
        ],
      })),
    );
    if (hasTypical) {
      const typical = chart.addSeries(
        LineSeries,
        {
          color: colors.typical,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceFormat: { type: "volume" },
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        },
        volumePane,
      );
      // Unknown typical volume leaves a gap in the line.
      typical.setData(
        m.map((p) =>
          p.typical === null
            ? { time: p.time }
            : { time: p.time, value: p.typical },
        ),
      );
    }
    const panes = chart.panes();
    panes[0]?.setStretchFactor(3);
    if (opp) panes[1]?.setStretchFactor(0.12);
    panes[volumePane]?.setStretchFactor(1.6);

    const alertBar = m.find((p) => p.instant === alertMs);
    // Regular session open and close (from the bars' session labels, so
    // early closes are right), plus the alert, as markers on the price line.
    const lastRegular = m.filter((p) => p.session === "regular").at(-1);
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
        color: "#142b29",
        text: `Alert ${israelClock(alertMs)}`,
      });
    // Validation: the simulated entry and where it turned good or was stopped.
    if (outcome?.entryAt) {
      const entryMs = Date.parse(outcome.entryAt);
      const at = (ms: number) => m.find((p) => p.instant === ms);
      const entryBar = at(entryMs + 60000);
      if (entryBar)
        markers.push({
          time: entryBar.time,
          position: "belowBar",
          shape: "circle",
          color: colors.ticker,
          text: `Entry $${outcome.entry?.toFixed(2)}`,
        });
      const done =
        outcome.minutes !== null ? at(entryMs + outcome.minutes * 60000) : null;
      if (done)
        markers.push({
          time: done.time,
          position: outcome.result === "good" ? "aboveBar" : "belowBar",
          shape: "circle",
          color: outcome.result === "good" ? "#15803d" : "#b91c1c",
          text: outcome.result === "good" ? "✅ good" : "❌ stop",
        });
    }
    if (levels) {
      for (const [price, title, color, style] of [
        [levels.entry, "Entry", colors.typical, LineStyle.Dotted],
        [levels.good, "Good", "#15803d", LineStyle.Dashed],
        [levels.stop, "Stop", "#b91c1c", LineStyle.Dashed],
      ] as const)
        tickerLine.createPriceLine({
          price: pct(price),
          color,
          lineWidth: 1,
          lineStyle: style,
          axisLabelVisible: true,
          title: `${title} $${price.toFixed(2)}`,
        });
    }
    markers.sort((x, y) => Number(x.time) - Number(y.time));
    if (markers.length) createSeriesMarkers(tickerLine, markers);
    // Applied after the first layout; autoSize would otherwise shift it.
    const frame = requestAnimationFrame(() =>
      applyRange(chart, rangeRef.current, m, alertMs),
    );
    chartRef.current = { chart, m };

    const benchByTime = new Map(b?.map((p) => [p.time, p]));
    const readoutAt = (p: Point): Readout => ({
      time: p.instant,
      session: p.session,
      ticker: p.percent,
      close: p.close,
      bench: benchByTime.get(p.time)?.percent ?? null,
      volume: p.volume,
      typical: p.typical,
      state: opp?.states[p.index] ?? null,
    });
    const byTime = new Map(m.map((p) => [p.time, p]));
    setLatest(readoutAt((alertBar ?? m[m.length - 1])!));
    const onMove = (param: MouseEventParams) => {
      const p = param.time ? byTime.get(param.time as UTCTimestamp) : undefined;
      setReadout(p ? readoutAt(p) : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      cancelAnimationFrame(frame);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
    };
    // `opp`, `main`, `bench` and the flags derive from `data`.
  }, [data, alertMs, window, outcome, direction, units]);

  useEffect(() => {
    const c = chartRef.current;
    if (c) applyRange(c.chart, range, c.m, alertMs);
  }, [range]);

  const shown = readout ?? latest;
  const benchName = bench?.ticker ?? benchmark;
  const base = main?.previousClose === null ? "first trade" : "previous close";
  const isToday = date === usSessionDate(Date.now());
  const ratio = shown ? typicalRatio(shown.volume, shown.typical) : null;
  const o = oppositeDefaults;
  return (
    <figure className={`day-chart ${className}`} aria-busy={!data && !error}>
      <div className="chart-controls">
        {hasSector && (
          <div
            className="segmented small"
            role="group"
            aria-label="Compare with"
          >
            {["SPY", sector!].map((symbol) => (
              <button
                type="button"
                key={symbol}
                aria-pressed={benchmark === symbol}
                onClick={() => setAgainst(symbol)}
              >
                vs {symbol}
              </button>
            ))}
          </div>
        )}
        <div className="segmented small" role="group" aria-label="Chart range">
          {(
            [
              ...(alertEnd ? ([["alert", "Around alert"]] as const) : []),
              ["day", "Today"],
              ["open", "Since open"],
              ["hour", "Last hour"],
            ] as const
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              aria-pressed={range === key}
              onClick={() => setRange(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="notice error">{error}</p>}
      {!data && !error && <p className="chart-status">Loading day chart…</p>}
      {data && main?.bars.length === 0 && (
        <p className="chart-status">
          No {ticker} bars for {date}.
        </p>
      )}
      {data && main && main.bars.length > 0 && (
        <>
          {opp && (
            <div className="chart-summary">
              <span className="summary strong">
                <i aria-hidden="true" />
                {episodeSummary(
                  "strong",
                  opp.episodes,
                  main.bars,
                  benchName,
                  isToday,
                )}
              </span>
              <span className="summary weak">
                <i aria-hidden="true" />
                {episodeSummary(
                  "weak",
                  opp.episodes,
                  main.bars,
                  benchName,
                  isToday,
                )}
              </span>
            </div>
          )}
          {shown && (
            <p className="chart-readout" aria-live="off">
              <strong className="chart-time">{israelClock(shown.time)}</strong>
              <span>
                <i className="key" style={{ borderColor: colors.ticker }} />
                {main.ticker}{" "}
                <strong style={{ color: colors.tickerText }}>
                  {signed(shown.ticker)}%
                </strong>{" "}
                <span className="muted">
                  ${shown.close.toFixed(2)} · right axis
                </span>
              </span>
              {bench && shown.bench !== null && (
                <>
                  <span>
                    <i
                      className="key dashed"
                      style={{ borderColor: colors.benchmark }}
                    />
                    {bench.ticker}{" "}
                    <strong style={{ color: colors.benchmarkText }}>
                      {signed(shown.bench)}%
                    </strong>{" "}
                    <span className="muted">left axis</span>
                  </span>
                  <span>
                    Gap{" "}
                    <strong>{signed(shown.ticker - shown.bench)} pts</strong>
                  </span>
                </>
              )}
              <span>
                Volume <strong>{compact.format(shown.volume)}</strong>
                {ratio !== null && (
                  <span
                    className={ratio >= strongVolume ? "strong-ratio" : "muted"}
                  >
                    {" "}
                    {ratio.toFixed(1)}× typical
                  </span>
                )}
              </span>
              {opp && shown.session === "regular" ? (
                <span className={`state-chip ${shown.state ?? "none"}`}>
                  {stateText(shown.state, benchName)}
                </span>
              ) : (
                <span className="state-chip none">
                  {sessionName[shown.session]}
                </span>
              )}
            </p>
          )}
          <div
            className="chart-canvas"
            ref={host}
            role="img"
            aria-label={`${ticker} percent change from the ${base} on the right axis${bench ? ` and ${benchName} on the left axis` : ""}${opp ? `, with periods moving opposite to ${benchName}` : ""}, and ${ticker} one-minute volume${hasTypical ? " against typical volume" : ""} on ${date}, times in ${israelLabel}`}
          />
          <p className="chart-legend-note">
            Lines: % from the {base}, each axis fitted to its own range (
            {main.ticker} right, {benchName} left).
            {opp && (
              <>
                {" "}
                <span className="legend-swatch strong" aria-hidden="true" />
                Red: over the last {o.window} minutes {benchName} fell ≥{" "}
                {Math.abs(o.benchFall)} % points while {main.ticker} held or
                rose. <span className="legend-swatch weak" aria-hidden="true" />
                Blue: {benchName} held or rose (≥ −{Math.abs(o.benchHold)} %
                points) while {main.ticker} fell ≥ {o.weakMultiple}× its usual{" "}
                {o.window}-minute move. Regular session only; a display aid, not
                a signal.
              </>
            )}{" "}
            {hasTypical
              ? `Volume: solid bars ≥ ${strongVolume}× typical for that minute, faded below; dashed line = typical volume.`
              : "Typical volume is not available for this chart."}{" "}
            {!Number.isNaN(alertMs) && "▼ marks the alert. "}
            {outcome?.entry !== null &&
              outcome?.entry !== undefined &&
              direction &&
              units &&
              `Horizontal lines: the simulated entry (dotted), the good level ${units.goodUnits}u in the alert's direction and the stop ${units.stopUnits}u against it (dashed, labelled). `}
            Shaded = pre-market. Times in {israelLabel}.
          </p>
        </>
      )}
    </figure>
  );
}
