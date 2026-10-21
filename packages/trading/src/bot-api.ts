// The bot's state for the website (docs/tasks/backend-indi-bot.md): what the
// trading service answers at GET /v1/bot, read with the read-only token.

export interface BotView {
  enabled: boolean;
  mode: "dry" | "live";
  sizePct: number;
  delta: number;
  universe: string[];
  day: string;
  signals: {
    day: string;
    symbol: string;
    right: "C" | "P";
    minute: number;
    t: number;
    rvol: number;
    outcome: string;
    detail: string;
    at: number;
  }[];
  positions: {
    id: string;
    day: string;
    symbol: string;
    contract: string;
    right: "C" | "P";
    qty: number;
    bought: number;
    cost: number;
    nights: number;
    status: "buying" | "open" | "closed";
    dry: boolean;
    sales: { at: number; qty: number; reason: string }[];
    openedAt: number;
    closedAt: number | null;
  }[];
}

export async function handleBotStatus(
  trader: { url?: string; token?: string },
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: BotView | { error: string } }> {
  if (!trader.url || !trader.token)
    return {
      status: 503,
      body: { error: "The trading service is not configured for this site" },
    };
  try {
    const response = await fetcher(new URL("/v1/bot", trader.url), {
      headers: { Authorization: `Bearer ${trader.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      return {
        status: 502,
        body: { error: `The trading service answered ${response.status}` },
      };
    return { status: 200, body: (await response.json()) as BotView };
  } catch {
    return {
      status: 502,
      body: { error: "The trading service is unreachable" },
    };
  }
}
