import { lazy, Suspense, useState } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { FeedAlert } from "./AlertFeed.js";
import {
  alertDate,
  alertDirection,
  filterRows,
  isMoving,
  moving,
  rangePosition,
  sipDelayText,
  sortRows,
  sortsDescending,
  statsOf,
  watchRows,
  type Compare,
  type WatchFilter,
  type WatchRow,
  type WatchSort,
} from "./live-model.js";
import { Sparkline } from "./Sparkline.js";
import { israelClock, israelLabel } from "./time.js";
import {
  scoreNote,
  scoreCell,
  scoreStrong,
  scoreTone,
  scoreWeak,
  toneWords,
} from "./vs-spy-model.js";

const DayChart = lazy(() =>
  import("./DayChart.js").then((m) => ({ default: m.DayChart })),
);

const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const pts = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
/** Rel vol bar is full at this ratio; bold from `moving.relVolume`. */
const relVolScale = 4;

const columns: [WatchSort | null, string, "left" | "right"][] = [
  ["ticker", "Symbol", "left"],
  ["last", "Last", "right"],
  ["change", "Change", "left"],
  ["excess", "", "right"], // vs SPY | vs sector
  ["rsScore", "vs SPY score", "right"], // always against SPY
  ["relVolume", "Rel vol", "left"],
  ["range", "Day range", "left"],
  ["alerts", "Alerts", "left"],
  [null, "Today", "left"],
];

function RowDetail({
  row,
  board,
  alerts,
  onShowAlerts,
}: {
  row: WatchRow;
  board: Board;
  alerts: FeedAlert[];
  onShowAlerts: () => void;
}) {
  const beta = statsOf(board.series.find((s) => s.ticker === row.ticker))?.beta;
  return (
    <div className="watch-detail">
      <Suspense fallback={<p className="chart-status">Loading day chart…</p>}>
        <DayChart
          key={row.against}
          ticker={row.ticker}
          date={board.date}
          sector={row.sector ?? undefined}
          against={row.against}
        />
      </Suspense>
      <div className="watch-side">
        <dl>
          <dt>Day range</dt>
          <dd>
            {row.dayLow === null || row.dayHigh === null
              ? "—"
              : `Low ${money(row.dayLow)} · High ${money(row.dayHigh)}`}
          </dd>
          <dt>Rel. volume</dt>
          <dd>
            {row.relVolume === null
              ? "— (before the regular open, or too little history)"
              : `${row.relVolume.toFixed(1)}× of typical volume by this time`}
          </dd>
          <dt>vs SPY score</dt>
          <dd>
            {row.rsScore === null
              ? "—"
              : `${row.rsScore} / 100 · ${toneWords[scoreTone(row.rsScore)]}`}
            {beta !== undefined &&
              (beta === null ? " · β assumed 1" : ` · β ${beta.toFixed(2)}`)}
          </dd>
          <dt>Benchmark</dt>
          <dd>
            {row.against}{" "}
            {row.benchChange === null ? "—" : pct(row.benchChange)}
          </dd>
        </dl>
        <strong className="side-title">Alerts today</strong>
        {alerts.length > 0 ? (
          <>
            <ul>
              {alerts.map((a) => (
                <li key={a.end}>
                  {israelClock(Date.parse(a.end))} ·{" "}
                  {alertDirection(a) === "up" ? "▲" : "▼"} {pct(a.move)} ·{" "}
                  {a.ratio === null ? "—" : `${a.ratio.toFixed(1)}×`} volume
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="action primary"
              onClick={onShowAlerts}
            >
              Show in Alerts →
            </button>
          </>
        ) : (
          <span className="muted">None so far.</span>
        )}
      </div>
    </div>
  );
}

/** Dense, sortable watchlist table; a row expands to the day chart. */
export function WatchTable({
  board,
  alerts,
  onShowAlerts,
}: {
  board: Board;
  alerts: FeedAlert[];
  onShowAlerts: (ticker: string) => void;
}) {
  const [filter, setFilter] = useState<WatchFilter>("all");
  const [compare, setCompare] = useState<Compare>("SPY");
  const [find, setFind] = useState("");
  const [sort, setSort] = useState<WatchSort>("change");
  const [descending, setDescending] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  // "Alerts today" counts the alerts of the session the board shows.
  const today = alerts.filter((a) => alertDate(a) === board.date);
  const counts = new Map<string, number>();
  for (const a of today) counts.set(a.ticker, (counts.get(a.ticker) ?? 0) + 1);
  const all = watchRows(board, counts, compare);
  const rows = sortRows(filterRows(all, filter, find), sort, descending);
  const bySymbol = new Map(board.series.map((s) => [s.ticker, s]));
  const asOf = board.series
    .map((s) => statsOf(s)?.asOf ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const hasSectors = Object.keys(board.benchmarks).length > 0;

  const pick = (key: WatchSort) => {
    if (key === sort) setDescending(!descending);
    else {
      setSort(key);
      setDescending(sortsDescending(key));
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show">
          {(
            [
              ["all", "All", all.length],
              ["moving", "Moving", all.filter(isMoving).length],
              ["alerts", "With alerts", all.filter((r) => r.alerts).length],
            ] as const
          ).map(([key, label, n]) => (
            <button
              type="button"
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label} <span className="count">{n}</span>
            </button>
          ))}
        </div>
        {hasSectors && (
          <div className="segmented" role="group" aria-label="Compare with">
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
                onClick={() => setCompare(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <label className="inline-field">
          Find
          <input
            type="search"
            value={find}
            placeholder="Symbol"
            autoCapitalize="characters"
            onChange={(e) => setFind(e.target.value)}
          />
        </label>
        <span className="toolbar-gap" />
        <span className="source-note">
          Prices and charts: {sipDelayText(board.delayMinutes)}, 5-min bars
          {asOf > 0 &&
            ` · rel vol as of ${israelClock(asOf * 1000)} ${israelLabel}`}
        </span>
      </div>

      <div className="watch-table">
        <div className="watch-scroll">
          <div className="watch-head" role="group" aria-label="Sort by">
            {columns.map(([key, label, align]) => {
              const text =
                key === "excess"
                  ? compare === "sector"
                    ? "vs sector"
                    : "vs SPY"
                  : label;
              if (!key)
                return (
                  <span key={text} className={align}>
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
                  className={`${align}${active ? " active" : ""}`}
                  aria-pressed={active}
                  aria-label={`Sort by ${text}${key === "change" ? " (size of move)" : ""}${active ? (descending ? ", highest first" : ", lowest first") : ""}`}
                  onClick={() => pick(key)}
                >
                  {text}
                  <span aria-hidden="true">
                    {active ? (descending ? " ▼" : " ▲") : ""}
                  </span>
                </button>
              );
            })}
            <span />
          </div>
          <ul>
            {rows.map((r) => {
              const expanded = open === r.ticker;
              const s = bySymbol.get(r.ticker);
              const bench =
                r.against === r.ticker
                  ? undefined
                  : bySymbol.get(r.against)?.points;
              const position = rangePosition(r);
              const strong =
                r.relVolume !== null && r.relVolume >= moving.relVolume;
              return (
                <li key={r.ticker}>
                  <button
                    type="button"
                    className={expanded ? "watch-row open" : "watch-row"}
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : r.ticker)}
                  >
                    <span className="watch-symbol">
                      <strong>{r.ticker}</strong>
                      {r.sector && <span>{r.sector}</span>}
                    </span>
                    <span className="num right">{money(r.last)}</span>
                    {r.change === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span
                        className={
                          r.change >= 0 ? "move-tag up" : "move-tag down"
                        }
                      >
                        {r.change >= 0 ? "▲" : "▼"} {pct(r.change)}
                      </span>
                    )}
                    <span
                      className={
                        r.excess === null
                          ? "num right muted"
                          : `num right excess ${r.excess >= 0 ? "up" : "down"}`
                      }
                    >
                      {r.excess === null ? "—" : `${pts(r.excess)} pts`}
                    </span>
                    <ScoreCell score={r.rsScore} />
                    <span className="relvol">
                      <span className={strong ? "num strong" : "num"}>
                        {r.relVolume === null
                          ? "—"
                          : `${r.relVolume.toFixed(1)}×`}
                      </span>
                      <span
                        className={strong ? "meter" : "meter faint"}
                        aria-hidden="true"
                      >
                        <span
                          style={{
                            width: `${Math.min(100, ((r.relVolume ?? 0) / relVolScale) * 100)}%`,
                          }}
                        />
                      </span>
                    </span>
                    {position === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span
                        className="range"
                        title={`Low ${money(r.dayLow)} · High ${money(r.dayHigh)}`}
                      >
                        <span className="sr-only">
                          Low {money(r.dayLow)}, high {money(r.dayHigh)}
                        </span>
                        <i style={{ left: `${position * 100}%` }} />
                      </span>
                    )}
                    <span className={r.alerts ? "alert-count" : "muted"}>
                      {r.alerts ? (
                        <>
                          ● {r.alerts}
                          <span className="sr-only">
                            {r.alerts === 1 ? " alert" : " alerts"}
                          </span>
                        </>
                      ) : (
                        "–"
                      )}
                    </span>
                    <span className="today">
                      <Sparkline
                        ticker={s?.points ?? []}
                        benchmark={bench}
                        marks={[board.open]}
                      />
                    </span>
                    <svg
                      className="chevron"
                      width="14"
                      height="14"
                      viewBox="0 0 12 12"
                      aria-hidden="true"
                    >
                      <path
                        d="M3 4.5l3 3 3-3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                      />
                    </svg>
                  </button>
                  {expanded && (
                    <RowDetail
                      row={r}
                      board={board}
                      alerts={today.filter((a) => a.ticker === r.ticker)}
                      onShowAlerts={() => onShowAlerts(r.ticker)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {rows.length === 0 && (
            <p className="table-empty">No symbols match.</p>
          )}
        </div>
      </div>
      <p className="table-note">
        Change: since the previous close. vs SPY / vs sector: today&apos;s
        change minus the benchmark&apos;s change, in % points. vs SPY score:
        0–100, always vs SPY ({scoreNote}), scaled by how large that weighted sum usually is for the stock at this minute over the previous 20 sessions; green ≥ {scoreStrong} stronger,
        red ≤ {scoreWeak} weaker, grey between; “—” without enough history. Rel
        vol: regular-session volume so far ÷ the median volume by the same New
        York minute over the previous 20 sessions; “—” before the{" "}
        {israelClock(board.open * 1000)} open or with too little history.
        Moving: |change| ≥ {moving.change}% or rel vol ≥ {moving.relVolume}×.
        Day range: today&apos;s low to high, the mark is the last price. Today:
        blue = symbol, dashed orange = benchmark, dotted line = regular open.
        Times in {israelLabel}.
      </p>
    </>
  );
}

/** Watchlist "vs SPY score" cell: coloured score, words for screen readers. */
function ScoreCell({ score }: { score: number | null }) {
  const c = scoreCell(score);
  if (c.score === null)
    return (
      <span className="num right muted" title={c.title}>
        —<span className="sr-only"> {c.title}</span>
      </span>
    );
  return (
    <span className="num right" title={c.title}>
      <span className={`score-chip ${c.tone}`} aria-hidden="true">
        {c.text}
      </span>
      <span className="sr-only">{c.title}</span>
    </span>
  );
}
