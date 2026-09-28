import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseAlertLink } from "../../../packages/contracts/src/alert-link.js";
import { Backtest } from "./Backtest.js";
import { Live } from "./Live.js";
import "./styles.css";

type Mode = "backtest" | "live";
const modeKey = "sma.mode.v1";
function savedMode(): Mode {
  try {
    return localStorage.getItem(modeKey) === "backtest" ? "backtest" : "live";
  } catch {
    return "live";
  }
}

// A notification link opens the Live view on that alert.
const link = parseAlertLink(location.search);

function App() {
  const [mode, setModeState] = useState<Mode>(link ? "live" : savedMode);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(modeKey, m);
    } catch {
      // Remembered for this visit only.
    }
  };
  const modes = (
    <nav className="modes" aria-label="Data mode">
      {(
        [
          ["live", "Live"],
          ["backtest", "Backtest"],
        ] as const
      ).map(([value, label]) =>
        value === mode ? (
          <span className="selected" key={value} aria-current="page">
            {label}
          </span>
        ) : (
          <button type="button" key={value} onClick={() => setMode(value)}>
            {label}
          </button>
        ),
      )}
    </nav>
  );
  return mode === "live" ? (
    <Live modes={modes} link={link} />
  ) : (
    <Backtest modes={modes} />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <App />
    </main>
  </StrictMode>,
);
