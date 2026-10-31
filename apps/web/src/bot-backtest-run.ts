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
  // Set when the user stopped the run: the parts back by then, of all of them.
  stopped?: { done: number; total: number } | null;
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
      stopped: saved.stopped ?? null,
    };
  } catch {
    return empty;
  }
}

let state: RunState | null = null;
const listeners = new Set<() => void>();
// The run in flight: its id (a newer run replaces it) and what cancels its requests.
let runId = 0;
let controller: AbortController | null = null;

function current(): RunState {
  state ??= savedResult();
  return state;
}

function set(next: Partial<RunState>) {
  state = { ...current(), ...next };
  for (const l of listeners) l();
}

function save() {
  const { ran, runs, errors, stopped } = current();
  try {
    localStorage.setItem(
      resultKey,
      JSON.stringify({ ran, runs, errors, stopped }),
    );
  } catch {
    // Too big for the browser's storage: kept until the tab closes.
  }
}

/** The run's state now, outside React. */
export const runState = (): RunState => current();

export function useBacktestRun(): RunState {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, current);
}

/**
 * Stops the run now (the user, 2026-10-31: "add stop button that works"): the
 * requests in flight are cancelled, no new part starts, and the parts already
 * back stay as the result. The server may finish a cancelled part; it is not read.
 */
export function stopRun() {
  const busy = current().busy;
  if (!busy) return;
  runId++;
  controller?.abort();
  controller = null;
  set({ busy: null, stopped: { done: busy.done, total: busy.total } });
  save();
}

export async function startRun(ran: Ran) {
  if (current().busy) return;
  // Period parts first, so the run moves through the period in time order.
  const jobs = periodParts(ran.from, ran.to).flatMap((p) =>
    ran.tickers.map((symbol) => ({ symbol, ...p })),
  );
  const id = ++runId;
  const abort = new AbortController();
  controller = abort;
  const live = () => runId === id;
  const startedAt = Date.now();
  set({
    busy: { done: 0, total: jobs.length, startedAt, lastDoneAt: startedAt },
    errors: [],
    runs: [],
    ran,
    stopped: null,
  });
  let next = 0;
  let done = 0;
  const got: BotBacktestResponse[] = [];
  const failed: string[] = [];
  const worker = async () => {
    while (next < jobs.length && live()) {
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
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
        });
        const body = await readJson<BotBacktestResponse>(response);
        if (!live()) return;
        got.push(body);
        set({ runs: [...got] });
      } catch (e) {
        // A stopped run's cancelled requests are not failures.
        if (!live()) return;
        failed.push(
          `${job.symbol} ${job.from} → ${job.to}: ${e instanceof Error ? e.message : String(e)}`,
        );
        set({ errors: [...failed] });
      }
      if (!live()) return;
      done++;
      set({
        busy: { done, total: jobs.length, startedAt, lastDoneAt: Date.now() },
      });
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  if (!live()) return;
  controller = null;
  set({ busy: null });
  save();
}
