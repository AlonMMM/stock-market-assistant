import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

export const roles = {
  "product-ux": "Product + UX",
  backend: "Backend",
  frontend: "Frontend",
  integration: "Integration / Review",
};

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (["--prepare-only", "--list", "--fresh", "--help"].includes(key))
      options[key.slice(2)] = true;
    else if (
      ["--role", "--task", "--resume"].includes(key) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      options[key.slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${key}`);
  }
  if (options.role && !Object.hasOwn(roles, options.role))
    throw new Error(
      "Unknown role. Use product-ux, backend, frontend, or integration.",
    );
  for (const key of ["task", "resume"]) {
    if (
      options[key] &&
      (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options[key]) ||
        options[key].length > 90)
    )
      throw new Error(`${key} must be a short lowercase kebab-case name.`);
  }
  if (options.resume && (options.role || options.task))
    throw new Error("Use --resume OR --role/--task.");
  return options;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || result.stderr.trim());
  return result.stdout.trim();
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function lock(path) {
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `Session operation already active (or stale lock): ${path}. Close the other launcher first. See docs/sessions.md for crash recovery.`,
    );
  }
  writeJson(resolve(path, "owner.json"), { pid: process.pid });
  return () => rmSync(path, { recursive: true });
}

function available(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

function records(registry) {
  return readdirSync(registry)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(resolve(registry, name), "utf8")));
}

async function allocatePorts(registry) {
  const reserved = new Set(
    records(registry).flatMap((item) => Object.values(item.ports)),
  );
  for (let start = 5200; start < 9200; start += 4) {
    const ports = {
      web: start,
      api: start + 1,
      e2eWeb: start + 2,
      e2eApi: start + 3,
    };
    if (Object.values(ports).some((port) => reserved.has(port))) continue;
    const free = await Promise.all(Object.values(ports).map(available));
    if (free.every(Boolean)) return ports;
  }
  throw new Error("No free session port block found between 5200 and 9199.");
}

export function claudeArgs(record, fresh = false) {
  if (record.conversationStarted && !fresh)
    return ["--resume", record.claudeSessionId];
  return [
    "--session-id",
    record.claudeSessionId,
    `Work in the ${roles[record.role]} role on task ${record.task}. Read AGENTS.md, docs/roles/${record.role}.md, and docs/tasks/${record.id}.md. The role is already selected; do not ask again. Inspect the branch and current files, then clarify the task outcome if its acceptance criteria are not defined. Keep changes within this task; do not automatically merge or deploy.`,
  ];
}

async function prepare(root, registry, options) {
  const release = lock(resolve(registry, "registry.lock"));
  try {
    const id = options.resume || `${options.role}-${options.task}`;
    const path = resolve(registry, `${id}.json`);
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (!existsSync(record.worktree))
        throw new Error(
          `Worktree missing: ${record.worktree}. Restore it before resuming; no replacement was created.`,
        );
      const branch = git(record.worktree, ["branch", "--show-current"]);
      if (branch !== record.branch)
        throw new Error(
          `Expected branch ${record.branch}, found ${branch}. Restore the expected branch before resuming.`,
        );
      return record;
    }
    if (options.resume) throw new Error(`Unknown session: ${id}. Use --list.`);
    if (git(root, ["status", "--porcelain"]))
      throw new Error(
        "Commit or stash your current changes before creating a new session. The launcher does not include uncommitted files.",
      );
    const sourceSha = git(root, ["rev-parse", "HEAD"]);
    const ports = await allocatePorts(registry);
    const primary = dirname(dirname(registry));
    const worktree = resolve(
      dirname(primary),
      `${basename(primary)}-sessions`,
      id,
    );
    const branch = `session/${id}`;
    if (existsSync(worktree))
      throw new Error(
        `Target already exists: ${worktree}. It will not be overwritten.`,
      );
    git(root, ["worktree", "add", "-b", branch, worktree, sourceSha]);
    const record = {
      id,
      role: options.role,
      task: options.task,
      branch,
      worktree,
      sourceSha,
      ports,
      claudeSessionId: randomUUID(),
      conversationStarted: false,
    };
    writeJson(path, record);
    return record;
  } finally {
    release();
  }
}

function setupLocalContext(record) {
  writeJson(resolve(record.worktree, ".sma-session.json"), {
    role: record.role,
    task: record.task,
    ports: record.ports,
  });
  const taskPath = resolve(record.worktree, "docs/tasks", `${record.id}.md`);
  if (!existsSync(taskPath)) {
    mkdirSync(dirname(taskPath), { recursive: true });
    writeFileSync(
      taskPath,
      `# Task: ${record.task}\n\nOwner: ${record.role}\nStatus: proposed\nBranch: ${record.branch}\n\n## Outcome\n\nTo be defined with the user before implementation.\n\n## Acceptance criteria\n\nTo be defined.\n\n## Dependencies and scope\n\nRead [role responsibilities](../roles/${record.role}.md). Record required specs/contracts and their commit IDs.\n\n## Verification and handoff\n\nRecord actual checks, remaining work, and handoff to Integration.\n`,
    );
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(
      "npm run session\n  --role backend --task first-alert [--prepare-only]\n  --resume backend-first-alert [--fresh] [--prepare-only]\n  --list\nRoles: product-ux, backend, frontend, integration. New worktrees start from current committed HEAD; no fetch/merge is automatic.",
    );
    return 0;
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const common = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const registry = resolve(common, "sma-sessions");
  mkdirSync(registry, { recursive: true });
  const existing = records(registry);
  if (options.list) {
    console.log(
      existing.length
        ? existing
            .map(
              (r) =>
                `${r.id} | ${roles[r.role]} | web ${r.ports.web} | ${r.worktree}`,
            )
            .join("\n")
        : "No saved sessions.",
    );
    return 0;
  }
  if (!options.resume && (!options.role || !options.task)) {
    if (!process.stdin.isTTY)
      throw new Error(
        "Interactive terminal required, or supply --role and --task / --resume.",
      );
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      if (!options.role && !options.task && existing.length) {
        console.log("Saved sessions:");
        existing.forEach((r, i) =>
          console.log(`${i + 1}. ${r.id} (${roles[r.role]})`),
        );
        const answer = (
          await input.question("Resume a number, or Enter for a new session: ")
        ).trim();
        if (answer) {
          const selected = /^\d+$/.test(answer)
            ? existing[Number(answer) - 1]
            : undefined;
          if (!selected) throw new Error("Invalid session selection.");
          options.resume = selected.id;
        }
      }
      if (!options.resume) {
        if (!options.role) {
          const keys = Object.keys(roles);
          keys.forEach((key, i) => console.log(`${i + 1}. ${roles[key]}`));
          const answer = (
            await input.question("Which role for this session? ")
          ).trim();
          options.role = /^\d+$/.test(answer)
            ? keys[Number(answer) - 1]
            : answer;
        }
        if (!options.task)
          options.task = (
            await input.question("Task name (e.g. alert-feed): ")
          ).trim();
        parseArgs(["--role", options.role || "", "--task", options.task || ""]);
      }
    } finally {
      input.close();
    }
  }
  if (!options["prepare-only"]) {
    const check = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (check.error || check.status !== 0)
      throw new Error(
        "Claude Code is unavailable on PATH. Install/sign in to it, or use --prepare-only to prepare the worktree without launching it.",
      );
  }
  const record = await prepare(root, registry, options);
  const release = lock(resolve(registry, `${record.id}.lock`));
  // Let Claude handle terminal Ctrl+C; release our lock after the child exits.
  const hold = () => {};
  process.on("SIGINT", hold);
  try {
    setupLocalContext(record);
    console.log(
      `\n${roles[record.role]} / ${record.task}\nWorktree: ${record.worktree}\nBranch: ${record.branch}\nWeb: http://127.0.0.1:${record.ports.web}\nAPI: http://127.0.0.1:${record.ports.api}\nE2E: ${record.ports.e2eWeb}/${record.ports.e2eApi}\n`,
    );
    if (options["prepare-only"]) {
      console.log(
        "Prepared. Run npm ci in the worktree, then npm run dev in a separate terminal. Resume with npm run session -- --resume " +
          record.id,
      );
      return 0;
    }
    if (options.fresh) {
      record.claudeSessionId = randomUUID();
      record.conversationStarted = false;
    }
    writeJson(resolve(registry, `${record.id}.json`), record);
    console.log(
      "Dependencies are not installed automatically. Use npm ci in this worktree when needed.",
    );
    const child = spawnSync("claude", claudeArgs(record), {
      cwd: record.worktree,
      stdio: "inherit",
    });
    if (child.error) throw child.error;
    if (child.status === 0) {
      record.conversationStarted = true;
      writeJson(resolve(registry, `${record.id}.json`), record);
    } else
      console.error(
        "Claude did not exit cleanly. If resume fails, use --resume " +
          record.id +
          " --fresh for a new conversation in the same worktree.",
      );
    return child.status ?? 1;
  } finally {
    process.off("SIGINT", hold);
    release();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
