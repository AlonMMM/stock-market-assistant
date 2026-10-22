import { newYork } from "../../../packages/market-data/src/calendar.js";
import type { BotView } from "../../../packages/trading/src/bot-api.js";
import {
  contractWords,
  contractsInWords,
  parseOccSymbol,
} from "../../../packages/trading/src/options.js";
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
  earnings: "Skipped: earnings reaction day",
  premarket: "Skipped: pre-market volume 4× normal or more",
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

/** "MU Put 75 · 2DTE": days to expiry from the entry date. */
function contractName(contract: string, entryDay: string): string {
  const words = contractWords(contract, entryDay);
  if (words === contract) return contract;
  return `${parseOccSymbol(contract).underlying} ${words}`;
}

// Older feed lines and signal details may carry OCC symbols: in words, from that day.
const nyDay = (at: number) => newYork(at).date;

const blockedText: Record<string, string> = {
  earnings: "earnings day",
  premarket: "pre-market 4×+",
};

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

// How near a stock is to the signal: both bars full means a signal.
const nearness = (r: { t: number; rvol: number }) =>
  Math.min(r.t / 2, r.rvol / 1.5);

function Meter({
  value,
  of,
  label,
}: {
  value: number;
  of: number;
  label: string;
}) {
  const share = Math.min(1, value / of);
  return (
    <span className="bot-meter" title={label}>
      <span className="bot-meter-bar">
        <span
          className={share >= 1 ? "bot-meter-fill full" : "bot-meter-fill"}
          style={{ width: `${share * 100}%` }}
        />
      </span>
      <span className="num">{label}</span>
    </span>
  );
}

/** Each stock's two conditions now, closest to a signal first. */
function LiveScan({ scan }: { scan: BotView["scan"] }) {
  if (scan.length === 0)
    return (
      <p className="muted">
        The scan starts 10 minutes after the US open on trading days.
      </p>
    );
  return (
    <div className="bot-scan-wrap">
      <table className="bot-scan">
        <thead>
          <tr>
            <th>Stock</th>
            <th>Leaning</th>
            <th>Strength vs SPY (need t 2)</th>
            <th>Volume vs normal (need 1.5×)</th>
            <th>News filter</th>
          </tr>
        </thead>
        <tbody>
          {scan.slice(0, 25).map((r) => (
            <tr key={r.symbol} className={nearness(r) >= 1 ? "hot" : ""}>
              <td>
                <strong>{r.symbol}</strong>
              </td>
              <td>{r.side === "C" ? "up (call)" : "down (put)"}</td>
              <td>
                <Meter value={r.t} of={2} label={`t ${r.t.toFixed(1)}`} />
              </td>
              <td>
                <Meter
                  value={r.rvol}
                  of={1.5}
                  label={`${r.rvol.toFixed(1)}×`}
                />
              </td>
              <td>{newsCell(r.blocked)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        At {sessionTime(scan[0]!.minute)}. A stock signals the first minute both
        bars are full; one signal per stock a day.
      </p>
    </div>
  );
}

function newsCell(blocked: BotView["scan"][number]["blocked"]) {
  if (!blocked) return <span className="muted">—</span>;
  return (
    <span className="pill amber" title="No new entry in this stock today">
      Blocked: {blockedText[blocked] ?? blocked}
    </span>
  );
}

const newsStateText: Record<string, string> = {
  pending: "waiting for 09:30 NY",
  failed: "failed today, not applied",
  off: "not set up",
};

/** The news filter's sources, when one is not working. */
function newsNote(news: BotView["news"]) {
  if (!news) return null;
  const parts: string[] = [];
  if (news.earnings !== "ok")
    parts.push(`earnings calendar ${newsStateText[news.earnings]}`);
  const preFine = news.premarket === "ok" || news.premarket === "pending";
  if (!preFine)
    parts.push(`pre-market volume ${newsStateText[news.premarket]}`);
  if (parts.length === 0) return null;
  return <p className="muted small">News filter: {parts.join("; ")}.</p>;
}

const kindLabel: Record<BotView["activity"][number]["kind"], string> = {
  info: "•",
  signal: "⚡",
  skip: "–",
  order: "$",
  error: "!",
};

/** What the bot did, newest first. */
function Activity({ items }: { items: BotView["activity"] }) {
  if (items.length === 0) return <p className="muted">Nothing yet.</p>;
  return (
    <ul className="bot-activity">
      {items.map((e, i) => (
        <li key={`${e.at}-${i}`} className={`bot-ev ${e.kind}`}>
          <span className="bot-ev-time num">
            {israelShortDate(e.at)} {israelClock(e.at)}
          </span>
          <span className="bot-ev-kind" aria-hidden="true">
            {kindLabel[e.kind]}
          </span>
          <span>{contractsInWords(e.text, nyDay(e.at))}</span>
        </li>
      ))}
    </ul>
  );
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
        Watching {value.watching.length} stocks: {value.universe.length} Indi
        traded in the past year
        {value.favorites
          ? ` and your "${value.favorites.name}" list (${value.favorites.tickers.length})`
          : " (no favorites list received yet)"}
        . C signal · delta {value.delta} · {value.sizePct}% of the account a
        trade · your stop, winners up 100% held overnight · no new entry on an
        earnings reaction day or with pre-market volume 4× normal.
        {value.lastRun !== null && ` Last check ${israelClock(value.lastRun)}.`}
      </p>

      <h3>Live scan</h3>
      {newsNote(value.news)}
      <LiveScan scan={value.scan} />

      <h3>Activity</h3>
      <Activity items={value.activity} />

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
                {s.detail && (
                  <span className="muted">
                    {" "}
                    · {contractsInWords(s.detail, s.day)}
                  </span>
                )}
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
              <strong>{contractName(p.contract, p.day)}</strong>
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
              <strong>{contractName(p.contract, p.day)}</strong>
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
