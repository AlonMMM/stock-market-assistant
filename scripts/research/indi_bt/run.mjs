// Runs one of the Python steps with the Alpaca keys from .env in its environment (and nowhere else).
//   node --env-file=.env scripts/research/indi_bt/run.mjs <script.py> [args...]
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const [script, ...args] = process.argv.slice(2);
const r = spawnSync("python3", [join(dirname(fileURLToPath(import.meta.url)), script), ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
