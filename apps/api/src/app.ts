import Fastify from "fastify";
import {
  defaults,
  replay,
  type Bar,
  type Config,
} from "../../../packages/alerts/src/relative-volume.js";
import { demoBars } from "../../../packages/alerts/src/demo.js";
import type { HealthResponse } from "../../../packages/contracts/src/index.js";

export function buildApp(logging = false) {
  const app = Fastify({ logger: logging });
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
