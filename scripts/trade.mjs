// `npm run trade -- preview|buy|stop …`: runs scripts/option-order.ts with the
// keys from `.env`. A worktree usually has no `.env`, so the main checkout's
// is used when this one has none.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

let main = "";
try {
  main = execFileSync("git", ["worktree", "list", "--porcelain"], {
    encoding: "utf8",
  })
    .split("\n")[0]
    .replace(/^worktree /, "");
} catch {
  // Not a Git checkout: only the local .env is tried.
}
const env = [".env", ...(main ? [join(main, ".env")] : [])].find(existsSync);
const result = spawnSync(
  process.execPath,
  [
    ...(env ? [`--env-file=${env}`] : []),
    "--import",
    "tsx",
    "scripts/option-order.ts",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
