import { useRef, useState, type ReactNode } from "react";
import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
import { AlertCard, number } from "./AlertCard.js";
type Result = {
  source: string;
  evaluated: number;
  alerts: Evaluation[];
  diagnostics: Record<string, number>;
};
export function VolumeReplay({ modes }: { modes: ReactNode }) {
  const [threshold, setThreshold] = useState(3);
  const [minimum, setMinimum] = useState(10000);
  const [cooldown, setCooldown] = useState(15);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  function changed() {
    setResult(null);
    setError("");
  }
  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (file && file.size > 900000)
        throw new Error("Choose a JSON file smaller than 900 KB.");
      const bars: unknown = file ? JSON.parse(await file.text()) : undefined;
      if (file && !Array.isArray(bars))
        throw new Error(
          "The JSON file must contain an array of closed minute bars.",
        );
      const response = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { threshold, minVolume: minimum, cooldown },
          bars,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Replay failed");
      setResult(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replay failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header>
        <span className="brand">
          SMA<span className="brand-dot">.</span>
        </span>
        <span className="badge">{file ? "HISTORICAL DATA" : "DEMO DATA"}</span>
      </header>
      <h1>Relative volume</h1>
      <p className="lede">Find activity unusual for this time of day.</p>
      {modes}
      <p className="method">
        5-minute volume / same-time median · 20 prior sessions
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="volume-controls">
          <label>
            Alert threshold (×)
            <input
              aria-label="Alert ratio"
              required
              disabled={busy}
              type="number"
              min="1.1"
              step="0.1"
              value={threshold}
              onChange={(e) => {
                setThreshold(Number(e.target.value));
                changed();
              }}
            />
          </label>
          <label>
            Minimum volume
            <input
              required
              disabled={busy}
              type="number"
              min="0"
              step="1"
              value={minimum}
              onChange={(e) => {
                setMinimum(Number(e.target.value));
                changed();
              }}
            />
          </label>
          <label>
            Cooldown (min)
            <input
              required
              disabled={busy}
              type="number"
              min="0"
              max="1440"
              step="1"
              value={cooldown}
              onChange={(e) => {
                setCooldown(Number(e.target.value));
                changed();
              }}
            />
          </label>
        </div>
        <button className="run" disabled={busy} type="submit">
          {busy ? "Running…" : "Run replay"}
        </button>
        <input
          hidden
          ref={upload}
          aria-label="Historical bars"
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            changed();
          }}
        />
        <button
          className="upload"
          type="button"
          disabled={busy}
          onClick={() => upload.current?.click()}
        >
          ↑ Upload historical JSON
        </button>
        {file && (
          <div className="file-row">
            <span>{file.name}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setFile(null);
                if (upload.current) upload.current.value = "";
                changed();
              }}
            >
              Use demo
            </button>
          </div>
        )}
      </form>
      {error && (
        <p className="notice error" role="alert">
          {error} You can try running the replay again.
        </p>
      )}
      <div aria-live="polite" aria-busy={busy}>
        {busy && (
          <p className="notice">
            Evaluating closed bars and matching historical windows…
          </p>
        )}
        {!result && !busy && !error && (
          <p className="notice">
            Ready to explore. Run the synthetic demo or upload historical data
            to see alerts.
          </p>
        )}
        {result && (
          <section className="results">
            <div className="result-header">
              <h2>
                {result.alerts.length}{" "}
                {result.alerts.length === 1 ? "alert" : "alerts"} detected
              </h2>
              <span className="badge">
                {result.source === "synthetic-demo"
                  ? "Synthetic replay"
                  : "Historical replay"}
              </span>
            </div>
            {result.alerts.length === 0 && (
              <p className="notice">No alerts matched these settings.</p>
            )}
            {result.alerts.map((a) => (
              <AlertCard alert={a} key={a.ticker + a.end} />
            ))}
            <details>
              <summary>Data quality &amp; suppressed signals</summary>
              <p>{number(result.evaluated)} complete windows evaluated.</p>
              <ul>
                {Object.entries(result.diagnostics).map(([s, n]) => (
                  <li key={s}>
                    {s.replaceAll("-", " ")}: {number(n)}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        )}
      </div>
      <footer>
        {file ? "Uploaded historical data." : "Illustrative data."} Live market
        feed is not connected.
      </footer>
    </>
  );
}
