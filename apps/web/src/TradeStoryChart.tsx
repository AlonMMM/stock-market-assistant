import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type AutoscaleInfo,
  type IChartApi,
  type IPanePrimitive,
  type IPanePrimitivePaneView,
  type IPriceLine,
  type IPrimitivePaneRenderer,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { TradeChart as TradeChartData } from "../../../packages/market-data/src/trade-chart.js";
import {
  barTime,
  levelLines,
  type LevelLine,
  type Marker,
  type Story,
} from "./trade-story-model.js";

// The trade's chart (docs/tasks/frontend-trade-story.md), on the library the
// regular chart uses, so it zooms and scrolls the same way: the stock with
// SPY beside it, the volume, the bot's strength against SPY, the option and
// its volume, each in a pane; the levels as price lines, the entry and the
// exits as markers. The viewer dragging past the first or last day asks the
// window for more days.

export type ChartView = "trade" | "day" | "all";
export type ChartStyle = "line" | "candles";

const colors = {
  surface: "#fafbf8",
  text: "#52514e",
  grid: "#e7ece6",
  divider: "#cdd7ce",
  up: "#16a34a",
  down: "#dc2626",
  upVolume: "rgba(22, 163, 74, 0.3)",
  downVolume: "rgba(220, 38, 38, 0.3)",
  stock: "#2f4b8f",
  option: "#3b4a46",
  optionVolume: "rgba(59, 74, 70, 0.28)",
  spy: "#8a97b8",
  strength: "#2f4b8f",
  rule: "#0e7a43",
  otherRule: "#c0322b",
  zero: "#cdd7ce",
  level: "#b5651d",
  entry: "#2f4b8f",
  paid: "#6b7a76",
  stop: "#c0322b",
  buy: "#0e7a43",
  sell: "#c0322b",
  expired: "#6b7a76",
  signal: "#2f4b8f",
  touch: "#b5651d",
};
// Marker labels are drawn when the bars are at least this far apart.
const labelSpacing = 5.5;
// Dragging this far past the first or last bar asks for more days.
const edgeBars = 3;

const crosshairDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const crosshairClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** "Tue 30 Sep · 17:03" from a chart time (the Israel wall clock, read as UTC). */
export const chartClock = (seconds: number): string =>
  `${crosshairDay.format(seconds * 1000)} · ${crosshairClock.format(seconds * 1000)}`;

// Dashed vertical lines where each day after the first starts.
function dayLines(chart: IChartApi, times: () => Time[]): IPanePrimitive<Time> {
  const renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();
        context.strokeStyle = colors.divider;
        context.setLineDash([4, 4]);
        context.lineWidth = 1;
        for (const t of times()) {
          const x = chart.timeScale().timeToCoordinate(t);
          if (x === null) continue;
          context.beginPath();
          context.moveTo(Math.round(x) + 0.5, 0);
          context.lineTo(Math.round(x) + 0.5, mediaSize.height);
          context.stroke();
        }
        context.restore();
      }),
  };
  const view: IPanePrimitivePaneView = {
    zOrder: () => "bottom",
    renderer: () => renderer,
  };
  return { paneViews: () => [view] };
}

/** The pane's own range, widened to keep the given prices in view. */
function withPrices(
  original: () => AutoscaleInfo | null,
  prices: () => number[],
): AutoscaleInfo | null {
  const base = original();
  const extra = prices();
  if (!base?.priceRange || extra.length === 0) return base;
  return {
    ...base,
    priceRange: {
      minValue: Math.min(base.priceRange.minValue, ...extra),
      maxValue: Math.max(base.priceRange.maxValue, ...extra),
    },
  };
}

function markerShape(m: Marker): SeriesMarker<Time> {
  const time = barTime(m.at.date, m.at.minute) as UTCTimestamp;
  if (m.kind === "buy")
    return {
      time,
      position: "belowBar",
      shape: "arrowUp",
      color: colors.buy,
      text: m.label,
      size: 1.4,
    };
  if (m.kind === "sell")
    return {
      time,
      position: "aboveBar",
      shape: "arrowDown",
      color: colors.sell,
      text: m.label,
      size: 1.4,
    };
  if (m.kind === "expired")
    return {
      time,
      position: "aboveBar",
      shape: "circle",
      color: colors.expired,
      text: m.label,
      size: 1,
    };
  if (m.kind === "touch")
    return {
      time,
      position: "aboveBar",
      shape: "circle",
      color: colors.touch,
      text: m.label,
      size: 1,
    };
  return {
    time,
    position: "belowBar",
    shape: "circle",
    color: colors.signal,
    text: m.label,
    size: 1,
  };
}

function lineStyle(kind: LevelLine["kind"]): {
  color: string;
  style: LineStyle;
} {
  if (kind === "entry") return { color: colors.entry, style: LineStyle.Dashed };
  if (kind === "level") return { color: colors.level, style: LineStyle.Dashed };
  if (kind === "touch")
    return { color: colors.level, style: LineStyle.SparseDotted };
  if (kind === "fallback")
    return { color: colors.level, style: LineStyle.Dotted };
  if (kind === "paid") return { color: colors.paid, style: LineStyle.Dashed };
  return { color: colors.stop, style: LineStyle.Dotted };
}

interface Parts {
  chart: IChartApi;
  stockLine: ISeriesApi<"Line">;
  stockCandles: ISeriesApi<"Candlestick">;
  spy: ISeriesApi<"Line">;
  volume: ISeriesApi<"Histogram">;
  strength: ISeriesApi<"Line">;
  optionLine: ISeriesApi<"Line"> | null;
  optionCandles: ISeriesApi<"Candlestick"> | null;
  optionVolume: ISeriesApi<"Histogram"> | null;
  // Markers on the line and on the candles alike: only the visible one shows them.
  stockMarkers: ISeriesMarkersPluginApi<Time>[];
  optionMarkers: ISeriesMarkersPluginApi<Time>[];
  lines: IPriceLine[];
  ruleLines: IPriceLine[];
  dayStarts: Time[];
  stockLevels: number[];
  optionLevels: number[];
  rvol: Map<number, number>;
  optionAt: { time: number; value: number }[]; // the option's closes, by time
}

/** The last value at or before `time`, from a list sorted by time. */
export function valueAtOrBefore(
  rows: { time: number; value: number }[],
  time: number,
): number | null {
  let lo = 0;
  let hi = rows.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.time <= time) {
      found = rows[mid]!.value;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export interface Hover {
  time: number;
  stock: number | null;
  spy: number | null;
  t: number | null;
  rvol: number | null;
  option: number | null;
  volume: number | null;
}

export function TradeStoryChart({
  chart,
  story,
  view,
  viewKey,
  style,
  onEdge,
  onHover,
}: {
  chart: TradeChartData;
  story: Story;
  view: ChartView;
  viewKey: number; // changes when a view is chosen again, to apply it again
  style: ChartStyle;
  onEdge: (side: "before" | "after") => void;
  onHover: (h: Hover | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const parts = useRef<Parts | null>(null);
  const moved = useRef(false);
  const [ready, setReady] = useState(0);
  const onEdgeRef = useRef(onEdge);
  onEdgeRef.current = onEdge;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const hasOption = chart.option;

  // The chart: created once, with every series; the data effect fills them.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const api = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.surface },
        textColor: colors.text,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: colors.divider, enableResize: false },
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      // SPY's axis only where there is room for it; on a phone its line and
      // its last value are enough.
      leftPriceScale: { borderVisible: false, visible: el.clientWidth >= 600 },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        minBarSpacing: 0.3,
      },
      handleScroll: { vertTouchDrag: false },
      // Times are already on the Israel wall clock; read them as UTC.
      localization: {
        locale: "en-GB",
        timeFormatter: (t: Time) => chartClock(t as number),
      },
    });
    const p: Partial<Parts> = { chart: api };
    const stockPrices = () => p.stockLevels ?? [];
    const optionPrices = () => p.optionLevels ?? [];
    p.stockLine = api.addSeries(LineSeries, {
      color: colors.stock,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) =>
        withPrices(original, stockPrices),
    });
    p.stockCandles = api.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) =>
        withPrices(original, stockPrices),
    });
    p.spy = api.addSeries(LineSeries, {
      priceScaleId: "left",
      color: colors.spy,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: "SPY",
    });
    p.volume = api.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1,
    );
    p.strength = api.addSeries(
      LineSeries,
      {
        color: colors.strength,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: "price", precision: 1, minMove: 0.1 },
      },
      2,
    );
    if (hasOption) {
      p.optionLine = api.addSeries(
        LineSeries,
        {
          color: colors.option,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
          autoscaleInfoProvider: (original: () => AutoscaleInfo | null) =>
            withPrices(original, optionPrices),
        },
        3,
      );
      p.optionCandles = api.addSeries(
        CandlestickSeries,
        {
          upColor: colors.up,
          downColor: colors.down,
          wickUpColor: colors.up,
          wickDownColor: colors.down,
          borderVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
          visible: false,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
          autoscaleInfoProvider: (original: () => AutoscaleInfo | null) =>
            withPrices(original, optionPrices),
        },
        3,
      );
      p.optionVolume = api.addSeries(
        HistogramSeries,
        {
          color: colors.optionVolume,
          priceFormat: { type: "volume" },
          priceLineVisible: false,
          lastValueVisible: false,
        },
        4,
      );
    } else {
      p.optionLine = null;
      p.optionCandles = null;
      p.optionVolume = null;
    }
    const panes = api.panes();
    const stretch = hasOption ? [5, 1.1, 1.7, 3.4, 1] : [6, 1.2, 1.8];
    panes.forEach((pane, i) => pane.setStretchFactor(stretch[i] ?? 1));
    api
      .priceScale("right")
      .applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
    api
      .priceScale("left")
      .applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
    panes[1]
      ?.priceScale("right")
      .applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
    panes[2]
      ?.priceScale("right")
      .applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });
    panes[3]
      ?.priceScale("right")
      .applyOptions({ scaleMargins: { top: 0.12, bottom: 0.1 } });
    panes[4]
      ?.priceScale("right")
      .applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
    p.dayStarts = [];
    for (const pane of panes)
      pane.attachPrimitive(dayLines(api, () => p.dayStarts ?? []));
    p.stockMarkers = [
      createSeriesMarkers(p.stockLine, []),
      createSeriesMarkers(p.stockCandles, []),
    ];
    p.optionMarkers =
      p.optionLine && p.optionCandles
        ? [
            createSeriesMarkers(p.optionLine, []),
            createSeriesMarkers(p.optionCandles, []),
          ]
        : [];
    p.lines = [];
    p.ruleLines = [];
    p.stockLevels = [];
    p.optionLevels = [];
    p.rvol = new Map();
    p.optionAt = [];
    const full = p as Parts;
    parts.current = full;

    const onMove = (param: MouseEventParams<Time>) => {
      const t = param.time as number | undefined;
      if (t === undefined || !param.point) {
        onHoverRef.current(null);
        return;
      }
      const value = (s: ISeriesApi<"Line"> | ISeriesApi<"Histogram">) => {
        const d = param.seriesData.get(s) as { value?: number } | undefined;
        return d?.value ?? null;
      };
      const candle = (
        line: ISeriesApi<"Line">,
        candles: ISeriesApi<"Candlestick">,
      ) => {
        const c = param.seriesData.get(candles) as
          { close?: number } | undefined;
        return c?.close ?? value(line);
      };
      onHoverRef.current({
        time: t,
        stock: candle(full.stockLine, full.stockCandles),
        spy: value(full.spy),
        t: value(full.strength),
        rvol: full.rvol.get(t) ?? null,
        option: full.optionLine ? valueAtOrBefore(full.optionAt, t) : null,
        volume: value(full.volume),
      });
    };
    const onRange = (range: LogicalRange | null) => {
      if (!range || !moved.current) return;
      const count = full.stockLine.data().length;
      if (range.from < -edgeBars) onEdgeRef.current("before");
      else if (range.to > count - 1 + edgeBars) onEdgeRef.current("after");
    };
    const onUse = () => (moved.current = true);
    for (const type of ["pointerdown", "wheel", "touchstart"])
      el.addEventListener(type, onUse, { passive: true });
    api.subscribeCrosshairMove(onMove);
    api.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    setReady((n) => n + 1);
    return () => {
      api.unsubscribeCrosshairMove(onMove);
      api.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      for (const type of ["pointerdown", "wheel", "touchstart"])
        el.removeEventListener(type, onUse);
      parts.current = null;
      api.remove();
    };
  }, [hasOption]);

  // The data and the story's lines and markers; the view stays where it was.
  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    const keep = p.chart.timeScale().getVisibleRange();
    const time = (date: string, m: number) => barTime(date, m) as UTCTimestamp;
    const lines: { time: UTCTimestamp; value: number }[] = [];
    const candles: {
      time: UTCTimestamp;
      open: number;
      high: number;
      low: number;
      close: number;
    }[] = [];
    const volume: { time: UTCTimestamp; value: number; color: string }[] = [];
    const spy: { time: UTCTimestamp; value: number }[] = [];
    const strength: { time: UTCTimestamp; value: number }[] = [];
    const optionLines: { time: UTCTimestamp; value: number }[] = [];
    const optionCandles: typeof candles = [];
    const optionVolume: { time: UTCTimestamp; value: number }[] = [];
    p.rvol = new Map();
    p.dayStarts = [];
    chart.sessions.forEach((s, i) => {
      if (i > 0) p.dayStarts.push(time(s.date, 0));
      for (const [m, o, h, l, c, v] of s.stock) {
        const t = time(s.date, m);
        lines.push({ time: t, value: c });
        candles.push({ time: t, open: o, high: h, low: l, close: c });
        volume.push({
          time: t,
          value: v,
          color: c >= o ? colors.upVolume : colors.downVolume,
        });
      }
      for (const [m, c] of s.spy) spy.push({ time: time(s.date, m), value: c });
      for (const [m, t, rvol] of s.strength) {
        const at = time(s.date, m);
        strength.push({ time: at, value: t });
        p.rvol.set(at, rvol);
      }
      for (const [m, o, h, l, c, v] of s.option) {
        const t = time(s.date, m);
        optionLines.push({ time: t, value: c });
        optionCandles.push({ time: t, open: o, high: h, low: l, close: c });
        optionVolume.push({ time: t, value: v });
      }
    });
    p.stockLine.setData(lines);
    p.stockCandles.setData(candles);
    p.volume.setData(volume);
    p.spy.setData(spy);
    p.strength.setData(strength);
    p.optionLine?.setData(optionLines);
    p.optionAt = optionLines;
    p.optionCandles?.setData(optionCandles);
    p.optionVolume?.setData(optionVolume);

    // The lines: the entry, the level and its touch and fall-back lines on
    // the stock; paid and the stop on the option.
    for (const l of p.lines) {
      p.stockLine.removePriceLine(l);
      p.optionLine?.removePriceLine(l);
    }
    p.lines = [];
    p.stockLevels = [];
    p.optionLevels = [];
    for (const l of levelLines(story)) {
      const series = l.pane === "stock" ? p.stockLine : p.optionLine;
      if (!series) continue;
      const { color, style } = lineStyle(l.kind);
      p.lines.push(
        series.createPriceLine({
          price: l.price,
          color,
          lineWidth: 1,
          lineStyle: style,
          axisLabelVisible: true,
          title: l.title,
        }),
      );
      if (l.pane === "stock") p.stockLevels.push(l.price);
      else p.optionLevels.push(l.price);
    }
    // The strength pane: zero, and the rule the signal needed (its side
    // marked, the other faint).
    for (const l of p.ruleLines) p.strength.removePriceLine(l);
    p.ruleLines = [
      p.strength.createPriceLine({
        price: 0,
        color: colors.zero,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: false,
        title: "",
      }),
    ];
    if (story.rule !== null) {
      const sign = story.right === "P" ? -1 : 1;
      p.ruleLines.push(
        p.strength.createPriceLine({
          price: sign * story.rule,
          color: colors.rule,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `rule t ${story.rule}`,
        }),
        p.strength.createPriceLine({
          price: -sign * story.rule,
          color: colors.otherRule,
          lineWidth: 1,
          lineStyle: LineStyle.SparseDotted,
          axisLabelVisible: false,
          title: "",
        }),
      );
    }
    const stockMarks = story.markers
      .filter((m) => m.pane === "stock")
      .map(markerShape);
    const optionMarks = story.markers
      .filter((m) => m.pane === "option")
      .map(markerShape);
    for (const plugin of p.stockMarkers) plugin.setMarkers(stockMarks);
    for (const plugin of p.optionMarkers) plugin.setMarkers(optionMarks);
    if (keep) p.chart.timeScale().setVisibleRange(keep);
  }, [chart, story, ready]);

  // Line or candles.
  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    const candles = style === "candles";
    p.stockLine.applyOptions({ visible: !candles });
    p.stockCandles.applyOptions({ visible: candles });
    p.optionLine?.applyOptions({ visible: !candles });
    p.optionCandles?.applyOptions({ visible: candles });
  }, [style, ready]);

  // The view: the trade's own minutes, its days, or every day drawn.
  useEffect(() => {
    const p = parts.current;
    if (!p || chart.sessions.length === 0) return;
    const scale = p.chart.timeScale();
    const first = chart.sessions[0]!;
    const last = chart.sessions.at(-1)!;
    const fills = story.markers.filter(
      (m) => m.kind === "buy" || m.kind === "sell" || m.kind === "expired",
    );
    const entry = fills[0]?.at;
    const exit = fills.at(-1)?.at;
    const session = (date: string) =>
      chart.sessions.find((s) => s.date === date);
    if (view === "trade" && entry && exit && session(entry.date)) {
      const end = session(exit.date) ?? last;
      scale.setVisibleRange({
        from: barTime(
          entry.date,
          Math.max(0, entry.minute - 20),
        ) as UTCTimestamp,
        to: barTime(
          end.date,
          Math.min(
            end.minutes - 1,
            (end.date === exit.date ? exit.minute : 0) + 40,
          ),
        ) as UTCTimestamp,
      });
    } else if (view === "day" && entry && exit && session(entry.date)) {
      const end = session(exit.date) ?? last;
      scale.setVisibleRange({
        from: barTime(entry.date, 0) as UTCTimestamp,
        to: barTime(end.date, end.minutes - 1) as UTCTimestamp,
      });
    } else
      scale.setVisibleRange({
        from: barTime(first.date, 0) as UTCTimestamp,
        to: barTime(last.date, last.minutes - 1) as UTCTimestamp,
      });
    // Choosing a view is not a drag: more days are not asked for.
    moved.current = false;
  }, [view, viewKey, ready, chart.option]);

  // Marker labels only when the bars are far enough apart to read them.
  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    let labelled: boolean | null = null;
    const onRange = () => {
      const wide = p.chart.timeScale().options().barSpacing >= labelSpacing;
      if (wide === labelled) return;
      labelled = wide;
      const strip = (m: SeriesMarker<Time>): SeriesMarker<Time> =>
        wide ? m : { ...m, text: undefined };
      const stockMarks = story.markers
        .filter((m) => m.pane === "stock")
        .map((m) => strip(markerShape(m)));
      const optionMarks = story.markers
        .filter((m) => m.pane === "option")
        .map((m) => strip(markerShape(m)));
      for (const plugin of p.stockMarkers) plugin.setMarkers(stockMarks);
      for (const plugin of p.optionMarkers) plugin.setMarkers(optionMarks);
    };
    p.chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    onRange();
    return () =>
      p.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
  }, [story, ready]);

  return <div className="ts-chart" ref={host} />;
}
