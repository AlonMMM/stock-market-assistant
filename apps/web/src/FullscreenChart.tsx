import { useEffect, useMemo, useRef, useState } from "react";
import { barSlot, chartTrading, withLiveRows } from "./chart-live.js";
import { useLatestPrices, useRunningBar } from "./live-prices.js";
import { createPortal } from "react-dom";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPanePrimitive,
  type IPanePrimitivePaneView,
  type IPrimitivePaneRenderer,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartBars } from "../../../packages/market-data/src/chart-bars.js";
import type { DayChart as DayChartData } from "../../../packages/market-data/src/day-chart.js";
import { previousSessions } from "../../../packages/market-data/src/calendar.js";
import { readJson } from "./api.js";
import { chartScores, endMinute, scoreAt } from "./chart-model.js";
import {
  alertBars,
  barOrder,
  barsUrl,
  chartTime,
  compactVolume,
  legendLine,
  mergeRows,
  ordinal,
  rangeText,
  sessionStarts,
  signedChange,
  volumeChip,
  vwapLine,
  type BarSize,
  type ChartBarsRow,
} from "./fullscreen-model.js";
import { sipDelayText } from "./live-model.js";
import { israelClock, israelLabel, usSessionDate } from "./time.js";
import { scoreCell } from "./vs-spy-model.js";

// The full-screen chart (docs/features/fullscreen-chart.md): the stock on the
// right price axis and its benchmark on the left, each in dollars, on a dark
// terminal-style chart, with bar sizes from 1m to 1D, an optional session
// VWAP, and volume against the last 20 sessions. One dark look in both
// themes, so the colours are fixed here rather than taken from the page.
const colors = {
  bg: "#0b0d0d",
  text: "#e3e8e6",
  muted: "#8d9996",
  grid: "rgba(255, 255, 255, 0.10)",
  line: "#2c3533",
  stock: "#3ddc5a",
  bench: "#f4f4f4",
  vwap: "#f5b82e",
  up: "#22c55e",
  down: "#ef4444",
  band: "rgba(255, 255, 255, 0.08)",
  crosshair: "#5f6a68",
  average: "rgba(227, 232, 230, 0.8)",
};
// Today's bars are read again this often while the chart is open.
// Bars are read again every 15 s; the latest trade moves the forming bar
// every second in between.
const refreshMs = 15000;

export interface FullscreenChartProps {
  ticker: string;
  date: string; // US session date the row shows; today's keeps refreshing
  sector?: string | undefined; // sector benchmark ETF, if the symbol has one
  alertEnd?: string | undefined; // ISO end of the alert window, from an alert row
  window?: number | undefined; // alert window in minutes
  onClose?: () => void;
  // Drawn in the page instead of over it (user 2026-10-19: the one chart
  // wherever a day chart was), with a button to open it full screen.
  inline?: boolean;
  onExpand?: () => void;
}

type Kind = "spy" | "candles";

// Dashed vertical lines at the given times: where each session (or month) starts.
function sessionLines(
  chart: IChartApi,
  times: () => Time[],
): IPanePrimitive<Time> {
  const renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();
        context.strokeStyle = colors.muted;
        context.globalAlpha = 0.7;
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
// "Fri 16 Oct · 21:01"; a daily bar (midnight) shows only its day.
function crosshairTime(seconds: number): string {
  const day = crosshairDay.format(seconds * 1000);
  return seconds % 86400 === 0
    ? day
    : `${day} · ${crosshairClock.format(seconds * 1000)}`;
}

interface Parts {
  chart: IChartApi;
  band: ISeriesApi<"Histogram">;
  candles: ISeriesApi<"Candlestick">;
  stock: ISeriesApi<"Line">;
  bench: ISeriesApi<"Line">;
  vwap: ISeriesApi<"Line">;
  volume: ISeriesApi<"Histogram">;
  average: ISeriesApi<"Line">;
  starts: Time[];
}

export function FullscreenChart({
  ticker,
  date,
  sector,
  alertEnd,
  window: alertWindow = 0,
  onClose = () => {},
  inline = false,
  onExpand,
}: FullscreenChartProps) {
  const hasSector = !!sector && sector !== ticker && sector !== "SPY";
  const [bar, setBar] = useState<BarSize>("1m");
  const [kind, setKind] = useState<Kind>("spy");
  const [against, setAgainst] = useState("SPY");
  const [showVwap, setShowVwap] = useState(false);
  const [data, setData] = useState<ChartBars | null>(null);
  // Rows with the bar size they were read for: after a switch, the old rows
  // are not drawn on the new time axis.
  const [view, setView] = useState<{ bar: BarSize; rows: ChartBarsRow[] }>({
    bar: "1m",
    rows: [],
  });
  // Older bars load only after the viewer drags or zooms the chart.
  const moved = useRef(false);
  const [error, setError] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const parts = useRef<Parts | null>(null);
  const fitted = useRef(false);
  const older = useRef<{ loading: boolean; done: boolean; first: string }>({
    loading: false,
    done: false,
    first: "",
  });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const live = date === usSessionDate(Date.now());
  const daily = bar === "1D";
  // The latest trades, every second, as the forming bar (chart-live.ts).
  const benchSymbol = hasSector ? against : "SPY";
  const latest = useLatestPrices(live ? [ticker, benchSymbol] : [], () =>
    chartTrading(date),
  );
  const slot = (at: number) => barSlot(view.bar, at);
  const stockRun = useRunningBar(
    latest.prices[ticker],
    slot,
    `${ticker}/${date}/${view.bar}`,
  );
  const benchRun = useRunningBar(
    latest.prices[benchSymbol],
    slot,
    `${benchSymbol}/${date}/${view.bar}`,
  );
  const liveRows = useMemo(
    () =>
      live
        ? withLiveRows(
            view.rows,
            view.bar,
            stockRun,
            data?.against ? benchRun : null,
          )
        : view.rows,
    [view, live, stockRun, benchRun, data?.against],
  );
  const rows = liveRows;

  // Open as a layer over the page: no page scroll, focus inside, Esc and Back close.
  useEffect(() => {
    if (inline) return;
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    history.pushState({ smaFullscreen: true }, "");
    const onPop = () => onCloseRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
      if (e.key !== "Tab" || !dialog.current) return;
      const items = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button:not([disabled])",
        ),
      ];
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    addEventListener("popstate", onPop);
    // Capture: the layer stops key events from reaching rows behind it.
    document.addEventListener("keydown", onKey, true);
    return () => {
      removeEventListener("popstate", onPop);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      before?.focus();
    };
  }, []);
  // ✕ and Esc go back one step, so the history entry added on open goes too.
  function requestClose() {
    if ((history.state as { smaFullscreen?: boolean } | null)?.smaFullscreen)
      history.back();
    else onCloseRef.current();
  }

  // The score chip: today's vs SPY score from the day chart, read once.
  useEffect(() => {
    let on = true;
    fetch("/api/day-chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, date, benchmark: "SPY" }),
      signal: AbortSignal.timeout(60000),
    })
      .then((r) => readJson<DayChartData>(r))
      .then((d) => {
        const main = d.series[0];
        const vs = chartScores(d);
        if (on && main && vs)
          setScore(scoreAt(vs, endMinute(main.bars, undefined, 0, false)));
      })
      .catch(() => {}); // the chip is left out
    return () => {
      on = false;
    };
  }, [ticker, date]);

  // Bars for the chosen size and benchmark; today's are read again.
  const benchmark = hasSector ? against : "SPY";
  useEffect(() => {
    let on = true;
    setData(null);
    setView({ bar, rows: [] });
    moved.current = false;
    setError("");
    setHover(null);
    fitted.current = false;
    older.current = { loading: false, done: false, first: "" };
    const url = barsUrl(ticker, benchmark, bar, live ? undefined : date);
    const read = async (first: boolean) => {
      if (!first && document.visibilityState !== "visible") return;
      try {
        const next = await readJson<ChartBars>(
          await fetch(url, { signal: AbortSignal.timeout(30000) }),
        );
        if (!on) return;
        setData(next);
        setView((old) => ({
          bar,
          rows: first ? next.rows : mergeRows(old.rows, next.rows),
        }));
        if (first) older.current.first = next.sessions[0] ?? "";
        setError("");
      } catch (e) {
        if (on && first)
          setError(
            e instanceof Error
              ? e.name === "TimeoutError"
                ? "The chart took too long."
                : e.message
              : "No chart data",
          );
      }
    };
    void read(true);
    const timer = live ? setInterval(() => void read(false), refreshMs) : 0;
    return () => {
      on = false;
      clearInterval(timer);
    };
  }, [ticker, benchmark, bar, date, live]);

  // Dragging to the oldest bars reads the sessions before them.
  async function loadOlder() {
    const o = older.current;
    if (o.loading || o.done || !o.first) return;
    let end: string;
    try {
      end = previousSessions(o.first, 1)[0]!;
    } catch {
      o.done = true; // before the calendar's first year
      return;
    }
    o.loading = true;
    const requested = { bar, benchmark };
    try {
      const page = await readJson<ChartBars>(
        await fetch(barsUrl(ticker, benchmark, bar, end), {
          signal: AbortSignal.timeout(30000),
        }),
      );
      if (
        requested.bar !== barRef.current ||
        requested.benchmark !== benchRef.current
      )
        return;
      if (page.rows.length === 0) o.done = true;
      else {
        o.first = page.sessions[0] ?? o.first;
        setView((old) => ({ bar, rows: mergeRows(page.rows, old.rows) }));
      }
    } catch {
      o.done = true; // keep what is shown
    } finally {
      o.loading = false;
    }
  }
  const barRef = useRef(bar);
  barRef.current = bar;
  const benchRef = useRef(benchmark);
  benchRef.current = benchmark;
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  // The chart: created once, with every series; the data effect fills them.
  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.bg },
        textColor: colors.text,
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: 12,
        attributionLogo: false,
        panes: { separatorColor: colors.muted, enableResize: false },
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: colors.grid, style: LineStyle.Dashed },
      },
      rightPriceScale: { borderColor: colors.line },
      leftPriceScale: { borderColor: colors.line, visible: true },
      timeScale: {
        borderColor: colors.line,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        minBarSpacing: 0.05,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: colors.text,
          labelBackgroundColor: colors.crosshair,
        },
        horzLine: {
          color: colors.text,
          labelBackgroundColor: colors.crosshair,
        },
      },
      handleScroll: { vertTouchDrag: false },
      // Times are already on the Israel wall clock; read them as UTC.
      localization: {
        locale: "en-GB",
        timeFormatter: (t: Time) => crosshairTime(t as number),
      },
    });
    // The alert window, on its own hidden full-height scale.
    const band = chart.addSeries(HistogramSeries, {
      priceScaleId: "band",
      color: colors.band,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("band").applyOptions({
      visible: false,
      scaleMargins: { top: 0, bottom: 0 },
    });
    const bench = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      color: colors.bench,
      lineWidth: 1,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
      priceLineVisible: false,
    });
    const stock = chart.addSeries(LineSeries, {
      color: colors.stock,
      lineWidth: 2,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    const vwap = chart.addSeries(LineSeries, {
      color: colors.vwap,
      lineWidth: 2,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1,
    );
    const average = chart.addSeries(
      LineSeries,
      {
        color: colors.average,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      1,
    );
    const p: Parts = {
      chart,
      band,
      candles,
      stock,
      bench,
      vwap,
      volume,
      average,
      starts: [],
    };
    const panes = chart.panes();
    panes[0]?.setStretchFactor(4);
    panes[1]?.setStretchFactor(1);
    for (const pane of panes)
      pane.attachPrimitive(sessionLines(chart, () => p.starts));
    const onMove = (param: MouseEventParams<Time>) => {
      const i = param.logical;
      setHover(param.point && i !== undefined && i >= 0 ? Math.round(i) : null);
    };
    const onRange = (range: LogicalRange | null) => {
      // Only a drag past the first bar: fitting the view starts at bar 0.
      if (range && range.from < -3 && moved.current)
        void loadOlderRef.current();
    };
    const onUse = () => (moved.current = true);
    for (const type of ["pointerdown", "wheel", "touchstart"])
      host.current.addEventListener(type, onUse, { passive: true });
    chart.subscribeCrosshairMove(onMove);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    parts.current = p;
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      parts.current = null;
      chart.remove();
    };
  }, []);

  // Fill the series; keep the view where the viewer left it.
  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    const spy = kind === "spy";
    const bar = view.bar;
    const daily = bar === "1D";
    const rows = view.bar === barRef.current ? liveRows : [];
    const time = (r: ChartBarsRow) => chartTime(r, bar) as UTCTimestamp;
    const band = new Set(alertBars(rows, bar, alertEnd, alertWindow));
    const range = p.chart.timeScale().getVisibleLogicalRange();
    const firstBefore = p.stock.data()[0]?.time;
    const lastBefore = p.stock.data().at(-1)?.time;
    const countBefore = p.stock.data().length;
    p.chart.applyOptions({
      leftPriceScale: { visible: spy },
      timeScale: { timeVisible: !daily },
    });
    p.band.setData(
      rows.map((r, i) =>
        band.has(i) ? { time: time(r), value: 1 } : { time: time(r) },
      ),
    );
    p.candles.applyOptions({ visible: !spy });
    p.candles.setData(
      rows.map((r) => ({
        time: time(r),
        open: r.stock.open,
        high: r.stock.high,
        low: r.stock.low,
        close: r.stock.close,
      })),
    );
    p.stock.applyOptions({ visible: spy });
    p.stock.setData(rows.map((r) => ({ time: time(r), value: r.stock.close })));
    p.bench.applyOptions({ visible: spy && !!data?.against });
    p.bench.setData(
      rows.map((r) =>
        r.against
          ? { time: time(r), value: r.against.close }
          : { time: time(r) },
      ),
    );
    p.vwap.applyOptions({ visible: showVwap && !daily });
    p.vwap.setData(
      rows.map((r) =>
        r.vwap === null ? { time: time(r) } : { time: time(r), value: r.vwap },
      ),
    );
    p.volume.setData(
      rows.map((r) => ({
        time: time(r),
        value: r.stock.volume,
        color: r.stock.close >= r.stock.open ? colors.up : colors.down,
      })),
    );
    p.average.setData(
      rows.map((r) =>
        r.averageVolume === null
          ? { time: time(r) }
          : { time: time(r), value: r.averageVolume },
      ),
    );
    p.starts = sessionStarts(rows, bar).map((i) => time(rows[i]!));
    if (rows.length === 0) return;
    if (!fitted.current) {
      p.chart.timeScale().fitContent();
      fitted.current = true;
    } else if (range && firstBefore !== undefined) {
      // Older bars were added in front: move the view by as many bars.
      const added = rows.findIndex((r) => time(r) === firstBefore);
      if (added > 0)
        p.chart.timeScale().setVisibleLogicalRange({
          from: range.from + added,
          to: range.to + added,
        });
      // A new bar at the end (the forming one): follow it when the newest
      // bars were in view.
      const newer =
        rows.length - 1 - rows.findIndex((r) => time(r) === lastBefore);
      if (
        added <= 0 &&
        newer > 0 &&
        newer < rows.length &&
        range.to >= countBefore - 1.5
      )
        p.chart.timeScale().scrollToRealTime();
    }
  }, [view, liveRows, kind, showVwap, data?.against]);

  const last = rows.at(-1);
  const shown = hover !== null && rows[hover] ? rows[hover]! : last;
  const change = last
    ? signedChange(last.stock.close, last.previousClose)
    : null;
  const chip = volumeChip(data?.today ?? null, (s) => israelClock(s * 1000));
  const scoreChip = scoreCell(score, "at the latest regular-session minute");
  const benchName = data?.against ?? null;
  const vsWhat = daily ? "vs prev. day" : "vs prev. close";
  const status = error
    ? error
    : !data
      ? "Loading chart…"
      : rows.length === 0
        ? "No bars for these sessions"
        : "";
  const when = useMemo(
    () =>
      shown
        ? daily
          ? shown.date
          : `${shown.date} · ${israelClock(shown.start * 1000)} ${israelLabel}`
        : "",
    [shown, daily],
  );

  const layer = (
    <div
      className={inline ? "fullscreen-chart inline" : "fullscreen-chart"}
      {...(inline
        ? { role: "region", "aria-label": `${ticker} chart` }
        : {
            role: "dialog",
            "aria-modal": true,
            "aria-label": `${ticker} chart, full screen`,
          })}
      ref={dialog}
      // React passes portal events up to the row that opened the layer.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="fs-bar">
        <div className="fs-id">
          <strong>{ticker}</strong>
          {last && <span className="num">{last.stock.close.toFixed(2)}</span>}
          {change && (
            <span className={`num ${change.startsWith("+") ? "up" : "down"}`}>
              {change}
            </span>
          )}
          <span className="fs-sub">
            {rangeText(bar)}
            {alertEnd && ` · alert at ${israelClock(Date.parse(alertEnd))}`}
            {data && ` · ${sipDelayText(data.delayMinutes)}`}
          </span>
        </div>
        {chip && (
          <span className="fs-chip" title={chip.title}>
            {chip.text}
          </span>
        )}
        {score !== null && (
          <span className="fs-chip" title={scoreChip.title}>
            vs SPY score{" "}
            <strong className={`score-chip ${scoreChip.tone}`}>
              {scoreChip.text}
            </strong>{" "}
            / 100
          </span>
        )}
        <div className="segmented small" role="group" aria-label="Bar size">
          {barOrder.map((b) => (
            <button
              type="button"
              key={b}
              aria-pressed={bar === b}
              onClick={() => setBar(b)}
            >
              {b}
            </button>
          ))}
        </div>
        <div className="segmented small">
          <button
            type="button"
            aria-pressed={showVwap && !daily}
            disabled={daily}
            title="The stock's session VWAP, from the regular open (1m to 1h)"
            onClick={() => setShowVwap((v) => !v)}
          >
            VWAP
          </button>
        </div>
        <div className="segmented small" role="group" aria-label="Chart type">
          <button
            type="button"
            aria-pressed={kind === "candles"}
            onClick={() => setKind("candles")}
          >
            Candles
          </button>
          <button
            type="button"
            aria-pressed={kind === "spy"}
            onClick={() => setKind("spy")}
          >
            vs {benchmark}
          </button>
        </div>
        {hasSector && kind === "spy" && (
          <div
            className="segmented small"
            role="group"
            aria-label="Compare with"
          >
            {["SPY", sector!].map((s) => (
              <button
                type="button"
                key={s}
                aria-pressed={benchmark === s}
                onClick={() => setAgainst(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {inline ? (
          onExpand && (
            <button
              type="button"
              className="fs-close"
              aria-label={`${ticker} chart, full screen`}
              onClick={onExpand}
            >
              ⛶ Full screen
            </button>
          )
        ) : (
          <button
            type="button"
            className="fs-close"
            ref={closeButton}
            onClick={requestClose}
          >
            ✕ Close
          </button>
        )}
      </div>
      <div className="fs-body">
        <div ref={host} className="fs-canvas" />
        {status && <p className="fs-status">{status}</p>}
        {shown && (
          <div className="fs-legend" aria-hidden="true">
            <span style={{ color: colors.stock }}>
              {legendLine(ticker, bar, shown.stock)}
            </span>
            {kind === "spy" && benchName && shown.against && (
              <span style={{ color: colors.bench }}>
                {legendLine(benchName, bar, shown.against)}
              </span>
            )}
            {showVwap && !daily && shown.vwap !== null && (
              <span style={{ color: colors.vwap }}>
                {vwapLine(ticker, shown.stock.close, shown.vwap)}
              </span>
            )}
          </div>
        )}
        {shown && (
          <dl className="fs-window">
            <dt>Date</dt>
            <dd>{when}</dd>
            <dt className="fs-head" style={{ color: colors.stock }}>
              {ticker}, {bar}
            </dt>
            <dd />
            <dt>Open</dt>
            <dd>{shown.stock.open.toFixed(2)}</dd>
            <dt>High</dt>
            <dd>{shown.stock.high.toFixed(2)}</dd>
            <dt>Low</dt>
            <dd>{shown.stock.low.toFixed(2)}</dd>
            <dt>Close</dt>
            <dd>{shown.stock.close.toFixed(2)}</dd>
            <dt>{vsWhat}</dt>
            <dd>
              {signedChange(shown.stock.close, shown.previousClose) ?? "—"}
            </dd>
            {showVwap && !daily && shown.vwap !== null && (
              <>
                <dt>VWAP</dt>
                <dd>{shown.vwap.toFixed(2)}</dd>
                <dt>vs VWAP</dt>
                <dd>{signedChange(shown.stock.close, shown.vwap)}</dd>
              </>
            )}
            <dt>Volume</dt>
            <dd>{shown.stock.volume.toLocaleString("en-US")}</dd>
            <dt>vs 20-session avg</dt>
            <dd>
              {shown.averageVolume
                ? `${(shown.stock.volume / shown.averageVolume).toFixed(1)}×`
                : "—"}
            </dd>
            <dt>Percentile</dt>
            <dd>
              {shown.volumePercentile === null
                ? "—"
                : ordinal(shown.volumePercentile)}
            </dd>
            {kind === "spy" && benchName && shown.against && (
              <>
                <dt className="fs-head" style={{ color: colors.bench }}>
                  {benchName}, {bar}
                </dt>
                <dd />
                <dt>Open</dt>
                <dd>{shown.against.open.toFixed(2)}</dd>
                <dt>High</dt>
                <dd>{shown.against.high.toFixed(2)}</dd>
                <dt>Low</dt>
                <dd>{shown.against.low.toFixed(2)}</dd>
                <dt>Close</dt>
                <dd>{shown.against.close.toFixed(2)}</dd>
                <dt>{vsWhat}</dt>
                <dd>
                  {signedChange(
                    shown.against.close,
                    shown.againstPreviousClose,
                  ) ?? "—"}
                </dd>
              </>
            )}
          </dl>
        )}
        <p className="fs-volume-key" aria-hidden="true">
          {ticker} volume
          {rows.some((r) => r.averageVolume !== null) &&
            ` · dashed: avg of last 20 ${daily ? "days" : "sessions at this time"}`}
          {last && ` · last ${compactVolume(last.stock.volume)}`}
        </p>
      </div>
    </div>
  );
  return inline ? layer : createPortal(layer, document.body);
}
