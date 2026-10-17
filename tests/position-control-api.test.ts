import assert from "node:assert/strict";
import test from "node:test";
import {
  controlAccess,
  handleControl,
  type ControlConfig,
} from "../packages/trading/src/control-api.js";
import { chartSession } from "../apps/web/src/positions-model.js";

const config = {
  owner: "Owner@Example.com",
  url: "https://trader.test",
  token: "service-token",
};
const owner = { email: "owner@example.com" };
const contract = "NVDA261016C00240000";
const origin = "https://site.test";

function setup(answer: { status?: number; body?: unknown } = {}) {
  const seen: {
    url: string;
    method: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  const fetcher = (async (input: URL, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: init.method ?? "GET",
      auth: new Headers(init.headers).get("Authorization"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(answer.body ?? { status: "started", jobId: "j1" }, {
      status: answer.status ?? 200,
    });
  }) as unknown as typeof fetch;
  const post = (
    identity: { email: string } | null,
    body: unknown,
    requestOrigin: string | null = origin,
    c: ControlConfig = config,
  ) =>
    handleControl(
      c,
      identity,
      {
        method: "POST",
        path: "/api/portfolio/control",
        body,
        origin,
        requestOrigin,
      },
      fetcher,
    );
  return { seen, post, fetcher };
}

test("position controls: only the owner's verified sign-in may trade", async () => {
  assert.deepEqual(controlAccess(config, owner), { canTrade: true });
  assert.equal(controlAccess(config, null).canTrade, false);
  assert.equal(
    controlAccess(config, { email: "other@example.com" }).canTrade,
    false,
  );
  // A near miss is not the owner, and an unset owner allows nobody.
  assert.equal(
    controlAccess(config, { email: "owner@example.co" }).canTrade,
    false,
  );
  assert.equal(
    controlAccess({ ...config, owner: "" }, { email: "" }).canTrade,
    false,
  );
  assert.equal(
    controlAccess({ ...config, token: undefined }, owner).canTrade,
    false,
  );

  const { seen, post } = setup();
  for (const who of [null, { email: "other@example.com" }]) {
    const refused = await post(who, { contract, qty: 0 });
    assert.equal(refused.status, 403);
  }
  const unset = await post(owner, { contract, qty: 0 }, origin, {
    ...config,
    owner: undefined,
  });
  assert.equal(unset.status, 403);
  assert.equal(seen.length, 0);
});

test("position controls: the owner's request reaches the trading service as a resize", async () => {
  const { seen, post, fetcher } = setup();
  const out = await post(owner, { contract, qty: 6, stopPct: 99, extra: 1 });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { status: "started", jobId: "j1" });
  assert.deepEqual(seen, [
    {
      url: "https://trader.test/v1/resize",
      method: "POST",
      auth: "Bearer service-token",
      // Only the contract and the size are passed on.
      body: { contract, qty: 6, via: "site" },
    },
  ]);
  const job = await handleControl(
    config,
    owner,
    {
      method: "GET",
      path: "/api/portfolio/control/jobs/j1",
      origin,
      requestOrigin: null,
    },
    fetcher,
  );
  assert.equal(job.status, 200);
  assert.equal(seen[1]!.url, "https://trader.test/v1/jobs/j1");
  // Whether one may trade is answered to anyone who can open the site.
  const asked = await handleControl(
    config,
    { email: "other@example.com" },
    {
      method: "GET",
      path: "/api/portfolio/control",
      origin,
      requestOrigin: null,
    },
    fetcher,
  );
  assert.deepEqual(asked, {
    status: 200,
    body: {
      canTrade: false,
      reason: "Only the account owner can change positions",
    },
  });
  assert.equal(seen.length, 2);
});

test("position controls: bad or foreign requests send nothing", async () => {
  const { seen, post } = setup();
  // Sent by another site through the owner's browser.
  assert.equal(
    (await post(owner, { contract, qty: 0 }, "https://evil.test")).status,
    403,
  );
  assert.equal((await post(owner, { contract, qty: 0 }, null)).status, 403);
  assert.equal((await post(owner, { contract: "NVDA", qty: 1 })).status, 400);
  assert.equal((await post(owner, { contract, qty: -1 })).status, 400);
  assert.equal((await post(owner, { contract, qty: 1.5 })).status, 400);
  assert.equal((await post(owner, { contract, qty: "all" })).status, 400);
  assert.equal(seen.length, 0);
  // The service's own credential failing is not shown as the visitor's fault.
  const broken = setup({ status: 401, body: { error: "Unauthorized" } });
  assert.equal((await broken.post(owner, { contract, qty: 0 })).status, 502);
});

test("chart session: today's once pre-market has begun, otherwise the last one", () => {
  assert.equal(chartSession(Date.parse("2026-10-12T15:00:00Z")), "2026-10-12");
  assert.equal(chartSession(Date.parse("2026-10-12T05:00:00Z")), "2026-10-09");
  assert.equal(chartSession(Date.parse("2026-10-11T15:00:00Z")), "2026-10-09");
});

test("trade ticket: chain, check and buy are forwarded for the owner only", async () => {
  const { seen, fetcher } = setup({ body: { ok: true } });
  const call = (
    who: { email: string } | null,
    method: string,
    sub: string,
    extra: {
      body?: unknown;
      query?: string;
      requestOrigin?: string | null;
    } = {},
  ) =>
    handleControl(
      config,
      who,
      {
        method,
        path: `/api/portfolio/control/${sub}`,
        origin,
        requestOrigin:
          extra.requestOrigin === undefined ? origin : extra.requestOrigin,
        ...(extra.body === undefined ? {} : { body: extra.body }),
        ...(extra.query === undefined
          ? {}
          : { query: new URLSearchParams(extra.query) }),
      },
      fetcher,
    );
  const order = { contract, sizePct: 0.5, stopPct: 40, force: true, x: 1 };
  // Nobody else reaches any of it.
  for (const who of [null, { email: "other@example.com" }]) {
    assert.equal(
      (await call(who, "GET", "chain", { query: "underlying=NVDA&right=call" }))
        .status,
      403,
    );
    assert.equal(
      (await call(who, "POST", "check", { body: order })).status,
      403,
    );
    assert.equal((await call(who, "POST", "buy", { body: order })).status, 403);
  }
  assert.equal(seen.length, 0);
  await call(owner, "GET", "chain", {
    query: "underlying=nvda&right=call&expiry=2026-10-16&junk=1",
  });
  await call(owner, "POST", "check", { body: order });
  await call(owner, "POST", "buy", { body: { contract, qty: 3 } });
  assert.deepEqual(
    seen.map((s) => [
      s.method,
      s.url.replace("https://trader.test", ""),
      s.body,
    ]),
    [
      [
        "GET",
        "/v1/chain?underlying=NVDA&right=call&expiry=2026-10-16",
        undefined,
      ],
      [
        "POST",
        "/v1/check",
        { contract, sizePct: 0.5, stopPct: 40, force: true, via: "site" },
      ],
      ["POST", "/v1/buy", { contract, qty: 3, via: "site" }],
    ],
  );
  // Bad input and requests from another site send nothing more.
  assert.equal(
    (await call(owner, "GET", "chain", { query: "underlying=NVDA&right=both" }))
      .status,
    400,
  );
  assert.equal(
    (await call(owner, "GET", "chain", { query: "underlying=../x&right=call" }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(owner, "POST", "buy", {
        body: { contract, sizePct: 1, qty: 1 },
      })
    ).status,
    400,
  );
  assert.equal(
    (await call(owner, "POST", "buy", { body: { contract } })).status,
    400,
  );
  assert.equal(
    (
      await call(owner, "POST", "buy", {
        body: order,
        requestOrigin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(owner, "POST", "sell", { body: order })).status,
    404,
  );
  assert.equal(seen.length, 3);
  // Moving a stop, canceling an order and changing a price.
  const id = "0b1c2d3e-aaaa-bbbb-cccc-000000000001";
  for (const [sub, body] of [
    ["stop", { contract, price: 0.8 }],
    ["cancel", { orderId: id }],
    ["price", { orderId: id, price: 0.95 }],
  ] as const) {
    assert.equal((await call(null, "POST", sub, { body })).status, 403);
    assert.equal((await call(owner, "POST", sub, { body })).status, 200);
  }
  assert.deepEqual(
    seen
      .slice(3)
      .map((s) => [s.url.replace("https://trader.test", ""), s.body]),
    [
      ["/v1/stop/move", { contract, price: 0.8, via: "site" }],
      ["/v1/orders/cancel", { orderId: id, via: "site" }],
      ["/v1/orders/price", { orderId: id, price: 0.95, via: "site" }],
    ],
  );
  const refused = async (sub: string, body: unknown) =>
    (await call(owner, "POST", sub, { body })).status;
  assert.equal(await refused("stop", { contract, price: -1 }), 400);
  assert.equal(await refused("cancel", { orderId: "../x" }), 400);
  assert.equal(await refused("price", { orderId: id }), 400);
  assert.equal(seen.length, 6);
});

test("stock trading: quote, buy and sell are forwarded for the owner only", async () => {
  const { fetcher, seen } = setup();
  const call = (
    method: string,
    sub: string,
    body?: unknown,
    identity: { email: string } | null = owner,
    query?: URLSearchParams,
  ) =>
    handleControl(
      config,
      identity,
      {
        method,
        path: `/api/portfolio/control/${sub}`,
        ...(query ? { query } : {}),
        body,
        origin,
        requestOrigin: origin,
      },
      fetcher,
    );
  const quote = await call(
    "GET",
    "stock/quote",
    undefined,
    owner,
    new URLSearchParams({ symbol: "aapl" }),
  );
  assert.equal(quote.status, 200);
  assert.equal(seen[0]!.url, "https://trader.test/v1/stock/quote?symbol=AAPL");
  assert.equal(
    (await call("POST", "stock/buy", { symbol: "aapl", amount: 2500 })).status,
    200,
  );
  assert.deepEqual(seen[1]!.body, {
    symbol: "AAPL",
    amount: 2500,
    via: "site",
  });
  assert.equal(
    (await call("POST", "stock/sell", { symbol: "AAPL", qty: "half" })).status,
    200,
  );
  assert.deepEqual(seen[2]!.body, { symbol: "AAPL", qty: "half", via: "site" });
  // Nothing is sent for someone else, or for a bad size.
  assert.equal(
    (
      await call(
        "POST",
        "stock/buy",
        { symbol: "AAPL", qty: 1 },
        { email: "x@y.z" },
      )
    ).status,
    403,
  );
  for (const body of [
    { symbol: "AAPL" },
    { symbol: "AAPL", qty: 1, amount: 100 },
    { symbol: "AAPL", qty: 0.5 },
    { symbol: "AAPL1", qty: 1 },
  ])
    assert.equal((await call("POST", "stock/buy", body)).status, 400);
  assert.equal(
    (await call("POST", "stock/sell", { symbol: "AAPL", qty: -1 })).status,
    400,
  );
  assert.equal(seen.length, 3);
});

test("site typed stock orders and changes: only known fields are passed on", async () => {
  const { fetcher, seen } = setup({ body: { status: "sent" } });
  const call = (sub: string, body: unknown) =>
    handleControl(
      config,
      owner,
      {
        method: "POST",
        path: `/api/portfolio/control/${sub}`,
        body,
        origin,
        requestOrigin: origin,
      },
      fetcher,
    );
  const ticket = {
    symbol: "aapl",
    side: "sell",
    type: "trailing_stop",
    timeInForce: "gtc",
    qty: "all",
    trailPercent: 4,
    extra: "dropped",
  };
  assert.equal((await call("stock/check", ticket)).status, 200);
  assert.equal(seen[0]!.url, "https://trader.test/v1/stock/order");
  assert.deepEqual(seen[0]!.body, {
    symbol: "AAPL",
    side: "sell",
    type: "trailing_stop",
    timeInForce: "gtc",
    qty: "all",
    trailPercent: 4,
    check: true,
    via: "site",
  });
  assert.equal((await call("stock/order", ticket)).status, 200);
  assert.equal((seen[1]!.body as { check?: boolean }).check, undefined);
  assert.equal(
    (await call("change", { orderId: "abc-1", stopPrice: 101.5 })).status,
    200,
  );
  assert.equal(seen[2]!.url, "https://trader.test/v1/orders/change");
  assert.deepEqual(seen[2]!.body, {
    orderId: "abc-1",
    stopPrice: 101.5,
    via: "site",
  });
  // Bad shapes never reach the service.
  assert.equal((await call("stock/order", { symbol: "AAPL1" })).status, 400);
  assert.equal(
    (await call("stock/order", { symbol: "AAPL", type: { x: 1 } })).status,
    400,
  );
  assert.equal((await call("change", { orderId: "a b" })).status, 400);
  assert.equal(seen.length, 3);
});

test("site option buy: the ticket's limit price, stepping and stop choices are passed on", async () => {
  const { fetcher, seen } = setup({ body: { status: "started" } });
  const call = (sub: string, body: unknown) =>
    handleControl(
      config,
      owner,
      {
        method: "POST",
        path: `/api/portfolio/control/${sub}`,
        body,
        origin,
        requestOrigin: origin,
      },
      fetcher,
    );
  const order = {
    contract: "NVDA261016C00240000",
    qty: 2,
    ladder: false,
    limitPrice: 1.05,
    autoStop: false,
  };
  assert.equal((await call("check", order)).status, 200);
  assert.deepEqual(seen[0]!.body, { ...order, via: "site" });
  // The usual buy sends none of them.
  assert.equal(
    (await call("buy", { contract: order.contract, qty: 1 })).status,
    200,
  );
  assert.deepEqual(seen[1]!.body, {
    contract: order.contract,
    qty: 1,
    via: "site",
  });
  assert.equal((await call("buy", { ...order, autoStop: "no" })).status, 400);
  assert.equal((await call("buy", { ...order, limitPrice: "1" })).status, 400);
  assert.equal(seen.length, 2);
});
