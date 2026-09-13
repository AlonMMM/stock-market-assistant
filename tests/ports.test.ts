import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { getPorts } from "../packages/config/src/ports.js";

test("local worktree ports apply consistently and environment can select E2E ports", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "sma-ports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(getPorts(root, {}), {
    web: 5173,
    api: 3001,
    e2eWeb: 5174,
    e2eApi: 3002,
  });
  const ports = { web: 5200, api: 5201, e2eWeb: 5202, e2eApi: 5203 };
  writeFileSync(resolve(root, ".sma-session.json"), JSON.stringify({ ports }));
  assert.deepEqual(getPorts(root, {}), ports);
  assert.equal(
    getPorts(root, { SMA_WEB_PORT: "5202", SMA_API_PORT: "5203" }).api,
    5203,
  );
  assert.throws(() => getPorts(root, { SMA_WEB_PORT: "NaN" }), /Invalid/);
  assert.throws(() => getPorts(root, { SMA_WEB_PORT: "5201" }), /must differ/);
});
