import { useState } from "react";
import type {
  PricedBy,
  VolumeAccount,
  VolumeAccountTrade,
  VolumeMoney,
} from "../../../packages/trading/src/strangle/backtest.js";
import {
  strangleLimits,
  type StrangleSettings,
} from "../../../packages/trading/src/strangle/settings.js";
import { NumberRow } from "./backtest-ui.js";
import { stepMs } from "./bot-backtest-model.js";
import type { VolumeRan } from "./bot-backtest-run.js";
import { signedPct, signedUsd, tone, usd } from "./format.js";
import { groups, switches } from "./strangle-fields.js";
import { israelDateTime, israelLabel } from "./time.js";
import {
  nyClock,
  outcomeCounts,
  pricedCounts,
  pricedWords,
  refusalWords,
  volumeCsv,
  type VolumeRow,
} from "./volume-backtest-model.js";

// The Volume bot's parts of the Backtest page (BotBacktest.tsx holds the
// setup and the run): its rules form, the result, every alert and the trades.

// Settings the backtest has no use for: the live switches and the stock list,
// and the broker's safety stop (the backtest sells on the bot's own exits).
const notReplayed = new Set<keyof StrangleSettings>([
  "safetyStopPct",
  "fastAlert",
  "followFavorites",
]);

/** The rules form: the Volume bot's settings as its settings page shows them. */
export function VolumeRules({
  settings,
  base,
  onChange,
}: {
  settings: StrangleSettings;
  base: StrangleSettings | null;
  onChange: (s: StrangleSettings) => void;
}) {
  const changed = (key: keyof StrangleSettings) =>
    base !== null &&
    JSON.stringify(base[key]) !== JSON.stringify(settings[key]);
  return (
    <>
      {groups.map((g) => (
        <fieldset key={g.title} className="rule-group">
          <legend>{g.title}</legend>
          {g.specs
            .filter((f) => !notReplayed.has(f.key))
            .map((f) => {
              const [min, max, step] = strangleLimits[f.key];
              return (
                <NumberRow
                  key={f.key}
                  label={f.label}
                  unit={f.fmt(settings[f.key])}
                  value={settings[f.key]}
                  min={min}
                  max={max}
                  step={step}
                  changed={changed(f.key)}
                  onChange={(v) => onChange({ ...settings, [f.key]: v })}
                />
              );
            })}
        </fieldset>
      ))}
      <fieldset className="rule-group">
        <legend>Switches</legend>
        {switches
          .filter((w) => !notReplayed.has(w.key))
          .map((w) => (
            <label
              key={w.key}
              className={
                changed(w.key)
                  ? "rule-field switch-row changed"
                  : "rule-field switch-row"
              }
            >
              <span>
                {w.label}
                <span className="hint"> {w.help}</span>
              </span>
              <input
                type="checkbox"
                checked={settings[w.key]}
                onChange={(e) =>
                  onChange({ ...settings, [w.key]: e.target.checked })
                }
              />
            </label>
          ))}
      </fieldset>
    </>
  );
}

export function VolumeEmpty() {
  return (
    <section className="card bt-empty">
      <h2>Test the Volume bot on the past</h2>
      <p className="muted">
        Pick the stocks and the period, then Run. You get the total gain or
        loss, the account over time, every alert with why it was or was not
        traded, and every trade.
      </p>
      <p className="muted small">
        How it is simulated: the live bot&apos;s own rules on every plan alert
        (the minute volume alert) and shock alert, the side read on the
        stock&apos;s seconds after the alert, the give-back on minute closes.
        Prices are real Databento bids and asks: 1-second books around the alert
        where they were downloaded, else the minute book, else the option&apos;s
        minute bars with the fill cost. Without 1-second books the result is
        pessimistic: on the same alerts, minute books alone made $361K where
        1-second books made $827K.
      </p>
    </section>
  );
}

const pricedOrder: PricedBy[] = ["seconds", "minutes", "bars"];

export function VolumeSummary({
  ran,
  account,
  money,
  rows,
  ignored,
  busy,
}: {
  ran: VolumeRan;
  account: VolumeAccount;
  money: VolumeMoney;
  rows: VolumeRow[];
  ignored: string[];
  busy: boolean;
}) {
  const pnl = account.end - account.start;
  const returnPct = (pnl / account.start) * 100;
  const taken = account.trades.filter((a) => a.status === "taken");
  const wins = taken.filter((a) => a.pnl > 0);
  const losses = taken.filter((a) => a.pnl <= 0);
  const refused = account.trades.length - taken.length;
  const notTraded = rows.filter((r) => r.signal.outcome !== "traded").length;
  const priced = pricedCounts(account);
  const avg = (list: VolumeAccountTrade[]) =>
    list.reduce((sum, a) => sum + a.pnl, 0) / list.length;
  const notSeconds = priced.buys.minutes + priced.buys.bars;
  return (
    <section className="card bt-summary" aria-label="Result">
      <div className="bt-total">
        <span className="muted small">
          Volume bot · {ran.tickers.length} stocks · {ran.from} → {ran.to}
          {busy ? " · running…" : ""}
        </span>
        <strong className={`bt-pnl num${tone(pnl)}`}>{signedUsd(pnl)}</strong>
        <span className={`num${tone(pnl)}`}>
          {signedPct(returnPct)} · {usd(account.start)} → {usd(account.end)}
        </span>
      </div>
      <dl className="bt-stats num">
        <div>
          <dt>Trades</dt>
          <dd>{account.taken}</dd>
        </div>
        <div>
          <dt>Won</dt>
          <dd>
            {account.won}
            {account.taken
              ? ` (${((account.won / account.taken) * 100).toFixed(0)}%)`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Average a trade</dt>
          <dd className={tone(account.avgRet)}>
            {account.taken ? signedPct(account.avgRet * 100) : "—"}
          </dd>
        </div>
        <div>
          <dt>Average win</dt>
          <dd className="up">{wins.length ? signedUsd(avg(wins)) : "—"}</dd>
        </div>
        <div>
          <dt>Average loss</dt>
          <dd className="down">
            {losses.length ? signedUsd(avg(losses)) : "—"}
          </dd>
        </div>
        <div>
          <dt>Worst drop</dt>
          <dd>{account.maxDrawdownPct.toFixed(1)}%</dd>
        </div>
      </dl>
      {account.taken > 0 && (
        <div className="vbt-priced" aria-label="How the fills were priced">
          <span className="muted small">Buys priced from</span>
          {pricedOrder.map((p) => (
            <PricedChip key={p} p={p} n={priced.buys[p]} />
          ))}
          <span className="muted small">· sales</span>
          {pricedOrder.map((p) => (
            <PricedChip key={p} p={p} n={priced.sales[p]} />
          ))}
        </div>
      )}
      {notSeconds > 0 && (
        <p className="stale small">
          {notSeconds} of {account.taken} buys had no 1-second book: they are
          priced from the minute book or the bars, which read a fast move late.
          Those trades come out worse than they would live (on the same alerts,
          minute books alone made $361K where 1-second books made $827K).
        </p>
      )}
      <p className="muted small">
        {money.sizePct}% a trade, sized from each morning&apos;s account · fees
        ${money.feePerContract.toFixed(2)} a contract each way · fill cost{" "}
        {ran.fillPct}% on the bars
        {money.limits
          ? ` · limits: ${money.maxTradesPerDay} trades a day, ${money.maxOpen} open, ${money.dayLossPct}% day loss`
          : " · no day limits"}
        {` · ${money.maxPerStock} a stock a day`}
        {refused > 0
          ? ` · ${refused} trade${refused === 1 ? "" : "s"} refused by the account`
          : ""}
        {notTraded > 0 ? ` · ${notTraded} alerts not traded` : ""}
        {ignored.length > 0 ? ` · not replayed: ${ignored.join(", ")}` : ""}.
        Simulated, not a promise.
      </p>
    </section>
  );
}

/** Every alert of the run in one folded table: traded or not, and why. */
export function VolumeSignalList({ rows }: { rows: VolumeRow[] }) {
  const [which, setWhich] = useState<"all" | "bought" | "skipped">("all");
  const [reason, setReason] = useState<string>("");
  if (!rows.length) return null;
  const reasons = outcomeCounts(rows);
  const shown = rows.filter((r) => {
    if (which === "bought" && !r.bought) return false;
    if (which === "skipped" && r.bought) return false;
    if (reason && r.signal.outcome !== reason) return false;
    return true;
  });
  const bought = rows.filter((r) => r.bought).length;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([volumeCsv(shown)], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "volume-backtest-alerts.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
  const filters = [
    ["all", "All"],
    ["bought", "Bought"],
    ["skipped", "Not bought"],
  ] as const;
  return (
    <details className="card bt-signals">
      <summary>
        {rows.length} alert{rows.length === 1 ? "" : "s"} · {bought} bought ·{" "}
        {rows.length - bought} not bought
      </summary>
      <div className="bt-signals-tools">
        <div className="segmented small" role="group" aria-label="Which alerts">
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={which === id}
              onClick={() => setWhich(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          aria-label="Why not traded"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          <option value="">Every reason</option>
          {reasons.map((r) => (
            <option key={r.outcome} value={r.outcome}>
              {r.label} ({r.count})
            </option>
          ))}
        </select>
        <button type="button" className="link" onClick={download}>
          Download CSV
        </button>
      </div>
      <div className="bt-signals-scroll">
        <table className="bt-signals-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Stock</th>
              <th>Alert</th>
              <th>Outcome</th>
              <th title="The trade's return after fees">Return</th>
              <th title="The 3 minutes up to the alert, in typical 30-minute moves">
                Burst
              </th>
              <th title="Seconds from the alert to the side">Side after</th>
              <th>Contract</th>
              <th title="The buy, and what priced it">Bought at</th>
              <th title="The sale, and what priced it">Sold at</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <VolumeSignalLine key={r.key} r={r} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Times in {israelLabel}. A plan alert is the minute volume alert, read at
        its minute&apos;s close; a shock alert is the 60-second one at 15×
        volume.
      </p>
    </details>
  );
}

function VolumeSignalLine({ r }: { r: VolumeRow }) {
  const s = r.signal;
  const t = s.trade;
  const taken = r.account?.status === "taken";
  let outcome = r.why;
  if (taken) outcome = "Bought";
  return (
    <tr className={r.bought ? "bought" : undefined}>
      <td className="num">
        {israelDateTime(stepMs(s.date, 0) + s.second * 1000)}
      </td>
      <td>
        <strong>{s.symbol}</strong>
      </td>
      <td>
        {s.kind === "shock" ? "Shock" : "Plan"} {s.alert === "up" ? "▲" : "▼"}
      </td>
      <td title={s.detail || undefined}>{outcome}</td>
      <td className={taken ? `num${tone(r.account!.ret)}` : "num muted"}>
        {taken ? signedPct(r.account!.ret * 100) : "—"}
      </td>
      <td className="num">{s.burst === null ? "—" : s.burst.toFixed(2)}</td>
      <td className="num">{t ? `${t.toSide} s` : "—"}</td>
      <td className="num">{t ? `${t.strike} ${t.right}` : "—"}</td>
      <td className="num" title={t ? pricedWords[t.buyPriced] : undefined}>
        {t ? t.buy.toFixed(2) : "—"}
        {t && <PricedMark p={t.buyPriced} />}
      </td>
      <td className="num" title={t ? pricedWords[t.sellPriced] : undefined}>
        {t ? t.sell.toFixed(2) : "—"}
        {t && <PricedMark p={t.sellPriced} />}
      </td>
    </tr>
  );
}

/** How many fills one source priced; gray when none. */
function PricedChip({ p, n }: { p: PricedBy; n: number }) {
  let cls = `vbt-priced-chip ${p}`;
  if (n === 0) cls = "vbt-priced-chip";
  return (
    <span className={cls}>
      {pricedWords[p]} <b className="num">{n}</b>
    </span>
  );
}

/** A small mark of what priced a fill: nothing for a 1-second book. */
function PricedMark({ p }: { p: PricedBy }) {
  if (p === "seconds") return null;
  const label = p === "minutes" ? "m" : "b";
  return (
    <span className={`vbt-mark ${p}`} title={pricedWords[p]}>
      {label}
    </span>
  );
}

/** The trades the account took or refused, newest first; each opens its details. */
export function VolumeTradeList({ account }: { account: VolumeAccount }) {
  const [filter, setFilter] = useState<"all" | "won" | "lost" | "refused">(
    "all",
  );
  const shown = account.trades
    .filter((a) => {
      if (filter === "won") return a.status === "taken" && a.pnl > 0;
      if (filter === "lost") return a.status === "taken" && a.pnl <= 0;
      if (filter === "refused") return a.status !== "taken";
      return true;
    })
    .sort(
      (a, b) =>
        b.signal.date.localeCompare(a.signal.date) ||
        b.signal.second - a.signal.second,
    );
  const filters = [
    ["all", "All"],
    ["won", "Won"],
    ["lost", "Lost"],
    ["refused", "Over the limits"],
  ] as const;
  return (
    <section className="card bt-trades" aria-label="Trades">
      <div className="card-head">
        <h2>Trades</h2>
        <div className="segmented small" role="group" aria-label="Which trades">
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {account.trades.length === 0 && (
        <p className="muted">No alert was traded in this period.</p>
      )}
      {account.trades.length > 0 && shown.length === 0 && (
        <p className="muted">None of these.</p>
      )}
      <ul className="bt-list">
        {shown.map((a) => (
          <li key={a.signal.id}>
            <VolumeTradeRow a={a} />
          </li>
        ))}
      </ul>
      <p className="muted small">
        Times in {israelLabel}. Open a trade for the alert, the side, the book
        it bought on and the exit.
      </p>
    </section>
  );
}

function VolumeTradeRow({ a }: { a: VolumeAccountTrade }) {
  const s = a.signal;
  const t = s.trade!;
  let spread = "—";
  if (t.spread !== null) spread = `${(t.spread * 100).toFixed(0)}%`;
  let book = "no book";
  if (t.book) book = `${t.book.bid.toFixed(2)} / ${t.book.ask.toFixed(2)}`;
  let exit = "Out by the end time";
  if (t.exitReason === "giveback") exit = "The stock's give-back";
  return (
    <details className="vbt-trade">
      <summary className="bt-row">
        <span className="bt-when num">
          {israelDateTime(stepMs(s.date, 0) + s.second * 1000)}
        </span>
        <span className="bt-what">
          <strong>{s.symbol}</strong> {t.strike}{" "}
          {t.right === "C" ? "Call" : "Put"}
          <span className="state-chip">
            {s.kind === "shock" ? "Shock" : "Plan"}
          </span>
          {t.buyPriced !== "seconds" && (
            <span className="state-chip" title={pricedWords[t.buyPriced]}>
              {t.buyPriced === "minutes" ? "Minute book" : "Bar model"}
            </span>
          )}
        </span>
        {a.status === "taken" ? (
          <>
            <span className="bt-exit muted">
              {a.qty} × {t.buy.toFixed(2)} → {t.sell.toFixed(2)}
            </span>
            <span className={`bt-result num${tone(a.pnl)}`}>
              {signedUsd(a.pnl)}{" "}
              <span className="small">({signedPct(a.ret * 100)})</span>
            </span>
          </>
        ) : (
          <span className="bt-exit muted">{refusalWords[a.status]}</span>
        )}
      </summary>
      <dl className="vbt-facts num">
        <div>
          <dt>Alert</dt>
          <dd>
            {s.kind === "shock" ? "Shock" : "Plan"} {s.alert} at{" "}
            {nyClock(s.second)} New York
            {s.burst === null ? "" : `, burst ${s.burst.toFixed(2)}`}
          </dd>
        </div>
        <div>
          <dt>Side</dt>
          <dd>
            {nyClock(t.sideSecond)}, {t.toSide} s after the alert, stock{" "}
            {t.stockIn.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt>Contract</dt>
          <dd>
            {t.contract} · Δ {t.delta.toFixed(2)}
            {t.fallback ? ` · ${t.fallback}` : ""}
          </dd>
        </div>
        <div>
          <dt>Bought</dt>
          <dd>
            {t.buy.toFixed(2)} on the {pricedWords[t.buyPriced].toLowerCase()}{" "}
            (the book at the side: bid / ask {book}, spread {spread}; an ask
            that ran away is chased)
          </dd>
        </div>
        <div>
          <dt>Sold</dt>
          <dd>
            {t.sell.toFixed(2)} on the {pricedWords[t.sellPriced].toLowerCase()}{" "}
            at {nyClock(t.exitMinute * 60)}: {exit}
            {t.stockOut === null ? "" : `, stock ${t.stockOut.toFixed(2)}`}
          </dd>
        </div>
      </dl>
    </details>
  );
}
