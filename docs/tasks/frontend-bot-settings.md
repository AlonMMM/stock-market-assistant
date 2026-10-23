# Task: Bot settings page (owner only)

Status: completed; the API is in docs/tasks/backend-bot-settings.md
Owner: frontend
Branch: feat/bot-settings
Spec: the "Bot settings" design canvas, https://claude.ai/artifact/Eiqn3j2yjUJ9KYaXWBCJWo

## Outcome

The account owner opens Portfolio → 🤖 Bot → **Settings** and changes how the bot trades: on/off, paper vs dry
run, the stocks it watches, trade size, losses, overnight holding, the contract, and (folded away) the signal
itself. Everyone else still sees only the read-only Bot tab.

## Scope and exclusions

- In: `apps/web/src/BotSettings.tsx` (page), `apps/web/src/bot-settings-model.ts` (defaults, stock list,
  warnings), a Settings button in `BotPanel` and the owner gate in `Portfolio` (`canTrade`), styles.
- Out (backend, not built here): storing the settings, the site and trader routes, and the bot reading them.

## Proposed contract (for Integration and Backend)

`GET /api/bot/settings` → `BotSettings`; `PUT /api/bot/settings` with a whole `BotSettings` → the saved
`BotSettings`. PUT needs the owner's sign-in, like the position controls (403 otherwise). The type is
`BotSettings` in `apps/web/src/bot-settings-model.ts`; now shared as `packages/trading/src/bot/settings.ts`. Fields missing from a GET answer fall back to `defaultSettings`.

- Stocks: `followFavorites`, `added` (the owner's own tickers), `off` (tickers turned off). The watched set is
  core ∪ added ∪ (favorites if followed), minus `off`, minus SPY and the futures CL, GC, SI. Stocks apply from
  the next session, the rest from the next minute.
- Values the bot already runs: `enabled`, `mode`, `sizePct`, `delta`, `stopPct` 30, `safetyStopPct` 50,
  `checks`, `holdFromPct` 100, `maxNights` 2, `nightCapPct` 10 (V2: "Most held overnight", 0 = no cap), `maxDte` 7, `minPrice` 0.20, `minVolume` 200, `minT` 1.8 (step 0.1),
  `minRvol` 1.5, `firstEntryMin` 10, `skipEarnings`, `skipPremarket`.
- New bot behaviour the design asks for: `maxBuysPerDay` (default 5), `maxOpen` (4), `dayLossPct` (5, a
  bot-only limit beside the owner's 5% rule), `drawdownPausePct` (15, turns the bot off). These are not in the
  backtest; the page labels them "Default", not "Backtest". The user confirmed the design's defaults (2026-10-22).

## Bot version card (2026-10-23)

Above the stocks: **Bot version · 2.1**, a segment of the known versions (packages/trading/src/bot/versions.ts),
the chosen one's name, date and notes, and what entries are stamped with. Picking a version sets its rules on the
sliders and switches below; changing a rule afterwards shows "Changed: stopPct 30 → 40", the stamp "2.1\*" and a
"Back to 2.1's rules" link, and an input to name the edited set (an own label, up to 24 characters). The owner's
limits and the stock lists are not part of a version. The Bot tab shows the version in its header, on each
holding ("v2.1"), on signals and closed trades, and first under "How the bot decides".

**Full rules per version (2026-10-23, user: "for each version I want to be able to click on it and see the bot's
full algorithm rules").** Under the version's notes, a folded row per version, newest first ("2.1 · V2 +
failed-break sale · since 2026-10-23", "running" on the one in force). Opening a row lists the version's whole
algorithm in words (`algorithmSteps`, packages/trading/src/bot/algorithm.ts): signal, news filter, contract, early
checks, failed break, stop, day exit. A row that is not running ends with **Run these rules**, which is the same as
picking that version. When the rules below were changed or carry an own label, a first row shows the rules as set
("2.1\* · the rules as set below"). The Bot tab's "How the bot decides" uses the same wording for the rules in force.

## Behaviour without the API

The page tries `GET /api/bot/settings`. A 404/405 or a non-JSON answer means "not served yet": it starts from
`GET /api/bot` (on/off, mode, size, delta; stocks not watched today start off) and the defaults, shows an amber
note, and keeps **Save** disabled with "Saving is not connected yet; nothing here reaches the bot". No change is
presented as applied.

## Verification evidence

- `node --import tsx --test tests/bot-settings-model.test.ts`: 9 pass.
- `npm run check`: exit 0 (568 tests: 567 pass, 0 fail, 1 skipped; format, types, build).
- Headless Chrome (Playwright), built app, **synthetic** `/api/bot` data, at 1280 px and 390 px:
  - settings API 404: note shown, Save disabled, toggling TSLA and the stop slider marks them changed;
  - settings API mocked: Save sends PUT and shows "Saved. The bot uses the new settings."; the save bar sits
    above the phone tab bar.

## Handoff

Next: Backend adds the store and routes (Worker + trader `GET/PUT /v1/bot/settings`), and the bot reads the
settings each tick (stocks at warm-up). Integration confirms the four new defaults with the user and moves the
type into the shared package.
