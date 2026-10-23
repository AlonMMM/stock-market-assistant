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
| `version`                                  | 2.1                | the rule set's name, stamped on every entry (see "Versions")  |
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
| `nightCapPct`                              | 10 (V2)            | 15:50: one contract held overnight ≤ this % of equity; 0 off  |
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

## Versions (2026-10-23, user: "make the bot support version, write the bot version on each entry, let me control it")

`packages/trading/src/bot/versions.ts`. A version is a named set of the **trading rules**: `stopPct`, `checks`,
`sellFailedBreak`, `holdFromPct`, `maxNights`, `nightCapPct`, `delta`, `maxDte`, `minPrice`, `minVolume`, `minT`,
`minRvol`, `firstEntryMin`, `skipEarnings`, `skipPremarket`. The owner's limits (`sizePct`, `maxBuysPerDay`,
`maxOpen`, `safetyStopPct`, `dayLossPct`, `drawdownPausePct`), on/off, the mode and the stock lists are not part of
a version.

| Version | Since      | Rules                                                                                                          |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-10-21 | the first bot: t 2, volume 1.5×, delta 0.15, 1–7 DTE, your stop + overnight hold; no news filter, no night cap |
| 2.0     | 2026-10-22 | V2 champion: t 1.8, night cap 10%, news filter (earnings reaction day, pre-market 4×)                          |
| 2.1     | 2026-10-23 | 2.0 + the failed-break sale on the entry day                                                                   |

- `settings.version` is the chosen version's id or the owner's own label (1–24 letters, digits, dots, dashes,
  spaces). The default is the newest version (`currentVersion`). A record saved before versions gets the version
  its rules match exactly, else the newest.
- **The stamp.** `versionLabel(settings)` is what every entry carries: the version id, with a star when the rules
  differ from that version's ("2.1\*"), or the own label as typed. The bot writes it to the signal
  (`bot_signals.data.version`), the position (`bot_positions.data.version`), the buy's note ("… · bot 2.1", so the
  trade journal and Telegram post have it), the warm-up line ("Ready for …; bot version 2.1") and `GET /v1/bot`
  (`version`, `signals[].version`, `positions[].version`). Positions from before versions have no stamp.
- **Control.** The settings page's **Bot version** card (docs/tasks/frontend-bot-settings.md) picks a version,
  which sets its rules (`applyVersion`), shows where the sliders below differ from it ("Changed: stopPct 30 → 40",
  with "Back to 2.1's rules"), and lets the owner name an edited set. Saving goes through `PUT /v1/bot/settings`
  like any other setting; a version change is a settings change in the feed (`version "2.1" → "1.0"; …`).
- A new version is a new entry in `botVersions` (and a new default): the research log decides what gets one.
  Execution changes (chasing the ask, 10-second exit checks) are code, dated in docs/tasks/backend-indi-bot.md, not
  versions.

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
  site's owner gate and token choice (synthetic); versions: ids, the defaults are 2.1, the label and its star,
  applying a version, the label check, the version an old record gets.
- `tests/indi-bot.test.ts`: size and safety stop reach the buy, a stock turned off, a stricter signal, max open,
  the daily loss limit, the drawdown pause (synthetic bars, chains and fills); the version stamp on the signal,
  the position, the buy's note and the feed, starred after a rule change, and picking 1.0.
- `tests/bot-settings-model.test.ts`: the version card's state.

## Deploy

Both parts: the trading service (Railway `sma-trader`) and the website Worker. Until the trader is deployed, the
site's settings page shows "not connected" and keeps Save off.
