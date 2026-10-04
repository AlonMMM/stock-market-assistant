# Task: alert-vs-spy

Owner: frontend
Status: done (pending Integration)
Branch: session/frontend-alert-vs-spy

## Outcome

Live and Backtest alert rows show the alert-time score vs SPY with its direction
label, and Live expanded rows show how that score developed today
("vs SPY at alert 78 → now 84 ↑ · β 1.4").

## Acceptance criteria

From [alert-vs-spy](../features/alert-vs-spy.md) "UI" and scenarios 1–3, 6:

- Live table: the former "Rel. strength" column is now "vs SPY at alert": label tag
  plus score; green confirmed (▲ Long / ▼ Short · confirmed), red against
  (▲ Up / ▼ Down · against), grey "▲/▼ · moving with market", "—" without a score or
  without `vsSpy` (older alerts). Arrow and words are always present; colour is never
  the only cue. The tag's tooltip is the shared `vsSpyText` line (as in Telegram).
- Live expanded row: "vs SPY at alert S → now N T · β B", T = ↑/↓/→ at ±5 points;
  "(assumed)" after β when `betaAssumed`; small "SPY bar lagged" when `spyLagged`.
  "now" comes from `strengthNow[ticker]` (refreshed with the 30 s `/api/live` poll)
  and is shown only when the alert is on the same Israel day as the score's `at`.
- The analysis panel keeps its own RS score; it no longer feeds the row column.
- Backtest alert rows: the same cell from the alert's `vsSpy`, on a second line under
  symbol/move/volume with a "vs SPY" prefix (the 7-column row had no room in the
  ~700 px results column); expanded rows show the at-alert line without "now".
- Table notes on both pages explain the score, the label and that it is not a trade
  recommendation.

## Dependencies and scope

- Spec: docs/features/alert-vs-spy.md at cda29e7.
- Contract: `packages/contracts/src/vs-spy.ts` (`AlertVsSpy`, `StrengthNow`,
  `vsSpyLabel`, `vsSpyText`), `LiveStatus.strengthNow`, `BacktestAlert.vsSpy` from
  backend commit 8ff06ee; later the whole backend branch (through cd0ab53) and
  origin/main 6c4189e were merged. The merge resolved backend conflicts in
  `packages/market-data/src/backtest.ts` (`runBacktest(…, results, delayMinutes)`,
  window end uses `sipDelayMs` and keeps `complete`) and `scripts/backtest.ts` (main's
  `codeVersion`). `evaluationSources` now also lists `contracts/src/vs-spy.ts`,
  `market-data/src/alert-vs-spy.ts` and `rs-score.ts`, so cached backtest results
  are not reused after vsSpy code changes. Backend should review these.
- Code: `apps/web/src/vs-spy-model.ts` (cell text/tone, trend, same-day "now",
  detail line), `AlertFeed.tsx` (`VsSpyTag`, `VsSpyLine`), `LiveAlerts.tsx`,
  `Live.tsx`, `BacktestAlerts.tsx`, `styles.css`; tests in
  `tests/vs-spy-model.test.ts`.
- The cell uses the label stored with the alert; thresholds are not re-derived in the
  web app (a test checks the tone follows `vsSpyLabel` at 0/40/41/59/60/100).

- Follow-up (Product+UX): SIP source notes (watchlist toolbar, market chart,
  status popover "Charts") come from `delayMinutes` on `/api/board` via
  `sipDelayText`: 0 → "SIP, real time", N → "SIP, N-min delayed", absent (older
  API) → "SIP, 15-min delayed". The Backtest page loads no board, so its popover
  says only "Alpaca SIP". docs/features/live-page.md updated. "now" score only for
  today's Israel-day alerts: confirmed by Product+UX.

## Verification and handoff

- `npm run check`: passed (format, typecheck, 203 tests: 202 pass, 1 pre-existing
  skip, build). `git diff --check`: clean.
- Headless Chrome against a SYNTHETIC mock API (scratchpad, not committed) at
  1280 and 390 px, Live and Backtest: confirmed (▲ 78, ▼ 22/18), against (▲ 38,
  ▼ 70), market (▼ 50), none (`label: "none"`) and missing `vsSpy` → "—"; expanded
  "vs SPY at alert 78 → now 84 ↑ · β 1.4" and "38 → now 31 ↓ · β 1.9 · SPY bar
  lagged"; no horizontal scroll at either width. Screenshots inspected.
- Follow-up headless check (SYNTHETIC mock, 1280 px) with `delayMinutes` 0, 5 and
  absent: all three notes read "SIP, real time" / "SIP, 5-min delayed" / "SIP,
  15-min delayed" respectively.
- Not verified: the real collector/API path (`vsSpy` and `strengthNow` from the
  backend's implementation), the 30 s update of "now" in a live session, and
  screen-reader output.
- Open: Backtest's "Direction label" breakdown in the look-now card is a later step
  per spec. The day chart itself shows no delay note (none existed before).
