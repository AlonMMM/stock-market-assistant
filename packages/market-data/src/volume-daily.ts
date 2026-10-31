import { coreClose, newYork, newYorkToUtc } from "./calendar.js";
import type { VolumeDataStore } from "./volume-data.js";
import type { ShockAlert } from "../../trading/src/strangle/backtest.js";

// New days of the Volume bot's backtest data (the user, 2026-10-31: "lets
// open the volume for backtesting on the app"): once a day after the close,
// the Worker's scheduled step reads the trader's fired 10-second alerts and
// its alert books (apps/trader/src/alert-books.ts, every 2 s for 300 s, then a
// minute) for the day and writes them to D1 (volume-data.ts), so the backtest
// covers the days after the Mac's uploads with no new secret: the website
// already reads the trader with its read token.

/** One fired alert as the trader keeps it (strangle-store.ts FastAlertRow). */
export interface TraderAlert {
  day: string;
  symbol: string;
  second: number;
  kind: "shock" | "fast";
  price: number;
  up: boolean;
}

/** One alert's books as the trader keeps them (alert-books.ts AlertBookWatch). */
export interface TraderBooks {
  day: string;
  symbol: string;
  second: number;
  kind: string;
  contracts: { symbol: string }[];
  samples: { at: number; books: ([number, number] | null)[] }[];
}

export interface OptionWindow {
  contract: string;
  date: string;
  start: number;
  end: number;
  rows: [number, number, number][]; // [session second, bid, ask]
}

// The run waits this long after the close, so the trader's last minute
// samples (to 15:30) and the day's alerts are all in.
const afterClose = 20;

/**
 * An alert's books as one window a contract. A sample read at `at` is the
 * book as the second before it ended (no look-ahead); a sample without a
 * book for a contract, or with a zero ask, is left out.
 */
export function bookWindows(b: TraderBooks): OptionWindow[] {
  const openMs = newYorkToUtc(b.day, 570);
  const out: OptionWindow[] = [];
  b.contracts.forEach((c, i) => {
    const rows: [number, number, number][] = [];
    for (const s of b.samples) {
      const q = s.books[i];
      if (!q || !(q[1] > 0) || !(q[0] >= 0)) continue;
      rows.push([Math.floor((s.at - openMs) / 1000) - 1, q[0], q[1]]);
    }
    if (!rows.length) return;
    rows.sort((x, y) => x[0] - y[0]);
    out.push({
      contract: c.symbol,
      date: b.day,
      start: rows[0]![0],
      end: rows.at(-1)![0],
      rows,
    });
  });
  return out;
}

/** The day's data once, after the close; a line for the log. */
export async function syncVolumeDay(o: {
  trader: { url?: string; token?: string };
  store: VolumeDataStore;
  now: number;
  fetcher?: typeof fetch;
}): Promise<string> {
  const { date, minute } = newYork(o.now);
  const close = coreClose(date);
  if (close === null) return "not a session";
  if (minute < close + afterClose) return "not yet";
  if (await o.store.daySynced(date)) return "done";
  if (!o.trader.url || !o.trader.token) return "the trader is not configured";
  const url = new URL("/v1/strangle/alert-data", o.trader.url);
  url.searchParams.set("day", date);
  const response = await (o.fetcher ?? fetch).call(globalThis, url, {
    headers: { Authorization: `Bearer ${o.trader.token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return `the trader answered ${response.status}`;
  const body = (await response.json()) as {
    alerts?: TraderAlert[];
    books?: TraderBooks[];
  };
  const alerts = (body.alerts ?? []).filter((a) => a.day === date);
  const windows = (body.books ?? [])
    .filter((b) => b.day === date)
    .flatMap(bookWindows);
  await o.store.putAlerts(
    alerts.map((a) => ({
      symbol: a.symbol,
      kind: a.kind,
      alert: {
        date: a.day,
        second: a.second,
        price: a.price,
        up: a.up,
      } satisfies ShockAlert,
    })),
  );
  await o.store.putOptionWindows(windows);
  await o.store.markDay(date, alerts.length, windows.length);
  return `${date}: ${alerts.length} alerts, ${windows.length} option windows`;
}
