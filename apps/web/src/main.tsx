import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseAlertLink } from "../../../packages/contracts/src/alert-link.js";
import { Backtest } from "./Backtest.js";
import { Live } from "./Live.js";
import { Portfolio } from "./Portfolio.js";
import { WatchlistPage } from "./WatchlistPage.js";
import "./styles.css";

// "live" is the alerts section; the stored value keeps its old name.
const modeNames = [
  ["live", "Alerts"],
  ["watchlist", "Watchlist"],
  ["portfolio", "Portfolio"],
  ["backtest", "Backtest"],
] as const;
const icons: Record<Mode, string> = {
  live: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4",
  watchlist: "M4 6h16M4 12h16M4 18h10",
  portfolio: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 4v8l6 4",
  backtest: "M4 19V5M4 19h16M8 15l4-4 3 3 5-6",
};
type Mode = (typeof modeNames)[number][0];
const modeKey = "sma.mode.v1";
// A link may name the section: #alerts, #watchlist, #portfolio, #backtest.
const hashModes: Record<string, Mode> = {
  alerts: "live",
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
    return modeNames.find(([value]) => value === saved)?.[0] ?? "live";
  } catch {
    return "live";
  }
}

// A notification link opens the Live view on that alert.
const link = parseAlertLink(location.search);

function App() {
  const [mode, setModeState] = useState<Mode>(link ? "live" : savedMode);
  // Where the watchlist sends a symbol: its alerts, or the trade ticket.
  const [alertSymbol, setAlertSymbol] = useState<string | null>(null);
  const [tradeSymbol, setTradeSymbol] = useState<string | null>(null);
  const [tradeMode, setTradeMode] = useState<"options" | "stock">("options");
  const setMode = (m: Mode) => {
    setModeState(m);
    window.scrollTo(0, 0);
    history.replaceState(null, "", `#${m === "live" ? "alerts" : m}`);
    try {
      localStorage.setItem(modeKey, m);
    } catch {
      // Remembered for this visit only.
    }
  };
  const go = (m: Mode) => {
    setAlertSymbol(null);
    setTradeSymbol(null);
    setMode(m);
  };
  const modes = (
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
  );
  return (
    <>
      {mode === "live" ? (
        <Live
          key={alertSymbol ?? ""}
          modes={modes}
          link={link}
          initialSymbol={alertSymbol}
        />
      ) : mode === "watchlist" ? (
        <WatchlistPage
          modes={modes}
          onShowAlerts={(ticker) => {
            setAlertSymbol(ticker);
            setMode("live");
          }}
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
        />
      ) : (
        <Backtest modes={modes} />
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <App />
    </main>
  </StrictMode>,
);
