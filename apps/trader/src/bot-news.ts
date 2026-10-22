import type { EarningsReport } from "../../../packages/trading/src/bot/news.js";

// The public Nasdaq earnings calendar, for the bot's news filter
// (docs/tasks/backend-indi-bot.md). One date a request; no key. Read-only.

export async function nasdaqEarnings(
  date: string,
  fetcher: typeof fetch = fetch,
): Promise<EarningsReport[]> {
  const url = new URL("https://api.nasdaq.com/api/calendar/earnings");
  url.searchParams.set("date", date);
  const response = await fetcher(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(`Nasdaq earnings calendar failed (${response.status})`);
  const body = (await response.json()) as {
    data?: { rows?: { symbol?: unknown; time?: unknown }[] | null } | null;
  };
  // A date with no reports (a weekend) comes back without rows.
  const rows = body.data?.rows ?? [];
  if (!Array.isArray(rows))
    throw new Error("Invalid Nasdaq earnings calendar response");
  return rows
    .filter((r) => typeof r.symbol === "string" && r.symbol.trim())
    .map((r) => ({
      symbol: String(r.symbol).trim().toUpperCase().replace("/", "."),
      date,
      time: typeof r.time === "string" ? r.time : "",
    }));
}
