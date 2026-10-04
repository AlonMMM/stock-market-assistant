import Fastify from "fastify";
import {
  defaults,
  replay,
  type Bar,
  type Config,
} from "../../../packages/alerts/src/relative-volume.js";
import { demoBars } from "../../../packages/alerts/src/demo.js";
import type { HealthResponse } from "../../../packages/contracts/src/index.js";
import {
  handleBacktest,
  type Credentials,
} from "../../../packages/market-data/src/backtest.js";
import { handleDayChart } from "../../../packages/market-data/src/day-chart.js";
import type { BarCache } from "../../../packages/market-data/src/bar-cache.js";
import {
  handleBoard,
  type StrengthStore,
} from "../../../packages/market-data/src/board.js";
import type { BaselineStore } from "../../../packages/market-data/src/volume-baseline.js";
import type { ResultCache } from "../../../packages/market-data/src/result-cache.js";
import {
  handleBacktestSymbols,
  type D1SymbolList,
} from "../../../packages/market-data/src/backtest-symbols.js";
import {
  loadAnalysisChart,
  loadLive,
} from "../../../packages/market-data/src/live.js";
import { loadWatchlist } from "../../../packages/market-data/src/watchlist.js";
import { parseSipDelay } from "../../../packages/market-data/src/sip-delay.js";

export function buildApp(
  logging = false,
  alpaca: Credentials & {
    fetcher?: typeof fetch;
    cache?: BarCache;
    baselines?: BaselineStore; // stored Rel vol baselines for the board
    strengths?: StrengthStore; // stored β/σ vs SPY for the board's score
    results?: ResultCache; // computed backtest parts
    symbols?: D1SymbolList; // the Backtest page's symbol list
  } = {
    key: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_API_SECRET,
  },
) {
  // ALPACA_SIP_DELAY_MINUTES (default 0); an invalid value stops startup.
  alpaca = {
    ...alpaca,
    sipDelayMinutes:
      alpaca.sipDelayMinutes ??
      parseSipDelay(process.env.ALPACA_SIP_DELAY_MINUTES),
  };
  const app = Fastify({ logger: logging });
  app.post("/api/backtest", async (request, reply) => {
    const result = await handleBacktest(
      request.body,
      alpaca,
      alpaca.fetcher,
      Date.now(),
      alpaca.cache,
      alpaca.results,
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/api/backtest/symbols", async (_request, reply) => {
    const result = await handleBacktestSymbols(
      "GET",
      undefined,
      alpaca.symbols,
    );
    return reply.code(result.status).send(result.body);
  });
  app.post("/api/backtest/symbols", async (request, reply) => {
    const result = await handleBacktestSymbols(
      "POST",
      request.body,
      alpaca.symbols,
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/api/board", async (_request, reply) => {
    const list = await loadWatchlist({
      url: process.env.COLLECTOR_URL,
      token: process.env.COLLECTOR_TOKEN,
    });
    const result = await handleBoard(
      list.tickers,
      list.benchmarks,
      alpaca,
      alpaca.fetcher,
      Date.now(),
      alpaca.baselines,
      alpaca.strengths,
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/api/live", async () =>
    loadLive({
      url: process.env.COLLECTOR_URL,
      token: process.env.COLLECTOR_TOKEN,
    }),
  );
  app.get("/api/live/chart", async (request, reply) => {
    const chart = await loadAnalysisChart(
      { url: process.env.COLLECTOR_URL, token: process.env.COLLECTOR_TOKEN },
      request.query as Record<string, unknown>,
    );
    if (!chart.png)
      return reply.code(chart.status).send({ error: chart.error });
    return reply
      .type("image/png")
      .header("Cache-Control", "private, max-age=300")
      .send(Buffer.from(chart.png));
  });
  app.get("/api/watchlist", async () =>
    loadWatchlist({
      url: process.env.COLLECTOR_URL,
      token: process.env.COLLECTOR_TOKEN,
    }),
  );
  app.post("/api/day-chart", async (request, reply) => {
    const result = await handleDayChart(
      request.body,
      alpaca,
      alpaca.fetcher,
      Date.now(),
      alpaca.cache,
    );
    return reply.code(result.status).send(result.body);
  });
  app.post<{ Body: { config?: Partial<Config>; bars?: Bar[] } }>(
    "/api/replay",
    async (request, reply) => {
      try {
        const body = request.body;
        if (!body || typeof body !== "object")
          throw new Error("Expected JSON object");
        if (
          body.bars !== undefined &&
          (!Array.isArray(body.bars) || body.bars.length > 100000)
        )
          throw new Error("Expected at most 100000 closed bars");
        const config = { ...defaults, ...body.config };
        const results = replay(body.bars ?? demoBars(), config);
        return {
          source: body.bars ? "uploaded" : "synthetic-demo",
          config,
          evaluated: results.length,
          alerts: results.filter((r) => r.status === "alert"),
          diagnostics: Object.fromEntries(
            [...new Set(results.map((r) => r.status))].map((s) => [
              s,
              results.filter((r) => r.status === s).length,
            ]),
          ),
        };
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error ? error.message : "Invalid replay input",
        });
      }
    },
  );
  app.get<{ Reply: HealthResponse }>("/api/health", async () => ({
    status: "ok",
    service: "stock-market-assistant",
    marketData: "not-connected",
  }));
  return app;
}
