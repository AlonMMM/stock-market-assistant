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
import { D1AreaSigmaStore } from "../../../packages/market-data/src/area-sigma.js";
import { ResultCache } from "../../../packages/market-data/src/result-cache.js";
import {
  loadAnalysisChart,
  loadLive,
} from "../../../packages/market-data/src/live.js";
import { loadWatchlist } from "../../../packages/market-data/src/watchlist.js";
import { parseSipDelay } from "../../../packages/market-data/src/sip-delay.js";
import { verifyAccess } from "./access.js";

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
      baselines: D1BaselineStore;
      strengths: D1StrengthStore;
      sigmas: D1AreaSigmaStore;
      results: ResultCache;
    }
  | undefined;
function stores(db: D1Like) {
  if (cache?.db !== db)
    cache = {
      db,
      cache: new D1BarCache(db),
      baselines: new D1BaselineStore(db),
      strengths: new D1StrengthStore(db),
      sigmas: new D1AreaSigmaStore(db),
      // Unbuilt (tests import this module directly): a key no build shares.
      results: new ResultCache(
        db,
        typeof __EVALUATION_CODE__ === "string"
          ? __EVALUATION_CODE__
          : "unbuilt",
      ),
    };
  return cache;
}
const barCache = (db: D1Like) => stores(db).cache;

export default {
  async fetch(
    request: Request,
    env: {
      ALPACA_API_KEY?: string;
      ALPACA_API_SECRET?: string;
      ACCESS_TEAM_DOMAIN?: string;
      ACCESS_AUD?: string;
      COLLECTOR_URL?: string;
      // D1 database caching Alpaca bars, Rel vol baselines, β/σ vs SPY and
      // the area score's σ curves.
      BARS_CACHE?: D1Like;
      COLLECTOR_TOKEN?: string;
      // Minutes SIP data may lag real time; default 0 (see sip-delay.ts).
      ALPACA_SIP_DELAY_MINUTES?: string;
    } = {},
  ): Promise<Response> {
    // Access protection is enabled by configuration; without both values the
    // Worker stays open (local tests, the owner-private Sites publication).
    if (env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD) {
      if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
        return new Response("Access is misconfigured", { status: 500 });
      const identity = await verifyAccess(request, {
        teamDomain: env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, ""),
        audience: env.ACCESS_AUD,
      }).catch(() => null);
      if (!identity)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const path = new URL(request.url).pathname;
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
    if (path === "/api/board") {
      if (request.method !== "GET")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      const list = await loadWatchlist({
        url: env.COLLECTOR_URL,
        token: env.COLLECTOR_TOKEN,
      });
      const result = await handleBoard(
        list.tickers,
        list.benchmarks,
        credentials,
        fetch,
        Date.now(),
        env.BARS_CACHE ? stores(env.BARS_CACHE).baselines : undefined,
        env.BARS_CACHE ? stores(env.BARS_CACHE).strengths : undefined,
        env.BARS_CACHE ? barCache(env.BARS_CACHE) : undefined,
        env.BARS_CACHE ? stores(env.BARS_CACHE).sigmas : undefined,
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
