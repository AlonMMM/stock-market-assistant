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
  type Logical,
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
import { isDarkNow, useDark } from "./theme.js";

// The trade's chart (docs/tasks/frontend-trade-story.md), on the library the
// regular chart uses, so it zooms and scrolls the same way: the stock with
// SPY beside it, the volume, the bot's strength against SPY, the option and
// its volume, each in a pane; the levels as price lines, the entry and the
// exits as markers. The viewer dragging past the first or last day asks the
// window for more days.

export type ChartView = "trade" | "day" | "all";
export type ChartStyle = "line" | "candles";

const lightColors = {
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
  held: "rgba(47, 75, 143, 0.07)",
  tagText: "#fff", // on the coloured fill labels
  dot: "#fff", // inside a fill's dot on the option
};
// The dark theme's pairs (user 2026-10-27: dark mode for the whole app).
const darkColors: typeof lightColors = {
  surface: "#1f232a",
  text: "#b9bcc1",
  grid: "#2a2f37",
  divider: "#343a43",
  up: "#3fcf7f",
  down: "#ff5c5c",
  upVolume: "rgba(63, 207, 127, 0.3)",
  downVolume: "rgba(255, 92, 92, 0.3)",
  stock: "#8ea8f0",
  option: "#c6c9ce",
  optionVolume: "rgba(198, 201, 206, 0.22)",
  spy: "#7d89a8",
  strength: "#8ea8f0",
  rule: "#3fcf7f",
  otherRule: "#ff5c5c",
  zero: "#343a43",
  level: "#e0a060",
  entry: "#8ea8f0",
  paid: "#8d95a1",
  stop: "#ff5c5c",
  buy: "#3fcf7f",
  sell: "#ff5c5c",
  expired: "#8d95a1",
  signal: "#8ea8f0",
  touch: "#e0a060",
  held: "rgba(142, 168, 240, 0.1)",
  tagText: "#16191f",
  dot: "#1f232a",
};
// Read at each draw; the chart is built again when the theme changes.
const palette = () => (isDarkNow() ? darkColors : lightColors);
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

/** One fill drawn across the panes: when, at what option price, its label. */
interface FillMark {
  time: number; // chart time (the Israel wall clock, read as UTC)
  kind: "buy" | "sell" | "expired";
  price: number | null;
  label: string;
}

/** The chart x of a time, or of the nearest bar when that minute has none. */
function xOf(chart: IChartApi, time: number): number | null {
  const scale = chart.timeScale();
  const exact = scale.timeToCoordinate(time as UTCTimestamp);
  if (exact !== null) return exact;
  const index = scale.timeToIndex(time as UTCTimestamp, true);
  return index === null
    ? null
    : scale.logicalToCoordinate(index as unknown as Logical);
}

/**
 * The trade drawn on every pane at the fills' own minutes (user 2026-10-26:
 * the entry and exit were not shown where they happened): the time held as a
 * shaded band, a line at the buy and at each sale, their labels along the top
 * of the price pane, and on the option pane a dot at each fill's price. Not
 * tied to the option's bars, which a thin contract lacks in many minutes.
 */
function tradeMarks(
  chart: IChartApi,
  fills: () => FillMark[],
  role: "stock" | "option" | "other",
  option: () => ISeriesApi<"Line"> | ISeriesApi<"Candlestick"> | null,
): IPanePrimitive<Time> {
  const band: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        const list = fills();
        const buy = list.find((f) => f.kind === "buy");
        const last = list.filter((f) => f.kind !== "buy").at(-1);
        if (!buy || !last) return;
        const a = xOf(chart, buy.time);
        const b = xOf(chart, last.time);
        if (a === null || b === null) return;
        context.fillStyle = palette().held;
        context.fillRect(
          Math.min(a, b),
          0,
          Math.max(2, Math.abs(b - a)),
          mediaSize.height,
        );
      }),
  };
  const marks: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();
        context.font = "600 11px Inter, ui-sans-serif, system-ui, sans-serif";
        context.textBaseline = "middle";
        let labelRow = 0;
        let lastLabelEnd = -Infinity;
        for (const f of fills()) {
          const x = xOf(chart, f.time);
          if (x === null) continue;
          const color =
            f.kind === "buy"
              ? palette().buy
              : f.kind === "sell"
                ? palette().sell
                : palette().expired;
          const px = Math.round(x) + 0.5;
          context.strokeStyle = color;
          context.globalAlpha = 0.85;
          context.lineWidth = 1.5;
          context.setLineDash([]);
          context.beginPath();
          context.moveTo(px, 0);
          context.lineTo(px, mediaSize.height);
          context.stroke();
          context.globalAlpha = 1;
          if (role === "stock") {
            // A label chip at the top; a second row when two would overlap.
            const text = f.label;
            const w = context.measureText(text).width + 12;
            const left = Math.min(
              Math.max(2, px - w / 2),
              mediaSize.width - w - 2,
            );
            labelRow = left < lastLabelEnd + 4 ? labelRow + 1 : 0;
            lastLabelEnd = left + w;
            const top = 4 + labelRow * 22;
            context.fillStyle = color;
            context.beginPath();
            context.roundRect(left, top, w, 18, 4);
            context.fill();
            context.fillStyle = palette().tagText;
            context.fillText(text, left + 6, top + 9.5);
          }
          if (role === "option" && f.price !== null) {
            const series = option();
            const y = series?.priceToCoordinate(f.price);
            if (y === null || y === undefined) continue;
            context.fillStyle = palette().dot;
            context.strokeStyle = color;
            context.lineWidth = 2.5;
            context.beginPath();
            context.arc(px, y, 5, 0, Math.PI * 2);
            context.fill();
            context.stroke();
            const text = f.price.toFixed(2);
            const w = context.measureText(text).width + 10;
            // A buy's tag to the right of its dot, a sale's to the left,
            // clear of the price lines' titles on the right edge.
            const right = f.kind === "buy";
            const left =
              right && px + 8 + w <= mediaSize.width
                ? px + 8
                : !right && px - 8 - w >= 0
                  ? px - 8 - w
                  : px + 8;
            context.fillStyle = color;
            context.beginPath();
            context.roundRect(left, y - 9, w, 18, 4);
            context.fill();
            context.fillStyle = palette().tagText;
            context.fillText(text, left + 5, y + 0.5);
          }
        }
        context.restore();
      }),
  };
  const views: IPanePrimitivePaneView[] = [
    { zOrder: () => "bottom", renderer: () => band },
    { zOrder: () => "top", renderer: () => marks },
  ];
  return { paneViews: () => views };
}

// Dashed vertical lines where each day after the first starts.
function dayLines(chart: IChartApi, times: () => Time[]): IPanePrimitive<Time> {
  const renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();
        context.strokeStyle = palette().divider;
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
      color: palette().buy,
      text: m.label,
      size: 1.4,
    };
  if (m.kind === "sell")
    return {
      time,
      position: "aboveBar",
      shape: "arrowDown",
      color: palette().sell,
      text: m.label,
      size: 1.4,
    };
  if (m.kind === "expired")
    return {
      time,
      position: "aboveBar",
      shape: "circle",
      color: palette().expired,
      text: m.label,
      size: 1,
    };
  if (m.kind === "touch")
    return {
      time,
      position: "aboveBar",
      shape: "circle",
      color: palette().touch,
      text: m.label,
      size: 1,
    };
  return {
    time,
    position: "belowBar",
    shape: "circle",
    color: palette().signal,
    text: m.label,
    size: 1,
  };
}

const fillClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** "Buy 16:53", "Sell 18:47": the fill's side and Israel time. */
function fillLabel(m: Marker): string {
  const side =
    m.kind === "buy" ? "Buy" : m.kind === "sell" ? "Sell" : "Expired";
  return m.ms > 0 ? `${side} ${fillClock.format(m.ms)}` : side;
}

function lineStyle(kind: LevelLine["kind"]): {
  color: string;
  style: LineStyle;
} {
  if (kind === "entry")
    return { color: palette().entry, style: LineStyle.Dashed };
  if (kind === "level")
    return { color: palette().level, style: LineStyle.Dashed };
  if (kind === "touch")
    return { color: palette().level, style: LineStyle.SparseDotted };
  if (kind === "fallback")
    return { color: palette().level, style: LineStyle.Dotted };
  if (kind === "paid")
    return { color: palette().paid, style: LineStyle.Dashed };
  return { color: palette().stop, style: LineStyle.Dotted };
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
  // Price lines on the line and on the candles alike, as with the markers.
  lines: {
    series: ISeriesApi<"Line"> | ISeriesApi<"Candlestick">;
    line: IPriceLine;
  }[];
  ruleLines: IPriceLine[];
  dayStarts: Time[];
  fills: FillMark[];
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

type ChartProps = Parameters<typeof StoryChart>[0];

/** The chart in the page's theme; a theme change draws it again. */
export function TradeStoryChart(props: ChartProps) {
  const dark = useDark();
  return <StoryChart key={dark ? "dark" : "light"} {...props} />;
}

function StoryChart({
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
        background: { type: ColorType.Solid, color: palette().surface },
        textColor: palette().text,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: palette().divider, enableResize: false },
      },
      grid: {
        vertLines: { color: palette().grid },
        horzLines: { color: palette().grid },
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
      color: palette().stock,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) =>
        withPrices(original, stockPrices),
    });
    p.stockCandles = api.addSeries(CandlestickSeries, {
      upColor: palette().up,
      downColor: palette().down,
      wickUpColor: palette().up,
      wickDownColor: palette().down,
      borderVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) =>
        withPrices(original, stockPrices),
    });
    p.spy = api.addSeries(LineSeries, {
      priceScaleId: "left",
      color: palette().spy,
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
        color: palette().strength,
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
          color: palette().option,
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
          upColor: palette().up,
          downColor: palette().down,
          wickUpColor: palette().up,
          wickDownColor: palette().down,
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
          color: palette().optionVolume,
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
    p.fills = [];
    const optionSeries = () =>
      p.optionCandles?.options().visible
        ? p.optionCandles
        : (p.optionLine ?? null);
    panes.forEach((pane, i) => {
      pane.attachPrimitive(dayLines(api, () => p.dayStarts ?? []));
      pane.attachPrimitive(
        tradeMarks(
          api,
          () => p.fills ?? [],
          i === 0 ? "stock" : i === 3 && hasOption ? "option" : "other",
          optionSeries,
        ),
      );
    });
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
          color: c >= o ? palette().upVolume : palette().downVolume,
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
    for (const { series, line } of p.lines) series.removePriceLine(line);
    p.lines = [];
    p.stockLevels = [];
    p.optionLevels = [];
    // The watched level and its touch and fall-back lines matter when the
    // exit was a failed break; otherwise the level is drawn when in view but
    // does not stretch the price scale, and its two helper lines are left out.
    const failedBreak = story.exits.some((x) => x.title === "Failed break");
    for (const l of levelLines(story)) {
      if (!failedBreak && (l.kind === "touch" || l.kind === "fallback"))
        continue;
      const onStock = l.pane === "stock";
      const targets = onStock
        ? [p.stockLine, p.stockCandles]
        : [p.optionLine, p.optionCandles];
      const { color, style } = lineStyle(l.kind);
      for (const series of targets) {
        if (!series) continue;
        p.lines.push({
          series,
          line: series.createPriceLine({
            price: l.price,
            color,
            lineWidth: 1,
            lineStyle: style,
            axisLabelVisible: true,
            title: l.title,
          }),
        });
      }
      if (onStock) {
        if (l.kind === "entry" || failedBreak) p.stockLevels.push(l.price);
      } else p.optionLevels.push(l.price);
    }
    // The strength pane: zero, and the rule the signal needed (its side
    // marked, the other faint).
    for (const l of p.ruleLines) p.strength.removePriceLine(l);
    p.ruleLines = [
      p.strength.createPriceLine({
        price: 0,
        color: palette().zero,
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
          color: palette().rule,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `rule t ${story.rule}`,
        }),
        p.strength.createPriceLine({
          price: -sign * story.rule,
          color: palette().otherRule,
          lineWidth: 1,
          lineStyle: LineStyle.SparseDotted,
          axisLabelVisible: false,
          title: "",
        }),
      );
    }
    p.fills = story.markers
      .filter(
        (m): m is Marker & { kind: FillMark["kind"] } =>
          m.kind === "buy" || m.kind === "sell" || m.kind === "expired",
      )
      .map((m) => ({
        time: barTime(m.at.date, m.at.minute),
        kind: m.kind,
        price: m.price,
        label: fillLabel(m),
      }));
    const stockMarks = story.markers
      .filter((m) => m.pane === "stock")
      .map(markerShape);
    for (const plugin of p.stockMarkers) plugin.setMarkers(stockMarks);
    for (const plugin of p.optionMarkers) plugin.setMarkers([]);
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
          Math.max(0, entry.minute - 30),
        ) as UTCTimestamp,
        to: barTime(
          end.date,
          Math.min(
            end.minutes - 1,
            (end.date === exit.date ? exit.minute : 0) + 60,
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
      for (const plugin of p.stockMarkers) plugin.setMarkers(stockMarks);
    };
    p.chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    onRange();
    return () =>
      p.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
  }, [story, ready]);

  return <div className="ts-chart" ref={host} />;
}
