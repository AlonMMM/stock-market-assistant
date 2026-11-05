import type { BotBacktestResponse } from "../../../packages/market-data/src/bot-backtest.js";
import type { VolumeBacktestResponse } from "../../../packages/market-data/src/volume-backtest.js";
import {
  defaultMoney,
  runAccount,
} from "../../../packages/trading/src/bot/backtest-account.js";
import {
  ruleKeys,
  versionById,
} from "../../../packages/trading/src/bot/versions.js";
import { volumeAccount } from "../../../packages/trading/src/strangle/backtest.js";
import {
  volumeRuleKeys,
  volumeVersionById,
} from "../../../packages/trading/src/strangle/versions.js";
import { ruleGroups, sessionsBetween } from "./bot-backtest-model.js";
import type { Ran, VolumeRan } from "./bot-backtest-run.js";
import { groups as volumeGroups, switches } from "./strangle-fields.js";
import { defaultVolumeMoney, volumeMoney } from "./volume-backtest-model.js";

// The History rows in tags (the user, 2026-11-05: the list of runs was
// "super hard to understand"; "use tags... the list we are running, the
// results, the number of months"): each change in words, the period by its
// length, and the result in short.

/** One rule a run changed from its version, in words. */
export interface RuleChange {
  label: string; // "Night cap"
  from: string;
  to: string;
  // A list (size steps, volume tiers): the tag says "changed", the tooltip both.
  long: boolean;
}

/**
 * A finished run's result in short, worked out by the page once it read the
 * run and kept on the server for its History row. Always at the default money
 * ($100,000, the run's own sizes and limits), so rows compare with each other.
 */
export interface RunSummary {
  v: 1;
  returnPct: number;
  pnl: number;
  trades: number;
  winRate: number; // %
  maxDrawdownPct: number;
  // The Main bot's trades priced on real quotes, %; null for the Volume bot
  // (it buys on real books only).
  realQuotesPct: number | null;
}
export const summaryVersion = 1;

const mainLabels = new Map<string, { label: string; unit?: string }>(
  ruleGroups.flatMap((g) => g.fields.map((f) => [f.key, f] as const)),
);
// Rules set outside the Rules card.
const extraLabels: Record<string, string> = {
  sizeSteps: "Size steps",
  volumeTiers: "Size by volume",
  nightCapPct: "Night cap",
};

function unitText(v: number, unit: string | undefined): string {
  if (!unit) return String(v);
  if (unit.startsWith("%")) return `${v}%`;
  if (unit === "$") return `$${v}`;
  if (unit.startsWith("×")) return `${v}×`;
  // "1 contract", "1 day".
  if (v === 1 && /^[a-z]+s$/.test(unit)) return `1 ${unit.slice(0, -1)}`;
  return `${v} ${unit}`;
}

function valueText(v: unknown, unit: string | undefined): string {
  if (v === undefined) return "—";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return unitText(v, unit);
  if (Array.isArray(v)) return v.map((x) => JSON.stringify(x)).join(", ");
  return String(v);
}

/** The Main bot run's rules that differ from its version's, in words. */
export function mainRuleChanges(ran: Ran): RuleChange[] {
  const version = versionById(ran.version.replace(/\*$/, ""));
  if (!version) return [];
  return ruleKeys
    .filter(
      (k) => JSON.stringify(ran.rules[k]) !== JSON.stringify(version.rules[k]),
    )
    .map((k) => {
      const field = mainLabels.get(k);
      // The night cap's own unit is long ("% of the account").
      const unit = k === "nightCapPct" ? "%" : field?.unit;
      const before = version.rules[k];
      return {
        label: extraLabels[k] ?? field?.label ?? k,
        from: valueText(before, unit),
        to: valueText(ran.rules[k], unit),
        long: Array.isArray(before) || Array.isArray(ran.rules[k]),
      };
    });
}

const volumeNumbers = new Map(
  volumeGroups.flatMap((g) => g.specs.map((s) => [s.key as string, s])),
);
const volumeSwitches = new Map(switches.map((s) => [s.key as string, s]));

/** The Volume bot run's rules that differ from its version's, in words. */
export function volumeRuleChanges(ran: VolumeRan): RuleChange[] {
  const version = volumeVersionById(ran.settings.version);
  if (!version) return [];
  const text = (k: string, v: unknown) => {
    const spec = volumeNumbers.get(k);
    if (spec && typeof v === "number") return spec.fmt(v);
    return valueText(v, undefined);
  };
  return volumeRuleKeys
    .filter(
      (k) =>
        JSON.stringify(ran.settings[k]) !== JSON.stringify(version.rules[k]),
    )
    .map((k) => ({
      label: volumeNumbers.get(k)?.label ?? volumeSwitches.get(k)?.label ?? k,
      from: text(k, version.rules[k]),
      to: text(k, ran.settings[k]),
      long: false,
    }));
}

/** A change as one line: "Night cap 10% → 40%", or "Size steps changed". */
export function changeText(c: RuleChange): string {
  if (c.long) return `${c.label} changed`;
  return `${c.label} ${c.from} → ${c.to}`;
}

/** The period by its length: "1 year", "6 months", "3 weeks", "4 days". */
export function periodName(from: string, to: string): string {
  const days =
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) /
      86_400_000 +
    1;
  const months = Math.round(days / 30.44);
  if (months >= 12 && months % 12 === 0) {
    const years = months / 12;
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  if (months >= 1 && Math.abs(days - months * 30.44) <= 4)
    return `${months} month${months === 1 ? "" : "s"}`;
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  const sessions = sessionsBetween(from, to).length;
  return `${sessions} day${sessions === 1 ? "" : "s"}`;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "2-digit",
});
/** "5 Nov 25 → 4 Nov 26". */
export function periodDates(from: string, to: string): string {
  const day = (d: string) => dayFormat.format(new Date(`${d}T12:00:00Z`));
  return `${day(from)} → ${day(to)}`;
}

/** The Main bot run's result at the default money, as its page shows it. */
export function mainRunSummary(
  ran: Ran,
  parts: readonly BotBacktestResponse[],
): RunSummary {
  const trades = parts.flatMap((p) => p.trades);
  const account = runAccount(trades, {
    ...defaultMoney,
    sizeSteps: ran.rules.sizeSteps ?? [],
    nightCapPct: ran.rules.nightCapPct,
    fillPct: ran.fillPct,
  });
  const quoted = trades.filter((t) => t.priced === "quotes").length;
  return {
    v: summaryVersion,
    returnPct: account.returnPct,
    pnl: account.pnl,
    trades: account.taken,
    winRate: account.winRate,
    maxDrawdownPct: account.maxDrawdownPct,
    realQuotesPct: trades.length ? (quoted / trades.length) * 100 : null,
  };
}

/** The Volume bot run's result at the default money. */
export function volumeRunSummary(
  ran: VolumeRan,
  parts: readonly VolumeBacktestResponse[],
): RunSummary {
  const account = volumeAccount(
    parts,
    volumeMoney(defaultVolumeMoney, ran.settings),
  );
  return {
    v: summaryVersion,
    returnPct: (account.end / account.start - 1) * 100,
    pnl: account.end - account.start,
    trades: account.taken,
    winRate: account.taken ? (account.won / account.taken) * 100 : 0,
    maxDrawdownPct: account.maxDrawdownPct,
    realQuotesPct: null,
  };
}

/** A summary kept by an older page is worked out again. */
export function isCurrentSummary(s: unknown): s is RunSummary {
  return (
    typeof s === "object" &&
    s !== null &&
    (s as { v?: unknown }).v === summaryVersion
  );
}
