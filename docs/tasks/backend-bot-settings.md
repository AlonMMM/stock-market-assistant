# Task: the bot reads the owner's settings

Status: implemented on `feat/bot-config`
Owner: backend (also the site's route and the Bot tab's wording)
Branch: feat/bot-config

## Outcome

Everything on the site's Bot settings page (docs/tasks/frontend-bot-settings.md) drives the bot. The owner saves
from Portfolio → 🤖 Bot → Settings; nothing needs a redeploy or an environment change.

## User-confirmed (2026-10-22)

"Make the bot fully configurable and use the defaults": the four new limits start at the design's numbers.

## Settings and where they act

`packages/trading/src/bot/settings.ts` holds the type, the defaults, each number's range and step, and the mapping
to the existing rule objects. The bot reads them every minute (`IndiBot.settings()`), so a change counts from the
next minute; the stock list is fixed at warm-up (09:25 New York) and changes from the next session.

| Setting                                    | Default            | Acts on                                                       |
| ------------------------------------------ | ------------------ | ------------------------------------------------------------- |
| `enabled`                                  | env                | the existing on/off switch (`bot_settings.enabled`)           |
| `mode`                                     | env                | `live` paper orders or `dry` "would buy"; new entries only    |
| `followFavorites`, `added`, `off`          | on, —, QQQ SQQQ    | today's stocks: core ∪ added ∪ favorites − off − SPY/CL/GC/SI |
| `sizePct`                                  | 2                  | the buy's `sizePct` (dry run: the same share of equity)       |
| `maxBuysPerDay`                            | 5 (new)            | entries today (bought or would buy); then `max_buys`          |
| `maxOpen`                                  | 4 (new)            | open bot positions of the mode; then `max_open`               |
| `stopPct`                                  | 30                 | `exitRules.stopOut`                                           |
| `safetyStopPct`                            | 50                 | the broker stop on buys and on what is left after a sale      |
| `dayLossPct`                               | 5 (new)            | account vs its value at warm-up; then `day_loss`              |
| `drawdownPausePct`                         | 15 (new)           | switches the bot off (below)                                  |
| `checks`                                   | on                 | the 10- and 20-minute checks                                  |
| `holdFromPct`, `maxNights`                 | 100, 2             | the overnight carry                                           |
| `nightCapPct`                              | 8 (V2)             | 15:50: one contract held overnight ≤ this % of equity; 0 off  |
| `delta`, `maxDte`, `minPrice`, `minVolume` | 0.15, 7, 0.20, 200 | the contract picker (delta ≤ 0.25)                            |
| `minT`, `minRvol`, `firstEntryMin`         | 1.8 (V2), 1.5, 10  | the C signal (`minT` on a 0.1 step)                           |
| `skipEarnings`, `skipPremarket`            | on, on             | the news filter                                               |

V2 (`feat/indi-bot-v2-rules`, docs/tasks/backend-indi-bot.md "V2 rules"): `minT` 1.8 (was 2, step 0.25 → 0.1) and
the new `nightCapPct`. Settings the owner saved before keep their own `minT` (a saved 2 stays 2) and get
`nightCapPct` 8 from the defaults. `nightCapPct` was backtested, so it is not in `untested`.

`enabled` and `mode` default to `BOT_ENABLED` / `BOT_MODE` until the owner saves; a saved value then wins.
Limits on new buys run after the news filter and before the contract is picked. Exits of held positions are
never limited, also when the bot is off or paused.

**Drawdown pause.** Each sale now keeps its price (the fill's average, the mid in a dry run). The bot adds up the
P&L of its sales (of the current mode) since it was last switched on; when that running total is
`drawdownPausePct` of the account below its best, it switches itself off, writes an error line and posts
"🤖 Bot: paused". The owner switches it back on, which restarts the count. Sales from before prices were kept
do not count.

## Endpoints

- Trader: `GET /v1/bot/settings` (read token works) → `BotSettings`; `PUT /v1/bot/settings` (full token) with a
  whole `BotSettings` → the saved settings, or 400 with the first wrong field. Changes go to the activity feed
  ("Settings changed: stopPct 30 → 45").
- Site (Worker): `GET /api/bot/settings` with the read token; `PUT` only for `TRADE_OWNER_EMAIL`'s verified
  sign-in from the site's own origin, passed on with `TRADER_TOKEN`; the trading service's 400 comes back as is.
- Local API: GET as above; PUT answers 403 (no sign-in locally).
- `GET /v1/bot` and `/api/bot` now carry `settings`, so the Bot tab shows the numbers in force.

## Verification

- `tests/bot-settings.test.ts`: validation, defaults, watched stocks, rule mapping, checks off, drawdown, the
  site's owner gate and token choice (synthetic).
- `tests/indi-bot.test.ts`: size and safety stop reach the buy, a stock turned off, a stricter signal, max open,
  the daily loss limit, the drawdown pause (synthetic bars, chains and fills).

## Deploy

Both parts: the trading service (Railway `sma-trader`) and the website Worker. Until the trader is deployed, the
site's settings page shows "not connected" and keeps Save off.
