import assert from "node:assert/strict";
import test from "node:test";
import { handleMcp, tools } from "../apps/connector/src/mcp.js";

const token = "t".repeat(40);
const env = {
  MCP_TOKEN: token,
  TRADER_URL: "https://trader.test",
  TRADER_TOKEN: "service-token",
};
type Seen = { url: string; method: string; auth: string | null; body: unknown };

function setup(
  answer: { status?: number; body?: unknown; down?: boolean } = {},
) {
  const seen: Seen[] = [];
  const fetcher = (async (input: URL, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: init.method ?? "GET",
      auth: new Headers(init.headers).get("Authorization"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (answer.down) throw new Error("connect failed");
    return Response.json(answer.body ?? { ok: true }, {
      status: answer.status ?? 200,
    });
  }) as unknown as typeof fetch;
  const rpc = async (
    method: string,
    params?: unknown,
    options: { path?: string; auth?: string | null; id?: number | null } = {},
  ) => {
    const auth = options.auth === undefined ? `Bearer ${token}` : options.auth;
    const response = await handleMcp(
      new Request(`https://connector.test${options.path ?? "/mcp"}`, {
        method: "POST",
        headers: auth ? { Authorization: auth } : {},
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(options.id === null ? {} : { id: options.id ?? 1 }),
          method,
          ...(params === undefined ? {} : { params }),
        }),
      }),
      env,
      fetcher,
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { seen, rpc };
}

test("connector: without the credential nothing is answered or forwarded", async () => {
  const { seen, rpc } = setup();
  for (const auth of [null, "Bearer wrong", `Bearer ${token}x`, "Basic abc"])
    assert.equal((await rpc("tools/list", undefined, { auth })).status, 401);
  assert.equal(
    (await rpc("tools/list", undefined, { auth: null, path: "/mcp/guess" }))
      .status,
    401,
  );
  assert.equal(
    (await rpc("tools/list", undefined, { path: "/other" })).status,
    404,
  );
  assert.equal(seen.length, 0);
  const unset = await handleMcp(
    new Request("https://connector.test/mcp", { method: "POST" }),
    { ...env, MCP_TOKEN: "short" },
  );
  assert.equal(unset.status, 503);
});

test("connector: the credential works as a header or as the end of the address", async () => {
  const { rpc } = setup();
  assert.equal((await rpc("ping")).status, 200);
  const byPath = await rpc("ping", undefined, {
    auth: null,
    path: `/mcp/${token}`,
  });
  assert.deepEqual(byPath.body, { jsonrpc: "2.0", id: 1, result: {} });
});

test("connector: initialize, notifications and the tool list", async () => {
  const { rpc } = setup();
  const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
  assert.equal(init.body.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.body.result.capabilities, { tools: {} });
  const newer = await rpc("initialize", { protocolVersion: "2099-01-01" });
  assert.equal(newer.body.result.protocolVersion, "2025-06-18");
  const note = await rpc("notifications/initialized", undefined, { id: null });
  assert.deepEqual([note.status, note.body], [202, null]);
  const list = await rpc("tools/list");
  assert.deepEqual(
    list.body.result.tools.map((t: { name: string }) => t.name),
    ["buy", "preview", "trade_status", "sell", "set_stop", "positions"],
  );
  assert.equal(list.body.result.tools[0].call, undefined);
  assert.equal((await rpc("resources/list")).body.error.code, -32601);
});

test("connector: each tool reaches its route on the trading service", async () => {
  const { seen, rpc } = setup({ body: { status: "started", jobId: "j1" } });
  const call = (name: string, args: unknown) =>
    rpc("tools/call", { name, arguments: args });
  const buy = { underlying: "NVDA", right: "call", sizePct: 0.5 };
  const out = await call("buy", buy);
  assert.equal(out.body.result.isError, false);
  assert.deepEqual(JSON.parse(out.body.result.content[0].text), {
    status: "started",
    jobId: "j1",
  });
  await call("preview", buy);
  await call("trade_status", { jobId: "a/b" });
  await call("sell", { underlying: "NVDA", qty: "half" });
  await call("set_stop", { underlying: "NVDA", stopPct: 30 });
  await call("positions", {});
  assert.deepEqual(
    seen.map((s) => [
      s.method,
      s.url.replace("https://trader.test", ""),
      s.body,
    ]),
    [
      ["POST", "/v1/buy", buy],
      ["POST", "/v1/preview", buy],
      ["GET", "/v1/jobs/a%2Fb", undefined],
      ["POST", "/v1/sell", { underlying: "NVDA", qty: "half" }],
      ["POST", "/v1/stop", { underlying: "NVDA", stopPct: 30 }],
      ["GET", "/v1/positions", undefined],
    ],
  );
  assert.ok(seen.every((s) => s.auth === "Bearer service-token"));
  assert.equal(tools.length, 6);
});

test("connector: errors of the trading service are shown as errors", async () => {
  const refused = setup({
    status: 400,
    body: { error: "No option position in NVDA" },
  });
  const out = await refused.rpc("tools/call", {
    name: "sell",
    arguments: { underlying: "NVDA", qty: "all" },
  });
  assert.equal(out.body.result.isError, true);
  assert.match(out.body.result.content[0].text, /No option position in NVDA/);
  const down = setup({ down: true });
  const lost = await down.rpc("tools/call", {
    name: "positions",
    arguments: {},
  });
  assert.equal(lost.body.result.isError, true);
  assert.match(lost.body.result.content[0].text, /unreachable/);
  const unknown = await down.rpc("tools/call", {
    name: "wire_money",
    arguments: {},
  });
  assert.equal(unknown.body.error.code, -32602);
});
