# Task: alert-vs-spy

Owner: backend
Status: implemented, awaiting Integration review
Branch: session/backend-alert-vs-spy (spec commit cda29e7 on main df6f3af)

## Outcome

Every live alert carries its score vs SPY at the moment it fires, with a direction label,
in the stored record, `/api/live` and the Telegram message; the site gets a "now" score
per symbol alerted today; backtest alerts carry the same alert-time score; the website's
SIP delay is configurable (default 0 for this account's real-time SIP).
Spec: [alert-vs-spy](../features/alert-vs-spy.md).

## Contract as implemented (additive)

- `packages/contracts/src/vs-spy.ts`: `AlertVsSpy { score: number | null; beta: number;
betaAssumed: boolean; label: "confirmed" | "against" | "market" | "none"; spyLagged:
boolean }`, `StrengthNow { score: number | null; at: string }` (`at` = UTC end of the
  symbol's latest bar), `vsSpyLabel(direction, score)`, `vsSpyText(direction, vsSpy)`
  (the Telegram line; reusable by the web app) and the thresholds `vsSpyStrong = 60`,
  `vsSpyWeak = 40`.
- `AlertEvent.vsSpy?`, `LiveAlert.vsSpy?`, `BacktestAlert.vsSpy?` (absent on records
  stored before this change → show "—").
- `LiveStatus.strengthNow: Record<ticker, StrengthNow>` (always present; `{}` when the
  collector is older or unreachable). Collector `GET /alerts` adds `strengthNow`;
  `GET /health` adds `benchmark: { ticker: "SPY", lastBar }`.
- `/api/board` and `/api/day-chart` add `delayMinutes` (optional in the types).

## Implementation

- Shared score: `packages/market-data/src/alert-vs-spy.ts` (`alertVsSpy`, `scoreVsSpy`)
  uses `rsScore`/`excessPercent` from `rs-score.ts`, with the same inputs as the analysis
  day score (previous regular close = last regular minute bar of the previous session).
- Collector (`packages/market-data/src/live-strength.ts`, `apps/collector/src/main.ts`):
  SPY is warmed up and streamed with the watchlist and evaluated only when listed. β/σ per
  watchlist symbol come from SIP split-adjusted daily bars via the board's `strengths()`
  (61 sessions before the date), stored in the collector SQLite table `spy_strength`, at
  startup, on watchlist change and every 5 minutes for missing symbols (new NY date ⇒ new
  preparation right after midnight). `raiseScored` waits ≤ 3 s for SPY's bar of the alert
  minute, attaches `vsSpy`, then stores and publishes; any failure ⇒ null score.
- Telegram: `vsSpyText` line directly under the headline.
- Backtest: `vsSpyAt` in `BacktestRun.compute` from the SPY minute/daily bars already
  loaded. Cost: no extra Alpaca subrequests; one β/σ computation per symbol and alert date
  (~120 daily rows), negligible next to the minute replay; ~100 bytes per alert in the
  response and cached parts. The offline script's part-cache hash now includes the score
  sources, so old cached parts are recomputed once.
- SIP delay: `packages/market-data/src/sip-delay.ts` (`ALPACA_SIP_DELAY_MINUTES`, integer
  0–60, default 0) threaded through board, day chart, backtest, bar cache, local API,
  Worker (`wrangler.jsonc` var `"0"`), `scripts/backtest.ts` and `scripts/backfill-bars.ts`.

## Acceptance (tests, synthetic data)

- 1–5, 7: `tests/alert-vs-spy.test.ts` (65 confirmed, 38 against, 50 market, σ missing
  ⇒ `vs SPY —`, SPY 1 s late used / 5 s late ⇒ lagged result at 3 s, analysis
  `scoreAgainst` equals the alert-time score, store-before-publish, strengthNow, Israel
  day). Label boundaries 40/41/59/60/null: `tests/vs-spy.test.ts`.
- 8: `tests/board.test.ts`, `tests/day-chart.test.ts` (delay 0 requests up to now; 15
  restores the old cut-off). Backtest vsSpy: `tests/backtest.test.ts`.
- Scenario 6 (site 20 min later) is Frontend's; the data is `strengthNow`.

## Verification

- `npm run check`: pass (format, types, 208 tests: 207 pass, 1 pre-existing skip, builds).
- `git diff --check`: clean. `npm run build:collector`: builds.
- Not verified with real Alpaca, the SIP stream or Telegram.

## Decisions and limitations

- SPY takes one `ALPACA_MAX_SYMBOLS` slot unless on the watchlist (avoids exceeding the
  free IEX 30-symbol limit); raise the limit with SIP.
- Daily bars for β/σ always use the SIP feed (REST history is available on every plan).
- A direction-less alert with an extreme score is labelled `none` (nothing to confirm).
- `spyLagged` is also true when SPY simply had no bar in that minute (sparse pre-market).
- The live and analysis SPY prices can differ only if the stream and REST bars differ.
- UI strings "SIP, 15-min delayed" (web) are Frontend's; use `delayMinutes`.

## Rollout (user)

See [alpaca-operations](../alpaca-operations.md#real-time-sip-rollout): Railway
`ALPACA_FEED=sip` and `ALPACA_MAX_SYMBOLS` = watchlist + 1, redeploy the collector;
deploy the Worker (var `ALPACA_SIP_DELAY_MINUTES = "0"`).

## Next action

Integration review; Frontend builds the Live/Backtest cells against this contract.
