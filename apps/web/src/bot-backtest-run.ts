import { useSyncExternalStore } from "react";
import type { BotBacktestResponse } from "../../../packages/market-data/src/bot-backtest.js";
import type { VolumeBacktestResponse } from "../../../packages/market-data/src/volume-backtest.js";
import type { Rules } from "../../../packages/trading/src/bot/versions.js";
import type { StrangleSettings } from "../../../packages/trading/src/strangle/settings.js";
import { readJson } from "./api.js";
import { parallel, periodParts } from "./bot-backtest-model.js";

// The Backtest page's runs, kept outside the page (the user, 2026-10-30): a run
// goes on while another section is open, and its result is there on the way
// back. The last finished result is also kept in the browser for a reload.
// One run a bot: the Main bot's (/api/bot-backtest) and the Volume bot's
// (/api/volume-backtest), each a stock and a part of the period a request.
//
// The result is kept in IndexedDB (user 2026-11-04: the last run "come back
// but not always"). It was in localStorage, whose 5 MB both bots and the rest
// of the app share: a long run's result was refused there, and the older
// result left in its place came back after a reload. A run in flight is
// saved as its parts come back, so a phone that drops the tab keeps them.

const dbName = "sma.backtest";
const dbStore = "results";
const progressSaveMs = 5000;

let db: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  db ??= new Promise((done) => {
    try {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(dbStore);
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
  return db;
}

async function dbRequest<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const d = await openDb();
  if (!d) throw new Error("no IndexedDB");
  return new Promise((done, fail) => {
    const tx = d.transaction(dbStore, mode);
    const req = op(tx.objectStore(dbStore));
    tx.oncomplete = () => done(req.result);
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });
}

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
}

export interface RunState<R, B> {
  busy: Busy | null;
  errors: string[];
  runs: B[];
  ran: R | null;
  // Set when the user stopped the run: the parts back by then, of all of them.
  stopped?: { done: number; total: number } | null;
  // The last result is being read from the browser's storage.
  restoring?: boolean;
}

export interface BacktestRun<R extends RanBase, B> {
  start(ran: R): Promise<void>;
  stop(): void;
  state(): RunState<R, B>;
  use(): RunState<R, B>;
}

function backtestRun<R extends RanBase, B>(o: {
  endpoint: string;
  resultKey: string;
  sessionsPerPart?: number;
  body: (ran: R) => Record<string, unknown>;
}): BacktestRun<R, B> {
  const empty: RunState<R, B> = { busy: null, errors: [], runs: [], ran: null };
  let state: RunState<R, B> | null = null;
  const listeners = new Set<() => void>();
  // The run in flight: its id (a newer run replaces it) and what cancels its requests.
  let runId = 0;
  let controller: AbortController | null = null;

  const canStore = typeof indexedDB !== "undefined";
  /** What a saved result reads back as; null when it is not one. */
  function fromSaved(raw: unknown): RunState<R, B> | null {
    const saved = raw as Partial<RunState<R, B>> & {
      progress?: { done: number; total: number } | null;
    };
    if (!saved || !saved.ran || !Array.isArray(saved.runs)) return null;
    return {
      busy: null,
      errors: saved.errors ?? [],
      runs: saved.runs,
      ran: saved.ran,
      // A run the tab was dropped in the middle of: the parts back by then.
      stopped: saved.stopped ?? saved.progress ?? null,
    };
  }
  /** The saved result: IndexedDB, else (once) the old localStorage copy, which is then moved. */
  async function restore() {
    let found: RunState<R, B> | null = null;
    try {
      found = fromSaved(
        await dbRequest("readonly", (st) => st.get(o.resultKey)),
      );
    } catch {
      // No IndexedDB: nothing is restored.
    }
    if (!found) {
      try {
        const raw = localStorage.getItem(o.resultKey);
        if (raw) found = fromSaved(JSON.parse(raw));
      } catch {
        // Unreadable: dropped below.
      }
    }
    try {
      localStorage.removeItem(o.resultKey);
    } catch {
      // Nothing to free.
    }
    const now = current();
    // A run started meanwhile wins over the saved one.
    if (now.ran || now.busy) {
      set({ restoring: false });
      return;
    }
    set({ ...(found ?? empty), restoring: false });
    if (found) void save();
  }
  const current = (): RunState<R, B> => {
    if (!state) {
      state = { ...empty, restoring: canStore };
      if (canStore) void restore();
    }
    return state;
  };
  function set(next: Partial<RunState<R, B>>) {
    state = { ...current(), ...next };
    for (const l of listeners) l();
  }
  let saving = Promise.resolve();
  /** Keeps the result; `progress` while the run is still going. */
  function save(progress: { done: number; total: number } | null = null) {
    const { ran, runs, errors, stopped } = current();
    const value = { ran, runs, errors, stopped, progress };
    saving = saving.then(async () => {
      try {
        await dbRequest("readwrite", (st) => st.put(value, o.resultKey));
      } catch {
        // Not kept: drop the older result, so it never comes back as this one.
        await dbRequest("readwrite", (st) => st.delete(o.resultKey)).catch(
          () => {},
        );
      }
    });
    return saving;
  }
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };

  /**
   * Stops the run now (the user, 2026-10-31: "add stop button that works"):
   * the requests in flight are cancelled, no new part starts, and the parts
   * already back stay as the result. The server may finish a cancelled part;
   * it is not read.
   */
  function stop() {
    const busy = current().busy;
    if (!busy) return;
    runId++;
    controller?.abort();
    controller = null;
    set({ busy: null, stopped: { done: busy.done, total: busy.total } });
    void save();
  }

  async function start(ran: R) {
    if (current().busy) return;
    // Period parts first, so the run moves through the period in time order.
    const jobs = periodParts(ran.from, ran.to, o.sessionsPerPart).flatMap((p) =>
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
    let savedAt = startedAt;
    const got: B[] = [];
    const failed: string[] = [];
    const worker = async () => {
      while (next < jobs.length && live()) {
        const job = jobs[next++]!;
        try {
          const response = await fetch(o.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...job, ...o.body(ran) }),
            signal: AbortSignal.any([
              abort.signal,
              AbortSignal.timeout(180000),
            ]),
          });
          const body = await readJson<B>(response);
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
          busy: {
            done,
            total: jobs.length,
            startedAt,
            lastDoneAt: Date.now(),
          },
        });
        if (canStore && Date.now() - savedAt >= progressSaveMs) {
          savedAt = Date.now();
          void save({ done, total: jobs.length });
        }
      }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
    if (!live()) return;
    controller = null;
    set({ busy: null });
    void save();
  }

  return {
    start,
    stop,
    state: current,
    use: () => useSyncExternalStore(subscribe, current),
  };
}

/** The Main bot's run. */
export const mainRun = backtestRun<Ran, BotBacktestResponse>({
  endpoint: "/api/bot-backtest",
  resultKey: "sma.botBacktest.result.v1",
  body: (ran) => ({ rules: ran.rules, fillPct: ran.fillPct }),
});

/**
 * The Volume bot's run: 20 sessions a request (the server takes 60), as each
 * alert also reads the stock's trades for its seconds.
 */
export const volumeRun = backtestRun<VolumeRan, VolumeBacktestResponse>({
  endpoint: "/api/volume-backtest",
  resultKey: "sma.volumeBacktest.result.v1",
  sessionsPerPart: 20,
  body: (ran) => ({ settings: ran.settings, fillPct: ran.fillPct }),
});

export const startRun = mainRun.start;
export const stopRun = mainRun.stop;
export const runState = mainRun.state;
export const useBacktestRun = (): RunState<Ran, BotBacktestResponse> =>
  mainRun.use();
