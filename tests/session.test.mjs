import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseArgs } from "../scripts/session.mjs";

const launcher = fileURLToPath(
  new URL("../scripts/session.mjs", import.meta.url),
);

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), "sma-session-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = resolve(directory, "repo");
  mkdirSync(root);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Session Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(resolve(root, ".gitignore"), ".sma-session.json\n");
  writeFileSync(resolve(root, "README.md"), "# Fixture\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const registry = resolve(root, ".git/sma-sessions");
  const invoke = (args, env = process.env) =>
    spawnSync(process.execPath, [launcher, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
    });
  const record = (id) =>
    JSON.parse(readFileSync(resolve(registry, `${id}.json`), "utf8"));
  return { root, directory, registry, invoke, record, git };
}

test("rejects unknown roles, unsafe names, and ambiguous selection", () => {
  for (const args of [
    ["--role", "admin"],
    ["--task", "../../escape"],
    ["--task", "a;touch-file"],
    ["--resume", "backend-one", "--role", "backend"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseArgs(args));
  }
});

test("isolated worktrees have distinct port blocks; reopening preserves role and user edits", (t) => {
  const f = fixture(t);
  for (const role of ["backend", "frontend"]) {
    const result = f.invoke([
      "--role",
      role,
      "--task",
      "alert-feed",
      "--prepare-only",
    ]);
    assert.equal(result.status, 0, result.stderr);
  }
  const backend = f.record("backend-alert-feed");
  const frontend = f.record("frontend-alert-feed");
  assert.notEqual(backend.worktree, frontend.worktree);
  assert.equal(
    new Set([...Object.values(backend.ports), ...Object.values(frontend.ports)])
      .size,
    8,
  );
  assert.equal(backend.sourceSha, f.git("rev-parse", "HEAD"));
  writeFileSync(resolve(backend.worktree, "user-edit.txt"), "keep my work");
  const resumed = f.invoke(["--resume", backend.id, "--prepare-only"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(f.record(backend.id), backend);
  assert.equal(
    readFileSync(resolve(backend.worktree, "user-edit.txt"), "utf8"),
    "keep my work",
  );
  assert.equal(
    JSON.parse(
      readFileSync(resolve(backend.worktree, ".sma-session.json"), "utf8"),
    ).role,
    "backend",
  );
  assert.equal(f.git("status", "--porcelain"), "");
});

test("active session lock blocks a second writer without changing the worktree", (t) => {
  const f = fixture(t);
  assert.equal(
    f.invoke(["--role", "integration", "--task", "review", "--prepare-only"])
      .status,
    0,
  );
  const lock = resolve(f.registry, "integration-review.lock");
  mkdirSync(lock);
  const result = f.invoke(["--resume", "integration-review", "--prepare-only"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already active/);
  assert.ok(existsSync(lock));
});

test("dirty source does not create a partial session; unknown resume fails", (t) => {
  const f = fixture(t);
  writeFileSync(resolve(f.root, "uncommitted.txt"), "keep");
  const result = f.invoke([
    "--role",
    "backend",
    "--task",
    "one",
    "--prepare-only",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Commit or stash/);
  assert.ok(!existsSync(resolve(f.registry, "backend-one.json")));
  assert.equal(
    f.invoke(["--resume", "backend-missing", "--prepare-only"]).status,
    1,
  );
});

test("launcher passes role on first launch, resumes exact UUID, and fresh preserves worktree", (t) => {
  const f = fixture(t);
  const bin = resolve(f.directory, "bin");
  mkdirSync(bin);
  const fake = resolve(bin, "claude");
  const output = resolve(f.directory, "claude-calls.jsonl");
  writeFileSync(
    fake,
    '#!/usr/bin/env node\nconst fs=require("node:fs"); if(process.argv[2]==="--version") { console.log("test CLI"); } else { fs.appendFileSync(process.env.SMA_TEST_LOG,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+"\\n"); }\n',
  );
  chmodSync(fake, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    SMA_TEST_LOG: output,
  };
  const first = f.invoke(["--role", "product-ux", "--task", "alert-flow"], env);
  assert.equal(first.status, 0, first.stderr);
  const saved = f.record("product-ux-alert-flow");
  const second = f.invoke(["--resume", saved.id], env);
  assert.equal(second.status, 0, second.stderr);
  const calls = readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls[0].cwd, saved.worktree);
  assert.deepEqual(calls[0].args.slice(0, 2), [
    "--session-id",
    saved.claudeSessionId,
  ]);
  assert.match(calls[0].args[2], /docs\/roles\/product-ux.md/);
  assert.deepEqual(calls[1].args, ["--resume", saved.claudeSessionId]);
  assert.equal(f.invoke(["--resume", saved.id, "--fresh"], env).status, 0);
  const fresh = f.record(saved.id);
  assert.notEqual(fresh.claudeSessionId, saved.claudeSessionId);
  assert.equal(fresh.worktree, saved.worktree);
  assert.deepEqual(fresh.ports, saved.ports);
  assert.equal(fresh.role, saved.role);
});
