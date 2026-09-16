import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { isHealthResponse } from "../../../packages/contracts/src/index.js";
import "./styles.css";
import { VolumeReplay } from "./VolumeReplay.js";

function App() {
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "error"
  >("loading");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 5000);
    setConnection("loading");
    async function connect() {
      try {
        const response = await fetch("/api/health", {
          signal: controller.signal,
        });
        if (!response.ok || !isHealthResponse(await response.json())) {
          throw new Error("Unexpected service response");
        }
        if (active) setConnection("connected");
      } catch {
        if (active) setConnection("error");
      } finally {
        clearTimeout(timeout);
      }
    }
    void connect();
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  return (
    <main>
      <header>
        <span className="brand">
          SMA<span className="brand-dot">.</span>
        </span>
        <span className="badge">Development workspace</span>
      </header>
      <section className="intro">
        <p className="eyebrow">STOCK MARKET ASSISTANT</p>
        <h1>
          A clearer view
          <br />
          of the market.
        </h1>
        <p className="lede">
          Your workspace for market alerts, sector context, and historical
          replay.
        </p>
      </section>
      <section className="connection" aria-labelledby="connection-title">
        <div>
          <p className="eyebrow">WORKSPACE STATUS</p>
          <h2 id="connection-title">The foundation comes first.</h2>
          <p
            role="status"
            className={connection === "error" ? "error" : "status"}
          >
            {connection === "loading"
              ? "Connecting to workspace…"
              : connection === "connected"
                ? "Workspace connected"
                : "Workspace unavailable. Start the API and try again."}
          </p>
        </div>
        <button
          type="button"
          disabled={connection === "loading"}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {connection === "error" ? "Try again" : "Check connection"}
        </button>
      </section>
      <VolumeReplay />
      <section className="roadmap" aria-label="Planned capabilities">
        <article>
          <span className="number">01 / MONITOR</span>
          <h2>Market alerts</h2>
          <p>Spot the events that matter across your ticker universe.</p>
          <span className="planned">Planned</span>
        </article>
        <article>
          <span className="number">02 / UNDERSTAND</span>
          <h2>See the context</h2>
          <p>Compare a ticker with its sector and the broader market.</p>
          <span className="planned">Planned</span>
        </article>
        <article>
          <span className="number">03 / VALIDATE</span>
          <h2>Historical replay</h2>
          <p>Explore how your alert rules behave on past market data.</p>
          <span className="planned">Planned</span>
        </article>
      </section>
      <footer>
        Market data is not connected. Alerts and notifications are not active.
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
