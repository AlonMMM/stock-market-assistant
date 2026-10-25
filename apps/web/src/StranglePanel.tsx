import { useEffect, useState } from "react";
import {
  clockOf,
  defaultStrangleSettings,
  strangleLimits,
  strangleSteps,
  strangleUntested,
  type StrangleNumberKey,
  type StrangleSettings,
} from "../../../packages/trading/src/strangle/settings.js";
import type {
  StrangleTradeView,
  StrangleView,
} from "../../../packages/trading/src/strangle/view.js";
import { readJson } from "./api.js";
import { usePolling } from "./Live.js";
import { israelClock, israelLabel } from "./time.js";

// The strangle bot's tab (docs/tasks/backend-strangle-bot.md): what it does
// today, its trades, and, for the account owner, its settings. A separate
// bot on its own paper account; nothing here touches the Indi bot.

const ignore = () => {};
const usd = (v: number) =>
  `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const signedUsd = (v: number) =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const tone = (v: number) => (v > 0 ? " up" : v < 0 ? " down" : "");
const legWords = (contract: string) => {
  const m = /([CP])(\d{8})$/.exec(contract);
  return m
    ? `${Number(m[2]) / 1000} ${m[1] === "C" ? "call" : "put"}`
    : contract;
};
const phaseWords: Record<StrangleTradeView["phase"], string> = {
  buying: "buying both legs",
  open: "both legs on, waiting for the side",
  kept: "riding the kept leg",
  closing: "selling",
  closed: "closed",
};
const outcomeWords: Record<string, string> = {
  traded: "bought the strangle",
  "would-trade": "would buy (dry run)",
  no_expiry: "no same-day expiry",
  no_strikes: "no strikes",
  no_prices: "no prices",
  too_cheap: "a leg too cheap",
  thin: "a leg too thin",
  too_small: "size buys less than a pair",
  max_trades: "the day's trades are used",
  max_open: "too many open",
  day_loss: "day loss limit",
  earnings: "earnings day",
  premarket: "busy pre-market",
  refused: "refused by the risk rules",
  error: "failed",
};

/** The trade's result: what came back plus what is still held at its marks, against what was paid. */
function result(t: StrangleTradeView): { pnl: number; pct: number | null } {
  const value = t.got + (t.phase === "closed" ? 0 : (t.openValue ?? 0));
  const pnl = value - t.paid;
  return { pnl, pct: t.paid > 0 ? (pnl / t.paid) * 100 : null };
}

function TradeRow({ t }: { t: StrangleTradeView }) {
  const [open, setOpen] = useState(false);
  const r = result(t);
  const orders = [
    ...t.legs.C.orders.map((o) => ({ ...o, leg: t.legs.C.contract })),
    ...t.legs.P.orders.map((o) => ({ ...o, leg: t.legs.P.contract })),
  ].sort((a, b) => a.at - b.at);
  return (
    <>
      <tr
        className="st-row"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <td>{t.day.slice(5)}</td>
        <td>
          <b>{t.symbol}</b>
          {t.dry && <span className="muted small"> dry</span>}
        </td>
        <td>
          {clockOf(t.alertMinute)} {t.alertSide === "up" ? "▲" : "▼"}
        </td>
        <td>{t.kept ? (t.kept === "C" ? "call" : "put") : "—"}</td>
        <td className="muted small">
          {t.phase === "closed"
            ? (t.closeReason ?? "closed")
            : phaseWords[t.phase]}
        </td>
        <td className="num">{usd(t.paid)}</td>
        <td className={`num${tone(r.pnl)}`}>
          {signedUsd(r.pnl)}
          {r.pct !== null && ` (${r.pct > 0 ? "+" : ""}${r.pct.toFixed(0)}%)`}
        </td>
      </tr>
      {open && (
        <tr className="st-detail">
          <td colSpan={7}>
            <ol className="st-fills">
              {orders.map((o, i) => (
                <li key={i}>
                  <span className="muted">{israelClock(o.at)}</span>{" "}
                  {o.side === "buy" ? "Buy" : "Sell"} {o.qty} ×{" "}
                  {legWords(o.leg)}
                  {o.price !== undefined && ` at ${o.price.toFixed(2)}`}
                  <span className="muted small">
                    {" "}
                    · {o.reason}
                    {o.settled ? "" : " · working"}
                  </span>
                </li>
              ))}
            </ol>
            <p className="muted small">
              Call {legWords(t.legs.C.contract)}, put{" "}
              {legWords(t.legs.P.contract)}; stock at the fill{" "}
              {t.stockAtFill?.toFixed(2) ?? "—"}; the side at ±
              {(t.unit * 100 * 0.25).toFixed(2)}% of it (a quarter of a typical
              30-minute move, {(t.unit * 100).toFixed(2)}%).
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

export function StrangleActivity({ onSettings }: { onSettings?: () => void }) {
  const { value: v, error } = usePolling<StrangleView>(
    "/api/strangle",
    10000,
    ignore,
  );
  if (!v)
    return (
      <p className={error ? "notice error" : "chart-status"}>
        {error
          ? `The strangle bot is unavailable: ${error}`
          : "Loading the strangle bot…"}
      </p>
    );
  const closed = v.trades.filter((t) => t.phase === "closed");
  const total = closed.reduce((sum, t) => sum + (t.got - t.paid), 0);
  const winners = closed.filter((t) => t.got > t.paid).length;
  const alerts = v.signals;
  let state = v.enabled ? "On" : "Off";
  if (v.enabled)
    state +=
      v.mode === "dry"
        ? " · dry run, no orders"
        : " · trading its paper account";
  return (
    <div className="bot-panel">
      <section className="bot-card">
        <div className="bs-card-head">
          <h2>🎯 Alert strangle</h2>
          <span className={v.enabled ? "small bs-good" : "small muted"}>
            {state}
          </span>
          {onSettings && (
            <button type="button" className="bs-link" onClick={onSettings}>
              Settings
            </button>
          )}
        </div>
        <p className="muted small">
          A separate bot on its own paper account ({v.account}). Watching{" "}
          {v.watching.length} stocks
          {v.favorites ? ` from "${v.favorites.name}"` : ""}
          {v.lastWork
            ? `, last checked ${israelClock(v.lastWork)} ${israelLabel}`
            : ""}
          .
        </p>
        <ol className="bs-rules-list">
          {v.steps.map((s) => (
            <li key={s.name}>
              <b>{s.name}.</b> {s.text}
            </li>
          ))}
        </ol>
      </section>

      <section className="bot-card">
        <div className="bs-card-head">
          <h2>Last 30 days</h2>
          <span className="muted small">
            {closed.length} closed, {winners} winners
          </span>
        </div>
        <p className={`num st-total${tone(total)}`}>{signedUsd(total)}</p>
      </section>

      {v.open.length > 0 && (
        <section className="bot-card">
          <div className="bs-card-head">
            <h2>Open now</h2>
          </div>
          <div className="st-table-wrap">
            <table className="st-table">
              <tbody>
                {v.open.map((t) => (
                  <TradeRow key={t.id} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="bot-card">
        <div className="bs-card-head">
          <h2>Today's first alerts</h2>
          <span className="muted small">{alerts.length}</span>
        </div>
        {alerts.length === 0 ? (
          <p className="muted small">
            None yet. The first alert of each stock between{" "}
            {clockOf(v.settings.firstMinute)} and{" "}
            {clockOf(v.settings.lastMinute)} New York counts.
          </p>
        ) : (
          <ul className="st-alerts">
            {alerts.map((a) => (
              <li key={a.symbol}>
                <b>{a.symbol}</b> {clockOf(a.minute)}{" "}
                {a.side === "up" ? "▲" : "▼"}{" "}
                <span className="muted small">
                  {outcomeWords[a.outcome] ?? a.outcome}
                  {a.detail ? ` · ${a.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bot-card">
        <div className="bs-card-head">
          <h2>Trades</h2>
          <span className="muted small">Tap a trade for its fills</span>
        </div>
        {v.trades.length === 0 ? (
          <p className="muted small">No trades yet.</p>
        ) : (
          <div className="st-table-wrap">
            <table className="st-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Stock</th>
                  <th>Alert</th>
                  <th>Kept</th>
                  <th>State</th>
                  <th className="num">Paid</th>
                  <th className="num">Result</th>
                </tr>
              </thead>
              <tbody>
                {v.trades.map((t) => (
                  <TradeRow key={t.id} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bot-card">
        <div className="bs-card-head">
          <h2>Activity</h2>
        </div>
        <ul className="st-events">
          {v.events.slice(0, 60).map((e, i) => (
            <li key={i} className={`st-ev-${e.kind}`}>
              <span className="muted small">{israelClock(e.at)}</span> {e.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---- settings, for the account owner ----

interface Spec {
  key: StrangleNumberKey;
  label: string;
  help: string;
  fmt: (v: number) => string;
}
const pct = (v: number) => `${v}%`;
const count = (v: number) => String(v);
const clock = (v: number) => clockOf(v);
const groups: { title: string; specs: Spec[] }[] = [
  {
    title: "Size and limits",
    specs: [
      {
        key: "sizePct",
        label: "Size of one trade",
        help: "Both legs together, as a share of the account.",
        fmt: pct,
      },
      {
        key: "maxTradesPerDay",
        label: "Most trades a day",
        help: "Each trade is up to three buys; the account allows ten a day.",
        fmt: count,
      },
      {
        key: "maxOpen",
        label: "Most open trades",
        help: "A new alert waits out while this many are open.",
        fmt: count,
      },
      {
        key: "dayLossPct",
        label: "Day loss limit",
        help: "No new trade after the account is down this much today.",
        fmt: pct,
      },
      {
        key: "safetyStopPct",
        label: "Broker safety stop",
        help: "On every leg, in case the service is down. The account's rules need a stop.",
        fmt: (v) => `−${v}%`,
      },
    ],
  },
  {
    title: "Entry",
    specs: [
      {
        key: "firstMinute",
        label: "From",
        help: "New York time; the first alert of the day from here counts.",
        fmt: clock,
      },
      {
        key: "lastMinute",
        label: "Until",
        help: "No new strangle after this.",
        fmt: clock,
      },
      {
        key: "delta",
        label: "Delta of each leg",
        help: "The call and the put of the same-day expiry.",
        fmt: (v) => v.toFixed(2),
      },
      {
        key: "minPrice",
        label: "Cheapest leg",
        help: "Each leg's mid at least this.",
        fmt: (v) => `$${v.toFixed(2)}`,
      },
      {
        key: "minVolume",
        label: "Liquidity",
        help: "Contracts traded in the last 30 minutes, each leg.",
        fmt: count,
      },
    ],
  },
  {
    title: "The side and the exit",
    specs: [
      {
        key: "confirmUnits",
        label: "The side at",
        help: "The stock's move from the fill, in typical 30-minute moves.",
        fmt: (v) => `${v.toFixed(2)}×`,
      },
      {
        key: "waitMinutes",
        label: "Wait for the side",
        help: "No side by then: both legs out.",
        fmt: (v) => `${v} min`,
      },
      {
        key: "trailPct",
        label: "Trail on the kept leg",
        help: "Sold when it closes this far under its high.",
        fmt: pct,
      },
      {
        key: "endMinute",
        label: "Everything out by",
        help: "New York time.",
        fmt: clock,
      },
    ],
  },
];
const switches: {
  key:
    | "recycle"
    | "strengthFilter"
    | "skipEarnings"
    | "skipPremarket"
    | "followFavorites";
  label: string;
  help: string;
}[] = [
  {
    key: "recycle",
    label: "Wrong leg's money into the right one",
    help: "The D bonus: at the side, what the wrong leg brings back buys more of the kept leg.",
  },
  {
    key: "strengthFilter",
    label: "Strength must agree",
    help: "Keep the side only when the stock's strength vs SPY since the open points the same way; else both out.",
  },
  {
    key: "skipEarnings",
    label: "Skip earnings days",
    help: "No entry on the stock's earnings reaction day.",
  },
  {
    key: "skipPremarket",
    label: "Skip busy pre-markets",
    help: "No entry when pre-market volume is 4× normal or more.",
  },
  {
    key: "followFavorites",
    label: "Watch the favorites list",
    help: "The site sends it before each session.",
  },
];

export function StrangleSettingsPage({ onBack }: { onBack: () => void }) {
  const [saved, setSaved] = useState<StrangleSettings | null>(null);
  const [draft, setDraft] = useState<StrangleSettings | null>(null);
  const [state, setState] = useState<
    | { step: "loading" | "ready" | "saving" | "saved" }
    | { step: "failed"; message: string }
  >({ step: "loading" });
  const [tickers, setTickers] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/strangle/settings", { signal: AbortSignal.timeout(15000) })
      .then((r) => readJson<StrangleSettings>(r))
      .then((s) => active && (setSaved(s), setState({ step: "ready" })))
      .catch(
        (e: unknown) =>
          active &&
          setState({
            step: "failed",
            message: e instanceof Error ? e.message : "Loading failed",
          }),
      );
    return () => {
      active = false;
    };
  }, []);
  const s = draft ?? saved;
  if (!s)
    return (
      <p className={state.step === "failed" ? "notice error" : "notice"}>
        {state.step === "failed"
          ? `The strangle bot's settings are unavailable: ${state.message}`
          : "Loading the strangle bot's settings…"}
      </p>
    );
  const put = (patch: Partial<StrangleSettings>) => {
    setDraft({ ...s, ...patch });
    setState({ step: "ready" });
  };
  const dirty = saved !== null && JSON.stringify(s) !== JSON.stringify(saved);
  const save = async () => {
    setState({ step: "saving" });
    try {
      const next = await readJson<StrangleSettings>(
        await fetch("/api/strangle/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(s),
          signal: AbortSignal.timeout(15000),
        }),
      );
      setSaved(next);
      setDraft(null);
      setState({ step: "saved" });
    } catch (e) {
      setState({
        step: "failed",
        message: e instanceof Error ? e.message : "Saving failed",
      });
    }
  };
  let status = "All changes saved.";
  let statusTone = "muted";
  if (state.step === "saving") status = "Saving…";
  else if (state.step === "failed") {
    status = `Not saved: ${state.message}`;
    statusTone = "bs-bad";
  } else if (dirty) {
    status =
      "Unsaved changes. Stocks apply from the next session, the rest from the next minute.";
    statusTone = "bs-changed";
  } else if (state.step === "saved") {
    status = "Saved. The strangle bot uses the new settings.";
    statusTone = "bs-good";
  }
  const addTickers = () => {
    const list = tickers
      .toUpperCase()
      .split(/[\s,]+/)
      .filter((t) => /^[A-Z][A-Z.]{0,5}$/.test(t));
    if (list.length) put({ added: [...new Set([...s.added, ...list])] });
    setTickers("");
  };
  return (
    <div className="bot-panel bot-settings">
      <div className="bs-head">
        <div className="bs-title">
          <button type="button" className="bs-back" onClick={onBack}>
            ← Back to the strangle
          </button>
          <h2 className="portfolio-title">Strangle settings</h2>
          <p className="muted small">
            Only you see this page. Everyone else sees the Strangle tab,
            read-only.
          </p>
        </div>
        <div className="bs-switches">
          <button
            type="button"
            className="bs-tog bs-power"
            aria-pressed={s.enabled}
            onClick={() => put({ enabled: !s.enabled })}
          >
            <span className={s.enabled ? "dot on" : "dot"} aria-hidden="true" />
            {s.enabled ? "Strangle on" : "Strangle off"}
          </button>
          <div className="bs-seg" role="group" aria-label="Mode">
            <button
              type="button"
              aria-pressed={s.mode === "live"}
              onClick={() => put({ mode: "live" })}
            >
              Trade its paper account
            </button>
            <button
              type="button"
              aria-pressed={s.mode === "dry"}
              onClick={() => put({ mode: "dry" })}
            >
              Dry run, no orders
            </button>
          </div>
        </div>
      </div>

      <section className="bot-card bs-card">
        <div className="bs-card-head">
          <h2>The rule, as set</h2>
        </div>
        <ol className="bs-rules-list">
          {strangleSteps(s).map((x) => (
            <li key={x.name}>
              <b>{x.name}.</b> {x.text}
            </li>
          ))}
        </ol>
      </section>

      {groups.map((g) => (
        <section key={g.title} className="bot-card bs-card">
          <div className="bs-card-head">
            <h2>{g.title}</h2>
          </div>
          {g.specs.map((spec) => {
            const [min, max, step] = strangleLimits[spec.key];
            const base = defaultStrangleSettings[spec.key];
            const value = s[spec.key];
            const source = strangleUntested.has(spec.key)
              ? "Default"
              : "Backtest";
            const changed = value !== base;
            const id = `st-${spec.key}`;
            return (
              <div className="bs-row" key={spec.key}>
                <div className="bs-what">
                  <label htmlFor={id}>{spec.label}</label>
                  <span className="muted small">{spec.help}</span>
                </div>
                <div className="bs-control">
                  <div className="bs-value">
                    <b>{spec.fmt(value)}</b>
                    <span className={changed ? "bs-changed" : "muted"}>
                      {changed
                        ? `Changed · ${source.toLowerCase()} ${spec.fmt(base)}`
                        : `${source}: ${spec.fmt(base)}`}
                    </span>
                  </div>
                  <input
                    id={id}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) =>
                      put({
                        [spec.key]: Number(
                          (
                            Math.round(Number(e.target.value) / step) * step
                          ).toFixed(4),
                        ),
                      })
                    }
                  />
                  <div className="bs-ends" aria-hidden="true">
                    <span>{spec.fmt(min)}</span>
                    <span>{spec.fmt(max)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      ))}

      <section className="bot-card bs-card">
        <div className="bs-card-head">
          <h2>Switches</h2>
        </div>
        {switches.map((w) => (
          <div className="bs-row bs-switch" key={w.key}>
            <div className="bs-what">
              <span className="bs-label">{w.label}</span>
              <span className="muted small">{w.help}</span>
            </div>
            <button
              type="button"
              className="bs-tog"
              aria-pressed={s[w.key]}
              aria-label={w.label}
              onClick={() => put({ [w.key]: !s[w.key] })}
            >
              {s[w.key] ? "On" : "Off"}
            </button>
          </div>
        ))}
      </section>

      <section className="bot-card bs-card">
        <div className="bs-card-head">
          <h2>Stocks</h2>
          <span className="muted small">
            Yours, plus the favorites list if watched; the ones turned off are
            left out.
          </span>
        </div>
        <div className="bs-row">
          <div className="bs-what">
            <label htmlFor="st-add">Add stocks</label>
            <span className="muted small">
              Tickers, separated by spaces or commas.
            </span>
          </div>
          <div className="bs-control">
            <input
              id="st-add"
              value={tickers}
              onChange={(e) => setTickers(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTickers()}
            />
            <button type="button" className="bs-secondary" onClick={addTickers}>
              Add
            </button>
          </div>
        </div>
        <ul className="st-tickers">
          {s.added.map((t) => (
            <li key={t}>
              {t}{" "}
              <button
                type="button"
                className="bs-link"
                aria-label={`Remove ${t}`}
                onClick={() => put({ added: s.added.filter((x) => x !== t) })}
              >
                ×
              </button>
            </li>
          ))}
          {s.off.map((t) => (
            <li key={`off-${t}`} className="muted">
              {t} off{" "}
              <button
                type="button"
                className="bs-link"
                aria-label={`Turn ${t} back on`}
                onClick={() => put({ off: s.off.filter((x) => x !== t) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="bs-savebar">
        <span className={`small ${statusTone}`} role="status">
          {status}
        </span>
        <button
          type="button"
          className="bs-secondary"
          disabled={!dirty}
          onClick={() => (setDraft(null), setState({ step: "ready" }))}
        >
          Undo changes
        </button>
        <button
          type="button"
          className="bs-secondary"
          onClick={() =>
            put({
              ...defaultStrangleSettings,
              enabled: s.enabled,
              mode: s.mode,
              added: s.added,
              off: s.off,
            })
          }
        >
          Backtested values
        </button>
        <button
          type="button"
          className="bs-primary"
          disabled={!dirty || state.step === "saving"}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </div>
  );
}
