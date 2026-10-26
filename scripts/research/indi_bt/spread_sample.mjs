// One pass over the watchlist: every OTM 0DTE/1DTE contract within 20% of the stock, its bid / ask / delta now.
// node --env-file=.env sample.mjs <out.csv> <tickers.json>
import fs from "node:fs";
const [out, tickersFile] = process.argv.slice(2);
const H = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY, "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET };
const get = async (u) => { for (let i = 0; i < 5; i++) { const r = await fetch(u, { headers: H }); if (r.status === 429) { await new Promise((d) => setTimeout(d, 2000)); continue; } if (!r.ok) return null; return r.json(); } return null; };
const tickers = JSON.parse(fs.readFileSync(tickersFile, "utf8"));
const now = new Date();
const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
const add = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const head = "at,symbol,stock,expiry,dte,right,strike,delta,bid,ask,mid,spread_pct,day_volume\n";
if (!fs.existsSync(out)) fs.writeFileSync(out, head);
let rows = 0;
for (let i = 0; i < tickers.length; i += 50) {
  const part = tickers.slice(i, i + 50);
  const lt = await get(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${part.join(",")}&feed=sip`);
  for (const sym of part) {
    const spot = lt?.trades?.[sym]?.p; if (!spot) continue;
    let token = "", got = [];
    do {
      const u = `https://data.alpaca.markets/v1beta1/options/snapshots/${sym}?feed=opra&limit=1000&expiration_date_gte=${ny}&expiration_date_lte=${add(ny, 4)}&strike_price_gte=${(spot * 0.8).toFixed(2)}&strike_price_lte=${(spot * 1.2).toFixed(2)}${token ? "&page_token=" + token : ""}`;
      const j = await get(u); if (!j) break;
      for (const [occ, s] of Object.entries(j.snapshots ?? {})) got.push([occ, s]);
      token = j.next_page_token ?? "";
    } while (token);
    const exps = [...new Set(got.map(([o]) => o.slice(-15, -9)))].sort();
    const near = exps[0]; if (!near) continue;
    const expiry = `20${near.slice(0, 2)}-${near.slice(2, 4)}-${near.slice(4, 6)}`;
    const dte = Math.round((Date.parse(expiry) - Date.parse(ny)) / 864e5);
    for (const [occ, s] of got) {
      if (occ.slice(-15, -9) !== near) continue;
      const right = occ.slice(-9, -8), strike = Number(occ.slice(-8)) / 1000;
      const otm = right === "C" ? strike >= spot : strike <= spot; if (!otm) continue;
      const q = s.latestQuote, d = s.greeks?.delta; if (!q || !(q.bp > 0) || !(q.ap > 0) || d == null) continue;
      const mid = (q.bp + q.ap) / 2;
      fs.appendFileSync(out, [now.toISOString(), sym, spot, expiry, dte, right, strike, Math.abs(d).toFixed(3), q.bp, q.ap, mid.toFixed(3), ((q.ap - q.bp) / mid * 100).toFixed(2), s.dailyBar?.v ?? 0].join(",") + "\n");
      rows++;
    }
  }
}
console.log("rows", rows);
