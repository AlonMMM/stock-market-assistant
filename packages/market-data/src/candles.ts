import { AlpacaFeed } from "./alpaca.js";
import { tickerPattern, type Credentials } from "./backtest.js";
import { normalize } from "./bars.js";
import { coreClose, newYorkToUtc } from "./calendar.js";
import { defaultSipDelayMinutes, sipDelayMs } from "./sip-delay.js";
import { overnightEnd, sessionAt } from "./sessions.js";

// One stock's minute candles for one US session, for a plain price chart that
// is refreshed every few seconds. One request for the bars and one for the
// stock's snapshot, whose last trade moves the candle of the minute that is
// still forming. Nothing is cached, and no benchmark or score is computed:
// `/api/day-chart` is for that.

export interface Candle {
  start: number; // bar start, Unix seconds (UTC)
  // "overnight": 20:00 to 04:00 of the next trading day (sessions.ts).
  session: "pre" | "regular" | "post" | "overnight";
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Candles {
  ticker: string;
  date: string;
  // Last regular-session close before `date`; null when it is not known.
  previousClose: number | null;
  candles: Candle[];
  // The last trade and when it printed (ms); null when it is not known.
  last: { price: number; at: number } | null;
  at: number; // when this was read (ms)
}

interface Snapshot {
  latestTrade?: { p?: number; t?: string };
  prevDailyBar?: { c?: number };
}

/** `GET /api/candles?ticker=NVDA&date=2026-10-12`. */
export async function handleCandles(
  query: { ticker?: unknown; date?: unknown },
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ status: number; body: Candles | { error: string } }> {
  if (!credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials are not configured on the server" },
    };
  const ticker =
    typeof query.ticker === "string" ? query.ticker.toUpperCase() : "";
  const date = typeof query.date === "string" ? query.date : "";
  let session = false;
  try {
    session = /^\d{4}-\d{2}-\d{2}$/.test(date) && coreClose(date) !== null;
  } catch {
    // Outside the calendar's years.
  }
  if (!tickerPattern.test(ticker) || !session)
    return {
      status: 400,
      body: { error: "Give a ticker and a US trading day" },
    };
  const delay = sipDelayMs(
    credentials.sipDelayMinutes ?? defaultSipDelayMinutes,
  );
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = Math.min(
    Date.parse(`${next.toISOString().slice(0, 10)}T06:00:00Z`),
    now - delay,
  );
  const start = Date.parse(`${date}T00:00:00Z`);
  if (start >= end)
    return { status: 400, body: { error: "That day has no data yet" } };
  const feed = new AlpacaFeed(
    credentials.key,
    credentials.secret,
    "sip",
    () => {},
    fetcher,
  );
  // The overnight after this session (sessions.ts): from 20:00 to 04:00 of
  // the next trading day, from BOATS. Without it the day still loads.
  const nightFrom = newYorkToUtc(date, 1200);
  const nightTo = Math.min(overnightEnd(date), now - delay);
  const night =
    nightTo > nightFrom
      ? new AlpacaFeed(
          credentials.key,
          credentials.secret,
          "boats",
          () => {},
          fetcher,
        )
          .history(
            ticker,
            new Date(nightFrom).toISOString(),
            new Date(nightTo).toISOString(),
          )
          .catch(() => [])
      : Promise.resolve([]);
  try {
    const [rows, snapshot, nightRows] = await Promise.all([
      feed.history(
        ticker,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
      ),
      // The chart works without it: only the forming minute is missing.
      fetcher
        .call(
          globalThis,
          new URL(
            `/v2/stocks/${encodeURIComponent(ticker)}/snapshot?feed=sip`,
            "https://data.alpaca.markets",
          ),
          {
            headers: {
              "APCA-API-KEY-ID": credentials.key,
              "APCA-API-SECRET-KEY": credentials.secret,
            },
            signal: AbortSignal.timeout(10000),
          },
        )
        .then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : null))
        .catch(() => null),
      night,
    ]);
    const candles: Candle[] = [];
    for (const row of rows) {
      const bar = normalize(ticker, row, "shares");
      if (!bar || bar.date !== date) continue;
      candles.push({
        start: row.start,
        session: bar.session,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
    }
    for (const row of nightRows) {
      const at = sessionAt(row.start * 1000);
      if (at?.part !== "overnight" || at.date !== date) continue;
      candles.push({
        start: row.start,
        session: "overnight",
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      });
    }
    const price = snapshot?.latestTrade?.p;
    const tradedAt = snapshot?.latestTrade?.t
      ? Date.parse(snapshot.latestTrade.t)
      : NaN;
    const last =
      typeof price === "number" && price > 0 && Number.isFinite(tradedAt)
        ? { price, at: tradedAt }
        : null;
    // A trade newer than the last finished bar belongs to the minute still
    // forming: it extends that minute's candle, or opens one.
    const tail = candles.at(-1);
    if (last && delay === 0 && last.at <= end + 60000 && last.at >= start) {
      const minute = Math.floor(last.at / 60000) * 60;
      if (tail && minute === tail.start) {
        tail.close = last.price;
        tail.high = Math.max(tail.high, last.price);
        tail.low = Math.min(tail.low, last.price);
      } else if (tail && minute > tail.start && minute - tail.start <= 600)
        candles.push({
          start: minute,
          session: tail.session,
          open: tail.close,
          high: Math.max(tail.close, last.price),
          low: Math.min(tail.close, last.price),
          close: last.price,
          volume: 0,
        });
    }
    const previous = snapshot?.prevDailyBar?.c;
    return {
      status: 200,
      body: {
        ticker,
        date,
        previousClose:
          typeof previous === "number" && previous > 0 ? previous : null,
        candles,
        last,
        at: now,
      },
    };
  } catch (error) {
    return {
      status: 502,
      body: {
        error:
          error instanceof Error && error.message.startsWith("Alpaca")
            ? error.message
            : "Market data request failed",
      },
    };
  }
}
