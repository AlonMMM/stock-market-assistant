// The Backtest page's retry of a part whose connection failed (apps/web/src/retry.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTransient,
  TransientHttpError,
  transientStatus,
  withRetries,
} from "../apps/web/src/retry.js";

const noWait = async () => {};

test("a dropped connection is asked again and the part comes back", async () => {
  let calls = 0;
  const waits: number[] = [];
  const got = await withRetries(
    async () => {
      if (++calls < 3) throw new TypeError("Failed to fetch");
      return "part";
    },
    { delaysMs: [1, 2, 3], wait: async (ms) => void waits.push(ms) },
  );
  assert.equal(got, "part");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1, 2]);
});

test("the last error is thrown once the pauses run out", async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(
      async () => {
        calls++;
        throw new TypeError("Failed to fetch");
      },
      { delaysMs: [1, 2], wait: noWait },
    ),
    /Failed to fetch/,
  );
  assert.equal(calls, 3);
});

test("the server's answer about the part is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(
      async () => {
        calls++;
        throw new Error("Unknown symbol");
      },
      { delaysMs: [1, 2], wait: noWait },
    ),
    /Unknown symbol/,
  );
  assert.equal(calls, 1);
});

test("the user's Stop is not retried", async () => {
  const stop = new AbortController();
  let calls = 0;
  await assert.rejects(
    withRetries(
      async () => {
        calls++;
        stop.abort();
        throw new TypeError("Failed to fetch");
      },
      { delaysMs: [1, 2], wait: noWait, signal: stop.signal },
    ),
  );
  assert.equal(calls, 1);
});

test("Stop ends a pause at once", async () => {
  const stop = new AbortController();
  const run = withRetries(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    { delaysMs: [60000], signal: stop.signal },
  );
  stop.abort();
  await assert.rejects(run);
});

test("which failures count as the connection's", () => {
  assert.ok(isTransient(new TypeError("Load failed")));
  assert.ok(isTransient(new DOMException("timed out", "TimeoutError")));
  assert.ok(isTransient(new TransientHttpError("Server limit reached", 503)));
  assert.ok(!isTransient(new DOMException("stopped", "AbortError")));
  assert.ok(!isTransient(new Error("Request failed (HTTP 400)")));
  for (const s of [429, 502, 503, 504, 522, 524]) assert.ok(transientStatus(s));
  for (const s of [200, 400, 401, 404, 500]) assert.ok(!transientStatus(s));
});
