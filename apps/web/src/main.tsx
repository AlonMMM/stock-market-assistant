import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Backtest } from "./Backtest.js";
import { VolumeReplay } from "./VolumeReplay.js";
import "./styles.css";

type Mode = "replay" | "backtest";

function App() {
  const [mode, setMode] = useState<Mode>("replay");
  const modes = (
    <nav className="modes" aria-label="Data mode">
      {(
        [
          ["replay", "Replay"],
          ["backtest", "Backtest"],
        ] as const
      ).map(([value, label]) =>
        value === mode ? (
          <span className="selected" key={value}>
            ▶ {label}
          </span>
        ) : (
          <button type="button" key={value} onClick={() => setMode(value)}>
            {label}
          </button>
        ),
      )}
      <button disabled>Live · Coming soon</button>
    </nav>
  );
  return mode === "replay" ? (
    <VolumeReplay modes={modes} />
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
