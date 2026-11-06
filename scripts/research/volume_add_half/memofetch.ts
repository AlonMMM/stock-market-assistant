// Temporary (not committed): Alpaca's answers about past days kept on disk, so a second version of a backtest asks
// nothing again (the user 2026-11-01: "why this one take so long?" - every version re-asked the same contracts and
// bars and lost the shared rate limit). GETs to *.alpaca.markets only; only 200 answers are kept.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function memoFetch(dir: string): typeof fetch {
  mkdirSync(dir, { recursive: true });
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    if (method !== "GET" || !/^https:\/\/[a-z.-]*alpaca\.markets\//.test(url)) return fetch(input, init);
    const file = join(dir, createHash("sha1").update(url).digest("hex") + ".json");
    if (existsSync(file)) return new Response(readFileSync(file, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    const r = await fetch(input, init);
    if (r.status !== 200) return r;
    const text = await r.text();
    writeFileSync(file, text);
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
