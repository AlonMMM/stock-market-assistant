import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

test(
  "collector waits for activation, protects endpoints, and shuts down without Alpaca",
  { timeout: 10000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-"));
    const token = randomBytes(32).toString("hex");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/collector/src/main.ts"],
      {
        env: {
          ...process.env,
          PORT: "0",
          COLLECTOR_HOST: "127.0.0.1",
          ALPACA_ENABLED: "false",
          ALPACA_SYMBOLS: "AAPL",
          ALPACA_WATCHLIST: "/missing/watchlist.json",
          COLLECTOR_TOKEN: token,
          COLLECTOR_DB: join(dir, "test.sqlite"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += String(chunk);
          if (!buffer.includes("\n")) return;
          try {
            resolve(JSON.parse(buffer.split("\n")[0]!).address.port);
          } catch (e) {
            reject(e);
          }
        });
        child.once("exit", (code) =>
          reject(new Error(`Unexpected exit ${code}`)),
        );
        child.once("error", reject);
      });
      const url = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${url}/health`)).status, 401);
      const headers = { Authorization: `Bearer ${token}` };
      const health = await (await fetch(`${url}/health`, { headers })).json();
      assert.equal(health.source, "alpaca");
      assert.equal(health.feed, "iex");
      assert.equal(health.state, "awaiting-alpaca-activation");
      assert.deepEqual(health.symbols, {});
      const alerts = await (await fetch(`${url}/alerts`, { headers })).json();
      assert.deepEqual(alerts.alerts, []);
    } finally {
      child.kill("SIGTERM");
      await exited;
      rmSync(dir, { recursive: true });
    }
  },
);
