import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PriceBar, RawBar } from "../../market-data/src/bars.js";
import { newYorkToUtc } from "../../market-data/src/calendar.js";
import { chartNamePattern } from "./technical-facts.js";

// Runs the user's technical-scan skill script (vendored from
// AlonMMM/stock-scanner, see technical-scan/README.md) on Alpaca bars. The
// script does all the level/relative-strength math; nothing here recomputes it.

export const technicalScript = fileURLToPath(
  new URL("../technical-scan/analyze.py", import.meta.url),
);

// get_price_history-shaped series: parallel arrays, ISO bar-start times.
export interface SeriesJson {
  time: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export interface TechnicalInput {
  ticker: string;
  benchmark: string;
  daily: RawBar[]; // split-adjusted, sessions before the alert day
  benchmarkDaily: RawBar[];
  minutes: PriceBar[]; // the ticker's one-minute bars up to the alert bar
  benchmarkMinutes: PriceBar[]; // the benchmark's, at least two sessions
}

export interface Chart {
  name: string; // the script's file name, e.g. 06_trade_levels.png
  png: Buffer;
}

export interface TechnicalScan {
  summary: Record<string, unknown>;
  charts: Chart[]; // in the script's order
}

// Regular-session buckets like IBKR's RTH bars: 5-minute, and hourly with a
// 9:30–10:00 first bar, then on the hour.
const fiveMinute = (start: number) => start - (start % 5);
const hourly = (start: number) => (start < 600 ? 570 : start - (start % 60));

export function aggregate(
  bars: PriceBar[],
  bucket: (startMinute: number) => number,
): SeriesJson {
  const out: SeriesJson = {
    time: [],
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
  };
  let key = "";
  for (const bar of bars) {
    if (bar.session !== "regular") continue;
    const minute = bucket(bar.minute - 1);
    const next = `${bar.date} ${minute}`;
    const i = out.time.length - 1;
    if (next === key) {
      out.high[i] = Math.max(out.high[i]!, bar.high);
      out.low[i] = Math.min(out.low[i]!, bar.low);
      out.close[i] = bar.close;
      out.volume[i]! += bar.volume;
      continue;
    }
    key = next;
    out.time.push(new Date(newYorkToUtc(bar.date, minute)).toISOString());
    out.open.push(bar.open);
    out.high.push(bar.high);
    out.low.push(bar.low);
    out.close.push(bar.close);
    out.volume.push(bar.volume);
  }
  return out;
}

export function dailySeries(rows: RawBar[]): SeriesJson {
  return {
    time: rows.map((r) => new Date(r.start * 1000).toISOString()),
    open: rows.map((r) => r.open),
    high: rows.map((r) => r.high),
    low: rows.map((r) => r.low),
    close: rows.map((r) => r.close),
    volume: rows.map((r) => r.volume),
  };
}

// Last `count` sessions present in the bars, oldest first.
function lastSessions(bars: PriceBar[], count: number) {
  const dates = [
    ...new Set(bars.filter((b) => b.session === "regular").map((b) => b.date)),
  ];
  const keep = new Set(dates.slice(-count));
  return bars.filter((b) => keep.has(b.date));
}

export type ScriptRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stderr: string }>;

// `script` defaults to the source tree; a bundled collector passes its copy.
export const pythonRunner =
  (python: string, script = technicalScript): ScriptRunner =>
  (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = spawn(python, [script, ...args], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: timeoutMs,
        env: { ...process.env, MPLBACKEND: "Agg" },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 4000) stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });

/** Writes the inputs, runs the script and reads its summary and chart. */
export async function runTechnicalScan(
  input: TechnicalInput,
  run: ScriptRunner,
  timeoutMs = 90000,
): Promise<TechnicalScan> {
  const intraday = aggregate(lastSessions(input.minutes, 2), fiveMinute);
  const benchIntraday = aggregate(
    lastSessions(input.benchmarkMinutes, 2),
    fiveMinute,
  );
  const hours = aggregate(input.minutes, hourly);
  if (intraday.time.length < 12 || benchIntraday.time.length < 12)
    throw new Error("Too few regular-session bars for a technical scan");
  if (input.daily.length < 61 || input.benchmarkDaily.length < 61)
    throw new Error("Too few daily bars for a technical scan");
  const dir = await mkdtemp(join(tmpdir(), "technical-scan-"));
  try {
    const files: Record<string, SeriesJson> = {
      daily: dailySeries(input.daily),
      hourly: hours,
      intraday,
      "bench-intraday": benchIntraday,
      "bench-daily": dailySeries(input.benchmarkDaily),
    };
    const args = ["--ticker", input.ticker, "--benchmark", input.benchmark];
    for (const [name, series] of Object.entries(files)) {
      const path = join(dir, `${name}.json`);
      await writeFile(path, JSON.stringify(series));
      args.push(`--${name}`, path);
    }
    const out = join(dir, "out");
    args.push("--outdir", out);
    const result = await run(args, timeoutMs);
    if (result.code !== 0)
      throw new Error(
        `technical-scan exited ${result.code ?? "on timeout"}: ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
      );
    const summary = JSON.parse(
      await readFile(join(out, "summary.json"), "utf8"),
    ) as Record<string, unknown>;
    const names = (await readdir(out))
      .filter((name) => chartNamePattern.test(name))
      .sort();
    const charts = await Promise.all(
      names.map(async (name) => ({
        name,
        png: await readFile(join(out, name)),
      })),
    );
    return { summary, charts };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
