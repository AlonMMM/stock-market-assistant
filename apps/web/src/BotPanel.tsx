import type { BotView } from "../../../packages/trading/src/bot-api.js";
import { usePolling } from "./Live.js";
import { israelClock, israelLabel, israelShortDate } from "./time.js";

// The Indi bot on the Portfolio page (docs/tasks/backend-indi-bot.md): whether
// it runs, today's signals and what it holds or sold. Read-only; it trades in
// the same paper account, so its positions also appear under Live trades and
// History, marked with the Bot chip.

const refreshMs = 15000;
const ignore = () => {};

const outcomeText: Record<string, string> = {
  bought: "Bought",
  "would-buy": "Would buy (dry run)",
  no_expiry: "Skipped: no expiry 1–7 days out",
  no_strikes: "Skipped: no strikes",
  no_prices: "Skipped: no prices",
  too_cheap: "Skipped: contract under $0.20",
  too_small: "Skipped: 2% buys less than one contract",
  thin: "Skipped: too few contracts traded",
  held: "Skipped: you hold this contract",
  refused: "Refused by the risk rules",
  error: "Failed",
  new: "Working",
};

const reasonText: Record<string, string> = {
  "check-10": "10-min check",
  "check-20": "20-min check",
  "stop-30": "−30% stop",
  "close-1550": "15:50 close",
  "morning-gap-keep": "morning, gap our way",
  "morning-gap-against": "morning, no gap",
  "expiry-day": "expiry day",
};

/** Contracts the bot opened in the last sessions, for the Bot chip. */
export function useBotContracts(): ReadonlySet<string> {
  const { value } = usePolling<BotView>("/api/bot", 30000, ignore);
  return new Set((value?.positions ?? []).map((p) => p.contract));
}

export function BotChip() {
  return (
    <span className="bot-chip" title="Opened by the Indi bot">
      🤖 Bot
    </span>
  );
}

function contractName(contract: string): string {
  const m = /^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(contract);
  if (!m) return contract;
  return `${m[1]} ${Number(m[6]) / 1000} ${m[5] === "C" ? "Call" : "Put"} ${Number(m[3])}/${Number(m[4])}`;
}

function sessionTime(minute: number): string {
  const wall = 570 + minute;
  return `${Math.floor(wall / 60)}:${String(wall % 60).padStart(2, "0")} NY`;
}

function statusPill(v: BotView) {
  if (!v.enabled) return <span className="pill grey">Off</span>;
  if (v.mode === "dry")
    return <span className="pill amber">On · dry run, no orders</span>;
  return <span className="pill green">On · trading the paper account</span>;
}

export function BotPanel() {
  const { value, error } = usePolling<BotView>("/api/bot", refreshMs, ignore);
  if (!value)
    return (
      <p className="notice">
        {error ? "The bot's status is not available." : "Loading…"}
      </p>
    );
  const open = value.positions.filter((p) => p.status !== "closed");
  const closed = value.positions.filter((p) => p.status === "closed").reverse();
  return (
    <div className="bot-panel">
      <div className="bot-head">
        <h2 className="portfolio-title">🤖 Indi bot</h2>
        {statusPill(value)}
      </div>
      <p className="muted">
        C signal on {value.universe.length} stocks Indi traded in the past year
        · delta {value.delta} · {value.sizePct}% of the account a trade · your
        stop, winners up 100% held overnight.
      </p>

      <h3>Today's signals</h3>
      {value.signals.length === 0 ? (
        <p className="muted">No signal yet today.</p>
      ) : (
        <ul className="bot-list">
          {value.signals.map((s) => (
            <li key={s.symbol}>
              <strong>
                {s.symbol} {s.right === "C" ? "call" : "put"}
              </strong>
              <span className="muted">
                {" "}
                {sessionTime(s.minute)} · t {s.t.toFixed(1)} · volume{" "}
                {s.rvol.toFixed(1)}×
              </span>
              <div>
                {outcomeText[s.outcome] ?? s.outcome}
                {s.detail && <span className="muted"> · {s.detail}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>Holding</h3>
      {open.length === 0 ? (
        <p className="muted">Nothing open.</p>
      ) : (
        <ul className="bot-list">
          {open.map((p) => (
            <li key={p.id}>
              <strong>{contractName(p.contract)}</strong>
              {p.dry && <span className="muted"> (dry run)</span>}
              <div className="muted">
                {p.status === "buying"
                  ? "Buying…"
                  : `${p.qty} contracts at ${p.cost.toFixed(2)}`}
                {p.nights > 0 &&
                  ` · held ${p.nights} night${p.nights === 1 ? "" : "s"}`}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>Closed, last 5 sessions</h3>
      {closed.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="bot-list">
          {closed.map((p) => (
            <li key={p.id}>
              <strong>{contractName(p.contract)}</strong>
              <span className="muted">
                {" "}
                {israelShortDate(p.openedAt)} · {p.bought} at{" "}
                {p.cost.toFixed(2)}
                {p.dry && " · dry run"}
              </span>
              <div className="muted">
                {p.sales
                  .map(
                    (s) =>
                      `${israelClock(s.at)} sold ${s.qty} (${reasonText[s.reason] ?? s.reason})`,
                  )
                  .join(" · ") || "Closed outside the bot"}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Times of sales in {israelLabel}; signal times in New York session time.
      </p>
    </div>
  );
}
