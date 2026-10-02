import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const errors = [];
if (Number(process.versions.node.split(".")[0]) !== 24)
  errors.push("Use Node.js 24 (see .nvmrc).");
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  errors.push("Git is required.");
}
if (!existsSync(resolve(root, "node_modules")))
  errors.push("Run npm ci to install locked dependencies.");
for (const name of [
  "AGENTS.md",
  "README.md",
  "CLAUDE.md",
  "docs/state.md",
  "docs/product.md",
  "docs/workflow.md",
  "docs/decisions.md",
  "docs/development.md",
  "docs/task-template.md",
  "docs/sessions.md",
  ".claude/settings.json",
  "scripts/session-start.mjs",
  "docs/roles/index.md",
  "docs/roles/product-ux.md",
  "docs/roles/backend.md",
  "docs/roles/frontend.md",
  "docs/roles/integration.md",
]) {
  const path = resolve(root, name);
  if (!existsSync(path)) {
    errors.push(`Missing context file: ${name}`);
    continue;
  }
  const content = readFileSync(path, "utf8");
  if (!content.trim()) errors.push(`Empty context file: ${name}`);
  for (const [, target] of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("#"))
      continue;
    if (!existsSync(resolve(dirname(path), target.split("#")[0])))
      errors.push(`Broken link in ${name}: ${target}`);
  }
}
// Warn when app code changed after docs/state.md was last committed. Skipped when
// state.md has uncommitted edits or the history is too shallow to compare (CI).
const appPaths = [
  "apps",
  "packages",
  "config",
  "Dockerfile.collector",
  "wrangler.jsonc",
];
const lastCommit = (...paths) => {
  try {
    return execFileSync(
      "git",
      ["log", "-1", "--format=%ct %h", "--", ...paths],
      {
        cwd: root,
        encoding: "utf8",
      },
    ).trim();
  } catch {
    return "";
  }
};
const stateEdited = (() => {
  try {
    return !!execFileSync(
      "git",
      ["status", "--porcelain", "--", "docs/state.md"],
      {
        cwd: root,
        encoding: "utf8",
      },
    ).trim();
  } catch {
    return true;
  }
})();
const [stateTime] = lastCommit("docs/state.md").split(" ");
const [appTime, appCommit] = lastCommit(...appPaths).split(" ");
if (!stateEdited && stateTime && appTime && Number(appTime) > Number(stateTime))
  console.warn(
    `WARN: docs/state.md is older than the latest app change (${appCommit}). Update it in the same PR (AGENTS.md).`,
  );
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "PASS: Node 24, Git, installed dependencies, and context links. Next: npm run check.",
  );
