import Fastify from "fastify";
import type { HealthResponse } from "../../../packages/contracts/src/index.js";

export function buildApp(logging = false) {
  const app = Fastify({ logger: logging });
  app.get<{ Reply: HealthResponse }>("/api/health", async () => ({
    status: "ok",
    service: "stock-market-assistant",
    marketData: "not-connected",
  }));
  return app;
}
