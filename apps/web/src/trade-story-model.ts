import type {
  TradeChart,
  TradeChartSession,
} from "../../../packages/market-data/src/trade-chart.js";
import {
  coreClose,
  newYork,
  newYorkToUtc,
  nextSessions,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import { levelRules } from "../../../packages/trading/src/bot/levels.js";
import type { BotView } from "../../../packages/trading/src/bot-api.js";
import type { BotSettings } from "../../../packages/trading/src/bot/settings.js";
import {
  versionById,
  type Rules,
} from "../../../packages/trading/src/bot/versions.js";
import type { Decision } from "../../../packages/trading/src/explain.js";
import type {
  ClosedTrade,
  TradeFill,
} from "../../../packages/trading/src/portfolio.js";
import { israelWallSeconds, usSessionDate } from "./time.js";

// A closed trade's story (docs/tasks/frontend-trade-story.md): where it sits
// on the chart of the days around it, why it was entered and why each exit
// happened. The bot's trades are told from the bot's own records (the signal,
// the position, its sales and their reasons); the owner's from the buy
// decision and the fills.

export const sessionOpen = 570; // 09:30 New York
/** Days drawn on each side of the trade when the window opens. */
export const contextDays = 2;
/** Days read at a time when the viewer drags past what is drawn. */
export const pageDays = 3;

/** A moment on the chart: the New York session and the minute since 09:30. */
export interface Moment {
  date: string;
  minute: number;
}

export const momentOf = (ms: number): Moment => {
  const ny = newYork(ms);
  return { date: ny.date, minute: ny.minute - sessionOpen };
};

/** The trade's first and last session. */
export function tradeDates(t: ClosedTrade): { from: string; to: string } {
  return {
    from: momentOf(Date.parse(t.openedAt)).date,
    to: momentOf(Date.parse(t.closedAt)).date,
  };
}

export function tradeChartUrl(
  symbol: string,
  from: string,
  to: string,
): string {
  return `/api/trade-chart?${new URLSearchParams({ symbol, from, to })}`;
}

// A session's bars are final about 20 minutes after its close (the data
// feed's delay); before that the day before is the last one to draw.
const settleMs = 20 * 60000;

/** The last US session whose bars are complete at `now`. */
export function lastClosedSession(now: number): string {
  const date = usSessionDate(now);
  const close = coreClose(date);
  if (close !== null && now >= newYorkToUtc(date, close) + settleMs)
    return date;
  return previousSessions(date, 1)[0]!;
}

/** The days the window opens on: the trade's and a couple each side, up to the last closed one. */
export function chartWindow(
  t: ClosedTrade,
  now: number,
): { from: string; to: string } {
  const { from, to } = tradeDates(t);
  const last = lastClosedSession(now);
  const after = nextSessions(to, contextDays).filter((d) => d <= last);
  return {
    from: previousSessions(from, contextDays)[0]!,
    to: after.at(-1) ?? (to <= last ? to : last),
  };
}

/** The chart's time for a session minute: the Israel wall clock, read as UTC. */
export function barTime(date: string, minute: number): number {
  return israelWallSeconds(newYorkToUtc(date, sessionOpen + minute) / 1000);
}

/** The sessions of two answers as one list, oldest first, each date once. */
export function mergeSessions(chart: TradeChart, more: TradeChart): TradeChart {
  const byDate = new Map<string, TradeChartSession>();
  for (const s of [...chart.sessions, ...more.sessions]) byDate.set(s.date, s);
  return {
    ...chart,
    sessions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    skipped: 0,
  };
}

export interface Marker {
  kind: "buy" | "sell" | "expired" | "signal" | "touch";
  pane: "stock" | "option";
  at: Moment;
  ms: number;
  price: number | null; // null: the chart reads the pane's value at that minute
  label: string;
}

export interface ExitRow {
  ms: number;
  qty: number;
  price: number | null; // null on an expiry
  title: string; // "Failed break", "Your sale", …
  text: string; // the rule or what is known
}

export interface Story {
  bot: boolean;
  version: string | null;
  entryTitle: string;
  entry: string[]; // why it was entered, one sentence each
  exits: ExitRow[];
  // Levels drawn on the chart.
  paid: number;
  stop: number | null;
  stopLabel: string;
  stockEntry: number | null; // null: the stock's close at the first buy
  // The level the bot watched; `unit` is the stock's unit in dollars when the
  // bot kept it (the touch and fall-back lines need it).
  wall: { name: string; level: number; unit: number | null } | null;
  right: "C" | "P" | null; // the bet's direction, for the lines around the level
  rule: number | null; // the strength the signal needed (t), for the strength pane
  markers: Marker[];
  decision: Decision | null; // the owner's buy order, for its full details
}

/** A line drawn across a pane at a price. */
export interface LevelLine {
  pane: "stock" | "option";
  price: number;
  title: string;
  kind: "entry" | "level" | "touch" | "fallback" | "paid" | "stop";
}

/** The lines a story draws: the entry, the level and its touch and fall-back lines, what was paid, the stop. */
export function levelLines(story: Story): LevelLine[] {
  const out: LevelLine[] = [];
  if (story.stockEntry !== null)
    out.push({
      pane: "stock",
      price: story.stockEntry,
      title: "entry",
      kind: "entry",
    });
  if (story.wall) {
    const w = story.wall;
    out.push({
      pane: "stock",
      price: w.level,
      title: `${w.name} · watched`,
      kind: "level",
    });
    if (w.unit !== null) {
      // Ahead of the entry: above for a call, below for a put.
      const back = story.right === "P" ? 1 : -1;
      out.push({
        pane: "stock",
        price: Number((w.level + back * levelRules.near * w.unit).toFixed(2)),
        title: "touch from",
        kind: "touch",
      });
      out.push({
        pane: "stock",
        price: Number((w.level + back * levelRules.back * w.unit).toFixed(2)),
        title: "fall-back · sell",
        kind: "fallback",
      });
    }
  }
  out.push({ pane: "option", price: story.paid, title: "paid", kind: "paid" });
  if (story.stop !== null)
    out.push({
      pane: "option",
      price: story.stop,
      title: story.stopLabel,
      kind: "stop",
    });
  return out;
}

type BotPosition = BotView["positions"][number];
type BotSignal = BotView["signals"][number];

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const time = (ms: number) => clock.format(ms);
const sideWord = (right: "C" | "P") => (right === "C" ? "call" : "put");
const money = (n: number) => `$${n.toFixed(2)}`;

/** The rules a bot position ran on: its version's when known exactly, else the rules now. */
export function rulesFor(
  version: string | undefined,
  settings: BotSettings,
): Rules {
  if (version) {
    const known = versionById(version);
    if (known) return known.rules;
  }
  return settings;
}

const fillMarkers = (t: ClosedTrade): Marker[] =>
  (t.fills ?? []).map((f: TradeFill) => {
    const ms = Date.parse(f.at);
    if (f.side === "buy")
      return {
        kind: "buy",
        pane: "option",
        at: momentOf(ms),
        ms,
        price: f.price,
        label: `buy ${f.qty} @ ${f.price.toFixed(2)}`,
      };
    if (f.side === "expired")
      return {
        kind: "expired",
        pane: "option",
        at: momentOf(ms),
        ms,
        price: 0,
        label: "expired",
      };
    return {
      kind: "sell",
      pane: "option",
      at: momentOf(ms),
      ms,
      price: f.price,
      label: `sell ${f.qty} @ ${f.price.toFixed(2)}`,
    };
  });

/** The bot's sale reasons as the rule they came from. */
export function botExitWords(
  reason: string,
  r: Rules,
  wall: { name: string; level: number } | null,
): { title: string; text: string } {
  const level = wall
    ? `${wall.name} at ${money(wall.level)}`
    : "the level ahead";
  const words: Record<string, [string, string]> = {
    "check-10": [
      "10-minute check",
      "10 minutes after the entry the stock was against the entry price: half sold.",
    ],
    "check-20": [
      "20-minute check",
      "20 minutes after the entry the stock was still against the entry price: the rest sold.",
    ],
    "stop-30": [
      `Stop −${r.stopPct}%`,
      `The option was down ${r.stopPct}% with the stock against the entry: all sold.`,
    ],
    "failed-break": [
      "Failed break",
      `The stock reached ${level} and fell back without breaking it: all sold on the entry day.`,
    ],
    "close-1550": [
      "Day exit",
      `15:50 New York: not up ${r.holdFromPct}%+, so sold before the close.`,
    ],
    "night-cap": [
      "Overnight cap",
      `15:50 New York: a winner, but only one contract worth at most ${r.nightCapPct}% of the account stays overnight; the rest sold.`,
    ],
    "night-no-equity": [
      "Day exit",
      "15:50 New York: the account's value was unknown, so nothing was kept overnight.",
    ],
    "morning-gap-against": [
      "Morning gap",
      "Held overnight; at the next open the stock gapped against the position: sold.",
    ],
    "expiry-day": ["Expiry day", "Held into its expiry day: sold at the open."],
  };
  const known = words[reason];
  if (known) return { title: known[0], text: known[1] };
  return { title: reason, text: "" };
}

/** The bot's trade from its own records; null when the bot has no record of it. */
export function botStory(
  t: ClosedTrade,
  view: BotView | null,
  settings: BotSettings,
): Story | null {
  const { from } = tradeDates(t);
  const p: BotPosition | undefined = view?.positions.find(
    (x) => x.contract === t.symbol && x.day === from,
  );
  if (!p) return null;
  const r = rulesFor(p.version, settings);
  const signal: BotSignal | undefined = (
    view?.entries ??
    view?.signals ??
    []
  ).find(
    (s) => s.day === p.day && s.symbol === p.symbol && s.right === p.right,
  );
  const wall = p.breakWatch
    ? {
        name: p.breakWatch.name,
        level: p.breakWatch.level,
        unit: p.breakWatch.unit ?? null,
      }
    : null;
  const entry: string[] = [];
  const strength = p.right === "C" ? "strength" : "weakness";
  if (signal)
    entry.push(
      `Signal at ${time(signal.at)}: ${p.symbol} showed ${strength} against SPY with t ${signal.t.toFixed(1)} (rule ${r.minT}+) on volume ${signal.rvol.toFixed(1)}× normal (rule ${r.minRvol}×+).`,
    );
  else
    entry.push(
      `A ${sideWord(p.right)} on ${p.symbol}'s ${strength} against SPY (t ${r.minT}+ on volume ${r.minRvol}×+); the signal's numbers were not kept.`,
    );
  if (t.option)
    entry.push(
      `The contract: ${t.underlying} ${t.option.strike} ${sideWord(p.right)}, expiry ${t.option.expiry}, the strike with delta closest to ${r.delta} and 1–${r.maxDte} days out. Paid ${p.cost.toFixed(2)} for ${p.bought} contract${p.bought === 1 ? "" : "s"}.`,
    );
  if (wall)
    entry.push(
      `Level ahead: ${wall.name} at ${money(wall.level)}, watched for a failed break.`,
    );
  if (p.dry) entry.push("A dry run: the bot noted the entry without an order.");
  const exits: ExitRow[] = p.sales.map((s) => {
    const w = botExitWords(s.reason, r, wall);
    return { ms: s.at, qty: s.qty, price: s.price ?? null, ...w };
  });
  if (t.expired)
    exits.push({
      ms: Date.parse(t.closedAt),
      qty: t.qty,
      price: null,
      title: "Expired",
      text: "What was still held expired worthless.",
    });
  const markers = fillMarkers(t);
  if (signal)
    markers.push({
      kind: "signal",
      pane: "stock",
      at: { date: signal.day, minute: signal.minute },
      ms: signal.at,
      price: null,
      label: `signal ${time(signal.at)}`,
    });
  if (p.breakWatch && p.breakWatch.touch !== null)
    markers.push({
      kind: "touch",
      pane: "stock",
      at: { date: p.day, minute: p.breakWatch.touch },
      ms: 0,
      price: null,
      label: "touch",
    });
  return {
    bot: true,
    version: p.version ?? null,
    entryTitle: "Why the bot entered",
    entry,
    exits,
    paid: t.entry,
    stop: Number((t.entry * (1 - r.stopPct / 100)).toFixed(2)),
    stopLabel: `stop −${r.stopPct}%`,
    stockEntry: p.entryStock ?? null,
    wall,
    right: p.right,
    rule: r.minT,
    markers,
    decision: null,
  };
}

/** A bot trade the bot no longer has a record of: the fills alone. */
export function unknownStory(t: ClosedTrade): Story {
  const exits: ExitRow[] = (t.fills ?? [])
    .filter((f) => f.side !== "buy")
    .map((f) => ({
      ms: Date.parse(f.at),
      qty: f.qty,
      price: f.side === "expired" ? null : f.price,
      title: f.side === "expired" ? "Expired" : "Sale",
      text: "",
    }));
  return {
    bot: true,
    version: null,
    entryTitle: "Why the bot entered",
    entry: [
      "The bot keeps its records for five sessions; this trade's signal and reasons are no longer available.",
    ],
    exits,
    paid: t.entry,
    stop: null,
    stopLabel: "stop",
    stockEntry: null,
    wall: null,
    right: null,
    rule: null,
    markers: fillMarkers(t),
    decision: null,
  };
}

// A fill lands seconds after its command; allow for clock differences.
const openSlackMs = 5 * 60000;

/** The owner's buy order behind a closed trade, if it is still in the orders list. */
export function decisionFor(
  t: ClosedTrade,
  decisions: Decision[],
): Decision | null {
  const opened = Date.parse(t.openedAt);
  const closed = Date.parse(t.closedAt);
  return (
    decisions
      .filter(
        (d) =>
          d.explanation.contract.symbol === t.symbol &&
          (d.result?.filledQty ?? 0) > 0 &&
          d.at >= opened - openSlackMs &&
          d.at <= closed,
      )
      .sort((a, b) => a.at - b.at)[0] ?? null
  );
}

/** The owner's trade: the buy order's reasons and what is known about each exit. */
export function ownerStory(t: ClosedTrade, decision: Decision | null): Story {
  const entry: string[] = [];
  const e = decision?.explanation;
  const stop = decision?.result?.stopPrice ?? e?.stop.atCeiling ?? null;
  if (e) {
    const asked = e.inputs
      .filter((i) => i.source === "command")
      .map((i) => `${i.name} ${i.value}`);
    entry.push(
      `Your command at ${time(decision!.at)}: ${asked.length ? asked.join(", ") : "the defaults"}.`,
    );
    if (e.selection)
      entry.push(`${e.selection.expiryRule} ${e.selection.strikeRule}`);
    else entry.push("You named the contract.");
    entry.push(
      `${e.sizing.qty} contract${e.sizing.qty === 1 ? "" : "s"}: ${e.sizing.rule} The ask was ${e.pricing.ask.toFixed(2)}, paid up to ${e.pricing.ceiling.toFixed(2)}.`,
    );
    if (stop !== null)
      entry.push(`A broker stop at ${stop.toFixed(2)} (−${e.stop.pct}%).`);
    for (const n of e.notes) entry.push(n);
  } else
    entry.push(
      "The buy order is no longer in the orders list, so its reasons are not shown.",
    );
  const exits: ExitRow[] = (t.fills ?? [])
    .filter((f) => f.side !== "buy")
    .map((f) => {
      const ms = Date.parse(f.at);
      if (f.side === "expired")
        return {
          ms,
          qty: f.qty,
          price: null,
          title: "Expired",
          text: "What was still held expired worthless.",
        };
      if (stop !== null && f.price <= stop + 0.02)
        return {
          ms,
          qty: f.qty,
          price: f.price,
          title: "Broker stop",
          text: `Filled at or below the stop you set (${stop.toFixed(2)}): most likely the broker stop.`,
        };
      return {
        ms,
        qty: f.qty,
        price: f.price,
        title: "Your sale",
        text: "Sold by you, from the Trade page, Telegram or the assistant.",
      };
    });
  return {
    bot: false,
    version: null,
    entryTitle: "Why you entered",
    entry,
    exits,
    paid: t.entry,
    stop,
    stopLabel: "stop",
    stockEntry: null,
    wall: null,
    right: null,
    rule: null,
    markers: fillMarkers(t),
    decision,
  };
}
