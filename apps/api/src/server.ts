import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { D1BarCache } from "../../../packages/market-data/src/bar-cache.js";
import { D1StrengthStore } from "../../../packages/market-data/src/board.js";
import { D1BaselineStore } from "../../../packages/market-data/src/volume-baseline.js";
import { SqliteD1 } from "./sqlite-d1.js";
import { buildApp } from "./app.js";
import { getPorts } from "../../../packages/config/src/ports.js";

// Local bar cache (ignored by Git under data/local).
const cachePath = process.env.BARS_CACHE_DB ?? "data/local/bars-cache.sqlite";
mkdirSync(dirname(cachePath), { recursive: true });
const db = new SqliteD1(cachePath);
const app = buildApp(true, {
  key: process.env.ALPACA_API_KEY,
  secret: process.env.ALPACA_API_SECRET,
  cache: new D1BarCache(db),
  baselines: new D1BaselineStore(db),
  strengths: new D1StrengthStore(db),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ port: getPorts().api, host: "127.0.0.1" });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
