import { useState } from "react";
import type { Evaluation } from "../../../packages/alerts/src/relative-volume.js";
type Result = {
  source: string;
  evaluated: number;
  alerts: Evaluation[];
  diagnostics: Record<string, number>;
};
export function VolumeReplay() {
  const [threshold, setThreshold] = useState(3);
  const [minimum, setMinimum] = useState(10000);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const bars: unknown = file ? JSON.parse(await file.text()) : undefined;
      const response = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { threshold, minVolume: minimum },
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
    <section className="volume-replay" aria-labelledby="volume-title">
      <p className="eyebrow">RELATIVE VOLUME / REPLAY</p>
      <h2 id="volume-title">Unusual volume for this time of day</h2>
      <p>
        Five-minute volume vs. the median of the same window over 20 prior
        session dates.
      </p>
      <p>
        <strong>Synthetic demo — not live market data.</strong> Upload
        normalized historical bars to test your own data.
      </p>
      <div className="volume-controls">
        <label>
          Alert ratio{" "}
          <input
            type="number"
            min="1.1"
            step="0.1"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
        <label>
          Minimum window volume{" "}
          <input
            type="number"
            min="0"
            step="1000"
            value={minimum}
            onChange={(e) => setMinimum(Number(e.target.value))}
          />
        </label>
        <label>
          Historical bars (JSON, optional){" "}
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
          />
        </label>
        <button disabled={busy} onClick={() => void run()}>
          {busy ? "Running…" : "Run replay"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div aria-live="polite">
          <p>
            {result.source === "synthetic-demo"
              ? "Synthetic demo"
              : "Uploaded data"}{" "}
            · {result.evaluated} evaluated windows · {result.alerts.length}{" "}
            alerts
          </p>
          {result.alerts.length === 0 && (
            <p>No alerts matched these settings.</p>
          )}
          {result.alerts.map((a) => (
            <article className="volume-alert" key={`${a.ticker}-${a.end}`}>
              <h3>
                {a.ticker} · {a.ratio?.toFixed(1)}× volume
              </h3>
              <p>
                {new Date(a.end).toLocaleString("en-US", {
                  timeZone: "America/New_York",
                })}{" "}
                New York · {a.session}
              </p>
              <p>
                {a.actual.toLocaleString()} shares vs.{" "}
                {a.expected?.toLocaleString()} expected · {a.samples} historical
                samples
              </p>
              <small>
                {a.rule} · threshold {a.config.threshold}× · cooldown{" "}
                {a.config.cooldown} min
              </small>
            </article>
          ))}
          <details>
            <summary>Data quality and suppressed signals</summary>
            <ul>
              {Object.entries(result.diagnostics).map(([s, n]) => (
                <li key={s}>
                  {s}: {n}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
