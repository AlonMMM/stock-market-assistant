import type { Decision } from "./explain.js";

// `GET /api/portfolio/orders`, shared by the local API and the hosted Worker:
// the recent buy commands with the reasons behind each, read from the trading
// service with its read-only token. The website can never send an order.

export interface OrderDecisions {
  decisions: Decision[];
}

export async function handleOrderDecisions(
  trader: { url?: string; token?: string },
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: OrderDecisions | { error: string } }> {
  if (!trader.url || !trader.token)
    return {
      status: 503,
      body: { error: "The trading service is not configured for this site" },
    };
  try {
    const response = await fetcher(
      new URL("/v1/decisions?limit=100", trader.url),
      {
        headers: { Authorization: `Bearer ${trader.token}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      return {
        status: 502,
        body: {
          error: `The trading service answered ${response.status}`,
        },
      };
    return { status: 200, body: (await response.json()) as OrderDecisions };
  } catch {
    return {
      status: 502,
      body: { error: "The trading service is unreachable" },
    };
  }
}
