# Task: the alert strangle, a second bot on its own paper account

Status: implemented on `feat/strangle-bot`; waiting for the account's keys, then a dry run, then live on paper
Owner: backend (also the site API and the Portfolio page)
Branch: feat/strangle-bot
Spec revision: user 2026-10-25 ("I would like to create another test with this strategy and test it - not mix
them. prepare it and I'll provide you account from alpaca next. I want to also be able to edit the settings and
see the trades in our app.")

## Outcome

The alert strangle from the V2 research (`zero9.py`, `docs/research/best-algorithms.md` on `research/indi-v2`;
the pages https://claude.ai/artifact/H8gGya26BFsnqxsw97TDsN and https://claude.ai/artifact/Uug3uh6G7MWQcvRTMfq3tM)
trades its own Alpaca paper account, next to the Indi bot and fully apart from it: its own account, records,
settings, posts tag (🎯 Strangle) and Portfolio tab. Nothing of the Indi bot changes.

## The rule (the defaults; every number is a setting)

1. On a day with a same-day expiry, from 09:40 to 13:00 New York, the first time the volume alert (rvol-v6, as
   the backtest evaluated it: `packages/trading/src/strangle/alert.ts`) fires on a stock, in either direction.
   One trade per stock a day; a later alert the same day does not count.
2. News filter as the Indi bot's: no entry on the earnings reaction day or with pre-market volume 4× or more.
3. Buy the 0.35-delta call and put of that expiry (`pickContract`, same day only), the same number of each, the
   pair costing 1% of the account; each leg's mid ≥ $0.20 and ≥ 200 contracts in the last 30 minutes.
4. The side: the stock 0.25 of its typical 30-minute move (`priorLevels(...).unit`, the failed break's unit)
   from the price when both legs are held. Optional strength filter: keep the side only when the C t-stat since
   the open agrees, else both out.
5. Sell the wrong leg; with `recycle` (on, the "D bonus") its money buys more of the right leg.
6. The right leg: sold when its mid is 30% under its highest since kept; everything out by 15:30. No side within
   60 minutes of the alert: both legs out. A leg left from a past day is sold at once (never carried).
7. Limits: 3 trades a day (each is up to 3 buys; the account allows 10), 3 open, no new trade after a 5% day loss.

Differences from the backtest: the live trail and the side are checked every 10 s on the stock's last trade and
the legs' quote mids (the backtest used minute closes); fills are the service's chased limit orders, not the bar
middle ± 2%; the service's risk rules apply (below).

## The account's risk rules (the owner's validator, unchanged)

Every order is an ordinary `TraderService` buy or sell at the strangle's account: paper only, the global switch,
never short, quotes ≤ 2 minutes old, spread ≤ 25% of the mid, ≤ 3% of the account per buy, ≤ 5% in one stock
and side, ≤ 10% open risk, 10 buys a day, no buy after a 5% day loss, and **no buy while a held contract has no
stop**. So every leg carries the broker's safety stop (`safetyStopPct`, default −70%, the most the rules allow);
the wrong-leg sale and the 30% trail act long before it. Sizes above about 5% may be refused on the per-buy or
per-position caps; the refusal shows in the activity feed.

## Parity with the backtest

`scripts/strangle-parity.ts` (local bar cache) replays the export's 307 trades (fair list, 2024–2026): the first
alert minute and side, the confirmation minute and kept leg, and the kept leg's trail exit minute: 307 / 307
identical on all three.

## Code

- `packages/trading/src/strangle/`: `settings.ts` (settings, limits, the rule in words), `alert.ts` (the port),
  `decide.ts` (side, trail, sizes), `view.ts` (the status shape).
- `apps/trader/src/strangle.ts` (the bot), `strangle-store.ts` (tables `strangle_*` in the trader database),
  `seed-bot.ts` (`ensureStrangleAccount`), `main.ts` (wiring and routes).
- Trader routes: `GET /v1/strangle` (status, read token), `GET|PUT /v1/strangle/settings`. The favorites list
  posted to `/v1/bot/watchlist` goes to both bots.
- Site: `GET /api/strangle`, `GET|PUT /api/strangle/settings` (PUT: the owner, from the site), `GET
/api/portfolio/strangle[/history]` (the account, read with its own keys).
- App: Portfolio → 🎯 Strangle → Activity (the rule, today's first alerts, open trades, every trade with its
  fills, the feed), Trades (the account: value, positions, orders, closed trades and the P&L chart), Settings
  (owner only: on/off, dry run or live, every number, the switches, the stocks).
- Tests: `tests/strangle.test.ts` (synthetic: the alert, the decisions, the settings, dry and live runs).

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

- `npm run check`: formatting, types and build pass; 637 of 639 tests pass, 1 skipped, and 1 fails: the Indi bot's "broker setting both" test, which this branch does not touch and which fails about half the time on main too (its two positions come back in random-id order).
- `scripts/strangle-parity.ts`: 307 / 307.
- Not verified: a real session on Alpaca (needs the account and the deploy), the app pages in a browser.
