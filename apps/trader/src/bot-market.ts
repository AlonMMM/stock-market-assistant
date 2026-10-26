import {
  AlpacaFeed,
  type AlpacaFeedName,
} from "../../../packages/market-data/src/alpaca.js";
import {
  newYork,
  newYorkToUtc,
} from "../../../packages/market-data/src/calendar.js";
import type { MinuteBar } from "../../../packages/trading/src/bot/signal.js";
import { toSessionBars, type BotMarket } from "./bot.js";

// Market data for the bot (docs/tasks/backend-indi-bot.md): stock minute bars
// from Alpaca's SIP feed, as the backtest used, pre-market volume from its
// 5-minute bars, and option volume from the option bars. Read-only; no
// account call.

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

  /** The last SIP trade of each symbol (GET /v2/stocks/trades/latest). */
  async lastPrices(symbols: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const part of chunk(symbols, 100)) {
      const url = new URL(
        "/v2/stocks/trades/latest",
        "https://data.alpaca.markets",
      );
      url.searchParams.set("symbols", part.join(","));
      url.searchParams.set("feed", "sip");
      const response = await this.fetcher.call(globalThis, url, {
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok)
        throw new Error(
          `Alpaca latest trades failed (HTTP ${response.status})`,
        );
      const body = (await response.json()) as {
        trades?: Record<string, { p?: unknown } | null> | null;
      };
      for (const [symbol, trade] of Object.entries(body.trades ?? {}))
        if (typeof trade?.p === "number" && trade.p > 0)
          out.set(symbol, trade.p);
    }
    return out;
  }

  async premarket(symbols: string[], dates: string[]) {
    // 04:00 of the first date through 09:30 of the last; bars outside 04:00–09:30 are dropped.
    const start = new Date(newYorkToUtc(dates[0]!, 240)).toISOString();
    const end = new Date(newYorkToUtc(dates.at(-1)!, 570)).toISOString();
    const wanted = new Set(dates);
    const out = new Map<string, Map<string, number>>();
    for (const part of chunk(symbols, 10)) {
      const got = await this.feed.multiHistory(part, start, end, "5Min");
      for (const [s, rows] of got) {
        const byDay = new Map<string, number>();
        for (const r of rows) {
          const { date, minute } = newYork(r.start * 1000);
          if (minute < 240 || minute >= 570 || !wanted.has(date)) continue;
          byDay.set(date, (byDay.get(date) ?? 0) + r.volume);
        }
        out.set(s, byDay);
      }
    }
    return out;
  }

  async optionVolume30(contract: string, date: string, minute: number) {
    return (
      (await this.optionVolumes30([contract], date, minute)).get(contract) ?? 0
    );
  }

  /** Contracts traded in the 30 minutes up to `minute`, for several at once. */
  async optionVolumes30(
    contracts: string[],
    date: string,
    minute: number,
  ): Promise<Map<string, number>> {
    const url = new URL("/v1beta1/options/bars", "https://data.alpaca.markets");
    url.searchParams.set("symbols", contracts.join(","));
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set(
      "start",
      new Date(newYorkToUtc(date, 570 + minute - 29)).toISOString(),
    );
    url.searchParams.set(
      "end",
      new Date(newYorkToUtc(date, 570 + minute + 1)).toISOString(),
    );
    url.searchParams.set("limit", "10000");
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
    return new Map(
      contracts.map((c) => [
        c,
        (body.bars?.[c] ?? []).reduce((sum, b) => sum + (b.v ?? 0), 0),
      ]),
    );
  }
}
