import { useEffect, useState } from "react";
import type {
  PriceAlert,
  PriceAlertKind,
} from "../../../packages/market-data/src/price-alerts.js";
import { readJson } from "./api.js";

// The user's own price alerts (user 2026-10-18): separate from the volume
// alerts the system finds. A level in dollars, or a % move today, on one
// stock; the server checks them every minute and sends each one that is met
// to Telegram once. Set from a stock's page; all of them on their own page.

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const money = (n: number) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** "Above $220.00", "Down 3% today". */
export function alertRule(a: Pick<PriceAlert, "kind" | "value">): string {
  return a.kind === "above"
    ? `Above $${money(a.value)}`
    : a.kind === "below"
      ? `Below $${money(a.value)}`
      : `${a.kind === "up" ? "Up" : "Down"} ${a.value}% today`;
}

async function call(method: string, path: string, body?: unknown) {
  return readJson<unknown>(
    await fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(15000),
    }),
  );
}

/** The alerts (of one stock, or all), kept fresh every minute. */
export function usePriceAlerts(ticker?: string) {
  const [alerts, setAlerts] = useState<PriceAlert[] | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    call(
      "GET",
      `/api/price-alerts${ticker ? `?ticker=${encodeURIComponent(ticker)}` : ""}`,
    )
      .then((b) => {
        setAlerts((b as { alerts: PriceAlert[] }).alerts);
        setError("");
      })
      .catch((e: unknown) => setError((e as Error).message));
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => clearInterval(timer);
  }, [ticker]);
  const act = async (work: Promise<unknown>) => {
    await work;
    await load();
  };
  return {
    alerts,
    error,
    reload: load,
    create: (body: {
      ticker: string;
      kind: PriceAlertKind;
      value: number;
      note?: string;
    }) => act(call("POST", "/api/price-alerts", body)),
    remove: (id: string) => act(call("DELETE", `/api/price-alerts/${id}`)),
    rearm: (id: string) => act(call("POST", `/api/price-alerts/${id}/rearm`)),
  };
}
export type PriceAlertsApi = ReturnType<typeof usePriceAlerts>;

export function BellIcon() {
  return (
    <svg className="pa-bell" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16ZM10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

const pricePresets = [-5, -2, -1, 1, 2, 5];
const movePresets = [1, 2, 3, 5, 10];

/** The sheet that sets one alert on a stock. */
export function PriceAlertSheet({
  ticker,
  last,
  previousClose,
  api,
  onClose,
}: {
  ticker: string;
  last: number | null;
  previousClose: number | null;
  api: PriceAlertsApi;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"price" | "move">(
    last === null ? "move" : "price",
  );
  const [level, setLevel] = useState(
    last === null ? "" : (last * 1.02).toFixed(2),
  );
  const [up, setUp] = useState(true);
  const [pct, setPct] = useState("3");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);

  const n = Number(mode === "price" ? level : pct);
  const valid =
    (mode === "price" ? level : pct).trim() !== "" &&
    n > 0 &&
    (mode === "price" || n < 100);
  // A level above the price waits for a rise; below it, for a fall.
  const kind: PriceAlertKind =
    mode === "move"
      ? up
        ? "up"
        : "down"
      : last === null || n >= last
        ? "above"
        : "below";
  const fromNow =
    mode === "price" && valid && last ? ((n - last) / last) * 100 : null;
  const today =
    last !== null && previousClose
      ? ((last - previousClose) / previousClose) * 100
      : null;
  const sentence = !valid
    ? "Enter a level."
    : mode === "price"
      ? `When ${ticker} trades ${kind === "above" ? "at or above" : "at or below"} $${money(n)}${fromNow === null ? "" : ` — ${Math.abs(fromNow).toFixed(1)}% ${fromNow >= 0 ? "above" : "below"} now`}.`
      : `When ${ticker} is ${up ? "up" : "down"} ${n}% or more today, from yesterday's close${previousClose ? ` ($${money(previousClose * (1 + ((up ? 1 : -1) * n) / 100))})` : ""}.`;

  return (
    <div className="pa-backdrop" onClick={onClose}>
      <form
        className="pa-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Price alert on ${ticker}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || busy) return;
          setBusy(true);
          setError("");
          api
            .create({
              ticker,
              kind,
              value: n,
              ...(note.trim() ? { note: note.trim() } : {}),
            })
            .then(onClose)
            .catch((err: unknown) => setError((err as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="pa-sheet-head">
          <span className="pa-sheet-icon">
            <BellIcon />
          </span>
          <div>
            <h3>Price alert</h3>
            <p className="muted">
              {ticker}
              {last !== null && (
                <>
                  {" "}
                  <b className="num">${money(last)}</b>
                </>
              )}
              {today !== null && (
                <span className={`num ${today >= 0 ? "up" : "down"}`}>
                  {" "}
                  {today >= 0 ? "+" : "−"}
                  {Math.abs(today).toFixed(2)}%
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            className="pa-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="segmented pa-mode" role="group" aria-label="Alert on">
          <button
            type="button"
            aria-pressed={mode === "price"}
            disabled={last === null}
            onClick={() => setMode("price")}
          >
            Price level
          </button>
          <button
            type="button"
            aria-pressed={mode === "move"}
            onClick={() => setMode("move")}
          >
            % move today
          </button>
        </div>

        {mode === "price" ? (
          <>
            <label className="pa-big">
              <span aria-hidden="true">$</span>
              <input
                className="num"
                inputMode="decimal"
                aria-label="Price level"
                value={level}
                disabled={busy}
                autoFocus
                onChange={(e) =>
                  setLevel(e.target.value.replace(/[^\d.]/g, ""))
                }
              />
              {valid && (
                <span className={`pa-dir ${kind}`}>
                  {kind === "above" ? "▲ above" : "▼ below"}
                </span>
              )}
            </label>
            <div className="pa-chips" role="group" aria-label="From the price">
              {pricePresets.map((p) => (
                <button
                  type="button"
                  key={p}
                  disabled={busy || last === null}
                  onClick={() =>
                    last !== null && setLevel((last * (1 + p / 100)).toFixed(2))
                  }
                >
                  {p > 0 ? "+" : "−"}
                  {Math.abs(p)}%
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="pa-move">
              <div className="segmented" role="group" aria-label="Direction">
                <button
                  type="button"
                  className="pa-up"
                  aria-pressed={up}
                  onClick={() => setUp(true)}
                >
                  ▲ Up
                </button>
                <button
                  type="button"
                  className="pa-down"
                  aria-pressed={!up}
                  onClick={() => setUp(false)}
                >
                  ▼ Down
                </button>
              </div>
              <label className="pa-big">
                <input
                  className="num"
                  inputMode="decimal"
                  aria-label="Percent"
                  value={pct}
                  disabled={busy}
                  onChange={(e) =>
                    setPct(e.target.value.replace(/[^\d.]/g, ""))
                  }
                />
                <span aria-hidden="true">%</span>
              </label>
            </div>
            <div className="pa-chips" role="group" aria-label="Percent">
              {movePresets.map((p) => (
                <button
                  type="button"
                  key={p}
                  aria-pressed={Number(pct) === p}
                  disabled={busy}
                  onClick={() => setPct(String(p))}
                >
                  {p}%
                </button>
              ))}
            </div>
          </>
        )}

        <input
          className="pa-note"
          aria-label="Note (optional)"
          placeholder="Note, e.g. breakout over the high"
          maxLength={80}
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="pa-sentence">{sentence}</p>
        <p className="muted pa-small">
          Checked every minute, pre- and after-hours too. Sent once to Telegram
          on your phone; then you can arm it again.
        </p>
        {error && (
          <p className="pos-problem" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="pos-go" disabled={!valid || busy}>
          {busy ? "Saving…" : "Set alert"}
        </button>
      </form>
    </div>
  );
}

/** Alerts as rows: the rule, its stock, armed or when it fired. */
export function PriceAlertList({
  alerts,
  api,
  showTicker,
  onOpenTicker,
}: {
  alerts: PriceAlert[];
  api: PriceAlertsApi;
  showTicker: boolean;
  onOpenTicker?: (ticker: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const run = (id: string, work: Promise<unknown>) => {
    setBusy(id);
    setError("");
    work
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setBusy(null));
  };
  return (
    <>
      <ul className="pa-list">
        {alerts.map((a) => {
          const fired = a.firedAt !== null;
          return (
            <li key={a.id} className={fired ? "fired" : "armed"}>
              <span className={`pa-arrow ${a.kind}`} aria-hidden="true">
                {a.kind === "above" || a.kind === "up" ? "▲" : "▼"}
              </span>
              <span className="pa-what">
                {showTicker &&
                  (onOpenTicker ? (
                    <button
                      type="button"
                      className="pa-ticker"
                      onClick={() => onOpenTicker(a.ticker)}
                    >
                      {a.ticker}
                    </button>
                  ) : (
                    <b className="pa-ticker">{a.ticker}</b>
                  ))}
                <span className="num">{alertRule(a)}</span>
                {a.note && <small className="muted">{a.note}</small>}
              </span>
              <span className="pa-state">
                {fired ? (
                  <small className="muted num">
                    Fired {clock.format(a.firedAt!)}
                    {a.firedPrice !== null && ` at $${money(a.firedPrice)}`}
                  </small>
                ) : (
                  <span className="pa-pill">Armed</span>
                )}
                <span className="pa-row-actions">
                  {fired && (
                    <button
                      type="button"
                      className="action"
                      disabled={busy === a.id}
                      onClick={() => run(a.id, api.rearm(a.id))}
                    >
                      Arm again
                    </button>
                  )}
                  <button
                    type="button"
                    className="action"
                    disabled={busy === a.id}
                    aria-label={`Delete ${a.ticker} ${alertRule(a)}`}
                    onClick={() => run(a.id, api.remove(a.id))}
                  >
                    Delete
                  </button>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="pos-problem" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Every price alert, on its own page (from the watchlist's bell). */
export function PriceAlertsPage({
  onBack,
  onOpenTicker,
}: {
  onBack: () => void;
  onOpenTicker: (ticker: string) => void;
}) {
  const api = usePriceAlerts();
  const armed = (api.alerts ?? []).filter((a) => a.firedAt === null);
  const fired = (api.alerts ?? []).filter((a) => a.firedAt !== null);
  return (
    <div className="tk pa-page">
      <button type="button" className="tk-back" onClick={onBack}>
        ‹ Watchlist
      </button>
      <div className="pa-page-head">
        <span className="pa-sheet-icon">
          <BellIcon />
        </span>
        <div>
          <h2>Price alerts</h2>
          <p className="muted">
            Your own levels and % moves, sent to Telegram. The volume alerts the
            system finds are under Alerts.
          </p>
        </div>
      </div>
      {api.error && <p className="notice error">{api.error}</p>}
      {api.alerts && api.alerts.length === 0 && (
        <section className="tk-card pa-empty">
          <p>No price alerts yet.</p>
          <p className="muted">
            Open a stock from the watchlist and tap Price alert.
          </p>
        </section>
      )}
      {armed.length > 0 && (
        <section className="tk-card">
          <h3>Armed · {armed.length}</h3>
          <PriceAlertList
            alerts={armed}
            api={api}
            showTicker
            onOpenTicker={onOpenTicker}
          />
        </section>
      )}
      {fired.length > 0 && (
        <section className="tk-card">
          <h3>Fired · {fired.length}</h3>
          <PriceAlertList
            alerts={fired}
            api={api}
            showTicker
            onOpenTicker={onOpenTicker}
          />
        </section>
      )}
    </div>
  );
}
