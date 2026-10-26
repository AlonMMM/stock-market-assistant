import { useEffect, useState } from "react";
import type {
  AccountRisk,
  accountRiskBounds,
} from "../../../packages/trading/src/account-risk.js";
import { readJson } from "./api.js";

// The risk manager's numbers, per account (user 2026-10-26): each account (the
// owner's own, the main bot's, IBKR, the volume bot's) has its own. It reads and
// saves `/api/risk`; saving is the owner's, the others see the numbers.

type Bounds = typeof accountRiskBounds;
interface RiskAccount {
  id: string;
  broker: string;
  label: string;
  settings: AccountRisk;
  saved: boolean;
  now: {
    equity: number;
    dayChangePct: number | null;
    state: "full" | "brake" | "recovery";
    reason: string;
  } | null;
}
interface RiskView {
  accounts: RiskAccount[];
  defaults: AccountRisk;
  bounds: Bounds;
}

type Field =
  | "dayLossPct"
  | "tradeRiskPct"
  | "openRiskPct"
  | "maxPositionPct"
  | "buysPerDay"
  | "drawdownPct";

const fields: {
  key: Field;
  label: string;
  help: string;
  unit: string;
  step: number;
}[] = [
  {
    key: "dayLossPct",
    label: "Daily loss limit",
    help: "A new buy waits once today's loss plus its risk at the stop is over this. A 2% trade with the 50% stop counts as 1%.",
    unit: "%",
    step: 0.5,
  },
  {
    key: "tradeRiskPct",
    label: "Risk per trade",
    help: "What one trade may lose at its stop.",
    unit: "%",
    step: 0.25,
  },
  {
    key: "openRiskPct",
    label: "Open risk",
    help: "All open trades at their stops, plus the new one. 0 turns it off.",
    unit: "%",
    step: 0.5,
  },
  {
    key: "maxPositionPct",
    label: "Largest position",
    help: "What one stock and side may cost in all.",
    unit: "%",
    step: 0.5,
  },
  {
    key: "buysPerDay",
    label: "Buys per day",
    help: "New buys in one trading day; sales do not count.",
    unit: "",
    step: 1,
  },
  {
    key: "drawdownPct",
    label: "Brake at a drawdown of",
    help: "This far below the account's high, the brake limits below apply until most of the fall is back.",
    unit: "%",
    step: 0.5,
  },
];

const stateWords = {
  full: "Full",
  brake: "Brake on",
  recovery: "Recovery",
} as const;

function same(a: AccountRisk, b: AccountRisk): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function outOfBounds(r: AccountRisk, b: Bounds): string | null {
  const bad = (v: number, [lo, hi]: readonly [number, number]) =>
    !Number.isFinite(v) || v < lo || v > hi;
  for (const f of fields)
    if (bad(r[f.key], b[f.key]))
      return `${f.label} must be from ${b[f.key][0]} to ${b[f.key][1]}`;
  for (const [name, p] of [
    ["Brake", r.brake],
    ["Recovery", r.recovery],
  ] as const) {
    if (bad(p.trade, b.trade))
      return `${name} per trade must be from ${b.trade[0]} to ${b.trade[1]}`;
    if (bad(p.day, b.day))
      return `${name} per day must be from ${b.day[0]} to ${b.day[1]}`;
  }
  if (!Number.isInteger(r.buysPerDay)) return "Buys per day is a whole number";
  return null;
}

function NumberInput({
  id,
  value,
  step,
  min,
  max,
  disabled,
  onChange,
  label,
}: {
  id: string;
  value: number;
  step: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (v: number) => void;
  label?: string;
}) {
  return (
    <input
      id={id}
      className="risk-input num"
      type="number"
      inputMode="decimal"
      value={Number.isFinite(value) ? value : ""}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      aria-label={label}
      onChange={(e) =>
        onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))
      }
    />
  );
}

function AccountCard({
  account,
  view,
  canSave,
  onSaved,
}: {
  account: RiskAccount;
  view: RiskView;
  canSave: boolean;
  onSaved: (a: RiskAccount) => void;
}) {
  const [draft, setDraft] = useState<AccountRisk>(account.settings);
  const [run, setRun] = useState<
    | { step: "idle" }
    | { step: "saving" }
    | { step: "saved" }
    | { step: "failed"; message: string }
  >({ step: "idle" });
  useEffect(() => setDraft(account.settings), [account.settings]);
  const changed = !same(draft, account.settings);
  const atDefaults = same(draft, view.defaults);
  const problem = outOfBounds(draft, view.bounds);
  const set = (patch: Partial<AccountRisk>) => {
    setDraft({ ...draft, ...patch });
    setRun({ step: "idle" });
  };
  const save = async () => {
    setRun({ step: "saving" });
    try {
      const answer = (await readJson(
        await fetch("/api/risk", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: account.id, settings: draft }),
          signal: AbortSignal.timeout(20000),
        }),
      )) as { settings: AccountRisk };
      onSaved({ ...account, settings: answer.settings, saved: true });
      setRun({ step: "saved" });
    } catch (e) {
      setRun({
        step: "failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const now = account.now;
  let stateLine = "No reading from this account right now";
  if (now) {
    const day =
      now.dayChangePct === null
        ? ""
        : ` · today ${now.dayChangePct > 0 ? "+" : ""}${now.dayChangePct.toFixed(2)}%`;
    stateLine = `${stateWords[now.state]} (${now.reason})${day}`;
  }
  const off = !canSave || run.step === "saving";
  return (
    <section
      className="bot-card bs-card risk-card"
      aria-labelledby={`risk-${account.id}`}
    >
      <div className="bs-card-head">
        <h3 id={`risk-${account.id}`}>{account.label}</h3>
        <span className={`risk-state ${now?.state ?? "unknown"}`}>
          {stateLine}
        </span>
      </div>
      {fields.map((f) => (
        <div className="bs-row risk-row" key={f.key}>
          <div className="bs-what">
            <label htmlFor={`${account.id}-${f.key}`}>{f.label}</label>
            <span className="muted small">{f.help}</span>
          </div>
          <div className="risk-control">
            <NumberInput
              id={`${account.id}-${f.key}`}
              value={draft[f.key]}
              step={f.step}
              min={view.bounds[f.key][0]}
              max={view.bounds[f.key][1]}
              disabled={off}
              onChange={(v) => set({ [f.key]: v })}
            />
            <span className="risk-unit">{f.unit}</span>
            {draft[f.key] !== view.defaults[f.key] && (
              <span className="bs-changed small">
                default {view.defaults[f.key]}
                {f.unit}
              </span>
            )}
          </div>
        </div>
      ))}
      <div className="bs-row risk-row">
        <div className="bs-what">
          <span className="bs-label">Under the brake / in recovery</span>
          <span className="muted small">
            Risk per trade and daily loss limit, % of the account, while the
            brake is on and while it comes off.
          </span>
        </div>
        <div className="risk-pairs">
          {(["brake", "recovery"] as const).map((k) => (
            <div className="risk-pair" key={k}>
              <span className="small">
                {k === "brake" ? "Brake" : "Recovery"}
              </span>
              <NumberInput
                id={`${account.id}-${k}-trade`}
                label={`${k} risk per trade`}
                value={draft[k].trade}
                step={0.25}
                min={view.bounds.trade[0]}
                max={view.bounds.trade[1]}
                disabled={off}
                onChange={(v) => set({ [k]: { ...draft[k], trade: v } })}
              />
              <span className="risk-unit">% trade</span>
              <NumberInput
                id={`${account.id}-${k}-day`}
                label={`${k} daily loss limit`}
                value={draft[k].day}
                step={0.5}
                min={view.bounds.day[0]}
                max={view.bounds.day[1]}
                disabled={off}
                onChange={(v) => set({ [k]: { ...draft[k], day: v } })}
              />
              <span className="risk-unit">% day</span>
            </div>
          ))}
        </div>
      </div>
      {canSave && (
        <div className="risk-actions">
          <button
            type="button"
            className="bs-primary"
            disabled={!changed || problem !== null || run.step === "saving"}
            onClick={() => void save()}
          >
            {run.step === "saving" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="bs-secondary"
            disabled={!changed || run.step === "saving"}
            onClick={() => set(account.settings)}
          >
            Undo
          </button>
          <button
            type="button"
            className="bs-secondary"
            disabled={atDefaults || run.step === "saving"}
            onClick={() => set(view.defaults)}
          >
            Defaults
          </button>
          {problem && changed && (
            <span className="bs-error small">{problem}</span>
          )}
          {run.step === "saved" && (
            <span className="muted small" role="status">
              Saved; the next buy uses it.
            </span>
          )}
          {run.step === "failed" && (
            <span className="bs-error small" role="alert">
              {run.message}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** Every account's risk numbers; the owner can change and save each. */
/**
 * The Risk page: every account, or, in a bot's tab, only that bot's accounts
 * (user 2026-10-26: "why i can't see risk managment validation configuration per
 * bot?"). `only` names the accounts by suffix, e.g. ["bot", "ibkr"].
 */
export function RiskSettingsPage({
  canSave,
  only,
}: {
  canSave: boolean;
  only?: readonly string[];
}) {
  const [view, setView] = useState<RiskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/risk", { signal: AbortSignal.timeout(30000) })
      .then(readJson)
      .then((v) => {
        if (active) setView(v as RiskView);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  if (error)
    return (
      <p className="notice error" role="alert">
        Risk settings unavailable: {error}
      </p>
    );
  if (!view) return <p className="chart-status">Loading risk settings…</p>;
  return (
    <div className="risk-page">
      <p className="muted small">
        Each account checks every new buy against its own numbers, % of that
        account.{" "}
        {canSave
          ? "A save applies to the next buy."
          : "Only the owner can change them."}{" "}
        The 3% cap on one trade's size stays fixed.
      </p>
      {view.accounts
        .filter((a) => !only || only.some((x) => a.id.endsWith(`-${x}`)))
        .map((a) => (
          <AccountCard
            key={a.id}
            account={a}
            view={view}
            canSave={canSave}
            onSaved={(next) =>
              setView({
                ...view,
                accounts: view.accounts.map((x) =>
                  x.id === next.id ? next : x,
                ),
              })
            }
          />
        ))}
    </div>
  );
}
