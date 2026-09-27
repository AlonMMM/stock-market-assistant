import { test } from "node:test";
import assert from "node:assert/strict";
import { AlpacaFeed } from "../packages/market-data/src/alpaca.js";

test("Alpaca adapter paginates minute history with raw IEX bars", async () => {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const pages = [
    {
      bars: [
        {
          t: "2026-09-24T13:30:00Z",
          o: 10,
          h: 12,
          l: 9,
          c: 11,
          v: 1234,
        },
      ],
      next_page_token: "next",
    },
    { bars: [], next_page_token: null },
  ];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(pages.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const feed = new AlpacaFeed("key", "secret", "iex", () => {}, fetcher);
  const rows = await feed.history(
    "AAPL",
    "2026-09-24T00:00:00Z",
    "2026-09-25T00:00:00Z",
  );
  assert.equal(rows[0]?.start, Date.parse("2026-09-24T13:30:00Z") / 1000);
  assert.equal(rows[0]?.volume, 1234);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url.pathname, "/v2/stocks/AAPL/bars");
  assert.equal(requests[0]?.url.searchParams.get("timeframe"), "1Min");
  assert.equal(requests[0]?.url.searchParams.get("adjustment"), "raw");
  assert.equal(requests[0]?.url.searchParams.get("feed"), "iex");
  assert.equal(requests[1]?.url.searchParams.get("page_token"), "next");
  assert.deepEqual(requests[0]?.init?.headers, {
    "APCA-API-KEY-ID": "key",
    "APCA-API-SECRET-KEY": "secret",
  });
});

test("Alpaca adapter authenticates once, subscribes to bars, and fails visibly", async () => {
  class FakeSocket {
    listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
    sent: unknown[] = [];
    addEventListener(
      type: string,
      listener: (event: { data?: unknown }) => void,
    ) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {}
    emit(type: string, data?: unknown) {
      for (const listener of this.listeners.get(type) ?? []) listener({ data });
    }
  }
  const socket = new FakeSocket();
  const failures: string[] = [];
  const bars: unknown[] = [];
  const feed = new AlpacaFeed(
    "key",
    "secret",
    "sip",
    (message) => failures.push(message),
    fetch,
    (url) => {
      assert.equal(url, "wss://stream.data.alpaca.markets/v2/sip");
      return socket;
    },
  );
  const connected = feed.stream(["AAPL", "MSFT"], (ticker, bar) =>
    bars.push({ ticker, bar }),
  );
  socket.emit("open");
  assert.deepEqual(socket.sent[0], {
    action: "auth",
    key: "key",
    secret: "secret",
  });
  socket.emit(
    "message",
    JSON.stringify([{ T: "success", msg: "authenticated" }]),
  );
  assert.deepEqual(socket.sent[1], {
    action: "subscribe",
    bars: ["AAPL", "MSFT"],
  });
  socket.emit(
    "message",
    JSON.stringify([{ T: "subscription", bars: ["MSFT", "AAPL"] }]),
  );
  await connected;
  socket.emit(
    "message",
    JSON.stringify([
      {
        T: "b",
        S: "AAPL",
        t: "2026-09-24T13:30:00Z",
        o: 10,
        h: 12,
        l: 9,
        c: 11,
        v: 4321,
      },
    ]),
  );
  assert.deepEqual(bars, [
    {
      ticker: "AAPL",
      bar: {
        start: Date.parse("2026-09-24T13:30:00Z") / 1000,
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 4321,
      },
    },
  ]);
  socket.emit(
    "message",
    JSON.stringify([{ T: "error", code: 406, msg: "sensitive" }]),
  );
  socket.emit("close");
  assert.deepEqual(failures, ["Alpaca stream error 406"]);
  feed.close();
});

test("Alpaca adapter rejects REST errors without exposing response bodies", async () => {
  const feed = new AlpacaFeed(
    "key",
    "secret",
    "iex",
    () => {},
    (async () =>
      new Response("secret provider details", { status: 403 })) as typeof fetch,
  );
  await assert.rejects(
    feed.history("AAPL", "2026-09-24", "2026-09-25"),
    /^Error: Alpaca REST request failed \(403\)$/,
  );
});

test("history calls fetch unbound, as Cloudflare Workers require", async () => {
  // Workers throw "Illegal invocation" when fetch runs with a foreign `this`.
  const fetcher = function (this: unknown) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError("Illegal invocation");
    return Promise.resolve(Response.json({ bars: [], next_page_token: null }));
  } as unknown as typeof fetch;
  const feed = new AlpacaFeed("key", "secret", "sip", () => {}, fetcher);
  assert.deepEqual(
    await feed.history("AAPL", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"),
    [],
  );
});

test("history treats Alpaca's null bars for an empty range as no bars", async () => {
  const feed = new AlpacaFeed("key", "secret", "iex", () => {}, (async () =>
    Response.json({ bars: null, next_page_token: null })) as typeof fetch);
  assert.deepEqual(
    await feed.history("AAPL", "2026-09-27T00:00:00Z", "2026-09-28T00:00:00Z"),
    [],
  );
  const broken = new AlpacaFeed("key", "secret", "iex", () => {}, (async () =>
    Response.json({ bars: "nope" })) as typeof fetch);
  await assert.rejects(
    broken.history("AAPL", "2026-09-27T00:00:00Z", "2026-09-28T00:00:00Z"),
    /Invalid Alpaca history response/,
  );
});
