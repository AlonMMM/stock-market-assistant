import { useRef, useState, type ReactNode } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import { EngineTickers } from "./EngineTickers.js";
import { boardRefreshMs, liveRefreshMs, usePolling } from "./Live.js";
import { pillFor, type Compare } from "./live-model.js";
import { useControlAccess } from "./Positions.js";
import { StatusPill } from "./StatusPill.js";
import { WatchTable } from "./WatchTable.js";
import {
  useWatchlists,
  WatchlistEditor,
  WatchlistSwitcher,
} from "./WatchlistLists.js";

/** The watchlist as its own section (user 2026-10-16, IBKR-like layout). */
export function WatchlistPage({
  modes,
  onShowAlerts,
  onTrade,
}: {
  modes: ReactNode;
  onShowAlerts: (ticker: string) => void;
  onTrade: (ticker: string) => void;
}) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const warn = (message: string) =>
    setWarnings((w) => (w.at(-1) === message ? w : [...w, message]));
  const live = usePolling<LiveStatus>("/api/live", liveRefreshMs, warn);
  // "vs sector" needs the collector's sector ETFs: asked for only then.
  const [compare, setCompare] = useState<Compare>("SPY");
  const lists = useWatchlists();
  const query = new URLSearchParams({
    ...(lists.chosenId !== "all" ? { list: lists.chosenId } : {}),
    ...(compare === "sector" ? { sectors: "1" } : {}),
  }).toString();
  const board = usePolling<Board>(
    `/api/board${query ? `?${query}` : ""}`,
    boardRefreshMs,
    warn,
  );
  const { canTrade } = useControlAccess();
  // The collector returns no alerts while unreachable; keep the last ones.
  const kept = useRef<LiveStatus["alerts"]>([]);
  const status = live.value;
  if (status && status.state !== "unavailable") kept.current = status.alerts;
  const pill = pillFor(status, Date.now(), live.at);

  return (
    <div className="live-page">
      <header>
        <div className="brand-status">
          <span className="brand">
            SMA<span className="brand-dot">.</span>
          </span>
          <StatusPill
            pill={pill}
            status={status}
            checkedAt={live.at}
            refreshSeconds={liveRefreshMs / 1000}
            warnings={warnings}
            onClearWarnings={() => setWarnings([])}
            chartDelay={
              board.value ? { minutes: board.value.delayMinutes } : undefined
            }
          />
        </div>
        {modes}
      </header>
      <h2 className="wl-title">
        {lists.current && !lists.current.builtIn
          ? lists.current.name
          : "Watchlist"}
        {board.value && (
          <span className="count num">{board.value.watchlist.length}</span>
        )}
      </h2>
      <WatchlistSwitcher w={lists} />
      {board.value &&
      board.value.watchlist.length === 0 &&
      lists.current &&
      !lists.current.builtIn ? (
        <p className="chart-status">
          This list is empty. Add tickers under “Edit {lists.current.name}”.
        </p>
      ) : board.value ? (
        <WatchTable
          board={board.value}
          alerts={status ? kept.current : []}
          onShowAlerts={onShowAlerts}
          onTrade={canTrade ? onTrade : undefined}
          compare={compare}
          onCompare={setCompare}
        />
      ) : (
        <p className={board.error ? "notice error" : "chart-status"}>
          {board.error
            ? `Watchlist unavailable: ${board.error}`
            : "Loading watchlist…"}
        </p>
      )}
      <WatchlistEditor w={lists} onChanged={board.reload} />
      <EngineTickers />
    </div>
  );
}
