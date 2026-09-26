import type { RawBar } from "./bars.js";

export type AlpacaFeedName = "iex" | "sip" | "delayed_sip";

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface HistoryResponse {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
}

interface StreamMessage {
  T?: string;
  S?: string;
  msg?: string;
  code?: number;
  bars?: string[];
  t?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

interface SocketLike {
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

type Fetcher = typeof fetch;
type SocketFactory = (url: string) => SocketLike;

function raw(bar: AlpacaBar): RawBar {
  const milliseconds = Date.parse(bar.t);
  if (!Number.isFinite(milliseconds) || milliseconds % 60000 !== 0)
    throw new Error("Invalid Alpaca bar timestamp");
  return {
    start: milliseconds / 1000,
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  };
}

export class AlpacaFeed {
  private socket?: SocketLike;
  private closed = false;

  constructor(
    private key: string,
    private secret: string,
    private feed: AlpacaFeedName,
    private onFailure: (message: string) => void,
    private fetcher: Fetcher = fetch,
    private socketFactory: SocketFactory = (url) => new WebSocket(url),
    private restUrl = "https://data.alpaca.markets",
    private streamUrl = "wss://stream.data.alpaca.markets",
  ) {}

  async history(ticker: string, start: string, end: string): Promise<RawBar[]> {
    const rows: RawBar[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(
        `/v2/stocks/${encodeURIComponent(ticker)}/bars`,
        this.restUrl,
      );
      url.searchParams.set("timeframe", "1Min");
      url.searchParams.set("start", start);
      url.searchParams.set("end", end);
      url.searchParams.set("adjustment", "raw");
      url.searchParams.set("feed", this.feed);
      url.searchParams.set("sort", "asc");
      url.searchParams.set("limit", "10000");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await this.fetcher(url, {
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw new Error(`Alpaca REST request failed (${response.status})`);
      const body = (await response.json()) as HistoryResponse;
      if (!Array.isArray(body.bars))
        throw new Error("Invalid Alpaca history response");
      rows.push(...body.bars.map(raw));
      pageToken = body.next_page_token ?? undefined;
    } while (pageToken);
    return rows;
  }

  stream(
    tickers: string[],
    onBar: (ticker: string, bar: RawBar) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let ready = false;
      let settled = false;
      let failed = false;
      const socket = this.socketFactory(`${this.streamUrl}/v2/${this.feed}`);
      this.socket = socket;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("Alpaca stream connection timed out"));
      }, 20000);
      const fail = (message: string) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(message));
        } else if (!this.closed) {
          this.onFailure(message);
        }
      };
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            action: "auth",
            key: this.key,
            secret: this.secret,
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        try {
          const messages = JSON.parse(String(event.data)) as StreamMessage[];
          if (!Array.isArray(messages)) throw new Error();
          for (const message of messages) {
            if (message.T === "success" && message.msg === "authenticated") {
              socket.send(
                JSON.stringify({ action: "subscribe", bars: tickers }),
              );
            } else if (message.T === "subscription") {
              const subscribed = new Set(message.bars ?? []);
              if (!tickers.every((ticker) => subscribed.has(ticker)))
                throw new Error("Alpaca stream subscription incomplete");
              if (!settled) {
                settled = true;
                ready = true;
                clearTimeout(timer);
                resolve();
              }
            } else if (message.T === "error") {
              fail(`Alpaca stream error ${message.code ?? "unknown"}`);
            } else if (message.T === "b" && ready) {
              if (
                !message.S ||
                typeof message.t !== "string" ||
                ![message.o, message.h, message.l, message.c, message.v].every(
                  (value) => typeof value === "number",
                )
              )
                throw new Error("Invalid Alpaca stream bar");
              onBar(
                message.S,
                raw({
                  t: message.t,
                  o: message.o!,
                  h: message.h!,
                  l: message.l!,
                  c: message.c!,
                  v: message.v!,
                }),
              );
            }
          }
        } catch (error) {
          fail(
            error instanceof Error && error.message
              ? error.message
              : "Invalid Alpaca stream message",
          );
        }
      });
      socket.addEventListener("error", () => fail("Alpaca stream failed"));
      socket.addEventListener("close", () => {
        if (!this.closed) fail("Alpaca stream disconnected");
      });
    });
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}
