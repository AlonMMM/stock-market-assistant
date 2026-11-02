// SPY 1-minute bars with the pre-market, 2025-09-25 .. 2026-10-31 (Alpaca SIP), to volyear/spy_min.json [[t, o, h, l, c, v]].
import { writeFileSync } from "node:fs";
const out = [];
let token = null;
do {
  const u = new URL("https://data.alpaca.markets/v2/stocks/SPY/bars");
  u.search = new URLSearchParams({ timeframe: "1Min", start: "2025-09-25T08:00:00Z", end: "2026-10-31T00:00:00Z", feed: "sip", limit: "10000", adjustment: "raw", ...(token ? { page_token: token } : {}) });
  const r = await fetch(u, { headers: { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY, "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET } });
  if (!r.ok) { console.log(r.status, await r.text()); process.exit(1); }
  const j = await r.json();
  for (const b of j.bars ?? []) out.push([Date.parse(b.t) / 1000, b.o, b.h, b.l, b.c, b.v]);
  token = j.next_page_token;
} while (token);
writeFileSync(process.argv[2], JSON.stringify(out));
console.log(out.length, "bars");
