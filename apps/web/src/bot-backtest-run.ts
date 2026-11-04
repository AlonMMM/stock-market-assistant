import { useSyncExternalStore } from "react";
import type { BotBacktestResponse } from "../../../packages/market-data/src/bot-backtest.js";
import type { VolumeBacktestResponse } from "../../../packages/market-data/src/volume-backtest.js";
import type { Rules } from "../../../packages/trading/src/bot/versions.js";
import type { StrangleSettings } from "../../../packages/trading/src/strangle/settings.js";
import { readJson } from "./api.js";
import { periodParts } from "./bot-backtest-model.js";

// The Backtest page's runs, kept outside the page (the user, 2026-10-30): a run
// goes on while another section is open, and its result is there on the way
// back. The last finished result is also kept in the browser for a reload.
// One run a bot: the Main bot's and the Volume bot's.
//
// The server runs them (the user, 2026-11-04: on the phone, leaving the page
// cancelled the run; "but I do want to see progress and trades during the
// run"). The page sends the whole run once (/api/backtest-jobs,
// docs/tasks/backend-backtest-jobs.md), then reads it every few seconds: the
// progress and the parts finished since the last read, so the trades come in
// while it runs. Leaving the page, locking the phone or reloading does not
// stop it; on the way back the page reads it again and catches up.

/** What every run keeps of its setup: the stocks and the period. */
export interface RanBase {
  tickers: string[];
  from: string;
  to: string;
  fillPct: number;
}

export interface Ran extends RanBase {
  version: string; // the label: the version, starred when its rules were changed
  rules: Rules;
}

export interface VolumeRan extends RanBase {
  settings: StrangleSettings;
}

export interface Busy {
  done: number;
  total: number;
  startedAt: number; // ms
  lastDoneAt: number; // ms, when the latest part came back
  // The last reads of the run failed (no network, the phone asleep); the run
  // goes on on the server and the page keeps trying.
  reconnecting?: boolean;
}

export interface RunState<R, B> {
  busy: Busy | null;
  errors: string[];
  runs: B[];
  ran: R | null;
  // Set when the user stopped the run: the parts back by then, of all of them.
  stopped?: { done: number; total: number } | null;
}

export interface BacktestRun<R extends RanBase, B> {
  start(ran: R): Promise<void>;
  stop(): void;
  state(): RunState<R, B>;
  use(): RunState<R, B>;
  /** Reads the run on the server again (on load and when the page shows). */
  resume(): Promise<void>;
}

/** The run as the server tells it (backtest-jobs.ts, JobView). */
interface JobView<R, B> {
  id: string;
  status: "running" | "done" | "stopped";
  total: number;
  done: number;
  createdAt: number;
  lastDoneAt: number | null;
  meta: R;
  results: { index: number; doneAt: number; body: B }[];
  errors: { symbol: string; from: string; to: string; error: string }[];
  stopped: { done: number; total: number } | null;
}

export const pollMs = 2500;
const jobsUrl = "/api/backtest-jobs";

function backtestRun<R extends RanBase, B>(o: {
  bot: "main" | "volume";
  resultKey: string;
  sessionsPerPart?: number;
  body: (ran: R) => Record<string, unknown>;
}): BacktestRun<R, B> {
  const empty: RunState<R, B> = { busy: null, errors: [], runs: [], ran: null };
  const jobKey = `${o.resultKey}.job`;
  let state: RunState<R, B> | null = null;
  const listeners = new Set<() => void>();
  // The run being read: its id, its finished parts by index, and the latest
  // finish time read (the next read asks only for parts after it).
  let jobId: string | null = null;
  let results = new Map<number, B>();
  let since = 0;
  // A newer read (or a stop) replaces the one in flight.
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let resumed = false;

  const storage = {
    get(key: string) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string | null) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // Too big for the browser's storage: kept until the tab closes.
      }
    },
  };

  function savedResult(): RunState<R, B> {
    try {
      const raw = storage.get(o.resultKey);
      if (!raw) return empty;
      const saved = JSON.parse(raw) as Partial<RunState<R, B>>;
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
  const current = (): RunState<R, B> => (state ??= savedResult());
  function set(next: Partial<RunState<R, B>>) {
    state = { ...current(), ...next };
    for (const l of listeners) l();
  }
  function save() {
    const { ran, runs, errors, stopped } = current();
    storage.set(o.resultKey, JSON.stringify({ ran, runs, errors, stopped }));
  }
  const subscribe = (l: () => void) => {
    listeners.add(l);
    // The first page to show the run reads it from the server.
    if (!resumed) {
      resumed = true;
      void resume();
    }
    return () => listeners.delete(l);
  };

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** Takes in what the server says of the run. */
  function apply(view: JobView<R, B>) {
    for (const r of view.results) {
      results.set(r.index, r.body);
      since = Math.max(since, r.doneAt);
    }
    const runs = [...results.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, body]) => body);
    const errors = view.errors.map(
      (e) => `${e.symbol} ${e.from} → ${e.to}: ${e.error}`,
    );
    if (view.status === "running") {
      set({
        busy: {
          done: view.done,
          total: view.total,
          startedAt: view.createdAt,
          lastDoneAt: view.lastDoneAt ?? view.createdAt,
          reconnecting: false,
        },
        runs,
        errors,
        ran: view.meta,
        stopped: null,
      });
      return;
    }
    set({
      busy: null,
      runs,
      errors,
      ran: view.meta,
      stopped: view.stopped,
    });
    save();
  }

  /** Reads the run now, then every pollMs while it runs. */
  async function read(id: string) {
    clearTimer();
    const gen = ++generation;
    let again = true;
    try {
      const response = await fetch(
        `${jobsUrl}/${encodeURIComponent(id)}?since=${since}`,
        { signal: AbortSignal.timeout(20000), cache: "no-store" },
      );
      if (response.status === 404) {
        // The run is gone (kept a week): what was read stays.
        if (gen !== generation) return;
        forget();
        const busy = current().busy;
        if (busy) set({ busy: null });
        return;
      }
      const view = await readJson<JobView<R, B>>(response);
      if (gen !== generation) return;
      failures = 0;
      apply(view);
      again = view.status === "running";
    } catch {
      if (gen !== generation) return;
      // No answer (no network, the phone woke up): try again; the run goes on
      // on the server.
      failures++;
      const busy = current().busy;
      if (busy && failures >= 2 && !busy.reconnecting)
        set({ busy: { ...busy, reconnecting: true } });
    }
    if (again && gen === generation)
      timer = setTimeout(
        () => void read(id),
        failures ? Math.min(30000, pollMs * 2 ** failures) : pollMs,
      );
  }

  function forget() {
    jobId = null;
    storage.set(jobKey, null);
  }

  async function resume() {
    if (jobId) {
      if (current().busy) await read(jobId);
      return;
    }
    if (typeof window === "undefined") return;
    // The run this browser started, else the latest one (another device's).
    const saved = storage.get(jobKey);
    let id = saved;
    try {
      // Only its state: no results (since far ahead).
      const response = await fetch(
        saved
          ? `${jobsUrl}/${encodeURIComponent(saved)}?since=${Number.MAX_SAFE_INTEGER}`
          : `${jobsUrl}/latest?bot=${o.bot}&since=${Number.MAX_SAFE_INTEGER}`,
        { signal: AbortSignal.timeout(20000), cache: "no-store" },
      );
      if (response.status === 404) {
        if (saved) forget();
        return;
      }
      const head = await readJson<JobView<R, B>>(response);
      id = head.id;
      // Finished, and its result is the one kept here: nothing to read.
      if (head.status !== "running" && saved === head.id && current().ran)
        return;
    } catch {
      // The server is not reachable now; a later look tries again.
      resumed = false;
      return;
    }
    if (!id || jobId) return;
    jobId = id;
    storage.set(jobKey, id);
    results = new Map();
    since = 0;
    await read(id);
  }

  /** Stops the run on the server: no new part starts; the parts back stay. */
  function stop() {
    const busy = current().busy;
    if (!busy) return;
    clearTimer();
    generation++;
    set({ busy: null, stopped: { done: busy.done, total: busy.total } });
    save();
    const id = jobId;
    if (!id) return;
    const gen = generation;
    void fetch(`${jobsUrl}/${encodeURIComponent(id)}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
    })
      .then((r) => readJson<JobView<R, B>>(r))
      .then(() => {
        // Parts finished before the stop came in: read them all.
        if (gen !== generation) return;
        results = new Map();
        since = 0;
        return read(id);
      })
      .catch(() => {
        // Not stopped on the server: its parts are not read any more here.
      });
  }

  async function start(ran: R) {
    if (current().busy) return;
    // Period parts first, so the run moves through the period in time order.
    const parts = periodParts(ran.from, ran.to, o.sessionsPerPart).flatMap(
      (p) => ran.tickers.map((symbol) => ({ symbol, ...p })),
    );
    clearTimer();
    const gen = ++generation;
    const startedAt = Date.now();
    results = new Map();
    since = 0;
    failures = 0;
    set({
      busy: { done: 0, total: parts.length, startedAt, lastDoneAt: startedAt },
      errors: [],
      runs: [],
      ran,
      stopped: null,
    });
    try {
      const response = await fetch(jobsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot: o.bot,
          parts,
          body: o.body(ran),
          meta: ran,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const { id } = await readJson<{ id: string }>(response);
      if (gen !== generation) return;
      jobId = id;
      storage.set(jobKey, id);
      resumed = true;
      await read(id);
    } catch (e) {
      if (gen !== generation) return;
      set({
        busy: null,
        errors: [
          `The run did not start: ${e instanceof Error ? e.message : String(e)}`,
        ],
      });
    }
  }

  return {
    start,
    stop,
    resume,
    state: current,
    use: () => useSyncExternalStore(subscribe, current),
  };
}

/** The Main bot's run. */
export const mainRun = backtestRun<Ran, BotBacktestResponse>({
  bot: "main",
  resultKey: "sma.botBacktest.result.v1",
  body: (ran) => ({ rules: ran.rules, fillPct: ran.fillPct }),
});

/**
 * The Volume bot's run: 20 sessions a part (the server takes 60), as each
 * alert also reads the stock's trades for its seconds.
 */
export const volumeRun = backtestRun<VolumeRan, VolumeBacktestResponse>({
  bot: "volume",
  resultKey: "sma.volumeBacktest.result.v1",
  sessionsPerPart: 20,
  body: (ran) => ({ settings: ran.settings, fillPct: ran.fillPct }),
});

export const startRun = mainRun.start;
export const stopRun = mainRun.stop;
export const runState = mainRun.state;
export const useBacktestRun = (): RunState<Ran, BotBacktestResponse> =>
  mainRun.use();

// A phone that shows the page again reads the runs at once, not at the next
// tick (its timers were paused while it slept).
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void mainRun.resume();
    void volumeRun.resume();
  });
