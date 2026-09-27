import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Backtest } from "./Backtest.js";
import "./styles.css";

function App() {
  const modes = (
    <nav className="modes" aria-label="Data mode">
      <span className="selected">▶ Backtest</span>
      <button disabled>Live · Coming soon</button>
    </nav>
  );
  return <Backtest modes={modes} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <App />
    </main>
  </StrictMode>,
);
