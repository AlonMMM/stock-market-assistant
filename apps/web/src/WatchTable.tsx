import type { LivePriceState } from "./live-prices.js";
import {
  lazy,
  Suspense,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import { newYorkToUtc } from "../../../packages/market-data/src/calendar.js";
import type { FeedAlert } from "./AlertFeed.js";
import {
  alertDate,
  alertDirection,
  filterRows,
  isHot,
  keepOrder,
  moving,
  rangePosition,
  sortRows,
  sortsDescending,
  statsOf,
  watchRows,
  ibChange,
  ibPct,
  ibPrice,
  ibRelVolume,
  ibVolume,
  phoneColumns,
  type Compare,
  type NightPrices,
  type WatchRow,
  type WatchSort,
} from "./live-model.js";
import { DaySpark } from "./Sparkline.js";
import { israelClock, israelLabel } from "./time.js";
import {
  scoreNote,
  scoreCell,
  scoreStrong,
  scoreTone,
  scoreWeak,
  toneWords,
} from "./vs-spy-model.js";

// An opened row shows plain candles only (user 2026-10-16).
const CandleChart = lazy(() =>
  import("./CandleChart.js").then((m) => ({ default: m.CandleChart })),
);

const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const pts = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const price = (n: number | null) =>
  n === null
    ? "—"
    : n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const shares = (n: number | null) =>
  n === null
    ? "—"
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}K`
        : String(Math.round(n));
/** Rel vol bar is full at this ratio. */
const relVolScale = 4;

/** The moon IBKR puts next to an overnight price. */
const Moon = () => (
  <svg className="wl-moon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M10.6 1.4a6.6 6.6 0 1 0 4 10.3A6 6 0 0 1 10.6 1.4z" />
  </svg>
);

// [sort key, label, alignment, shown on phones]. Phones get IBKR's five
// columns (user 2026-10-26): Instrument, Last price, Chng, Chg %, Volume,
// and Rel vol before Volume (user 2026-10-26: "i need relative volume").
const columns: [WatchSort | null, string, "left" | "right", boolean][] = [
  ["ticker", "Instrument", "left", true],
  [null, "Today", "left", false],
  ["last", "Last price", "right", true],
  [null, "Chng", "right", true],
  ["change", "Chg %", "right", true],
  ["excess", "", "right", false], // vs SPY | vs sector
  ["rsScore", "Score", "right", false],
  ["relVolume", "Rel vol", "right", true],
  // Today's regular-session shares (user 2026-10-17).
  ["volume", "Volume", "right", true],
  ["range", "Day range", "left", false],
  ["alerts", "Alerts", "right", false],
];

function RowDetail({
  row,
  board,
  alerts,
  onShowAlerts,
  onTrade,
}: {
  row: WatchRow;
  board: Board;
  alerts: FeedAlert[];
  onShowAlerts: () => void;
  onTrade?: (() => void) | undefined;
}) {
  const changeUsd = row.changeUsd;
  const beta = statsOf(board.series.find((s) => s.ticker === row.ticker))?.beta;
  return (
    <div className="wl-detail">
      <Suspense fallback={<p className="chart-status">Loading chart…</p>}>
        <CandleChart ticker={row.ticker} date={board.date} />
      </Suspense>
      <div className="wl-facts">
        <div className="wl-fact">
          <span>Change</span>
          <b
            className={changeUsd === null ? "" : changeUsd >= 0 ? "up" : "down"}
          >
            {changeUsd === null ? "—" : pts(changeUsd)}
          </b>
        </div>
        <div className="wl-fact">
          <span>Day range</span>
          <b>
            {row.dayLow === null || row.dayHigh === null
              ? "—"
              : `${price(row.dayLow)}–${price(row.dayHigh)}`}
          </b>
        </div>
        <div className="wl-fact">
          <span>Vol / typical</span>
          <b>
            {shares(row.volume)} / {shares(row.typicalVolume)}
          </b>
        </div>
        <div className="wl-fact">
          <span>Score vs SPY</span>
          <b>
            {row.rsScore === null
              ? "—"
              : `${row.rsScore} · ${toneWords[scoreTone(row.rsScore)]}`}
          </b>
        </div>
        <div className="wl-fact">
          <span>Beta</span>
          <b>
            {beta === undefined
              ? "—"
              : beta === null
                ? "1 (assumed)"
                : beta.toFixed(2)}
          </b>
        </div>
        <div className="wl-fact">
          <span>{row.against}</span>
          <b
            className={
              row.benchChange === null
                ? ""
                : row.benchChange >= 0
                  ? "up"
                  : "down"
            }
          >
            {row.benchChange === null ? "—" : pct(row.benchChange)}
          </b>
        </div>
      </div>
      {alerts.length > 0 && (
        <ul className="wl-alerts">
          {alerts.map((a) => (
            <li key={a.end} className="num">
              {israelClock(Date.parse(a.end))} ·{" "}
              {alertDirection(a) === "up" ? "▲" : "▼"} {pct(a.move)} ·{" "}
              {a.ratio === null ? "—" : `${a.ratio.toFixed(1)}×`} volume
            </li>
          ))}
        </ul>
      )}
      <div className="wl-actions">
        <button type="button" onClick={onShowAlerts}>
          {alerts.length > 0
            ? `${alerts.length} alert${alerts.length === 1 ? "" : "s"} today →`
            : "Alerts"}
        </button>
        {onTrade && (
          <button type="button" className="primary" onClick={onTrade}>
            Trade {row.ticker}
          </button>
        )}
      </div>
    </div>
  );
}

/** Watchlist "Score" cell: coloured score, words for screen readers. */
function ScoreCell({ score }: { score: number | null }) {
  const c = scoreCell(score);
  if (c.score === null)
    return (
      <span className="wl-cell wl-wide num right muted" title={c.title}>
        —<span className="sr-only"> {c.title}</span>
      </span>
    );
  return (
    <span className="wl-cell wl-wide num right" title={c.title}>
      <span className={`score-chip ${c.tone}`} aria-hidden="true">
        {c.text}
      </span>
      <span className="sr-only">{c.title}</span>
    </span>
  );
}

/**
 * The watchlist: one dense line per stock (IBKR-like), today's chart and Rel
 * vol kept. Phones show symbol, last, Chng, Chg %, Rel vol and volume; wider
 * screens add vs SPY/sector, the score, the day range and alert counts. A
 * row opens the day chart and its numbers.
 */
export function WatchTable({
  board,
  alerts,
  onShowAlerts,
  onTrade,
  onOpen,
  compare,
  onCompare,
  livePrices,
  night,
  tools,
}: {
  // Shown at the start of the toolbar, on Find's line ("+ Add ticker").
  tools?: ReactNode;
  // Whether Last and Change % follow each trade (live-prices.ts).
  livePrices?: LivePriceState;
  // The latest prints; those after the board's day are overnight (BOATS).
  night?: NightPrices;
  // A row opens the stock's own page (user 2026-10-18).
  onOpen?: (ticker: string) => void;
  board: Board;
  alerts: FeedAlert[];
  onShowAlerts: (ticker: string) => void;
  // Absent for visitors who cannot trade.
  onTrade?: ((ticker: string) => void) | undefined;
  // "vs sector" makes the page load the board with sector ETFs.
  compare: Compare;
  onCompare: (c: Compare) => void;
}) {
  const [find, setFind] = useState("");
  const [sort, setSort] = useState<WatchSort>("change");
  const [descending, setDescending] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  // "Alerts today" counts the alerts of the session the board shows.
  const today = alerts.filter((a) => alertDate(a) === board.date);
  const counts = new Map<string, number>();
  for (const a of today) counts.set(a.ticker, (counts.get(a.ticker) ?? 0) + 1);
  const all = watchRows(board, counts, compare, {
    now: Date.now(),
    night: night ?? {},
  });
  // The order is set when a sort is picked, the list changes or a new day
  // loads; live prices then update the rows in place, not their order.
  const sortKey = [sort, descending, board.date, ...board.watchlist].join(",");
  const order = useRef<{ key: string; tickers: string[] } | null>(null);
  if (order.current?.key !== sortKey)
    order.current = {
      key: sortKey,
      tickers: sortRows(all, sort, descending).map((r) => r.ticker),
    };
  const rows = keepOrder(filterRows(all, "all", find), order.current.tickers);
  const phone = phoneColumns(all);
  const bySymbol = new Map(board.series.map((s) => [s.ticker, s]));
  // Picked, but the board with sector ETFs has not arrived yet.
  const sectorsLoading =
    compare === "sector" && Object.keys(board.benchmarks).length === 0;

  const pick = (key: WatchSort) => {
    if (key === sort) setDescending(!descending);
    else {
      setSort(key);
      setDescending(sortsDescending(key));
    }
  };

  return (
    <div className="wl">
      <div className="wl-toolbar">
        {tools}
        <div className="wl-tools">
          <label className="wl-find">
            <span className="sr-only">Find a symbol</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4" />
            </svg>
            <input
              type="search"
              value={find}
              placeholder="Find"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setFind(e.target.value)}
            />
          </label>
          <div
            className="wl-chips small wl-compare"
            role="group"
            aria-label="Compare with"
          >
            {(
              [
                ["SPY", "vs SPY"],
                ["sector", "vs sector"],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-pressed={compare === key}
                onClick={() => onCompare(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {sectorsLoading && (
        <p className="wl-source" role="status">
          Loading sector ETFs…
        </p>
      )}

      <div
        className="wl-table"
        style={
          {
            "--wl-cols": phone.columns,
            "--wl-width": phone.width,
          } as CSSProperties
        }
      >
        <div className="wl-head wl-grid" role="group" aria-label="Sort by">
          {columns.map(([key, label, align, phone]) => {
            const text =
              key === "excess"
                ? compare === "sector"
                  ? "vs sector"
                  : "vs SPY"
                : label;
            const cls = `wl-cell ${align}${phone ? "" : " wl-wide"}${key === "volume" ? " wl-vol" : ""}`;
            if (!key)
              return (
                <span key={text} className={cls}>
                  {text}
                </span>
              );
            const active = sort === key;
            return (
              <button
                type="button"
                key={key}
                title={
                  key === "rsScore"
                    ? `0–100 vs SPY: ${scoreNote}; green ≥ ${scoreStrong} stronger, red ≤ ${scoreWeak} weaker`
                    : undefined
                }
                className={`${cls}${active ? " active" : ""}`}
                aria-pressed={active}
                aria-label={`Sort by ${text}${key === "change" ? " (size of move)" : ""}${active ? (descending ? ", highest first" : ", lowest first") : ""}`}
                onClick={() => pick(key)}
              >
                {text}
                <span aria-hidden="true" className="wl-arrow">
                  {active ? (descending ? "▼" : "▲") : "↕"}
                </span>
              </button>
            );
          })}
        </div>
        <ul>
          {rows.map((r) => {
            const expanded = open === r.ticker;
            const s = bySymbol.get(r.ticker);
            const position = rangePosition(r);
            const hot = isHot(r);
            return (
              <li key={r.ticker} className={expanded ? "open" : undefined}>
                <button
                  type="button"
                  className="wl-row wl-grid"
                  {...(onOpen
                    ? { "aria-label": `Open ${r.ticker}` }
                    : { "aria-expanded": expanded })}
                  onClick={() =>
                    onOpen
                      ? onOpen(r.ticker)
                      : setOpen(expanded ? null : r.ticker)
                  }
                >
                  <span className="wl-cell wl-symbol">
                    <strong>{r.ticker}</strong>
                    {r.sector && <small>{r.sector}</small>}
                    {r.alerts > 0 && (
                      <span className="wl-dot" title="Alert today">
                        <span className="sr-only">
                          , {r.alerts} alert{r.alerts === 1 ? "" : "s"} today
                        </span>
                      </span>
                    )}
                  </span>
                  <span className="wl-cell wl-spark wl-wide">
                    <DaySpark
                      points={s?.points ?? []}
                      previousClose={r.previousClose}
                    />
                  </span>
                  <span
                    className={`wl-cell right wl-num wl-last${r.mark === "night" ? " night" : ""}`}
                    title={
                      r.mark === "night"
                        ? "Overnight price (20:00–04:00 New York)"
                        : r.mark === "close"
                          ? "Closing price"
                          : undefined
                    }
                  >
                    {r.last === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span>
                        {r.mark === "night" && (
                          <>
                            <Moon />
                            <span className="sr-only">overnight </span>
                          </>
                        )}
                        {r.mark === "close" && (
                          <span className="wl-c">
                            <span aria-hidden="true">C</span>
                            <span className="sr-only">close </span>
                          </span>
                        )}
                        {ibPrice(r.last)}
                      </span>
                    )}
                  </span>
                  <span
                    className={`wl-cell right wl-num${r.changeUsd === null ? "" : r.changeUsd >= 0 ? " up" : " down"}`}
                  >
                    {r.changeUsd !== null && (
                      <span>{ibChange(r.changeUsd)}</span>
                    )}
                  </span>
                  <span
                    className={`wl-cell right wl-num${r.change === null ? "" : r.change >= 0 ? " up" : " down"}`}
                  >
                    {r.change !== null && <span>{ibPct(r.change)}</span>}
                  </span>
                  <span
                    className={
                      r.excess === null
                        ? "wl-cell wl-wide num right muted"
                        : `wl-cell wl-wide num right ${r.excess >= 0 ? "up" : "down"}`
                    }
                  >
                    {r.excess === null ? "—" : `${pts(r.excess)} pts`}
                  </span>
                  <ScoreCell score={r.rsScore} />
                  <span
                    className={`wl-cell right wl-rv wl-num${hot ? " hot" : ""}`}
                  >
                    <span>{ibRelVolume(r.relVolume)}</span>
                    <i aria-hidden="true">
                      <span
                        style={{
                          width: `${Math.min(100, ((r.relVolume ?? 0) / relVolScale) * 100)}%`,
                        }}
                      />
                    </i>
                  </span>
                  <span
                    className={`wl-cell right wl-num wl-vol${hot ? " hot" : ""}`}
                    title={
                      r.relVolume === null
                        ? undefined
                        : `${r.relVolume.toFixed(1)}× the usual volume by now`
                    }
                  >
                    <span>{ibVolume(r.volume)}</span>
                  </span>
                  <span className="wl-cell wl-wide">
                    {position === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span
                        className="range"
                        title={`Low ${price(r.dayLow)} · High ${price(r.dayHigh)}`}
                      >
                        <span className="sr-only">
                          Low {price(r.dayLow)}, high {price(r.dayHigh)}
                        </span>
                        <i style={{ left: `${position * 100}%` }} />
                      </span>
                    )}
                  </span>
                  <span
                    className={`wl-cell wl-wide right num${r.alerts ? " wl-alert-count" : " muted"}`}
                  >
                    {r.alerts || "–"}
                  </span>
                </button>
                {expanded && (
                  <RowDetail
                    row={r}
                    board={board}
                    alerts={today.filter((a) => a.ticker === r.ticker)}
                    onShowAlerts={() => onShowAlerts(r.ticker)}
                    onTrade={onTrade ? () => onTrade(r.ticker) : undefined}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {rows.length === 0 && <p className="table-empty">No symbols match.</p>}
      </div>
      <details className="wl-help">
        <summary>How to read the columns</summary>
        <p>
          Last price: the latest trade. From{" "}
          {israelClock(newYorkToUtc(board.date, 1200))} to{" "}
          {israelClock(newYorkToUtc(board.date, 1200) + 8 * 3600000)}{" "}
          (20:00–04:00 New York) it is the overnight session&apos;s price,
          marked with a moon, and Chng and Chg % are measured from the
          day&apos;s close. A C in front marks the close: nothing trades now, or
          the stock has not traded yet. Chng: dollars, and Chg %: percent, since
          the previous close. Volume: shares traded in today&apos;s regular
          session so far, orange when it is {moving.relVolume}× its usual or
          more. Today: the day&apos;s price, green above the previous close
          (dashed) and red below. vs SPY / vs sector: today&apos;s change minus
          the benchmark&apos;s, in % points. Score: 0–100, always vs SPY (
          {scoreNote}), scaled by how large that weighted sum usually is for the
          stock at this minute over the previous 20 sessions; green ≥{" "}
          {scoreStrong} stronger, red ≤ {scoreWeak} weaker. Rel vol:
          regular-session volume so far ÷ the median volume by the same New York
          minute over the previous 20 sessions; orange from {moving.relVolume}×;
          “—” before the {israelClock(board.open * 1000)} open or with too
          little history. An orange dot: a live alert today. Times in{" "}
          {israelLabel}.
        </p>
      </details>
    </div>
  );
}
