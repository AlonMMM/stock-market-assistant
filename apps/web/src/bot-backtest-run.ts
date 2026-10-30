import { useSyncExternalStore } from "react";
import type { BotBacktestResponse } from "../../../packages/market-data/src/bot-backtest.js";
import type { Rules } from "../../../packages/trading/src/bot/versions.js";
import { readJson } from "./api.js";
import { parallel, periodParts } from "./bot-backtest-model.js";

// The Backtest page's run, kept outside the page (the user, 2026-10-30): a run
// goes on while another section is open, and its result is there on the way
// back. The last finished result is also kept in the browser for a reload.

export interface Ran {
  version: string; // the label: the version, starred when its rules were changed
  rules: Rules;
  fillPct: number;
  tickers: string[];
  from: string;
  to: string;
}

export interface Busy {
  done: number;
  total: number;
  startedAt: number; // ms
  lastDoneAt: number; // ms, when the latest part came back
}

export interface RunState {
  busy: Busy | null;
  errors: string[];
  runs: BotBacktestResponse[];
  ran: Ran | null;
}

const resultKey = "sma.botBacktest.result.v1";
const empty: RunState = { busy: null, errors: [], runs: [], ran: null };

function savedResult(): RunState {
  try {
    const raw = localStorage.getItem(resultKey);
    if (!raw) return empty;
    const saved = JSON.parse(raw) as Partial<RunState>;
    if (!saved.ran || !Array.isArray(saved.runs)) return empty;
    return {
      busy: null,
      errors: saved.errors ?? [],
      runs: saved.runs,
      ran: saved.ran,
    };
  } catch {
    return empty;
  }
}

let state: RunState | null = null;
const listeners = new Set<() => void>();
let stopped = false;

function current(): RunState {
  state ??= savedResult();
  return state;
}

function set(next: Partial<RunState>) {
  state = { ...current(), ...next };
  for (const l of listeners) l();
}

function save() {
  const { ran, runs, errors } = current();
  try {
    localStorage.setItem(resultKey, JSON.stringify({ ran, runs, errors }));
  } catch {
    // Too big for the browser's storage: kept until the tab closes.
  }
}

export function useBacktestRun(): RunState {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, current);
}

export function stopRun() {
  stopped = true;
}

export async function startRun(ran: Ran) {
  if (current().busy) return;
  // Period parts first, so the run moves through the period in time order.
  const jobs = periodParts(ran.from, ran.to).flatMap((p) =>
    ran.tickers.map((symbol) => ({ symbol, ...p })),
  );
  stopped = false;
  const startedAt = Date.now();
  set({
    busy: { done: 0, total: jobs.length, startedAt, lastDoneAt: startedAt },
    errors: [],
    runs: [],
    ran,
  });
  let next = 0;
  let done = 0;
  const got: BotBacktestResponse[] = [];
  const failed: string[] = [];
  const worker = async () => {
    while (next < jobs.length && !stopped) {
      const job = jobs[next++]!;
      try {
        const response = await fetch("/api/bot-backtest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...job,
            rules: ran.rules,
            fillPct: ran.fillPct,
          }),
          signal: AbortSignal.timeout(180000),
        });
        got.push(await readJson<BotBacktestResponse>(response));
        set({ runs: [...got] });
      } catch (e) {
        failed.push(
          `${job.symbol} ${job.from} → ${job.to}: ${e instanceof Error ? e.message : String(e)}`,
        );
        set({ errors: [...failed] });
      }
      done++;
      set({
        busy: { done, total: jobs.length, startedAt, lastDoneAt: Date.now() },
      });
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  set({ busy: null });
  save();
}
