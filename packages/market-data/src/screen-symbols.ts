import { AlpacaUniverse, screenStock, liquidityDefaults } from "./universe.js";
import type { D1SymbolList } from "./backtest-symbols.js";
import { newYork, previousSessions } from "./calendar.js";

// Preview only: removal uses the existing symbol-list endpoint, which syncs live.
export async function handleSymbolScreen(
  credentials: { key?: string; secret?: string },
  store?: D1SymbolList,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!store || !credentials.key || !credentials.secret)
    return {
      status: 503,
      body: { error: "Alpaca credentials and a symbol database are required" },
    };
  try {
    const list = await store.list();
    const stocks = list.tickers.filter((s) => !list.etfs.includes(s));
    const asOf = previousSessions(newYork(now).date, 1)[0]!;
    const from = previousSessions(asOf, liquidityDefaults.sessions - 1)[0]!;
    const client = new AlpacaUniverse(
      credentials.key,
      credentials.secret,
      fetcher,
    );
    const results: ReturnType<typeof screenStock>[] = [];
    for (let i = 0; i < stocks.length; i += 100) {
      const batch = stocks.slice(i, i + 100);
      const bars = await client.dailyBars(batch, from, asOf);
      for (const s of batch)
        results.push(screenStock(s, bars.get(s) ?? [], asOf));
    }
    // Missing data is an issue to investigate, never evidence for deletion.
    const remove = results
      .filter((r) => !r.eligible && r.averageVolume !== null)
      .map((r) => r.symbol);
    return {
      status: 200,
      body: { asOf, policy: liquidityDefaults, results, remove },
    };
  } catch (error) {
    return { status: 502, body: { error: (error as Error).message } };
  }
}
