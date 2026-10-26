# Task: the alert leg, a second bot on its own paper account

Status: implemented on `feat/strangle-bot`; waiting for the account's keys, then a dry run, then live on paper
Owner: backend (also the site API and the Portfolio page)
Branch: feat/strangle-bot
Spec revision: user 2026-10-25 ("I would like to create another test with this strategy and test it - not mix
them. prepare it and I'll provide you account from alpaca next. I want to also be able to edit the settings and
see the trades in our app."), then the same day: "the one leg looks much better than the strangle - go with it".

## Outcome

The alert leg from the V2 research (`strangle_more.py`, `docs/research/best-algorithms.md` on `research/indi-v2`;
the report https://claude.ai/artifact/ErMfpGfvdRH8Zf3CiadMGe) trades its own Alpaca paper account, next to the
Indi bot and fully apart from it: its own account, records, settings, posts tag (🎯 Alert leg) and Portfolio tab.
Nothing of the Indi bot changes. It began as the alert strangle (both legs); the user chose the one-leg version.
The code keeps the name `strangle` for its module, routes, tables and environment variables.

## The rule (the defaults; every number is a setting)

1. On a day with a same-day expiry (or, with `nextDay` on, the default since 2026-10-25, a day whose nearest expiry
   is the next session: 1DTE, mostly Thursdays), from 09:40 to 13:00 New York, the first time the volume alert (rvol-v6, as
   the backtest evaluated it: `packages/trading/src/strangle/alert.ts`) fires on a stock, in either direction.
   A later alert burst on the same stock (an alert minute after one without) starts a new watch once the stock
   has nothing open, up to `maxPerStock` (2) trades a stock a day; a burst that gave no trade does not count
   (2026-10-26, `leg_twice.py`: with the day's caps 2 is best on both lists). Alerts are kept in
   `strangle_alerts` (one row per stock and alert minute; the older `strangle_signals` rows are copied once).
2. News filter as the Indi bot's: no trade on the earnings reaction day or with pre-market volume 4× or more.
3. Watch: the side is the first time the stock is 0.25 of its typical 30-minute move (`priorLevels(...).unit`,
   the failed break's unit) from its price when the alert was read, up or down. No side within 10 minutes of
   the alert (60 until 2026-10-26; `leg_entry.py`): no trade. Optional strength filter: buy only when the C t-stat since the open agrees.
4. Buy only that side's leg: the 0.35-delta call (up) or put (down) of that day's expiry (`pickContract`), 1% of
   the account at the ask; its mid ≥ $0.20 and ≥ 200 contracts in the last 30 minutes.
5. Sell all when the stock gives back 0.75 of its typical 30-minute move from its best since the buy (its high
   for a call, its low for a put); everything out by 15:30, 1DTE legs too. A leg left from a past day is sold at once.
6. Limits: 5 trades a day, 3 open, no new trade after a 5% day loss.

Backtest (2% fill a leg, 1% a trade): fair list 2024–2026 $157,440 / 3% worst drop vs the strangle's $134,415;
the favorites' last year $122,233 / 3% vs $104,976; at a 4% fill $137,179 and $112,497.

The 1DTE days (`leg_1dte.py`, `leg_export.py`, the rule as this bot runs it: the leg picked at the side), 1% at a 2%
fill: fair list 0DTE days alone $208,776 / 4.1% (446 trades), with the 1DTE days $308,991 / 5.0% (842); the
favorites' year $131,322 / 5.4% → $151,341 / 5.1% (253 → 440); at a 4% fill $171,500 → $211,991 and $117,513 →
$125,184. Holding 1DTE legs overnight was tested and dropped. Benchmark page:
https://claude.ai/artifact/4g8QiFg4AmAyUiH5FP5AY4.

Differences from the backtest: the side and the give-back are checked every 10 s on the stock's last trade (the
backtest used minute closes); the side is measured from the stock when the alert is read (the backtest from the
pair's fill, a minute later); fills are the service's chased limit orders, not the bar middle ± 2%; the service's
risk rules apply (below).

## The account's risk rules (the owner's validator, unchanged)

Every order is an ordinary `TraderService` buy or sell at the strangle's account: paper only, the global switch,
never short, quotes ≤ 2 minutes old, spread ≤ 25% of the mid, ≤ 3% of the account per buy, ≤ 5% in one stock
and side, ≤ 10% open risk, 10 buys a day, no buy after a 5% day loss, and **no buy while a held contract has no
stop**. So every leg carries the broker's safety stop (`safetyStopPct`, default −70%, the most the rules allow);
the give-back acts long before it. Sizes above 3% are refused by the per-buy cap; the refusal shows in the
activity feed.

## Parity with the backtest

`scripts/strangle-parity.ts` (local bar cache) replays strangle_more.py's exports (`BT_EXPORT`): the first alert
minute and side, the side's minute and leg, the buy minute and the give-back's exit minute. Fair list 307 trades
and favorites 192: identical on every step except 2 sides (HIMS 2025-01-31, GLD 2026-05-29), 4 minutes later in
the backtest, which also waited for both strangle legs to print before it watched the stock.

## Code

- `packages/trading/src/strangle/`: `settings.ts` (settings, limits, the rule in words), `alert.ts` (the port),
  `decide.ts` (the side, the give-back, the size), `view.ts` (the status shape).
- `apps/trader/src/strangle.ts` (the bot), `strangle-store.ts` (tables `strangle_*` in the trader database),
  `seed-bot.ts` (`ensureStrangleAccount`), `main.ts` (wiring and routes).
- Trader routes: `GET /v1/strangle` (status, read token), `GET|PUT /v1/strangle/settings`. The favorites list
  posted to `/v1/bot/watchlist` goes to both bots.
- Site: `GET /api/strangle`, `GET|PUT /api/strangle/settings` (PUT: the owner, from the site), `GET
/api/portfolio/strangle[/history]` (the account, read with its own keys).
- App: Portfolio → 🎯 Alert leg → Activity (the rule, today's first alerts, open trades, every trade with its
  fills, the feed), Trades (the account: value, positions, orders, closed trades and the P&L chart), Settings
  (owner only: on/off, dry run or live, every number, the switches, the stocks).
- Tests: `tests/strangle.test.ts` (synthetic: the alert, the decisions, the settings, dry and live runs, no side).

## Connect it (after merge, from a clean `origin/main`)

The bot does not run at all without its own account; it never falls back to another one.

1. Alpaca: a new **paper** account; enable options trading on it (the same level as the others).
2. Railway, trader service: `STRANGLE_ALPACA_API_KEY` and `STRANGLE_ALPACA_API_SECRET`. The log then shows
   `added the strangle bot's own Alpaca paper account "<owner>-strangle"` and `the strangle bot trades its own
account`.
3. Worker: `npx wrangler secret put STRANGLE_ALPACA_API_KEY` and `..._SECRET`, then deploy (the Trades page).
4. It starts **off and in dry run**. Switch it on in Settings; run dry a few sessions; then "Trade its paper
   account".
5. Keys pasted into a chat are regenerated afterwards and updated in both places.

## Verification

- `npm run check`: formatting, types and build pass; 637 of 639 tests pass, 1 skipped, 1 fails: the Indi bot's "broker setting both" test, untouched here and flaky on main too (its two positions come back in random-id order).
- `scripts/strangle-parity.ts`: 497 / 499 (the 2 explained above).
- Not verified: a real session on Alpaca (needs the account and the deploy), the app pages in a browser.
