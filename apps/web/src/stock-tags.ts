import { useEffect, useSyncExternalStore } from "react";
import { readJson } from "./api";
import { israelDateTime, israelLabel, israelWeekday } from "./time";

// Stock tags (user 2026-11-01): earnings in the next 24h, in the last 24h,
// later this week, and big news. Every place that shows a symbol mounts
// <StockTags>; the symbols on screen are read together from `/api/tags`,
// once a symbol appears and again every 5 minutes.

export type EarningsTiming = "pre" | "post" | "unknown";
export type StockTag =
  | {
      kind: "earnings-soon" | "earnings-past" | "earnings-week";
      at: number;
      date: string;
      timing: EarningsTiming;
    }
  | { kind: "big-news"; headlines: number };

interface TagsResponse {
  stocks: Record<string, StockTag[]>;
  earnings: "ok" | "unavailable";
  news: "ok" | "unavailable";
  at: number;
}

const refreshMs = 5 * 60_000;
const none: StockTag[] = [];

const tags = new Map<string, StockTag[]>();
const wanted = new Map<string, number>(); // symbol → mounted count
const fetchedAt = new Map<string, number>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function notify() {
  for (const l of listeners) l();
}

async function load(force: boolean) {
  if (inFlight) return;
  const now = Date.now();
  const symbols = [...wanted.keys()].filter(
    (s) => force || now - (fetchedAt.get(s) ?? 0) >= refreshMs,
  );
  if (symbols.length === 0) return;
  inFlight = true;
  let ok = false;
  try {
    for (let i = 0; i < symbols.length; i += 200) {
      const chunk = symbols.slice(i, i + 200);
      const response = await fetch(
        `/api/tags?symbols=${encodeURIComponent(chunk.join(","))}`,
      );
      const body = await readJson<TagsResponse>(response);
      for (const s of chunk) {
        tags.set(s, body.stocks[s] ?? none);
        fetchedAt.set(s, now);
      }
    }
    ok = true;
    notify();
  } catch {
    // Tags are extra: on a failure the symbols keep the last tags they had
    // (none at first) and are tried again on the next round.
  } finally {
    inFlight = false;
    // Symbols that appeared while this read was out are read next.
    if (ok && [...wanted.keys()].some((s) => !fetchedAt.has(s))) schedule();
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void load(false);
  }, 150);
  if (!interval) interval = setInterval(() => void load(true), refreshMs);
}

function watch(symbol: string) {
  wanted.set(symbol, (wanted.get(symbol) ?? 0) + 1);
  schedule();
  return () => {
    const n = (wanted.get(symbol) ?? 1) - 1;
    if (n > 0) wanted.set(symbol, n);
    else wanted.delete(symbol);
    if (wanted.size === 0 && interval) {
      clearInterval(interval);
      interval = null;
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The tags of one symbol; mounting it asks the server for them. */
export function useStockTags(symbol: string | null | undefined): StockTag[] {
  const s = symbol?.trim().toUpperCase() ?? "";
  useEffect(() => (s ? watch(s) : undefined), [s]);
  return useSyncExternalStore(subscribe, () =>
    s ? (tags.get(s) ?? none) : none,
  );
}

const hours = (ms: number) => {
  const h = Math.round(Math.abs(ms) / 3_600_000);
  return h < 1 ? "<1h" : `${h}h`;
};
const timingText: Record<EarningsTiming, string> = {
  pre: "before the open",
  post: "after the close",
  unknown: "time not given",
};

/**
 * The chip's text and its full explanation. `compact` is for rows that are
 * tight on a phone (the Watchlist, the bots' lists): "ER" for earnings.
 */
export function tagText(
  tag: StockTag,
  now: number,
  compact = false,
): { label: string; title: string } {
  if (tag.kind === "big-news")
    return {
      label: compact ? "News" : "Big news",
      title: `Big news: ${tag.headlines} headlines in the last 24 hours`,
    };
  const word = compact ? "ER" : "Earnings";
  const when = `${timingText[tag.timing]}, about ${israelDateTime(tag.at)} ${israelLabel}`;
  if (tag.kind === "earnings-soon")
    return {
      label: `${word} in ${hours(tag.at - now)}`,
      title: `Earnings in the next 24 hours: ${when}`,
    };
  if (tag.kind === "earnings-past")
    return {
      label: `${word} ${hours(now - tag.at)} ago`,
      title: `Earnings in the last 24 hours: ${when}`,
    };
  return {
    label: `${word} ${israelWeekday(tag.at)}`,
    title: `Earnings this week: ${when}`,
  };
}
