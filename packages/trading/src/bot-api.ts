// The bot's state for the website (docs/tasks/backend-indi-bot.md): what the
// trading service answers at GET /v1/bot, read with the read-only token.

export interface BotView {
  enabled: boolean;
  mode: "dry" | "live";
  sizePct: number;
  delta: number;
  universe: string[];
  favorites: { name: string; tickers: string[]; at: number } | null;
  watching: string[]; // today's stocks: the list and the favorites
  lastRun: number | null; // the bot's last check (ms)
  day: string;
  // Where each stock stands now: side, t-stat (|t|), volume ratio.
  scan: {
    symbol: string;
    side: "C" | "P";
    t: number;
    rvol: number;
    minute: number;
  }[];
  activity: {
    at: number;
    kind: "info" | "signal" | "skip" | "order" | "error";
    text: string;
  }[];
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

/**
 * The user's favorites list (user 2026-10-21: "watch also the tickers I have
 * in my favorite watchlist"): the list named in BOT_WATCHLIST, or else the
 * first whose name says favorite (or carries a star).
 */
export function favoritesList<T extends { name: string; builtIn?: true }>(
  lists: readonly T[],
  named?: string,
): T | undefined {
  const own = lists.filter((l) => !l.builtIn);
  if (named)
    return own.find((l) => l.name.toLowerCase() === named.toLowerCase());
  return own.find((l) => /fav|⭐|★/i.test(l.name));
}

/** Sends the favorites list to the bot before the session (worker cron). */
export async function pushFavorites(
  trader: { url?: string; token?: string },
  list: { name: string; tickers: string[] },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!trader.url || !trader.token)
    return "the trading service is not configured";
  const response = await fetcher(new URL("/v1/bot/watchlist", trader.url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${trader.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: list.name, tickers: list.tickers }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return `the trading service answered ${response.status}`;
  return `sent "${list.name}" (${list.tickers.length} stocks)`;
}
