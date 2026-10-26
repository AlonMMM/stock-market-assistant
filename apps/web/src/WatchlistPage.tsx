import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Board } from "../../../packages/market-data/src/board.js";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import { EngineTickers } from "./EngineTickers.js";
import { boardRefreshMs, liveRefreshMs, prefetch, usePolling } from "./Live.js";
import { MarketCards } from "./MarketCards.js";
import { pillFor, withLivePrices, type Compare } from "./live-model.js";
import { useLivePrices } from "./live-prices.js";
import { useControlAccess } from "./Positions.js";
import { StatusPill } from "./StatusPill.js";
import { BellIcon, PriceAlertsPage, usePriceAlerts } from "./PriceAlerts.js";
import { useDarkPage, useWatchlistTheme } from "./theme.js";
import { TickerPage } from "./TickerPage.js";
import { WatchTable } from "./WatchTable.js";
import {
  AddTicker,
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
  onTrade: (ticker: string, mode?: "options" | "stock") => void;
}) {
  // A stock's own page (user 2026-10-18), `#watchlist/NVDA`, and the price
  // alerts' page, `#watchlist/alerts`; the phone's Back returns to the list.
  const fromHash = () => {
    if (location.hash === "#watchlist/alerts") return "alerts";
    const m = /^#watchlist\/([A-Z][A-Z.]{0,9})$/.exec(location.hash);
    return m ? m[1]! : null;
  };
  const [page, setPage] = useState<string | null>(fromHash);
  useEffect(() => {
    const back = () => setPage(fromHash());
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  // `ticker` is a stock, or "alerts" for the price alerts' page.
  const open = (ticker: string) => {
    history.pushState(null, "", `#watchlist/${ticker}`);
    setPage(ticker);
    window.scrollTo(0, 0);
  };
  const priceAlerts = usePriceAlerts();
  const armedAlerts = (priceAlerts.alerts ?? []).filter(
    (a) => a.firedAt === null,
  ).length;
  const close = () => {
    if (/^#watchlist\//.test(location.hash)) history.back();
    else setPage(null);
  };
  const [warnings, setWarnings] = useState<string[]>([]);
  const warn = (message: string) =>
    setWarnings((w) => (w.at(-1) === message ? w : [...w, message]));
  const live = usePolling<LiveStatus>("/api/live", liveRefreshMs, warn);
  // "vs sector" needs the collector's sector ETFs: asked for only then.
  const [compare, setCompare] = useState<Compare>("SPY");
  const lists = useWatchlists();
  // The chosen list's editor, opened from "Edit list" by the chips; an empty list opens it.
  const [editing, setEditing] = useState(false);
  const emptyList =
    Boolean(lists.current && !lists.current.builtIn) &&
    lists.current!.tickers.length === 0;
  const query = new URLSearchParams({
    ...(lists.chosenId !== "all" ? { list: lists.chosenId } : {}),
    ...(compare === "sector" ? { sectors: "1" } : {}),
  }).toString();
  const board = usePolling<Board>(
    `/api/board${query ? `?${query}` : ""}`,
    boardRefreshMs,
    warn,
  );
  // Last, Change % and the day line follow each trade (every second).
  const prices = useLivePrices(board.value ?? null);
  const shown = board.value ? withLivePrices(board.value, prices.prices) : null;
  const { canTrade } = useControlAccess();
  // The other lists are read behind this one, one by one, so a switch to
  // any of them shows its rows at once (user 2026-10-19).
  const ownIds = lists.own.map((l) => l.id).join(",");
  const loaded = board.value !== null;
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    void (async () => {
      for (const id of ownIds.split(",")) {
        if (!live || !id || id === lists.chosenId) continue;
        await prefetch(`/api/board?list=${id}`, boardRefreshMs);
      }
    })();
    return () => {
      live = false;
    };
  }, [loaded, ownIds, lists.chosenId]);
  // The collector returns no alerts while unreachable; keep the last ones.
  const kept = useRef<LiveStatus["alerts"]>([]);
  const status = live.value;
  if (status && status.state !== "unavailable") kept.current = status.alerts;
  const pill = pillFor(status, Date.now(), live.at);
  // Dark mode: the list itself (not yet a stock's page or the price alerts).
  const theme = useWatchlistTheme();
  useDarkPage(theme.dark && page === null);

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
      {page === "alerts" ? (
        <PriceAlertsPage onBack={close} onOpenTicker={open} />
      ) : page ? (
        <TickerPage
          key={page}
          ticker={page}
          board={shown}
          night={prices.prices}
          alerts={status ? kept.current : []}
          onBack={close}
          onShowAlerts={() => onShowAlerts(page)}
          onTrade={canTrade ? (how) => onTrade(page, how) : undefined}
        />
      ) : (
        <>
          {board.value && <MarketCards date={board.value.date} onOpen={open} />}
          <h2 className="wl-title">
            {lists.current && !lists.current.builtIn
              ? lists.current.name
              : "Watchlist"}
            {board.value && (
              <span className="count num">{board.value.watchlist.length}</span>
            )}
            <button
              type="button"
              className="wl-theme"
              aria-pressed={theme.dark}
              title={theme.dark ? "Light mode" : "Dark mode"}
              onClick={() => theme.choose(theme.dark ? "light" : "dark")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {theme.dark ? (
                  <>
                    <circle cx="12" cy="12" r="4.5" />
                    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
                  </>
                ) : (
                  <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z" />
                )}
              </svg>
              <span className="sr-only">Dark mode</span>
            </button>
            <button
              type="button"
              className="wl-pa"
              onClick={() => open("alerts")}
            >
              <BellIcon />
              Price alerts
              {armedAlerts > 0 && <span className="num">{armedAlerts}</span>}
            </button>
          </h2>
          <WatchlistSwitcher
            w={lists}
            editing={editing || emptyList}
            onEdit={() => setEditing(!(editing || emptyList))}
          />
          {(editing || emptyList) && (
            <WatchlistEditor w={lists} onChanged={board.reload} />
          )}
          {board.value &&
          board.value.watchlist.length === 0 &&
          lists.current &&
          !lists.current.builtIn ? (
            <p className="chart-status">
              This list is empty. Add tickers in the editor above.
            </p>
          ) : board.value ? (
            <WatchTable
              board={shown!}
              night={prices.prices}
              livePrices={prices.state}
              alerts={status ? kept.current : []}
              onShowAlerts={onShowAlerts}
              onTrade={canTrade ? onTrade : undefined}
              onOpen={open}
              tools={<AddTicker w={lists} onAdded={board.reload} />}
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
          <EngineTickers />
        </>
      )}
    </div>
  );
}
