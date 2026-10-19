# Task: Watchlist fixes and features (user 2026-10-19)

Status: completed (in review)
Branch: feat/watchlist-v3

1. **Sorting header:** taller (46px), every sortable column shows ↕ (▲/▼ on the active
   one), hover states; the page is 1240px wide from 1100px screens.
2. **SPY and QQQ on top:** two cards with the price, the day's change and today's
   regular-session line (`/api/candles`), each opening its stock page.
3. **No source line** ("SIP, real time · 5-min bars · Rel vol as of …").
4. **No filter chips** (All / Moving / Rel vol ≥2× / With alerts); Find and vs SPY/sector
   stay.
5. **No "All tickers" list:** every ticker on any list joins the volume-alert pool
   (`syncPool`, watchlists.ts): after each list change on the site and in the Worker's
   minute cron, which also tells the collector. Taking a ticker off a list leaves it in the
   pool (the pool section at the bottom removes it). The first list is shown by default.
6. **Overview** = IBKR's "Market Overview": its 20 ETFs (TNX and the futures left out).
   Done in D1 directly; the 5 stocks it had are on Favorites.
7. **+ Add ticker** next to the lists.
8. **Caching:** the lists and every board / SPY-QQQ answer are kept in this browser
   (localStorage, 12 answers, 1.5 MB each) and shown at once on a visit, a reload or a
   list switch, then read again behind them; the other lists' boards are read ahead one
   by one after the first one loads.

## Follow-up (user 2026-10-19)

- A phone shows Volume as its own column ("Vol"), next to Rel vol; only the sorted
  column shows its arrow there.
- "+ Add ticker" is on Find's line.
- SPY / QQQ lines show the last 2 hours of 1-minute closes, are scaled to their own range and stretched to the card (the
  previous close only when inside it), so a 0.5% day reads as a real line.

## Verification evidence

- `npm run typecheck`, `npm test` (536: 535 pass, 1 skipped), `npm run build`, Prettier.
- `tests/watchlists.test.ts`: the pool takes every list's symbols and removes none; a
  ticker added through the hosted site joins it.
- Local server with real Alpaca data, headless Chromium at 390 and 1280 px, two test lists
  (deleted): rows after a reload in 1–2 ms, after a list switch in 3–13 ms (read ahead),
  first visit ~100 ms; no page errors.
- After deploy: the first minute's cron adds the lists' symbols to the pool and pushes it
  to the collector; check its log line "pool sync: added …; collector updated".
