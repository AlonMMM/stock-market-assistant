import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  BaselineSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPanePrimitive,
  type IPanePrimitivePaneView,
  type IPrimitivePaneRenderer,
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
import {
  axisPriceMinWidth,
  bandKinds,
  chartScores,
  dollars,
  episodeSummary,
  gapPoints,
  headerIndex,
  isStrongVolume,
  percentAndPrice,
  percentBase,
  priceAt,
  scoreBenchmark,
  signed,
  signedPercent,
  stateText,
  strongVolume,
  typicalRatio,
  weightRamp,
} from "./chart-model.js";
import { areaScoreNote, scoreCell } from "./vs-spy-model.js";
import {
  israelClock,
  israelLabel,
  israelWallSeconds,
  usSessionDate,
} from "./time.js";
import { readJson } from "./api.js";

// Categorical slots 1–2 of the validated dataviz palette for the lines. Volume
// follows the trading convention: green for an up minute, red for a down one,
// at full strength from 2× typical volume and faded below it. Bands: green =
// held while the benchmark fell (stronger), red = fell while the benchmark
// held (weaker); light fills behind the lines and a darker strip in its own
// pane, so they do not read as volume bars.
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
  band: { strong: "rgba(22, 163, 74, 0.13)", weak: "rgba(220, 38, 38, 0.11)" },
  strip: { strong: "#166534", weak: "#991b1b" },
  // Gap pane: stock minus β×SPY, green above 0, red below; a faint ramp
  // behind it shows how much each minute weighs in the score.
  gap: {
    upLine: "#15803d",
    upFill: ["rgba(22, 163, 74, 0.32)", "rgba(22, 163, 74, 0.06)"],
    downLine: "#b91c1c",
    downFill: ["rgba(220, 38, 38, 0.06)", "rgba(220, 38, 38, 0.32)"],
    zero: "#6b7280",
    ramp: "rgba(20, 43, 41, 0.07)",
  },
  clear: "rgba(0, 0, 0, 0)",
  surface: "#fafbf8",
  text: "#52514e",
  grid: "#e7ece6",
};

// A small "▲▼ vs SPY" tag at the strip's left edge, so the strip does not
// read as a row of volume bars.
function stripTag(text: string): IPanePrimitive<Time> {
  const renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.font = "600 10px Inter, ui-sans-serif, system-ui, sans-serif";
        const width = context.measureText(text).width + 8;
        context.fillStyle = colors.surface;
        context.fillRect(0, 0, width, mediaSize.height);
        context.fillStyle = colors.text;
        context.textBaseline = "middle";
        context.fillText(text, 4, mediaSize.height / 2 + 0.5);
      }),
  };
  const view: IPanePrimitivePaneView = {
    zOrder: () => "top",
    renderer: () => renderer,
  };
  return { paneViews: () => [view] };
}

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
  const reference = percentBase(series);
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
  benchClose: number | null;
  volume: number;
  typical: number | null;
  state: OppositeKind | null;
  score: number | null; // vs SPY, 0–100
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
  className = "",
}: {
  ticker: string;
  alertEnd?: string; // ISO time the alert window closed, if charting an alert
  window?: number; // alert window length in minutes
  date?: string; // US session date when there is no alert
  sector?: string; // the symbol's sector/theme benchmark ETF, if known
  against?: string; // benchmark shown first: "SPY" or `sector`
  className?: string;
}) {
  const alertMs = alertEnd ? Date.parse(alertEnd) : NaN;
  const date = alertEnd ? usSessionDate(alertMs - 60000) : day!;
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{
    chart: IChartApi;
    m: Point[];
    ramp: ISeriesApi<"Area"> | null;
    alertIndex: number;
  } | null>(null);
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
  // Score vs SPY per minute; null when the response has no inputs for it.
  const vs = useMemo(() => (data ? chartScores(data) : null), [data]);
  const showScore = !!main && main.ticker !== scoreBenchmark;

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
    // Tick marks show % only; each line's last-value (and crosshair) label
    // adds the price behind it where the chart is wide enough for both.
    const withPrice = (host.current.clientWidth || 0) >= axisPriceMinWidth;
    const percentFormat = (series: ChartSeries) => {
      const base = percentBase(series);
      return {
        type: "custom" as const,
        formatter: (p: number) =>
          withPrice ? percentAndPrice(p, priceAt(p, base)) : signedPercent(p),
        tickmarksFormatter: (ps: number[]) => ps.map(signedPercent),
        minMove: 0.01,
      };
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
    const tickerLine = chart.addSeries(LineSeries, {
      color: colors.ticker,
      lineWidth: 2,
      priceScaleId: "right",
      priceFormat: percentFormat(main),
      priceLineVisible: false,
      crosshairMarkerRadius: 4,
    });
    tickerLine.setData(m.map((p) => ({ time: p.time, value: p.percent })));
    if (b) {
      const benchLine = chart.addSeries(LineSeries, {
        color: colors.benchmark,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceScaleId: "left",
        priceFormat: percentFormat(bench!),
        priceLineVisible: false,
        crosshairMarkerRadius: 4,
      });
      benchLine.setData(b.map((p) => ({ time: p.time, value: p.percent })));
    }

    // Gap pane under the price pane: gap(t) = stock − β×SPY in % points
    // (the backend's series), a zero line, and the score's weight ramp.
    let nextPane = 1;
    let gapPane = -1;
    let ramp: ISeriesApi<"Area"> | null = null;
    if (vs && vs.gap.some((g) => g !== null)) {
      gapPane = nextPane++;
      ramp = chart.addSeries(
        AreaSeries,
        {
          priceScaleId: "ramp",
          lineVisible: false,
          topColor: colors.gap.ramp,
          bottomColor: colors.gap.ramp,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        },
        gapPane,
      );
      chart
        .priceScale("ramp", gapPane)
        .applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
      const gapSeries = chart.addSeries(
        BaselineSeries,
        {
          baseValue: { type: "price", price: 0 },
          topLineColor: colors.gap.upLine,
          topFillColor1: colors.gap.upFill[0],
          topFillColor2: colors.gap.upFill[1],
          bottomLineColor: colors.gap.downLine,
          bottomFillColor1: colors.gap.downFill[0],
          bottomFillColor2: colors.gap.downFill[1],
          lineWidth: 1,
          priceScaleId: "right",
          priceFormat: {
            type: "custom",
            formatter: gapPoints,
            minMove: 0.01,
          },
          priceLineVisible: false,
          crosshairMarkerRadius: 3,
        },
        gapPane,
      );
      gapSeries.setData(
        m.map((p) => {
          const g = vs.gap[p.index];
          return g === null || g === undefined
            ? { time: p.time }
            : { time: p.time, value: g };
        }),
      );
      gapSeries.createPriceLine({
        price: 0,
        color: colors.gap.zero,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
    }

    // Strip between the price and volume panes: solid opposite-to-benchmark
    // episodes.
    let stripPane = -1;
    if (opp) {
      stripPane = nextPane++;
      const strip = chart.addSeries(
        HistogramSeries,
        {
          priceScaleId: "strip",
          priceLineVisible: false,
          lastValueVisible: false,
          base: 0,
        },
        stripPane,
      );
      chart
        .priceScale("strip", stripPane)
        .applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
      strip.setData(
        m.map((p, i) => ({
          time: p.time,
          value: 1,
          color: kinds[i] ? colors.strip[kinds[i]!] : colors.clear,
        })),
      );
    }
    const volumePane = nextPane;

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
    if (gapPane >= 0) {
      panes[gapPane]?.setStretchFactor(0.9);
      panes[gapPane]?.attachPrimitive(stripTag(`Gap vs β×${scoreBenchmark}`));
    }
    if (opp) {
      panes[stripPane]?.setStretchFactor(0.2);
      panes[stripPane]?.attachPrimitive(stripTag(`▲▼ vs ${bench!.ticker}`));
    }
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
    markers.sort((x, y) => Number(x.time) - Number(y.time));
    if (markers.length) createSeriesMarkers(tickerLine, markers);
    // Applied after the first layout; autoSize would otherwise shift it.
    const frame = requestAnimationFrame(() =>
      applyRange(chart, rangeRef.current, m, alertMs),
    );
    const alertIndex = alertBar?.index ?? -1;
    ramp?.setData(rampData(m, rangeRef.current, alertIndex));
    chartRef.current = { chart, m, ramp, alertIndex };

    const benchByTime = new Map(b?.map((p) => [p.time, p]));
    const readoutAt = (p: Point): Readout => ({
      time: p.instant,
      session: p.session,
      ticker: p.percent,
      close: p.close,
      bench: benchByTime.get(p.time)?.percent ?? null,
      benchClose: benchByTime.get(p.time)?.close ?? null,
      volume: p.volume,
      typical: p.typical,
      state: opp?.states[p.index] ?? null,
      score: vs?.scores[p.index] ?? null,
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
  }, [data, alertMs, window]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    applyRange(c.chart, range, c.m, alertMs);
    c.ramp?.setData(rampData(c.m, range, c.alertIndex));
  }, [range]);

  const shown = readout ?? latest;
  // Header: the area score at the alert minute in "Around alert", else at
  // the latest bar (the same number as the alert's tag and Telegram line).
  const headerAt = main
    ? headerIndex(
        main.bars.length,
        main.bars.findIndex((b) => (b.start + 60) * 1000 === alertMs),
        range === "alert",
      )
    : -1;
  const header = scoreCell(
    vs?.scores[headerAt],
    range === "alert" && alertEnd ? "at the alert" : "at the latest minute",
  );
  const benchName = bench?.ticker ?? benchmark;
  const base = main?.previousClose === null ? "first trade" : "previous close";
  const isToday = date === usSessionDate(Date.now());
  const ratio = shown ? typicalRatio(shown.volume, shown.typical) : null;
  const o = oppositeDefaults;
  return (
    <figure className={`day-chart ${className}`} aria-busy={!data && !error}>
      <div className="chart-controls">
        {data && showScore && (
          <p className="chart-score" title={header.title}>
            vs {scoreBenchmark}{" "}
            <strong className={`score-chip ${header.tone}`} aria-hidden="true">
              {header.text}
            </strong>
            {header.score !== null && (
              <span className="muted" aria-hidden="true">
                {" "}
                / 100
              </span>
            )}
            <span className="sr-only">{header.title}</span>
            {vs?.betaAssumed && <span className="muted"> · β assumed</span>}
          </p>
        )}
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
                <i aria-hidden="true" />▲{" "}
                {episodeSummary(
                  "strong",
                  opp.episodes,
                  main.bars,
                  benchName,
                  isToday,
                )}
              </span>
              <span className="summary weak">
                <i aria-hidden="true" />▼{" "}
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
                  {signedPercent(shown.ticker)}
                </strong>{" "}
                · {dollars(shown.close)}{" "}
                <span className="muted">right axis</span>
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
                      {signedPercent(shown.bench)}
                    </strong>
                    {shown.benchClose !== null &&
                      ` · ${dollars(shown.benchClose)}`}{" "}
                    <span className="muted">left axis</span>
                  </span>
                  <span>
                    Gap{" "}
                    <strong>{signed(shown.ticker - shown.bench)} pts</strong>
                  </span>
                </>
              )}
              {showScore && <ReadoutScore score={shown.score} />}
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
            {main.ticker} right, {benchName} left); the price next to a % is
            that minute&apos;s close.
            {opp && (
              <>
                {" "}
                <span className="legend-swatch strong" aria-hidden="true" />
                Green (▲ stronger): over the last {o.window} minutes {benchName}{" "}
                fell ≥ {Math.abs(o.benchFall)} % points while {main.ticker} held
                or rose.{" "}
                <span className="legend-swatch weak" aria-hidden="true" />
                Red (▼ weaker): {benchName} held or rose (≥ −
                {Math.abs(o.benchHold)} % points) while {main.ticker} fell ≥{" "}
                {o.weakMultiple}× its usual {o.window}-minute move. Light bands
                behind the lines, and the dark strip just above the volume bars,
                mark these minutes. Regular session only; a display aid, not a
                signal.
              </>
            )}{" "}
            {hasTypical
              ? `Volume: solid bars ≥ ${strongVolume}× typical for that minute, faded below; dashed line = typical volume.`
              : "Typical volume is not available for this chart."}{" "}
            {!Number.isNaN(alertMs) && "▼ marks the alert. "}
            {showScore &&
              (vs
                ? `vs ${scoreBenchmark} score 0–100: the ${areaScoreNote} (β ${vs.betaAssumed ? "assumed 1" : vs.beta.toFixed(2)}); green ≥ 60 stronger, red ≤ 40 weaker. Header: ${alertEnd ? "the alert minute in Around alert, else " : ""}the latest minute; readout: the area ending at the pointed minute. Gap pane: ${main.ticker} minus β×${scoreBenchmark} in % points since the session's first bar, green above 0, red below; the faint ramp behind it is each minute's weight. `
                : `vs ${scoreBenchmark} score: not available for this chart. `)}
            Shaded = pre-market. Times in {israelLabel}.
          </p>
        </>
      )}
    </figure>
  );
}

/** Readout "Score N" for the pointed minute, coloured like the tags. */
function ReadoutScore({ score }: { score: number | null }) {
  const c = scoreCell(score, "at this minute");
  return (
    <span title={c.title}>
      Score{" "}
      <strong className={`score-chip ${c.tone}`} aria-hidden="true">
        {c.text}
      </strong>
      <span className="sr-only">{c.title}</span>
    </span>
  );
}

// The weight ramp ends where the header score ends.
function rampData(m: Point[], range: Range, alertIndex: number) {
  const end = headerIndex(m.length, alertIndex, range === "alert");
  const w = weightRamp(
    m.map((p) => ({ start: p.instant / 1000, session: p.session })),
    end,
  );
  return m.map((p, i) =>
    w[i] === null ? { time: p.time } : { time: p.time, value: w[i]! },
  );
}
