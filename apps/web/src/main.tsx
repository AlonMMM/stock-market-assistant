import {
  Component,
  StrictMode,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { parseAlertLink } from "../../../packages/contracts/src/alert-link.js";
import { BotBacktest } from "./BotBacktest.js";
import { Portfolio } from "./Portfolio.js";
import { ThemeButton } from "./ThemeButton.js";
import { WatchlistPage } from "./WatchlistPage.js";
import "./styles.css";

// After a deploy, a page opened before it still names the old chunks, which
// are gone: opening a stock or a chart failed to load its code and left a
// blank page (user 2026-11-02). Load the page again, once, to get the new
// ones; not again within a minute, so a real outage does not loop.
const reloadKey = "sma.chunk-reload";
window.addEventListener("vite:preloadError", (event) => {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(reloadKey) ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(reloadKey, String(Date.now()));
  } catch {
    // No storage (a private window): reload anyway.
  }
  event.preventDefault();
  location.reload();
});

// The Alerts section was removed (user 2026-10-30, "we are not using it"); the
// volume alerts still run behind the Volume bot and show on the Watchlist.
const modeNames = [
  ["watchlist", "Watchlist"],
  ["portfolio", "Trading"], // the stored value and #portfolio keep the old name
  ["backtest", "Backtest"],
] as const;
const icons: Record<Mode, string> = {
  watchlist: "M4 6h16M4 12h16M4 18h10",
  portfolio: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 4v8l6 4",
  backtest: "M4 19V5M4 19h16M8 15l4-4 3 3 5-6",
};
type Mode = (typeof modeNames)[number][0];
const modeKey = "sma.mode.v1";
// A link may name the section: #watchlist, #portfolio, #backtest; an old
// #alerts link opens the Watchlist.
const hashModes: Record<string, Mode> = {
  alerts: "watchlist",
  watchlist: "watchlist",
  portfolio: "portfolio",
  backtest: "backtest",
};
function savedMode(): Mode {
  // `#watchlist/NVDA` is a stock's page in the Watchlist section.
  const named = hashModes[location.hash.slice(1).split("/")[0]!];
  if (named) return named;
  try {
    const saved = localStorage.getItem(modeKey);
    return modeNames.find(([value]) => value === saved)?.[0] ?? "watchlist";
  } catch {
    return "watchlist";
  }
}

// A volume alert's link from Telegram opens the stock's own page.
const link = parseAlertLink(location.search);
if (link) {
  history.replaceState(null, "", `/#watchlist/${link.ticker}`);
}

function App() {
  const [mode, setModeState] = useState<Mode>(savedMode);
  // Where the watchlist sends a symbol: the trade ticket.
  const [tradeSymbol, setTradeSymbol] = useState<string | null>(null);
  const [tradeMode, setTradeMode] = useState<"options" | "stock">("options");
  const setMode = (m: Mode) => {
    setModeState(m);
    window.scrollTo(0, 0);
    history.replaceState(null, "", `#${m}`);
    try {
      localStorage.setItem(modeKey, m);
    } catch {
      // Remembered for this visit only.
    }
  };
  // A stock's own page in the Watchlist section, from a bot's map (user
  // 2026-10-27); the phone's Back returns to where it was opened.
  const openTicker = (ticker: string) => {
    setTradeSymbol(null);
    history.pushState(null, "", `#watchlist/${ticker}`);
    setModeState("watchlist");
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    const back = () => {
      const named = hashModes[location.hash.slice(1).split("/")[0]!];
      if (named) setModeState(named);
    };
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  const go = (m: Mode) => {
    setTradeSymbol(null);
    setMode(m);
  };
  // The sections and the dark mode switch, at the end of each page's header.
  const modes = (
    <div className="header-end">
      <nav className="modes" aria-label="Sections">
        {modeNames.map(([value, label]) =>
          value === mode ? (
            <span className="selected" key={value} aria-current="page">
              {label}
            </span>
          ) : (
            <button type="button" key={value} onClick={() => go(value)}>
              {label}
            </button>
          ),
        )}
      </nav>
      <ThemeButton />
    </div>
  );
  return (
    <>
      {mode === "watchlist" ? (
        <WatchlistPage
          modes={modes}
          onTrade={(ticker, how = "options") => {
            setTradeSymbol(ticker);
            setTradeMode(how);
            setMode("portfolio");
          }}
        />
      ) : mode === "portfolio" ? (
        <Portfolio
          key={`${tradeSymbol ?? ""}/${tradeMode}`}
          modes={modes}
          tradeSymbol={tradeSymbol}
          tradeMode={tradeMode}
          onOpenTicker={openTicker}
        />
      ) : (
        <BotBacktest modes={modes} />
      )}
      {/* Phones: the sections as a bottom bar, like a trading app. */}
      <nav className="tabbar" aria-label="Sections">
        {modeNames.map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-current={value === mode ? "page" : undefined}
            onClick={() => go(value)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={icons[value]} />
            </svg>
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}

/** A part of the page that failed (its code did not load): say so, never a blank page. */
class Failed extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice" role="alert">
        <p>
          This part of the page did not load. A new version may have just been
          published.
        </p>
        <button type="button" onClick={() => location.reload()}>
          Reload the page
        </button>
        <p className="muted small">{this.state.error}</p>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <Failed>
        <App />
      </Failed>
    </main>
  </StrictMode>,
);
