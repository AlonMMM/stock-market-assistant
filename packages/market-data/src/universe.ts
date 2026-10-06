// Read-only Alpaca universe discovery and liquidity screening.
export interface Asset {
  symbol: string;
  status: string;
  tradable: boolean;
  attributes?: string[];
}
export interface DailyLiquidityBar {
  t: string;
  c: number;
  v: number;
  vw?: number;
}
export const liquidityDefaults = {
  minPrice: 10,
  minAverageVolume: 1_000_000,
  minAverageDollarVolume: 50_000_000,
  sessions: 20,
};
export function screenStock(
  symbol: string,
  bars: DailyLiquidityBar[],
  asOf: string,
) {
  const rows = bars
    .filter((b) => b.t.slice(0, 10) <= asOf)
    .sort((a, b) => a.t.localeCompare(b.t))
    .slice(-liquidityDefaults.sessions);
  const price = rows.at(-1)?.c ?? null;
  const valid =
    rows.length === liquidityDefaults.sessions &&
    rows.every(
      (b) =>
        Number.isFinite(b.c) &&
        b.c > 0 &&
        Number.isFinite(b.v) &&
        b.v >= 0 &&
        (b.vw === undefined || (Number.isFinite(b.vw) && b.vw > 0)),
    ) &&
    new Set(rows.map((b) => b.t.slice(0, 10))).size === rows.length &&
    rows.at(-1)?.t.slice(0, 10) === asOf;
  const averageVolume = valid
    ? rows.reduce((n, b) => n + b.v, 0) / rows.length
    : null;
  const averageDollarVolume = valid
    ? rows.reduce((n, b) => n + b.v * (b.vw ?? b.c), 0) / rows.length
    : null;
  const reasons: string[] = [];
  if (!valid) reasons.push("Missing or invalid 20-session history");
  if (price !== null && price < liquidityDefaults.minPrice)
    reasons.push("Price below $10");
  if (
    averageVolume !== null &&
    averageVolume < liquidityDefaults.minAverageVolume
  )
    reasons.push("Average volume below 1M shares");
  if (
    averageDollarVolume !== null &&
    averageDollarVolume < liquidityDefaults.minAverageDollarVolume
  )
    reasons.push("Average dollar volume below $50M");
  return {
    symbol,
    eligible: reasons.length === 0,
    price,
    averageVolume,
    averageDollarVolume,
    dollarVolumeEstimated: rows.some((b) => b.vw === undefined),
    reasons,
  };
}

export interface OptionQuote {
  bp: number;
  ap: number;
  bs: number;
  as: number;
  t: string;
}
// Proposed contract-level filter, not enabled as a stock alert gate.
export function optionSpread(quote: OptionQuote | undefined, now: number) {
  if (
    !quote ||
    ![quote.bp, quote.ap, quote.bs, quote.as].every(Number.isFinite) ||
    quote.bp <= 0 ||
    quote.ap < quote.bp ||
    quote.bs < 1 ||
    quote.as < 1 ||
    !Number.isFinite(Date.parse(quote.t)) ||
    now - Date.parse(quote.t) > 60_000 ||
    Date.parse(quote.t) > now
  )
    return { eligible: false, spreadPercent: null };
  const midpoint = (quote.bp + quote.ap) / 2;
  const spread = quote.ap - quote.bp;
  const spreadPercent = (100 * spread) / midpoint;
  return {
    eligible: spreadPercent <= 5 + 1e-9 && spread <= 0.1 + 1e-9,
    spreadPercent,
  };
}

export class AlpacaUniverse {
  constructor(
    private readonly key: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly tradingUrl = "https://paper-api.alpaca.markets",
  ) {}
  private async get(url: URL): Promise<Record<string, unknown>> {
    const r = await this.fetcher.call(globalThis, url, {
      headers: {
        "APCA-API-KEY-ID": this.key,
        "APCA-API-SECRET-KEY": this.secret,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Alpaca universe request failed (${r.status})`);
    return r.json() as Promise<Record<string, unknown>>;
  }
  async optionableAssets(): Promise<Asset[]> {
    const url = new URL("/v2/assets", this.tradingUrl);
    url.searchParams.set("status", "active");
    url.searchParams.set("asset_class", "us_equity");
    const body = (await this.get(url)) as unknown as Asset[];
    if (!Array.isArray(body)) throw new Error("Invalid Alpaca assets response");
    return body.filter(
      (a) =>
        a.tradable &&
        a.status === "active" &&
        (a.attributes?.includes("has_options") ||
          a.attributes?.includes("options_enabled")),
    );
  }
  async dailyBars(symbols: string[], from: string, to: string) {
    const out = new Map<string, DailyLiquidityBar[]>(
      symbols.map((s) => [s, []]),
    );
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const url = new URL("/v2/stocks/bars", "https://data.alpaca.markets");
      for (const [k, v] of Object.entries({
        symbols: symbols.join(","),
        timeframe: "1Day",
        start: `${from}T00:00:00Z`,
        end: `${to}T23:59:59Z`,
        feed: "sip",
        adjustment: "split",
        limit: "10000",
        sort: "asc",
      }))
        url.searchParams.set(k, v);
      if (token) url.searchParams.set("page_token", token);
      const body = await this.get(url);
      if (
        !body.bars ||
        typeof body.bars !== "object" ||
        Array.isArray(body.bars)
      )
        throw new Error("Invalid Alpaca daily bars response");
      for (const [s, rows] of Object.entries(body.bars)) {
        if (rows === null) continue;
        if (!Array.isArray(rows)) throw new Error("Invalid Alpaca daily bars");
        if (out.has(s)) out.get(s)!.push(...(rows as DailyLiquidityBar[]));
      }
      token = body.next_page_token as string | undefined;
      if (token && seen.has(token))
        throw new Error("Repeated Alpaca page token");
      if (token) seen.add(token);
    } while (token);
    return out;
  }
  async optionChain(symbol: string, fromExpiry: string, toExpiry: string) {
    const snapshots: Record<
      string,
      { latestQuote?: OptionQuote; greeks?: { delta?: number } }
    > = {};
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const url = new URL(
        `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`,
        "https://data.alpaca.markets",
      );
      for (const [k, v] of Object.entries({
        feed: "opra",
        expiration_date_gte: fromExpiry,
        expiration_date_lte: toExpiry,
        limit: "1000",
      }))
        url.searchParams.set(k, v);
      if (token) url.searchParams.set("page_token", token);
      const body = await this.get(url);
      if (
        !body.snapshots ||
        typeof body.snapshots !== "object" ||
        Array.isArray(body.snapshots)
      )
        throw new Error("Invalid Alpaca option chain response");
      Object.assign(snapshots, body.snapshots);
      token = body.next_page_token as string | undefined;
      if (token && seen.has(token))
        throw new Error("Repeated Alpaca page token");
      if (token) seen.add(token);
    } while (token);
    return snapshots;
  }
}
