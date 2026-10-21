# Task: the Indi bot trades the paper account

Status: implemented on `feat/indi-bot`; dry run next, then live on paper
Owner: backend (also touches the site API and the Portfolio page)
Branch: feat/indi-bot

## Outcome

The rules that came out of the Indi backtest (`docs/tasks/research-indi-backtest.md` on
`research/indi-backtest`; report https://claude.ai/code/artifact/50f7263c-8a6a-4b52-b798-9ee70c5c40d7) trade the
owner's Alpaca **paper** account on their own. The trades show in the app and in the Telegram chat like the user's
own, marked 🤖 Bot. The point is the paper test: real fills, real drawdown, next to Indi.

## User-confirmed (2026-10-21)

- The existing paper account, shared with the user's manual trades.
- Delta 0.15 (the user does not want delta above 0.25).
- 2% of the current account per trade.
- Telegram: the same chat, posts marked 🤖 Bot.

## User-confirmed (2026-10-21, second round)

- The bot's buys go through the same validation and risk manager as the user's (they do: below).
- The platform auto stop at −50% stays on besides the strategy's own exits.
- The bot also trades the user's favorites watchlist, updated before each session.
- The app shows what the bot does live, not only its trades.

## Rules (as backtested; parity checked)

- **Stocks:** `config/bot-universe.json`, stocks Indi opened options on at least twice in the past 12 months, without
  index and macro ETFs. It is refreshed by hand.
- **Signal (C):** the t-stat of the 1-minute moves vs SPY × beta (beta from 5-minute returns, prior 20 sessions)
  is at least 2, and volume since the open is at least 1.5× the 20-session median of the same window. From 09:40
  to 15:44, one per stock per day, in the side that comes first. `packages/trading/src/bot/signal.ts`.
- **Contract:** nearest expiry 1–7 days out, OTM, delta closest to 0.15. Skip it when the mid is under $0.20, when
  under 200 contracts traded in the last 30 minutes, or when the account already holds that contract.
  `packages/trading/src/bot/picker.ts`.
- **Size:** `sizePct: 2` through the service's buy. The owner's validator and risk manager still apply.
- **Exits:** `packages/trading/src/bot/exits.ts`.
  - Your stop: half at +10 minutes and the rest at +20 minutes if the stock is against the entry; all out at −30%
    with the stock against.
  - 15:50: hold winners up 100% or more overnight (at most 2 nights, with a session before expiry); sell the rest.
  - The first carried morning at 09:40: half if the stock gapped 0.5% or more our way, otherwise all.
  - On carried days, −30% sells all. On expiry day everything is out by 15:30.
  - On an early-close day, 15:50 and 15:30 move to 10 and 30 minutes before the close.
- **Safety stop:** buys carry the service's broker stop at −50% (`stopPct: 50`) in case the service is down.
  Sales put it back on what is left. The backtest had no such stop.
- **Never short:** the bot sells an exact count, at most what its own records hold. Every tick it caps that count
  at what the account holds (a stop, or the user selling by hand). Sales go through the service's close-only sell
  and short check.

## Parity with the backtest

- `scripts/bot-parity.ts`: the TypeScript signal on the backtest's bar cache gives the same first minute and side
  as the Python `signals.py`. 26,049 stock-days in 2024–2026 were checked, with 0 differences.
- `scripts/bot-exit-parity.ts`: every trade of the backtest run `t_flat_n100_<year>` was walked again with
  `nextAction`. 875 trades gave the same sequence of exit rules, with 0 differences. 6 were skipped because the
  backtest filled them late or forced them out.
- Both scripts need the local cache (`data/local/x/bt`, not in Git).

## Risk management and validation

Every bot buy is an ordinary `TraderService.buy`, so it passes the owner's validator (`owner-v1`) and the engine's
checks, exactly like a buy from the Trade page or Claude. Any of them can refuse it. The signal then shows
"refused by the risk rules", with the reason, in the Bot tab and its activity feed.

- **Buy limits (`defaultBuyLimits`):**
  - at most 10 buys a day (shared with the user's);
  - open risk at most 10% of equity;
  - one position at most 5%;
  - no buys after a 5% day loss;
  - spread at most 25% of the mid;
  - quotes no older than 2 minutes.
- **Indi's risk manager:**
  - risk per trade 5% and per day 7% (premium × the share lost by days to expiry, so 1.4–1.8% for a 2% buy);
  - after a 12.5% drop from the high, the brake: 2% / 3%; in recovery, 3% / 5%.
- **Engine checks:** paper account only, the global switch, never short.

## Universe: Indi's list and the favorites

- `config/bot-universe.json` plus the user's favorites watchlist. That is the list named in the Worker's
  `BOT_WATCHLIST`, or else the first list whose name has "fav" or a star; SPY is dropped.
- The site's cron sends it to `POST /v1/bot/watchlist` every minute from 08:30 to 09:24 New York. The bot reads
  it when it warms up at 09:25, so a list changed during the session counts from the next session.

## What the app shows live

The Portfolio → 🤖 Bot tab refreshes every 15 seconds and shows:

- status and the last check time;
- the stocks watched and where they come from;
- a **live scan**: each stock's leaning, strength t (2 needed) and volume ratio (1.5× needed), as bars, closest to
  a signal first;
- today's signals and what came of them;
- holdings and closed trades;
- an **activity feed** (`bot_events`, last 2,000): warm-up, lists received, every signal, every skip and why, every
  check passed, buys, sales, overnight holds, the day summary, errors.

## Design

- `apps/trader/src/bot.ts` (`IndiBot`) runs inside the trading service and ticks every 15 seconds.
  - At 09:25 New York it warms up with 20 prior sessions of bars.
  - Each closed minute it reads the new bars (SIP), checks signals and runs the exits.
  - Buys and sales go through the owner's Alpaca `TraderService`, with `tag: "🤖 Bot"` and a reason line, so the
    service's posts, journal, stops and short check apply.
  - A day summary goes to Telegram 5 minutes after the close.
- `apps/trader/src/bot-store.ts` holds the `bot_signals`, `bot_positions` and `bot_settings` tables in the
  service's database. A restart resumes from them.
- `apps/trader/src/bot-market.ts`: Alpaca stock bars (SIP) and option volume. Read-only.
- `tag` and `note` on buy and sell requests (`engine.ts`, `message.ts`, `service.ts`) add the 🤖 Bot line and the
  reason to the entry and exit posts.
- Site: `GET /api/bot` reads the trader's `GET /v1/bot` with the read-only token (`packages/trading/src/bot-api.ts`).
- Web:
  - Portfolio → 🤖 Bot tab: status, today's signals, holdings, and closed trades of the last 5 sessions.
  - A Bot chip on the bot's positions (Live trades) and on its closed trades (History).

## Switches

| Setting                           | Where               | Effect                                                                               |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `BOT_ENABLED=true`                | trader env          | On when the service starts (default off)                                             |
| `BOT_MODE=live`                   | trader env          | Places orders. Anything else is a dry run: "would buy / would sell" posts, no orders |
| `POST /v1/bot {"enabled": false}` | trader, write token | Off now (kept across restarts)                                                       |
| `TRADING_ENABLED=false`           | trader env          | Refuses every buy, the bot's too                                                     |

## Verification evidence

- `tests/indi-bot.test.ts` (synthetic data) covers the favorites (pick, merge, cleaning), the live scan and the
  activity feed, and:
  - the signal: call, put, normal volume, too few prior days;
  - every exit rule;
  - the picker;
  - the 🤖 posts;
  - the runner: live (buy → overnight → morning sale of exactly what it holds), a contract the user holds is
    skipped, a hand sale caps the bot's count, and the dry run places no orders.
- `npm run check` passes: 548 tests, formatting, types, builds.
- Not verified yet: a real session (dry run), real fills, the Railway setup, and the Bot tab against the real
  service.

## Next

1. Merge, deploy the trader and the site from `origin/main`. Set `BOT_ENABLED=true`, leave `BOT_MODE` unset (dry).
2. Two sessions in dry run: compare its signals with `signals.py` on the same days.
3. `BOT_MODE=live` on paper. Review it daily against Indi; decide on size and delta after 4–6 weeks.

## Limits

- Bot and manual trades share the account and its History. The Bot chip marks contracts the bot opened in the
  last 5 sessions.
- The universe list does not refresh by itself.
- Backtest worst drop at 2% a trade was 46%, or 57% with 5% fill costs.
- Alpaca's delta (from its quotes) can differ slightly from the backtest's, which was Black-Scholes from the last
  trade.
