import {
  alpacaLastPrices,
  checkPriceAlerts,
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
import {
  defaults,
  replay,
  type Bar,
  type Config,
} from "../../../packages/alerts/src/relative-volume.js";
import { demoBars } from "../../../packages/alerts/src/demo.js";
import { handleBacktest } from "../../../packages/market-data/src/backtest.js";
import { handleDayChart } from "../../../packages/market-data/src/day-chart.js";
import {
  D1BarCache,
  type D1Like,
} from "../../../packages/market-data/src/bar-cache.js";
import {
  D1StrengthStore,
  handleBoard,
} from "../../../packages/market-data/src/board.js";
import { D1BaselineStore } from "../../../packages/market-data/src/volume-baseline.js";
import { D1MarksSigmaStore } from "../../../packages/market-data/src/marks-sigma.js";
import { ResultCache } from "../../../packages/market-data/src/result-cache.js";
import {
  D1SymbolList,
  handleBacktestSymbols,
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
  D1Watchlists,
  handleWatchlists,
  syncPool,
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
  favoritesList,
  favoritesStale,
  handleBotSettings,
  handleBotStatus,
  pushFavorites,
} from "../../../packages/trading/src/bot-api.js";
import { handleBotPortfolioAt } from "../../../packages/trading/src/bot-api.js";
import { newYork } from "../../../packages/market-data/src/calendar.js";
import { handleOrderDecisions } from "../../../packages/trading/src/decisions-api.js";
import {
  D1WatchStore,
  MemoryWatchStore,
  watchShort,
  type WatchStore,
} from "../../../packages/trading/src/watch.js";
import { TelegramSender } from "../../../packages/notifications/src/telegram.js";

const portfolio = new PortfolioCache();
// The bot's own paper account (docs/tasks/backend-bot-account.md) has its own
// cache: the two accounts answer the same Alpaca paths.
const botPortfolio = new PortfolioCache();
const stranglePortfolio = new PortfolioCache();
import { handleCandles } from "../../../packages/market-data/src/candles.js";
import { handleChartBars } from "../../../packages/market-data/src/chart-bars.js";
import { handleTradeChart } from "../../../packages/market-data/src/trade-chart.js";
import { handleBotBacktest } from "../../../packages/market-data/src/bot-backtest.js";
import { D1OptionQuotes } from "../../../packages/market-data/src/option-quotes.js";
import { D1OptionBars } from "../../../packages/market-data/src/option-bars.js";
import { handleVolumeBacktest } from "../../../packages/market-data/src/volume-backtest.js";
import { D1VolumeData } from "../../../packages/market-data/src/volume-data.js";
import { syncVolumeDay } from "../../../packages/market-data/src/volume-daily.js";
import { handleControl } from "../../../packages/trading/src/control-api.js";
import { changeRefusal } from "./owner-only.js";
import { verifyAccess, type AccessIdentity } from "./access.js";

declare const __STATIC_ASSETS__: Record<
  string,
  { content: string; type: string }
>;
// Backtest evaluation code version, set at build time (code-version.ts).
declare const __EVALUATION_CODE__: string;

// One cache per Worker instance, so the table check runs once, not per request.
let cache:
  | {
      db: D1Like;
      cache: D1BarCache;
      quotes: D1OptionQuotes;
      optionBars: D1OptionBars;
      volume: D1VolumeData;
      baselines: D1BaselineStore;
      strengths: D1StrengthStore;
      sigmas: D1MarksSigmaStore;
      results: ResultCache;
      symbols: D1SymbolList;
      watchlists: D1Watchlists;
      priceAlerts: D1PriceAlerts;
    }
  | undefined;
function stores(db: D1Like) {
  if (cache?.db !== db)
    cache = {
      db,
      cache: new D1BarCache(db),
      quotes: new D1OptionQuotes(db),
      optionBars: new D1OptionBars(db),
      volume: new D1VolumeData(db),
      baselines: new D1BaselineStore(db),
      strengths: new D1StrengthStore(db),
      sigmas: new D1MarksSigmaStore(db),
      // Unbuilt (tests import this module directly): a key no build shares.
      results: new ResultCache(
        db,
        typeof __EVALUATION_CODE__ === "string"
          ? __EVALUATION_CODE__
          : "unbuilt",
      ),
      symbols: new D1SymbolList(db),
      watchlists: new D1Watchlists(db),
      priceAlerts: new D1PriceAlerts(db),
    };
  return cache;
}

let watchStore: WatchStore | undefined;

export default {
  // Cron (wrangler.jsonc), every minute: the account must never be short an
  // option, and the trades channel is told if it is. Read-only at Alpaca.
  async scheduled(
    _event: unknown,
    env: {
      ALPACA_API_KEY?: string;
      ALPACA_API_SECRET?: string;
      ALPACA_TRADING_LIVE?: string;
      BARS_CACHE?: D1Like;
      TRADES_TELEGRAM_BOT_TOKEN?: string;
      TRADES_TELEGRAM_CHAT_ID?: string;
      // The user's own price alerts go here; the trades channel when unset.
      PRICE_ALERTS_TELEGRAM_BOT_TOKEN?: string;
      PRICE_ALERTS_TELEGRAM_CHAT_ID?: string;
      SITE_URL?: string;
      COLLECTOR_URL?: string;
      COLLECTOR_TOKEN?: string;
      TRADER_URL?: string;
      TRADER_TOKEN?: string;
      TRADER_READ_TOKEN?: string;
      // The watchlist the Indi bot also trades; else the one named "favorite".
      BOT_WATCHLIST?: string;
    },
  ): Promise<void> {
    const token = env.TRADES_TELEGRAM_BOT_TOKEN;
    const chat = env.TRADES_TELEGRAM_CHAT_ID;
    const sender = token && chat ? new TelegramSender(token, chat) : undefined;
    watchStore ??= env.BARS_CACHE
      ? new D1WatchStore(env.BARS_CACHE)
      : new MemoryWatchStore();
    const line = await watchShort({
      credentials: { key: env.ALPACA_API_KEY, secret: env.ALPACA_API_SECRET },
      live: env.ALPACA_TRADING_LIVE === "true",
      store: watchStore,
      send: async (html) => {
        if (!sender) return false;
        const sent = await sender.send(html);
        if (!sent.ok) console.error(`short watch: Telegram: ${sent.error}`);
        return sent.ok;
      },
    }).catch((error: unknown) => `crashed: ${String(error)}`);
    console.log(
      `short watch: ${line}${sender ? "" : " (Telegram is not configured)"}`,
    );
    // Lists changed outside the site (or before the pool followed them): the
    // pool takes their symbols, and the collector is told.
    if (env.BARS_CACHE) {
      const db = stores(env.BARS_CACHE);
      const added = await syncPool(db.watchlists, db.symbols).catch(
        (error: unknown) => {
          console.error(`pool sync: ${String(error)}`);
          return [] as string[];
        },
      );
      if (added.length) {
        const pushed = await pushLiveSymbols(
          { url: env.COLLECTOR_URL, token: env.COLLECTOR_TOKEN },
          (await db.symbols.list()).tickers,
        ).catch((error: unknown) => ({ synced: false, error: String(error) }));
        console.log(
          `pool sync: added ${added.join(", ")}; collector ${pushed.synced ? "updated" : `not updated: ${pushed.error}`}`,
        );
      }
    }
    // The Indi bot trades the user's favorites list too
    // (docs/tasks/backend-indi-bot.md): it is sent every minute from 08:30 to
    // 09:24 New York, before the bot warms up at 09:25, and every 10 minutes
    // the rest of the day, so a restart or an edited list is picked up.
    const ny = newYork(Date.now());
    const beforeWarmUp = ny.minute >= 510 && ny.minute < 565;
    if (env.BARS_CACHE && (beforeWarmUp || ny.minute % 10 === 0)) {
      const lists = await stores(env.BARS_CACHE).watchlists.lists();
      const fav = favoritesList(lists, env.BOT_WATCHLIST);
      const line = fav
        ? await pushFavorites(
            { url: env.TRADER_URL, token: env.TRADER_TOKEN },
            fav,
          ).catch((error: unknown) => `failed: ${String(error)}`)
        : "no favorites list";
      console.log(`bot favorites: ${line}`);
    }
    // The Volume bot's backtest data for the day, once after the close: the
    // trader's fired alerts and alert books into D1 (volume-daily.ts).
    if (env.BARS_CACHE && ny.minute % 5 === 0) {
      const line = await syncVolumeDay({
        trader: { url: env.TRADER_URL, token: env.TRADER_READ_TOKEN },
        store: stores(env.BARS_CACHE).volume,
        now: Date.now(),
      }).catch((error: unknown) => `failed: ${String(error)}`);
      if (line !== "not yet" && line !== "done" && line !== "not a session")
        console.log(`volume data: ${line}`);
    }
    // The user's price alerts (user 2026-10-18), checked every minute.
    if (env.BARS_CACHE) {
      const alertToken = env.PRICE_ALERTS_TELEGRAM_BOT_TOKEN ?? token;
      const alertChat = env.PRICE_ALERTS_TELEGRAM_CHAT_ID ?? chat;
      const alertSender =
        alertToken && alertChat
          ? new TelegramSender(alertToken, alertChat)
          : undefined;
      const result = await checkPriceAlerts({
        store: stores(env.BARS_CACHE).priceAlerts,
        prices: (tickers) =>
          alpacaLastPrices(tickers, {
            key: env.ALPACA_API_KEY,
            secret: env.ALPACA_API_SECRET,
          }),
        send: async (html) => {
          if (!alertSender) return false;
          const sent = await alertSender.send(html);
          if (!sent.ok) console.error(`price alerts: Telegram: ${sent.error}`);
          return sent.ok;
        },
        ...(env.SITE_URL ? { siteUrl: env.SITE_URL } : {}),
      }).catch((error: unknown) => `crashed: ${String(error)}`);
      console.log(
        `price alerts: ${result}${alertSender ? "" : " (Telegram is not configured)"}`,
      );
    }
  },
  async fetch(
    request: Request,
    env: {
      ALPACA_API_KEY?: string;
      ALPACA_API_SECRET?: string;
      ACCESS_TEAM_DOMAIN?: string;
      ACCESS_AUD?: string;
      COLLECTOR_URL?: string;
      // D1 database caching Alpaca bars, Rel vol baselines, β/σ vs SPY and
      // the marked-sections score's σ curves (marks_sigma).
      BARS_CACHE?: D1Like;
      COLLECTOR_TOKEN?: string;
      // Minutes SIP data may lag real time; default 0 (see sip-delay.ts).
      ALPACA_SIP_DELAY_MINUTES?: string;
      // "true" reads the live trading account on the Portfolio tab; the
      // keys must belong to it. Anything else reads the paper account.
      ALPACA_TRADING_LIVE?: string;
      // The Indi bot's own Alpaca paper account, for the Bot trades tab
      // (docs/tasks/backend-bot-account.md). Unset: the tab says so.
      BOT_ALPACA_API_KEY?: string;
      BOT_ALPACA_API_SECRET?: string;
      STRANGLE_ALPACA_API_KEY?: string;
      STRANGLE_ALPACA_API_SECRET?: string;
      // The trading service and its read-only token, for the Orders tab.
      TRADER_URL?: string;
      TRADER_READ_TOKEN?: string;
      // Position controls on the Portfolio page: the one email that may use
      // them, and the trading service's full token. Both unset: no controls.
      TRADE_OWNER_EMAIL?: string;
      TRADER_TOKEN?: string;
      // The watchlist the Indi bot also trades; else the one named "favorite".
      BOT_WATCHLIST?: string;
    } = {},
  ): Promise<Response> {
    // Access protection is enabled by configuration; without both values the
    // Worker stays open (local tests, the owner-private Sites publication).
    let identity: AccessIdentity | null = null;
    if (env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD) {
      if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
        return new Response("Access is misconfigured", { status: 500 });
      identity = await verifyAccess(request, {
        teamDomain: env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, ""),
        audience: env.ACCESS_AUD,
      }).catch(() => null);
      if (!identity)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const path = new URL(request.url).pathname;
    const refusal = changeRefusal(
      request.method,
      path,
      identity,
      env.TRADE_OWNER_EMAIL,
    );
    if (refusal)
      return Response.json(
        { error: refusal },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    if (path.startsWith("/api/portfolio/control")) {
      let body: unknown;
      if (request.method === "POST")
        try {
          const text = await request.text();
          if (text.length > 4096)
            return Response.json(
              { error: "Request too large" },
              { status: 413 },
            );
          body = JSON.parse(text);
        } catch {
          return Response.json(
            { error: "Expected JSON object" },
            { status: 400 },
          );
        }
      // Without the site's sign-in nobody is verified, so nobody may trade.
      const result = await handleControl(
        {
          owner: env.TRADE_OWNER_EMAIL,
          url: env.TRADER_URL,
          token: env.TRADER_TOKEN,
        },
        identity,
        {
          method: request.method,
          path,
          query: new URL(request.url).searchParams,
          body,
          origin: new URL(request.url).origin,
          requestOrigin: request.headers.get("Origin"),
        },
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/price-alerts" || path.startsWith("/api/price-alerts/")) {
      let body: unknown;
      if (request.method === "POST")
        try {
          const text = await request.text();
          if (text.length > 4096)
            return Response.json(
              { error: "Request too large" },
              { status: 413 },
            );
          body = text ? JSON.parse(text) : {};
        } catch {
          return Response.json(
            { error: "Expected JSON object" },
            { status: 400 },
          );
        }
      const result = await handlePriceAlerts(
        request.method,
        path.slice("/api/price-alerts/".length),
        { ticker: new URL(request.url).searchParams.get("ticker") },
        body,
        env.BARS_CACHE ? stores(env.BARS_CACHE).priceAlerts : undefined,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/watchlists" || path.startsWith("/api/watchlists/")) {
      let body: unknown;
      if (request.method === "POST" || request.method === "PATCH")
        try {
          const text = await request.text();
          if (text.length > 65536)
            return Response.json(
              { error: "Request too large" },
              { status: 413 },
            );
          body = JSON.parse(text);
        } catch {
          return Response.json(
            { error: "Expected JSON object" },
            { status: 400 },
          );
        }
      const db = env.BARS_CACHE ? stores(env.BARS_CACHE) : undefined;
      const result = await handleWatchlists(
        request.method,
        path.slice("/api/watchlists/".length),
        body,
        db?.watchlists,
        async () => (db ? (await db.symbols.list()).tickers : []),
      );
      // A symbol added to a list joins the pool the collector streams.
      if (db && request.method !== "GET" && result.status < 300) {
        const added = await syncPool(db.watchlists, db.symbols).catch(() => []);
        if (added.length)
          await pushLiveSymbols(
            { url: env.COLLECTOR_URL, token: env.COLLECTOR_TOKEN },
            (await db.symbols.list()).tickers,
          ).catch(() => undefined);
      }
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/backtest/symbols") {
      let body: unknown;
      if (request.method === "POST")
        try {
          const text = await request.text();
          if (text.length > 65536)
            return Response.json(
              { error: "Request too large" },
              { status: 413 },
            );
          body = JSON.parse(text);
        } catch {
          return Response.json(
            { error: "Expected JSON object" },
            { status: 400 },
          );
        }
      const result = await handleBacktestSymbols(
        request.method,
        body,
        env.BARS_CACHE ? stores(env.BARS_CACHE).symbols : undefined,
        (tickers) =>
          pushLiveSymbols(
            { url: env.COLLECTOR_URL, token: env.COLLECTOR_TOKEN },
            tickers,
          ),
      );
      return Response.json(result.body, { status: result.status });
    }
    let sipDelayMinutes: number;
    try {
      sipDelayMinutes = parseSipDelay(env.ALPACA_SIP_DELAY_MINUTES);
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: 500 },
      );
    }
    const credentials = {
      key: env.ALPACA_API_KEY,
      secret: env.ALPACA_API_SECRET,
      sipDelayMinutes,
    };
    if (path === "/api/candles") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const query = new URL(request.url).searchParams;
      const result = await handleCandles(
        { ticker: query.get("ticker"), date: query.get("date") },
        credentials,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/tickers/check") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const result = await handleTickerCheck(
        Object.fromEntries(new URL(request.url).searchParams),
        credentials,
        env.ALPACA_TRADING_LIVE === "true" ? liveUrl : paperUrl,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/ticker") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const result = await handleTicker(
        Object.fromEntries(new URL(request.url).searchParams),
        credentials,
        env.ALPACA_TRADING_LIVE === "true" ? liveUrl : paperUrl,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/tags") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const result = await handleTags(
        Object.fromEntries(new URL(request.url).searchParams),
        credentials,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/bars") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const query = new URL(request.url).searchParams;
      const result = await handleChartBars(
        Object.fromEntries(query),
        credentials,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/trade-chart") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const query = new URL(request.url).searchParams;
      const result = await handleTradeChart(
        Object.fromEntries(query),
        credentials,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    // The Main bot's backtest of one stock over a range (the Backtest page).
    if (path === "/api/bot-backtest") {
      if (request.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      let body: unknown;
      try {
        const text = await request.text();
        if (text.length > 65536)
          return Response.json({ error: "Request too large" }, { status: 413 });
        body = JSON.parse(text);
      } catch {
        return Response.json(
          { error: "Expected JSON object" },
          { status: 400 },
        );
      }
      const db = env.BARS_CACHE ? stores(env.BARS_CACHE) : undefined;
      const result = await handleBotBacktest(
        body,
        credentials,
        env.ALPACA_TRADING_LIVE === "true" ? liveUrl : paperUrl,
        fetch,
        Date.now(),
        db?.cache,
        db?.quotes,
        db?.optionBars,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    // The Volume bot's backtest of one stock over a range (strangle/backtest.ts).
    if (path === "/api/volume-backtest") {
      if (request.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      let body: unknown;
      try {
        const text = await request.text();
        if (text.length > 65536)
          return Response.json({ error: "Request too large" }, { status: 413 });
        body = JSON.parse(text);
      } catch {
        return Response.json(
          { error: "Expected JSON object" },
          { status: 400 },
        );
      }
      const db = env.BARS_CACHE ? stores(env.BARS_CACHE) : undefined;
      const result = await handleVolumeBacktest(
        body,
        credentials,
        env.ALPACA_TRADING_LIVE === "true" ? liveUrl : paperUrl,
        fetch,
        Date.now(),
        db?.cache,
        db?.quotes,
        db?.optionBars,
        db?.volume,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/backtest" || path === "/api/day-chart") {
      if (request.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      let body: unknown;
      try {
        const text = await request.text();
        if (text.length > 65536)
          return Response.json({ error: "Request too large" }, { status: 413 });
        body = JSON.parse(text);
      } catch {
        return Response.json(
          { error: "Expected JSON object" },
          { status: 400 },
        );
      }
      const db = env.BARS_CACHE ? stores(env.BARS_CACHE) : undefined;
      const result =
        path === "/api/backtest"
          ? await handleBacktest(
              body,
              credentials,
              fetch,
              Date.now(),
              db?.cache,
              db?.results,
            )
          : await handleDayChart(
              body,
              credentials,
              fetch,
              Date.now(),
              db?.cache,
              db?.sigmas,
            );
      return Response.json(result.body, { status: result.status });
    }
    if (path === "/api/prices") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const result = await handleLatestPrices(
        new URL(request.url).searchParams.get("symbols"),
        credentials,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/board") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      // Sector ETFs come from the collector and are asked for only when the
      // page wants "vs sector" (?sectors=1): a slow or down collector must
      // not hold up the board (user 2026-10-16).
      const query = new URL(request.url).searchParams;
      const sectors = query.get("sectors") === "1";
      const list =
        sectors || !env.BARS_CACHE
          ? await loadWatchlist({
              url: env.COLLECTOR_URL,
              token: env.COLLECTOR_TOKEN,
            })
          : null;
      // ?list=<id>: one watchlist's symbols; the engine list otherwise.
      const db = env.BARS_CACHE ? stores(env.BARS_CACHE) : undefined;
      const tickers = await boardTickers(
        query.get("list"),
        db?.watchlists,
        async () => (db ? (await db.symbols.list()).tickers : list!.tickers),
      );
      if (!tickers)
        return Response.json(
          { error: "No such watchlist" },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
      const result = await handleBoard(
        tickers,
        sectors ? list!.benchmarks : {},
        credentials,
        fetch,
        Date.now(),
        env.BARS_CACHE ? stores(env.BARS_CACHE).baselines : undefined,
        env.BARS_CACHE ? stores(env.BARS_CACHE).strengths : undefined,
        env.BARS_CACHE ? stores(env.BARS_CACHE).sigmas : undefined,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    // The strangle bot (docs/tasks/backend-strangle-bot.md): its status and
    // settings from the trading service, its account read with its own keys.
    if (path === "/api/strangle") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const result = await handleBotStatus(
        { url: env.TRADER_URL, token: env.TRADER_READ_TOKEN },
        fetch,
        "/v1/strangle",
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/strangle/settings") {
      let body: unknown;
      if (request.method === "PUT")
        try {
          const text = await request.text();
          if (text.length > 16384)
            return Response.json(
              { error: "Request too large" },
              { status: 413 },
            );
          body = JSON.parse(text);
        } catch {
          return Response.json(
            { error: "Expected JSON object" },
            { status: 400 },
          );
        }
      const result = await handleBotSettings(
        {
          owner: env.TRADE_OWNER_EMAIL,
          url: env.TRADER_URL,
          token: env.TRADER_TOKEN,
          readToken: env.TRADER_READ_TOKEN,
        },
        identity,
        {
          method: request.method,
          body,
          origin: new URL(request.url).origin,
          requestOrigin: request.headers.get("Origin"),
        },
        fetch,
        "/v1/strangle/settings",
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (
      path === "/api/portfolio/strangle" ||
      path === "/api/portfolio/strangle/history"
    ) {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const result = await handleBotPortfolio(
        {
          key: env.STRANGLE_ALPACA_API_KEY,
          secret: env.STRANGLE_ALPACA_API_SECRET,
        },
        path === "/api/portfolio/strangle"
          ? undefined
          : (new URL(request.url).searchParams.get("period") ?? ""),
        stranglePortfolio,
        fetch,
        Date.now(),
        "The strangle bot's Alpaca paper account is not connected (STRANGLE_ALPACA_API_KEY and STRANGLE_ALPACA_API_SECRET)",
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    // The owner's risk settings per account (account-risk.ts): read by any
    // signed-in viewer, saved by the owner only.
    if (path === "/api/risk") {
      let body: unknown;
      if (request.method === "PUT")
        try {
          const text = await request.text();
          if (text.length > 16384)
            return Response.json(
              { error: "Request too large" },
              { status: 413 },
            );
          body = JSON.parse(text);
        } catch {
          return Response.json(
            { error: "Expected JSON object" },
            { status: 400 },
          );
        }
      const result = await handleBotSettings(
        {
          owner: env.TRADE_OWNER_EMAIL,
          url: env.TRADER_URL,
          token: env.TRADER_TOKEN,
          readToken: env.TRADER_READ_TOKEN,
        },
        identity,
        {
          method: request.method,
          body,
          origin: new URL(request.url).origin,
          requestOrigin: request.headers.get("Origin"),
        },
        fetch,
        "/v1/risk",
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/bot/settings") {
      let body: unknown;
      if (request.method === "PUT")
        try {
          const text = await request.text();
          if (text.length > 16384)
            return Response.json(
              { error: "Request too large" },
              { status: 413 },
            );
          body = JSON.parse(text);
        } catch {
          return Response.json(
            { error: "Expected JSON object" },
            { status: 400 },
          );
        }
      const result = await handleBotSettings(
        {
          owner: env.TRADE_OWNER_EMAIL,
          url: env.TRADER_URL,
          token: env.TRADER_TOKEN,
          readToken: env.TRADER_READ_TOKEN,
        },
        identity,
        {
          method: request.method,
          body,
          origin: new URL(request.url).origin,
          requestOrigin: request.headers.get("Origin"),
        },
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/bot") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const trader = { url: env.TRADER_URL, token: env.TRADER_READ_TOKEN };
      let result = await handleBotStatus(trader);
      // The bot's copy of the favorites list is missing or old: send the
      // site's list now, so the page and the bot both count it.
      if (
        result.status === 200 &&
        "favorites" in result.body &&
        env.BARS_CACHE
      ) {
        const lists = await stores(env.BARS_CACHE).watchlists.lists();
        const fav = favoritesList(lists, env.BOT_WATCHLIST);
        if (fav && favoritesStale(result.body.favorites, fav)) {
          const sent = await pushFavorites(
            { url: env.TRADER_URL, token: env.TRADER_TOKEN },
            fav,
          ).catch((error: unknown) => `failed: ${String(error)}`);
          console.log(`bot favorites (Bot tab): ${sent}`);
          result = await handleBotStatus(trader);
        }
      }
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/portfolio/orders") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const result = await handleOrderDecisions({
        url: env.TRADER_URL,
        token: env.TRADER_READ_TOKEN,
      });
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (
      path === "/api/portfolio/bot" ||
      path === "/api/portfolio/bot/history"
    ) {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const params = new URL(request.url).searchParams;
      const broker = params.get("broker");
      const period =
        path === "/api/portfolio/bot"
          ? undefined
          : (params.get("period") ?? "");
      // Another account than the bot's Alpaca one is read through the trading
      // service (docs/tasks/backend-bot-ibkr.md).
      const result =
        broker && broker !== "alpaca"
          ? await handleBotPortfolioAt(
              { url: env.TRADER_URL, token: env.TRADER_READ_TOKEN },
              broker,
              period,
            )
          : await handleBotPortfolio(
              {
                key: env.BOT_ALPACA_API_KEY,
                secret: env.BOT_ALPACA_API_SECRET,
              },
              period,
              botPortfolio,
            );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/portfolio" || path === "/api/portfolio/history") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const live = env.ALPACA_TRADING_LIVE === "true";
      const result =
        path === "/api/portfolio"
          ? await handlePortfolio(
              credentials,
              live,
              fetch,
              Date.now(),
              portfolio,
            )
          : await handlePortfolioHistory(
              credentials,
              new URL(request.url).searchParams.get("period") ?? undefined,
              live,
              fetch,
              Date.now(),
              portfolio,
            );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/live")
      return request.method === "GET"
        ? Response.json(
            await loadLive({
              url: env.COLLECTOR_URL,
              token: env.COLLECTOR_TOKEN,
            }),
            { headers: { "Cache-Control": "no-store" } },
          )
        : new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET" },
          });
    if (path === "/api/live/chart") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const chart = await loadAnalysisChart(
        { url: env.COLLECTOR_URL, token: env.COLLECTOR_TOKEN },
        Object.fromEntries(new URL(request.url).searchParams),
      );
      return chart.png
        ? new Response(chart.png, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "private, max-age=300",
            },
          })
        : Response.json({ error: chart.error }, { status: chart.status });
    }
    if (path === "/api/watchlist")
      return request.method === "GET"
        ? Response.json(
            await loadWatchlist({
              url: env.COLLECTOR_URL,
              token: env.COLLECTOR_TOKEN,
            }),
            {
              headers: { "Cache-Control": "no-store" },
            },
          )
        : new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET" },
          });
    if (path === "/api/health")
      return Response.json({
        status: "ok",
        service: "stock-market-assistant",
        marketData: "not-connected",
      });
    if (path === "/api/replay") {
      if (request.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      try {
        // Bound streamed uploads before accumulating/parsing the request.
        const reader = request.body?.getReader();
        if (!reader) throw new Error("Expected JSON body");
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1048576) {
            await reader.cancel();
            return Response.json(
              { error: "Upload exceeds 1 MiB" },
              { status: 413 },
            );
          }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const body = JSON.parse(new TextDecoder().decode(bytes)) as {
          bars?: Bar[];
          config?: Partial<Config>;
        };
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("Expected JSON object");
        if (
          body.bars !== undefined &&
          (!Array.isArray(body.bars) || body.bars.length > 100000)
        )
          throw new Error("Expected at most 100000 closed bars");
        const config = { ...defaults, ...body.config };
        const results = replay(body.bars ?? demoBars(), config);
        const diagnostics: Record<string, number> = {};
        for (const result of results)
          diagnostics[result.status] = (diagnostics[result.status] ?? 0) + 1;
        return Response.json({
          source: body.bars ? "uploaded" : "synthetic-demo",
          config,
          evaluated: results.length,
          alerts: results.filter((r) => r.status === "alert"),
          diagnostics,
        });
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : "Invalid replay input" },
          { status: 400 },
        );
      }
    }
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    const asset = __STATIC_ASSETS__[path === "/" ? "/index.html" : path];
    if (!asset) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : asset.content, {
      headers: {
        "Content-Type": asset.type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  },
};
