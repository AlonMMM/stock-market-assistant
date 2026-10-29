import type { EarningsCalendar } from "../../market-data/src/earnings.js";

// `GET /api/earnings`, shared by the local API and the hosted Worker: the
// earnings dates around today for the ticker badges, read from the trading
// service with its read-only token (no account data).

export async function handleEarnings(
  trader: { url?: string; token?: string },
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: EarningsCalendar | { error: string } }> {
  if (!trader.url || !trader.token)
    return {
      status: 503,
      body: { error: "The trading service is not configured for this site" },
    };
  try {
    const response = await fetcher(new URL("/v1/earnings", trader.url), {
      headers: { Authorization: `Bearer ${trader.token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      return {
        status: 502,
        body: { error: `The trading service answered ${response.status}` },
      };
    return { status: 200, body: (await response.json()) as EarningsCalendar };
  } catch {
    return {
      status: 502,
      body: { error: "The trading service is unreachable" },
    };
  }
}
