import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseAlertLink } from "../../../packages/contracts/src/alert-link.js";
import { Backtest } from "./Backtest.js";
import { Live } from "./Live.js";
import { Portfolio } from "./Portfolio.js";
import "./styles.css";

const modeNames = [
  ["live", "Live"],
  ["backtest", "Backtest"],
  ["portfolio", "Portfolio"],
] as const;
type Mode = (typeof modeNames)[number][0];
const modeKey = "sma.mode.v1";
function savedMode(): Mode {
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
      {modeNames.map(([value, label]) =>
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
  ) : mode === "portfolio" ? (
    <Portfolio modes={modes} />
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
