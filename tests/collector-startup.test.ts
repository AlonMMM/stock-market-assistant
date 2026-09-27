import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Starts the collector and returns its base URL once it logs its address.
async function start(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/collector/src/main.ts"],
    {
      env: {
        ...process.env,
        PORT: "0",
        COLLECTOR_HOST: "127.0.0.1",
        COLLECTOR_DB: join(dir, "test.sqlite"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  const first = await new Promise<{ state: string; port: number }>(
    (resolve, reject) => {
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        if (!buffer.includes("\n")) return;
        try {
          const line = JSON.parse(buffer.split("\n")[0]!);
          resolve({ state: line.state, port: line.address.port });
        } catch (e) {
          reject(e);
        }
      });
      child.once("exit", (code) =>
        reject(new Error(`Unexpected exit ${code}`)),
      );
      child.once("error", reject);
    },
  );
  return {
    ...first,
    url: `http://127.0.0.1:${first.port}`,
    async close() {
      child.kill("SIGTERM");
      await exited;
      rmSync(dir, { recursive: true });
    },
  };
}

test(
  "collector waits for activation, protects endpoints, and stores the synced watchlist",
  { timeout: 10000 },
  async () => {
    const token = randomBytes(32).toString("hex");
    const syncToken = randomBytes(32).toString("hex");
    const collector = await start({
      ALPACA_ENABLED: "false",
      ALPACA_MAX_SYMBOLS: "2",
      COLLECTOR_TOKEN: token,
      WATCHLIST_SYNC_TOKEN: syncToken,
    });
    const { url } = collector;
    try {
      assert.equal(collector.state, "awaiting-alpaca-activation");
      assert.equal((await fetch(`${url}/health`)).status, 401);
      const headers = { Authorization: `Bearer ${token}` };
      const health = await (await fetch(`${url}/health`, { headers })).json();
      assert.equal(health.source, "alpaca");
      assert.equal(health.feed, "iex");
      assert.equal(health.state, "awaiting-alpaca-activation");
      assert.deepEqual(health.symbols, {});
      const alerts = await (await fetch(`${url}/alerts`, { headers })).json();
      assert.deepEqual(alerts.alerts, []);

      assert.equal((await fetch(`${url}/watchlist`, { headers })).status, 404);
      const put = (auth: string, body: unknown) =>
        fetch(`${url}/watchlist`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      assert.equal((await put(syncToken, { name: "Favorites" })).status, 400);
      assert.equal(
        (await put(syncToken, { name: "F", tickers: ["ES@CME"] })).status,
        400,
      );
      const synced = await put(syncToken, {
        name: "Favorites",
        tickers: ["NVDA", "AAPL", "NVDA", "MSFT"],
      });
      assert.equal(synced.status, 200);
      const body = await synced.json();
      assert.deepEqual(body.tickers, ["NVDA", "AAPL", "MSFT"]);
      assert.deepEqual(body.live, ["NVDA", "AAPL"]);
      assert.equal(body.restarting, false);

      const list = await (await fetch(`${url}/watchlist`, { headers })).json();
      assert.equal(list.name, "Favorites");
      assert.deepEqual(list.live, ["NVDA", "AAPL"]);
      // The sync token may only replace the watchlist.
      const syncHeaders = { Authorization: `Bearer ${syncToken}` };
      for (const path of ["/watchlist", "/health", "/alerts"])
        assert.equal(
          (await fetch(`${url}${path}`, { headers: syncHeaders })).status,
          401,
          path,
        );
    } finally {
      await collector.close();
    }
  },
);

test(
  "an enabled collector without a synced watchlist waits for one",
  { timeout: 10000 },
  async () => {
    const collector = await start({
      ALPACA_ENABLED: "true",
      ALPACA_API_KEY: "key",
      ALPACA_API_SECRET: "secret",
      COLLECTOR_TOKEN: randomBytes(32).toString("hex"),
    });
    try {
      assert.equal(collector.state, "awaiting-watchlist");
    } finally {
      await collector.close();
    }
  },
);
