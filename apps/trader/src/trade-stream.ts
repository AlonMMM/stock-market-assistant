// Live SIP trades over Alpaca's stream (the user, 2026-11-06: "I want to be
// the fastest as possible ... when we have a shock"): every trade of the
// Volume bot's stocks as it prints, so a shock's 10-second slot is read a
// second after it ends instead of waiting for the REST polls, which ran ~9 s
// behind on a busy tape (2026-11-05: shocks found a median 12.6 s late).
// The owner's key already holds the collector's stream (Alpaca allows one
// connection per account and feed), so this one uses the Volume bot's own
// account keys. Any failure leaves the REST polls in charge (strangle-fast.ts).

import type { AlpacaTrade } from "../../../packages/market-data/src/alpaca.js";

export interface StreamSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export type StreamState = "off" | "connecting" | "live" | "down";

export interface TradeStreamOptions {
  key: string;
  secret: string;
  onTrade: (symbol: string, trade: AlpacaTrade) => void;
  log?: (line: string) => void;
  now?: () => number;
  socket?: (url: string) => StreamSocket;
  url?: string;
  // Reconnect waits: from retryMs, doubling to maxRetryMs.
  retryMs?: number;
  maxRetryMs?: number;
}

interface Message {
  T?: string;
  msg?: string;
  code?: number;
  S?: string;
  i?: number;
  x?: string;
  p?: number;
  s?: number;
  c?: string[];
  t?: string;
  z?: string;
  trades?: string[];
}

export class TradeStream {
  state: StreamState = "off";
  // When the current connection's subscription was confirmed (Unix ms):
  // every trade from then on comes through it.
  since: number | null = null;
  lastError: string | null = null;
  private symbols: string[] = [];
  private socket: StreamSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private wait: number;
  private stopped = true;
  private readonly now: () => number;

  constructor(private readonly o: TradeStreamOptions) {
    this.now = o.now ?? Date.now;
    this.wait = o.retryMs ?? 5_000;
  }

  /** True while trades flow: subscribed to every symbol asked. */
  live(): boolean {
    return this.state === "live";
  }

  /** Streams `symbols`' trades; a new list reconnects. */
  start(symbols: string[]) {
    const same =
      !this.stopped && symbols.slice().sort().join() === this.symbols.join();
    if (same) return;
    this.symbols = symbols.slice().sort();
    this.stopped = false;
    this.close();
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.close();
    this.state = "off";
  }

  private close() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const s = this.socket;
    this.socket = null;
    this.since = null;
    try {
      s?.close();
    } catch {
      // already closed
    }
  }

  private connect() {
    if (this.stopped || !this.symbols.length) return;
    this.state = "connecting";
    const url = this.o.url ?? "wss://stream.data.alpaca.markets/v2/sip";
    let socket: StreamSocket;
    try {
      socket = (this.o.socket ?? ((u) => new WebSocket(u)))(url);
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;
    const mine = () => this.socket === socket;
    socket.addEventListener("open", () => {
      if (!mine()) return;
      socket.send(
        JSON.stringify({
          action: "auth",
          key: this.o.key,
          secret: this.o.secret,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (!mine()) return;
      let messages: Message[];
      try {
        messages = JSON.parse(String(event.data)) as Message[];
        if (!Array.isArray(messages)) return;
      } catch {
        return;
      }
      for (const m of messages) this.read(socket, m);
    });
    socket.addEventListener("error", () => {
      if (mine()) this.failed("the stream failed");
    });
    socket.addEventListener("close", () => {
      if (mine()) this.failed(this.lastError ?? "the stream closed");
    });
  }

  private read(socket: StreamSocket, m: Message) {
    if (m.T === "success" && m.msg === "authenticated") {
      socket.send(
        JSON.stringify({ action: "subscribe", trades: this.symbols }),
      );
      return;
    }
    if (m.T === "subscription") {
      const got = new Set(m.trades ?? []);
      if (!this.symbols.every((s) => got.has(s))) {
        this.failed("the subscription missed some stocks");
        return;
      }
      if (this.state !== "live") {
        this.state = "live";
        this.since = this.now();
        this.wait = this.o.retryMs ?? 5_000;
        this.lastError = null;
        this.o.log?.(`trade stream: live for ${this.symbols.length} stocks`);
      }
      return;
    }
    if (m.T === "error") {
      // 406: the account's connection is in use elsewhere.
      this.failed(`Alpaca stream error ${m.code ?? "?"} ${m.msg ?? ""}`.trim());
      return;
    }
    if (
      m.T === "t" &&
      this.state === "live" &&
      m.S &&
      typeof m.t === "string" &&
      typeof m.p === "number" &&
      typeof m.s === "number"
    )
      this.o.onTrade(m.S, {
        t: m.t,
        p: m.p,
        s: m.s,
        x: m.x ?? "",
        i: m.i ?? 0,
        z: m.z ?? "",
        ...(m.c ? { c: m.c } : {}),
      } as AlpacaTrade);
  }

  private failed(why: string) {
    if (this.stopped) return;
    const wasLive = this.state === "live";
    this.lastError = why;
    this.close();
    this.state = "down";
    if (wasLive || this.wait === (this.o.retryMs ?? 5_000))
      this.o.log?.(`trade stream: ${why}; the REST polls take over`);
    const wait = this.wait;
    this.wait = Math.min(this.wait * 2, this.o.maxRetryMs ?? 300_000);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, wait);
  }
}
