# Engine tickers and two-hour cooldown

User revision: 2026-10-07. Local branch: codex/ticker-controls-cooldown.
Updates the existing draft PR #45 (codex/reduce-alert-noise).

## Final behavior

- Shared live/backtest rule rvol-v6 keeps historical volume and today's pace at 4×.
- Cooldown defaults to 120 minutes per ticker, across directions and sessions.
  A new crossing at exactly 120 minutes is eligible; suppressed candidates do
  not extend the cooldown. Sustained qualifying windows remain one alert.
- The collector restores the most recent delivered alert from durable SQLite
  after warmup, so a restart, removal/re-add, or list edit does not bypass cooldown.
- The proposed v5 current-price and day-range gates are removed. Optional
  today-relative gates remain off, as in v4. The pre-existing 0.5% and 3×
  time-of-day move checks remain. Liquidity and option screens are withdrawn.
- Live → Manage engine tickers supports bulk symbol entry, stock/ETF marking,
  ticker search, individual removal, and explicit engine sync/retry.
- Changes use the existing shared symbol API and collector sync. The board and
  Backtest use that list; removed symbols cannot return from the IBKR display
  watchlist. The collector supports an empty list. Historical alerts remain.

## Approved one-time cleanup

The user approved the 35 exclusions from the October 5 cached-data report.
Production D1 was read before writing, and all 35 were still classified as
stocks. Only those stocks were removed on October 7. Newly edited tickers and
all ETFs were preserved. Shared list: 196 → 161 tickers, including 19 ETFs.
This is not an ongoing eligibility rule: the user may add a removed ticker again.

Removed: AI, ARQQ, BB, BEAM, BLK, BWXT, DGXX, EQIX, ERIC, INVZ, IRM, LAES,
LEU, LMND, LWLG, NASA, NEOV, NNE, NTLA, NVMI, ONDS, PLUG, POET, PSA, QLYS,
QUBT, REGN, ROK, RR, SERV, SEZL, SMR, SPG, VRTX, WIX.

## Validation and rollout

Targeted synthetic tests cover cooldown at the two-hour boundary, session and
side changes, independent tickers, restoration after restart, and durable
lookup outside the recent 100-alert feed. API integration tests verify that
add/remove changes appear in both Live boards, including an empty list.

Verified: npm run doctor; npm run check (formatting, types, 252 passing tests,
1 existing skip, API/web/Worker builds); git diff --check. Browser interaction
was not exercised. New settings have
not been compared on real historical bars in this revision.

Draft PR/code changes are not deployed. Production D1 cleanup is complete,
but running collector sync remains pending: Railway OAuth and Cloudflare
Worker bindings redact the collector credential. After deployment, Live →
Manage engine tickers → Sync engine sends the authoritative 161-symbol list
through the server-held credential. The production Railway service has no
RVOL_CONFIG override, so the new 120-minute default will apply when deployed.
