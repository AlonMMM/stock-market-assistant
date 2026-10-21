import {
  AlpacaFeed,
  type AlpacaFeedName,
} from "../../../packages/market-data/src/alpaca.js";
import { newYorkToUtc } from "../../../packages/market-data/src/calendar.js";
import type { MinuteBar } from "../../../packages/trading/src/bot/signal.js";
import { toSessionBars, type BotMarket } from "./bot.js";

// Market data for the bot (docs/tasks/backend-indi-bot.md): stock minute bars
// from Alpaca's SIP feed, as the backtest used, and option volume from the
// option bars. Read-only; no account call.

const chunk = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );

export class AlpacaBotMarket implements BotMarket {
  private readonly feed: AlpacaFeed;
  constructor(
    private readonly key: string,
    private readonly secret: string,
    feed: AlpacaFeedName = "sip",
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.feed = new AlpacaFeed(key, secret, feed, () => {}, fetcher);
  }

  async bars(symbols: string[], date: string, from: number, to: number) {
    const start = new Date(newYorkToUtc(date, 570 + from)).toISOString();
    const end = new Date(newYorkToUtc(date, 570 + to + 1)).toISOString();
    const out = new Map<string, MinuteBar[]>();
    for (const part of chunk(symbols, 50)) {
      const got = await this.feed.multiHistory(part, start, end, "1Min");
      for (const [s, rows] of got)
        out.set(s, toSessionBars(rows).get(date) ?? []);
    }
    return out;
  }

  async sessions(symbols: string[], dates: string[]) {
    const start = new Date(newYorkToUtc(dates[0]!, 570)).toISOString();
    const end = new Date(newYorkToUtc(dates.at(-1)!, 960)).toISOString();
    const out = new Map<string, Map<string, MinuteBar[]>>();
    for (const part of chunk(symbols, 10)) {
      const got = await this.feed.multiHistory(part, start, end, "1Min");
      for (const [s, rows] of got) out.set(s, toSessionBars(rows));
    }
    return out;
  }

  async optionVolume30(contract: string, date: string, minute: number) {
    const url = new URL("/v1beta1/options/bars", "https://data.alpaca.markets");
    url.searchParams.set("symbols", contract);
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set(
      "start",
      new Date(newYorkToUtc(date, 570 + minute - 29)).toISOString(),
    );
    url.searchParams.set(
      "end",
      new Date(newYorkToUtc(date, 570 + minute + 1)).toISOString(),
    );
    url.searchParams.set("limit", "1000");
    const response = await this.fetcher(url, {
      headers: {
        "APCA-API-KEY-ID": this.key,
        "APCA-API-SECRET-KEY": this.secret,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(`Alpaca option bars failed (${response.status})`);
    const body = (await response.json()) as {
      bars?: Record<string, { v?: number }[] | null>;
    };
    return (body.bars?.[contract] ?? []).reduce(
      (sum, b) => sum + (b.v ?? 0),
      0,
    );
  }
}
