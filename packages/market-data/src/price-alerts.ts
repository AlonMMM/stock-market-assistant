import type { D1Like } from "./bar-cache.js";
import { tickerPattern } from "./backtest.js";

// The user's own price alerts (user 2026-10-18: "regardless of the alerts we
// built, on a specific stock the user can ask for an alert above a price or a
// % move, then get it on the phone"). Kept in D1; the Worker's minute cron
// reads the stocks' last trades and sends each alert that is met to Telegram
// once. An alert that fired can be armed again.

export type PriceAlertKind = "above" | "below" | "up" | "down";
export const priceAlertKinds: readonly PriceAlertKind[] = [
  "above",
  "below",
  "up",
  "down",
];
export const maxPriceAlerts = 100;

export interface PriceAlert {
  id: string;
  ticker: string;
  // above / below: the last trade at or past `value` dollars; up / down:
  // the day's change since the previous close at or past `value` %.
  kind: PriceAlertKind;
  value: number;
  note: string;
  createdAt: number;
  firedAt: number | null;
  firedPrice: number | null;
}

interface Row {
  id: string;
  ticker: string;
  kind: string;
  value: number;
  note: string;
  created_at: number;
  fired_at: number | null;
  fired_price: number | null;
}

const toAlert = (r: Row): PriceAlert => ({
  id: r.id,
  ticker: r.ticker,
  kind: r.kind as PriceAlertKind,
  value: r.value,
  note: r.note,
  createdAt: r.created_at,
  firedAt: r.fired_at,
  firedPrice: r.fired_price,
});

export class D1PriceAlerts {
  private ready?: Promise<unknown>;
  constructor(private readonly db: D1Like) {}

  private init() {
    return (this.ready ??= this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS price_alerts (id TEXT PRIMARY KEY, ticker TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL, fired_at INTEGER, fired_price REAL)",
      )
      .run());
  }

  async list(ticker?: string): Promise<PriceAlert[]> {
    await this.init();
    const { results } = await (
      ticker
        ? this.db
            .prepare(
              "SELECT * FROM price_alerts WHERE ticker = ? ORDER BY created_at",
            )
            .bind(ticker)
        : this.db.prepare("SELECT * FROM price_alerts ORDER BY created_at")
    ).all<Row>();
    return results.map(toAlert);
  }

  async active(): Promise<PriceAlert[]> {
    await this.init();
    const { results } = await this.db
      .prepare("SELECT * FROM price_alerts WHERE fired_at IS NULL")
      .all<Row>();
    return results.map(toAlert);
  }

  async create(a: PriceAlert) {
    await this.init();
    await this.db
      .prepare(
        "INSERT INTO price_alerts (id, ticker, kind, value, note, created_at, fired_at, fired_price) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      )
      .bind(a.id, a.ticker, a.kind, a.value, a.note, a.createdAt)
      .run();
  }

  async remove(id: string) {
    await this.init();
    await this.db
      .prepare("DELETE FROM price_alerts WHERE id = ?")
      .bind(id)
      .run();
  }

  /** Marks it fired; false when it had already fired (another run). */
  async fire(id: string, at: number, price: number) {
    await this.init();
    await this.db
      .prepare(
        "UPDATE price_alerts SET fired_at = ?, fired_price = ? WHERE id = ? AND fired_at IS NULL",
      )
      .bind(at, price, id)
      .run();
  }

  async rearm(id: string) {
    await this.init();
    await this.db
      .prepare(
        "UPDATE price_alerts SET fired_at = NULL, fired_price = NULL WHERE id = ?",
      )
      .bind(id)
      .run();
  }
}

type Answer = { status: number; body: unknown };
const bad = (error: string, status = 400): Answer => ({
  status,
  body: { error },
});
const idPattern = /^[a-z0-9]{16}$/;

/**
 * `GET    /api/price-alerts[?ticker=NVDA]`: `{ alerts }`.
 * `POST   /api/price-alerts` `{ ticker, kind, value, note? }`: creates one.
 * `POST   /api/price-alerts/<id>/rearm`: arms a fired one again.
 * `DELETE /api/price-alerts/<id>`.
 */
export async function handlePriceAlerts(
  method: string,
  sub: string,
  query: { ticker?: string | null },
  body: unknown,
  store: D1PriceAlerts | undefined,
  now = Date.now(),
): Promise<Answer> {
  if (!store) return bad("No database is configured", 503);
  const input = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  if (sub === "") {
    if (method === "GET") {
      const ticker = query.ticker?.toUpperCase();
      if (ticker !== undefined && !tickerPattern.test(ticker))
        return bad("ticker is not valid");
      return { status: 200, body: { alerts: await store.list(ticker) } };
    }
    if (method !== "POST") return bad("Use GET or POST", 405);
    const ticker =
      typeof input.ticker === "string" ? input.ticker.toUpperCase() : "";
    if (!tickerPattern.test(ticker)) return bad("ticker is not valid");
    const kind = input.kind as PriceAlertKind;
    if (!priceAlertKinds.includes(kind))
      return bad(`kind must be one of ${priceAlertKinds.join(", ")}`);
    const value = input.value;
    if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0))
      return bad("value must be a number above zero");
    if ((kind === "up" || kind === "down") && value >= 100)
      return bad("a % move must be under 100");
    const note = input.note === undefined ? "" : input.note;
    if (typeof note !== "string" || note.length > 80)
      return bad("note is text of at most 80 characters");
    if ((await store.active()).length >= maxPriceAlerts)
      return bad(`At most ${maxPriceAlerts} armed price alerts`, 409);
    const alert: PriceAlert = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      ticker,
      kind,
      value: Number(value.toFixed(4)),
      note: note.trim(),
      createdAt: now,
      firedAt: null,
      firedPrice: null,
    };
    await store.create(alert);
    return { status: 201, body: alert };
  }
  const [id, action] = sub.split("/");
  if (!id || !idPattern.test(id)) return bad("No such price alert", 404);
  if (action === "rearm") {
    if (method !== "POST") return bad("Use POST", 405);
    await store.rearm(id);
    return { status: 200, body: { rearmed: id } };
  }
  if (action !== undefined) return bad("Not found", 404);
  if (method !== "DELETE") return bad("Use DELETE", 405);
  await store.remove(id);
  return { status: 200, body: { deleted: id } };
}

/** The stock's last trade and its previous close. */
export interface LastPrice {
  last: number;
  previousClose: number | null;
}

/** Whether the alert is met at this price. */
export function priceAlertMet(a: PriceAlert, p: LastPrice): boolean {
  if (a.kind === "above") return p.last >= a.value;
  if (a.kind === "below") return p.last <= a.value;
  if (!p.previousClose) return false;
  const move = ((p.last - p.previousClose) / p.previousClose) * 100;
  return a.kind === "up" ? move >= a.value : move <= -a.value;
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The Telegram message for an alert that is met. */
export function priceAlertMessage(
  a: PriceAlert,
  p: LastPrice,
  siteUrl?: string,
): string {
  const move =
    p.previousClose && p.previousClose > 0
      ? ((p.last - p.previousClose) / p.previousClose) * 100
      : null;
  const today =
    move === null
      ? ""
      : ` · ${move >= 0 ? "+" : "−"}${Math.abs(move).toFixed(2)}% today`;
  const rule =
    a.kind === "above"
      ? `at or above ${a.value.toFixed(2)}`
      : a.kind === "below"
        ? `at or below ${a.value.toFixed(2)}`
        : a.kind === "up"
          ? `up ${a.value}% or more today`
          : `down ${a.value}% or more today`;
  return [
    `<b>Price alert: $${escape(a.ticker)}</b>`,
    `${p.last.toFixed(2)}, ${rule}${today}`,
    ...(a.note ? [escape(a.note)] : []),
    ...(siteUrl
      ? [
          `<a href="${escape(`${siteUrl.replace(/\/+$/, "")}/#watchlist/${a.ticker}`)}">Open ${escape(a.ticker)}</a>`,
        ]
      : []),
  ].join("\n");
}

/**
 * One check, run by the minute cron: each armed alert whose stock is at or
 * past its level is sent once and marked fired. One that could not be sent
 * stays armed for the next minute.
 */
export async function checkPriceAlerts(options: {
  store: D1PriceAlerts;
  prices: (tickers: string[]) => Promise<Map<string, LastPrice>>;
  send: (html: string) => Promise<boolean>;
  now?: number;
  siteUrl?: string;
}): Promise<string> {
  const armed = await options.store.active();
  if (armed.length === 0) return "no price alerts armed";
  const prices = await options.prices([...new Set(armed.map((a) => a.ticker))]);
  let sent = 0;
  let failed = 0;
  for (const a of armed) {
    const p = prices.get(a.ticker);
    if (!p || !priceAlertMet(a, p)) continue;
    if (await options.send(priceAlertMessage(a, p, options.siteUrl))) {
      await options.store.fire(a.id, options.now ?? Date.now(), p.last);
      sent++;
    } else failed++;
  }
  return `${armed.length} armed, ${sent} sent${failed ? `, ${failed} not sent` : ""}`;
}

/** Last trades and previous closes from Alpaca's snapshots, in one request. */
export async function alpacaLastPrices(
  tickers: string[],
  credentials: { key?: string; secret?: string },
  fetcher: typeof fetch = fetch,
): Promise<Map<string, LastPrice>> {
  const out = new Map<string, LastPrice>();
  if (!credentials.key || !credentials.secret || tickers.length === 0)
    return out;
  const url = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
  url.searchParams.set("symbols", tickers.join(","));
  url.searchParams.set("feed", "sip");
  const response = await fetcher.call(globalThis, url, {
    headers: {
      "APCA-API-KEY-ID": credentials.key,
      "APCA-API-SECRET-KEY": credentials.secret,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Alpaca snapshots failed (${response.status})`);
  const body = (await response.json()) as Record<
    string,
    { latestTrade?: { p?: number }; prevDailyBar?: { c?: number } } | null
  >;
  for (const [ticker, s] of Object.entries(body)) {
    const last = s?.latestTrade?.p;
    if (typeof last === "number" && last > 0)
      out.set(ticker, {
        last,
        previousClose:
          typeof s?.prevDailyBar?.c === "number" ? s.prevDailyBar.c : null,
      });
  }
  return out;
}
