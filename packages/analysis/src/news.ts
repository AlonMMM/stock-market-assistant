// Alpaca News (Benzinga) for one symbol: GET /v1beta1/news. Market-data
// credentials only; no account or order endpoints.

export interface NewsItem {
  id: number;
  headline: string;
  summary: string;
  source: string;
  url: string | null;
  createdAt: string; // UTC ISO
  symbols: string[];
}

interface AlpacaNews {
  id?: unknown;
  headline?: unknown;
  summary?: unknown;
  source?: unknown;
  url?: unknown;
  created_at?: unknown;
  symbols?: unknown;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Newest first, published in [start, end]. */
export async function alpacaNews(
  credentials: { key: string; secret: string },
  symbol: string,
  start: string,
  end: string,
  fetcher: typeof fetch = fetch,
  limit = 50,
): Promise<NewsItem[]> {
  const url = new URL("https://data.alpaca.markets/v1beta1/news");
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("sort", "desc");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("include_content", "false");
  const response = await fetcher.call(globalThis, url, {
    headers: {
      "APCA-API-KEY-ID": credentials.key,
      "APCA-API-SECRET-KEY": credentials.secret,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Alpaca news request failed (${response.status})`);
  const body = (await response.json()) as { news?: unknown };
  if (!Array.isArray(body.news))
    throw new Error("Invalid Alpaca news response");
  return (body.news as AlpacaNews[]).flatMap((item) => {
    const createdAt = text(item.created_at);
    if (typeof item.id !== "number" || !Number.isFinite(Date.parse(createdAt)))
      return [];
    return [
      {
        id: item.id,
        headline: text(item.headline).slice(0, 500),
        summary: text(item.summary).slice(0, 1500),
        source: text(item.source),
        url: text(item.url) || null,
        createdAt: new Date(createdAt).toISOString(),
        symbols: Array.isArray(item.symbols)
          ? item.symbols.filter((s): s is string => typeof s === "string")
          : [],
      },
    ];
  });
}
