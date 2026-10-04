// Version of the backtest evaluation code (Node only): a hash of every source
// that changes a backtest's result. Part of each cached result's key, so a
// change to the rule or the scoring never reuses results of older code. The
// Worker, which cannot read files, gets it at build time (build-worker.mjs).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const evaluationSources = [
  "packages/alerts/src/relative-volume.ts",
  "packages/market-data/src/backtest.ts",
  "packages/market-data/src/bars.ts",
  "packages/market-data/src/beta.ts",
  "packages/market-data/src/calendar.ts",
  "packages/market-data/src/evaluator.ts",
  "packages/market-data/src/look-now.ts",
  "packages/market-data/src/outcome.ts",
];

/** `root` is the repository directory, ending with a slash. */
export function codeVersion(root: string): string {
  const hash = createHash("sha256");
  for (const file of evaluationSources)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(`${root}${file}`))
      .update("\0");
  return hash.digest("hex").slice(0, 16);
}
