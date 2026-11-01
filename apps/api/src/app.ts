import {
  D1PriceAlerts,
  handlePriceAlerts,
} from "../../../packages/market-data/src/price-alerts.js";
import {
  handleTicker,
  handleTickerCheck,
} from "../../../packages/market-data/src/ticker.js";
import { handleTags } from "../../../packages/market-data/src/tags.js";
import {
  liveUrl,
  paperUrl,
} from "../../../packages/trading/src/alpaca-trading.js";
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
import { handleCandles } from "../../../packages/market-data/src/candles.js";
import { handleChartBars } from "../../../packages/market-data/src/chart-bars.js";
import { handleTradeChart } from "../../../packages/market-data/src/trade-chart.js";
import { handleBotBacktest } from "../../../packages/market-data/src/bot-backtest.js";
import { handleVolumeBacktest } from "../../../packages/market-data/src/volume-backtest.js";
import type { VolumeDataStore } from "../../../packages/market-data/src/volume-data.js";
import type { BarCache } from "../../../packages/market-data/src/bar-cache.js";
import type { OptionQuoteStore } from "../../../packages/market-data/src/option-quotes.js";
import type { OptionBarStore } from "../../../packages/market-data/src/option-bars.js";
import {
  handleBoard,
  type StrengthStore,
} from "../../../packages/market-data/src/board.js";
import type { BaselineStore } from "../../../packages/market-data/src/volume-baseline.js";
import type { MarksSigmaStore } from "../../../packages/market-data/src/marks-sigma.js";
import type { ResultCache } from "../../../packages/market-data/src/result-cache.js";
import {
  handleBacktestSymbols,
  type D1SymbolList,
} from "../../../packages/market-data/src/backtest-symbols.js";
import {
  loadAnalysisChart,
  loadLive,
} from "../../../packages/market-data/src/live.js";
import {
  loadWatchlist,
  pushLiveSymbols,
} from "../../../packages/market-data/src/watchlist.js";
import {
  boardTickers,
  handleWatchlists,
  syncPool,
  type D1Watchlists,
} from "../../../packages/market-data/src/watchlists.js";
import { parseSipDelay } from "../../../packages/market-data/src/sip-delay.js";
import { handleLatestPrices } from "../../../packages/market-data/src/latest-prices.js";
import {
  handleBotPortfolio,
  handlePortfolio,
  handlePortfolioHistory,
  PortfolioCache,
} from "../../../packages/trading/src/portfolio.js";
import {
  handleBotSettings,
  handleBotStatus,
} from "../../../packages/trading/src/bot-api.js";
import { handleBotPortfolioAt } from "../../../packages/trading/src/bot-api.js";
import { handleOrderDecisions } from "../../../packages/trading/src/decisions-api.js";

export function buildApp(
  logging = false,
  alpaca: Credentials & {
    fetcher?: typeof fetch;
    cache?: BarCache;
    quotes?: OptionQuoteStore; // real option quotes uploaded from the Mac (option-quotes.ts)
    optionBars?: OptionBarStore; // option minute bars the backtest read, kept (option-bars.ts)
    volume?: VolumeDataStore; // the Volume bot's backtest: shock alerts and 1-second windows (volume-data.ts)
    baselines?: BaselineStore; // stored Rel vol baselines for the board
    strengths?: StrengthStore; // stored β/σ vs SPY for the board's score
    sigmas?: MarksSigmaStore; // stored σ curves of the marked-sections score
    results?: ResultCache; // computed backtest parts
    symbols?: D1SymbolList; // the Backtest page's symbol list
    watchlists?: D1Watchlists; // the user's named watchlists
    priceAlerts?: D1PriceAlerts; // the user's own price alerts
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
  const portfolio = new PortfolioCache();
  const botPortfolio = new PortfolioCache(); // the bot's own account
  const stranglePortfolio = new PortfolioCache(); // the strangle bot's account
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
      (tickers) =>
        pushLiveSymbols(
          {
            url: process.env.COLLECTOR_URL,
            token: process.env.COLLECTOR_TOKEN,
          },
          tickers,
          alpaca.fetcher,
        ),
    );
    return reply.code(result.status).send(result.body);
  });
  const watchlists = async (method: string, sub: string, body: unknown) => {
    const result = await handleWatchlists(
      method,
      sub,
      body,
      alpaca.watchlists,
      async () => (alpaca.symbols ? (await alpaca.symbols.list()).tickers : []),
    );
    // A symbol added to a list joins the engine pool (as on the Worker).
    if (
      method !== "GET" &&
      result.status < 300 &&
      alpaca.watchlists &&
      alpaca.symbols
    )
      await syncPool(alpaca.watchlists, alpaca.symbols).catch(() => []);
    return result;
  };
  app.route({
    method: ["GET", "POST"],
    url: "/api/watchlists",
    handler: async (request, reply) => {
      const result = await watchlists(request.method, "", request.body);
      return reply.code(result.status).send(result.body);
    },
  });
  app.route<{ Params: { sub: string } }>({
    method: ["GET", "POST", "PATCH", "DELETE"],
    url: "/api/watchlists/:sub",
    handler: async (request, reply) => {
      const result = await watchlists(
        request.method,
        request.params.sub,
        request.body,
      );
      return reply.code(result.status).send(result.body);
    },
  });
  // The user's price alerts; locally they are kept, the Worker's cron sends.
  app.route<{ Params: { "*": string }; Querystring: { ticker?: string } }>({
    method: ["GET", "POST", "DELETE"],
    url: "/api/price-alerts*",
    handler: async (request, reply) => {
      const result = await handlePriceAlerts(
        request.method,
        request.params["*"].replace(/^\//, ""),
        { ticker: request.query.ticker ?? null },
        request.body,
        alpaca.priceAlerts,
      );
      return reply.code(result.status).send(result.body);
    },
  });
  app.get("/api/prices", async (request, reply) => {
    const result = await handleLatestPrices(
      (request.query as { symbols?: string }).symbols ?? null,
      alpaca,
      alpaca.fetcher,
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/api/board", async (request, reply) => {
    // Sector ETFs (from the collector) only for "vs sector" (?sectors=1).
    const sectors = (request.query as { sectors?: string }).sectors === "1";
    const list =
      sectors || !alpaca.symbols
        ? await loadWatchlist({
            url: process.env.COLLECTOR_URL,
            token: process.env.COLLECTOR_TOKEN,
          })
        : null;
    // ?list=<id>: one watchlist's symbols; the engine list otherwise.
    const tickers = await boardTickers(
      (request.query as { list?: string }).list ?? null,
      alpaca.watchlists,
      async () =>
        alpaca.symbols ? (await alpaca.symbols.list()).tickers : list!.tickers,
    );
    if (!tickers) return reply.code(404).send({ error: "No such watchlist" });
    const result = await handleBoard(
      tickers,
      sectors ? list!.benchmarks : {},
      alpaca,
      alpaca.fetcher,
      Date.now(),
      alpaca.baselines,
      alpaca.strengths,
      alpaca.sigmas,
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/api/portfolio", async (_request, reply) => {
    const result = await handlePortfolio(
      alpaca,
      process.env.ALPACA_TRADING_LIVE === "true",
      alpaca.fetcher,
      Date.now(),
      portfolio,
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/portfolio/orders", async (_request, reply) => {
    const result = await handleOrderDecisions({
      url: process.env.TRADER_URL,
      token: process.env.TRADER_READ_TOKEN,
    });
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/bot", async (_request, reply) => {
    const result = await handleBotStatus({
      url: process.env.TRADER_URL,
      token: process.env.TRADER_READ_TOKEN,
    });
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  // The strangle bot (docs/tasks/backend-strangle-bot.md).
  app.get("/api/strangle", async (_request, reply) => {
    const result = await handleBotStatus(
      { url: process.env.TRADER_URL, token: process.env.TRADER_READ_TOKEN },
      fetch,
      "/v1/strangle",
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/strangle/settings", async (_request, reply) => {
    const result = await handleBotSettings(
      { url: process.env.TRADER_URL, readToken: process.env.TRADER_READ_TOKEN },
      null,
      { method: "GET", origin: "", requestOrigin: null },
      fetch,
      "/v1/strangle/settings",
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.put("/api/strangle/settings", async (_request, reply) =>
    reply
      .code(403)
      .send({ error: "Saving settings works on the hosted site only" }),
  );
  const strangleAt = (period: unknown) =>
    handleBotPortfolio(
      {
        key: process.env.STRANGLE_ALPACA_API_KEY,
        secret: process.env.STRANGLE_ALPACA_API_SECRET,
      },
      period,
      stranglePortfolio,
      alpaca.fetcher,
      Date.now(),
      "The strangle bot's Alpaca paper account is not connected (STRANGLE_ALPACA_API_KEY and STRANGLE_ALPACA_API_SECRET)",
    );
  app.get("/api/portfolio/strangle", async (_request, reply) => {
    const result = await strangleAt(undefined);
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get<{ Querystring: { period?: string } }>(
    "/api/portfolio/strangle/history",
    async (request, reply) => {
      const result = await strangleAt(request.query.period ?? "");
      return reply
        .code(result.status)
        .header("Cache-Control", "no-store")
        .send(result.body);
    },
  );
  // The risk settings: read here, saved on the hosted site only.
  app.get("/api/risk", async (_request, reply) => {
    const result = await handleBotSettings(
      {
        url: process.env.TRADER_URL,
        readToken: process.env.TRADER_READ_TOKEN,
      },
      null,
      { method: "GET", origin: "", requestOrigin: null },
      fetch,
      "/v1/risk",
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.put("/api/risk", async (_request, reply) =>
    reply
      .code(403)
      .send({ error: "Saving settings works on the hosted site only" }),
  );
  // Saving settings needs the hosted site's sign-in; here they can be read only.
  app.get("/api/bot/settings", async (_request, reply) => {
    const result = await handleBotSettings(
      {
        url: process.env.TRADER_URL,
        readToken: process.env.TRADER_READ_TOKEN,
      },
      null,
      { method: "GET", origin: "", requestOrigin: null },
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.put("/api/bot/settings", async (_request, reply) =>
    reply
      .code(403)
      .send({ error: "Saving settings works on the hosted site only" }),
  );
  // Position controls need the hosted site's sign-in; here nobody is
  // verified, so the page is told it cannot trade.
  app.get("/api/portfolio/control", async () => ({
    canTrade: false,
    reason: "Position controls work on the hosted site only",
  }));
  // The Indi bot's own paper account (docs/tasks/backend-bot-account.md).
  const botAt = (query: unknown, period: unknown) => {
    const broker = body(query).broker;
    if (broker && broker !== "alpaca")
      return handleBotPortfolioAt(
        { url: process.env.TRADER_URL, token: process.env.TRADER_READ_TOKEN },
        broker,
        period,
      );
    return handleBotPortfolio(
      {
        key: process.env.BOT_ALPACA_API_KEY,
        secret: process.env.BOT_ALPACA_API_SECRET,
      },
      period,
      botPortfolio,
      alpaca.fetcher,
    );
  };
  const body = (value: unknown) =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  app.get("/api/portfolio/bot", async (request, reply) => {
    const result = await botAt(request.query, undefined);
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/portfolio/bot/history", async (request, reply) => {
    const result = await botAt(
      request.query,
      (request.query as { period?: unknown }).period ?? "",
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/portfolio/history", async (request, reply) => {
    const result = await handlePortfolioHistory(
      alpaca,
      (request.query as { period?: unknown }).period,
      process.env.ALPACA_TRADING_LIVE === "true",
      alpaca.fetcher,
      Date.now(),
      portfolio,
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
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
  app.get("/api/candles", async (request, reply) => {
    const result = await handleCandles(
      request.query as { ticker?: unknown; date?: unknown },
      alpaca,
      alpaca.fetcher,
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/tickers/check", async (request, reply) => {
    const result = await handleTickerCheck(
      request.query as Record<string, unknown>,
      alpaca,
      process.env.ALPACA_TRADING_LIVE === "true" ? liveUrl : paperUrl,
      alpaca.fetcher,
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/ticker", async (request, reply) => {
    const result = await handleTicker(
      request.query as Record<string, unknown>,
      alpaca,
      process.env.ALPACA_TRADING_LIVE === "true" ? liveUrl : paperUrl,
      alpaca.fetcher,
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/tags", async (request, reply) => {
    const result = await handleTags(
      request.query as Record<string, unknown>,
      alpaca,
      alpaca.fetcher,
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/bars", async (request, reply) => {
    const result = await handleChartBars(
      request.query as Record<string, unknown>,
      alpaca,
      alpaca.fetcher,
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  app.get("/api/trade-chart", async (request, reply) => {
    const result = await handleTradeChart(
      request.query as Record<string, unknown>,
      alpaca,
      alpaca.fetcher,
    );
    return reply
      .code(result.status)
      .header("Cache-Control", "no-store")
      .send(result.body);
  });
  // The Main bot's backtest of one stock over a range (the Backtest page).
  app.post("/api/bot-backtest", async (request, reply) => {
    const result = await handleBotBacktest(
      request.body,
      alpaca,
      process.env.ALPACA_TRADING_LIVE === "true" ? liveUrl : paperUrl,
      alpaca.fetcher,
      Date.now(),
      alpaca.cache,
      alpaca.quotes,
      alpaca.optionBars,
    );
    return reply.code(result.status).send(result.body);
  });
  // The Volume bot's backtest of one stock over a range (strangle/backtest.ts).
  app.post("/api/volume-backtest", async (request, reply) => {
    const result = await handleVolumeBacktest(
      request.body,
      alpaca,
      process.env.ALPACA_TRADING_LIVE === "true" ? liveUrl : paperUrl,
      alpaca.fetcher,
      Date.now(),
      alpaca.cache,
      alpaca.quotes,
      alpaca.optionBars,
      alpaca.volume,
    );
    return reply.code(result.status).send(result.body);
  });
  app.post("/api/day-chart", async (request, reply) => {
    const result = await handleDayChart(
      request.body,
      alpaca,
      alpaca.fetcher,
      Date.now(),
      alpaca.cache,
      alpaca.sigmas,
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
