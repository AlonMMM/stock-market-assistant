import {
  defaults,
  replay,
  type Bar,
  type Config,
} from "../../../packages/alerts/src/relative-volume.js";
import { demoBars } from "../../../packages/alerts/src/demo.js";

declare const __STATIC_ASSETS__: Record<
  string,
  { content: string; type: string }
>;

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
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
