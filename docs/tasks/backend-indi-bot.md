# Task: the Indi bot trades the paper account

Status: implemented on `feat/indi-bot`; V2 rules (t 1.8, night cap) on `feat/indi-bot-v2-rules`; dry run next,
then live on paper
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

These are the defaults. Since 2026-10-22 the owner can change each one on the site's Bot settings page; see
`docs/tasks/backend-bot-settings.md`.

- **Stocks:** `config/bot-universe.json`, stocks Indi opened options on at least twice in the past 12 months, without
  index and macro ETFs. It is refreshed by hand.
- **Signal (C):** the t-stat of the 1-minute moves vs SPY × beta (beta from 5-minute returns, prior 20 sessions)
  is at least 1.8 (V2; it was 2), and volume since the open is at least 1.5× the 20-session median of the same window. From 09:40
  to 15:44, one per stock per day, in the side that comes first. `packages/trading/src/bot/signal.ts`.
- **News filter:** no new entry on the stock's earnings reaction day, or when its pre-market volume is 4× normal or
  more. Exits of held positions are unchanged. See "News filter (V2 champion)" below.
  `packages/trading/src/bot/news.ts`.
- **Contract:** nearest expiry 1–7 days out, OTM, delta closest to 0.15. Skip it when the mid is under $0.20, when
  under 200 contracts traded in the last 30 minutes, or when the account already holds that contract.
  `packages/trading/src/bot/picker.ts`.
- **Size:** `sizePct: 2` through the service's buy. The owner's validator and risk manager still apply.
- **Exits:** `packages/trading/src/bot/exits.ts`.
  - Your stop: half at +10 minutes and the rest at +20 minutes if the stock is against the entry; all out at −30%
    with the stock against.
  - 15:50: hold winners up 100% or more overnight (at most 2 nights, with a session before expiry); sell the rest.
    Since version 2.3 (2026-10-24, the user's call) the bar is +50% (`holdFromPct`, default 50).
    Of what is held, one contract is worth at most 10% of the account (`nightCapPct`, default 10; the user chose 10 on 2026-10-22): the excess is sold first.
    See "V2 rules" below.
  - The first carried morning at 09:40: half if the stock gapped 0.5% or more our way, otherwise all.
  - On carried days, −30% sells all. On expiry day everything is out by 15:30.
  - On an early-close day, 15:50 and 15:30 move to 10 and 30 minutes before the close.
- **Safety stop:** buys carry the service's broker stop at −50% (`stopPct: 50`) in case the service is down.
  Sales put it back on what is left. The backtest had no such stop.
- **Never short:** the bot sells an exact count, at most what its own records hold. Every tick it caps that count
  at what the account holds (a stop, or the user selling by hand). Sales go through the service's close-only sell
  and short check.

## V2 rules (`feat/indi-bot-v2-rules`)

From the V2 research (log: `docs/research/best-algorithms.md` on `research/indi-v2`). Backtests: delta 0.15, fair
list, Feb 2024 – Oct 2026, from $100,000, news filter on. Both changes were chosen by the user and are owner
settings (docs/tasks/backend-bot-settings.md).

### 1. Signal threshold t ≥ 1.8 (was 2)

`defaultSettings.minT` and `defaultSignalParams.strengthT` are 1.8 (the setting's step is now 0.1); day volume stays
≥ 1.5×; nothing else changes. Settings saved before V2 keep their own `minT`.

| Run                   | t ≥ 2.0 end / worst drop | t ≥ 1.8 end / worst drop |
| --------------------- | ------------------------ | ------------------------ |
| 1% a trade            | $297,160 / 16%           | $585,592 / 11%           |
| 2% a trade            | $688,039 / 30%           | $2,444,629 / 21%         |
| 151 unseen stocks, 1% | $121,443 / 11%           | $123,028 / 11%           |
| Delta 0.10, 1%        | $503,674 / 15%           | $808,028 / 13%           |

Parity: `scripts/bot-parity.ts` was run at t 2, where the research generator reproduces the TypeScript signals
exactly (11,058 of 11,058). The threshold is a parameter of the same code, so at 1.8 the bot matches the
research's 1.8 signals by construction. The parity script was not run again at 1.8 (it needs the local data).

### 2. Overnight cap: at most 10% of the account into the night (default; backtested at 8%)

- At the 15:50 decision, for a position the rules hold overnight: value = count × the option's mid now × 100. If
  that is more than `nightCapPct` (default 8) percent of the account's equity, the bot first sells the excess, an
  exact count: what is held after is the largest count worth at most the cap (rounded down). The sale has the
  reason "night cap" (`night-cap`); the rest is held and follows the usual morning rules.
- `nightCapPct` 0 is no cap (range 0–25, step 1). There is no environment variable.
- `nightCapSell` in `packages/trading/src/bot/exits.ts`; `IndiBot.nightCap` in `apps/trader/src/bot.ts`. The count
  is the bot's own, already capped at what the account holds, and the sale goes through the service's close-only
  sell like every other: never more than held.
- The cap is per contract, as in the research (`night_rules.py`, each trade's night against the account). The
  bot never holds two positions of one contract (it skips a contract the account holds).
- **Equity:** read from the trader account at 15:50. If that read fails, the cap uses the last value read
  successfully that day (warm-up or later; an `info` line says so). With none that day, the bot holds nothing
  overnight: it sells the whole carry (reason `night-no-equity`, "no account value today for the overnight
  cap") and writes an `error` line.
- Dry run: a "would sell" post and feed line, no order.
- The Bot tab names the sale ("overnight cap") and the rule; the settings page has "Most held overnight" under
  Profits and holding.

Backtest at t ≥ 2: free at 1% a trade; at 2% it cuts the end by about 25% ($688K → $516K) but the worst single
night from −17.6% to −5.4% of the account; the worst drop hardly changes.

### Not used: scale-in

Scale-in tested on t ≥ 1.8: worse (A $476,299 / 12% vs $585,592 / 11% at 1%; unseen $115,967 vs $123,028), not
used. The bot buys the full size (2%) at the signal.

## Versions (2026-10-23)

The rules the bot runs have a version, and every entry is stamped with it: 1.0 (the first bot, 2026-10-21), 2.0
(the V2 champion: t 1.8, night cap, news filter, 2026-10-22), 2.1 (2.0 plus the failed-break sale, 2026-10-23).
The owner picks the version on the settings page; a rule changed from the version's stars the stamp ("2.1\*"). The
table and the mechanics are in docs/tasks/backend-bot-settings.md, "Versions"; the code is
`packages/trading/src/bot/versions.ts`.

## News filter (V2 champion)

Branch `feat/indi-bot-news-filter`. From the V2 research (`news_filter.py` on `research/indi-v2`; full log in
`docs/research/best-algorithms.md` on that branch).

### The rule

1. **Earnings reaction day.** The public Nasdaq calendar (`api.nasdaq.com/api/calendar/earnings?date=…`), for a
   report listed on date D:
   - before the open (`time-pre-market`) and D a session: D;
   - after the close (`time-after-hours`), or D not a session: the next session after D;
   - no time (94% of rows), a causal rule the live bot can know: D itself when its regular-session open is 2% or
     more from the prior close; the next session when its open gap is larger than D's.
2. **Pre-market volume.** The sum of SIP 5-minute bar volume 04:00–09:30 New York, against the median of the same
   sum over the prior 20 sessions (at least 10 with data, otherwise no filter). 4× or more: no entry today.

### How the bot runs it

- **Warm-up (09:25 NY):** reads the calendar for every date from the previous session through today (a Monday
  reads Friday to Monday), keeps the rows of the watched stocks for the day, and writes a feed line.
- **09:30 NY, before the first entry at 09:40:** reads pre-market volume for today and the 20 prior sessions
  (`AlpacaBotMarket.premarket`, chunks of 10 stocks). It waits for 09:30 so the sum is final; the research also
  summed through 09:30. After a restart mid-session it reads it at once.
- **At a signal:** a blocked stock's signal ends as `earnings` ("skipped, earnings reaction day", with the report
  date and time) or `premarket` ("skipped, pre-market volume 4× normal or more", with the ratio), as a `skip` line
  in the activity feed. No buy in live mode, no "would buy" in a dry run. Skips are not posted to Telegram.
- **Fails open:** if the calendar or the pre-market read fails, an `error` line says the bot trades today without
  that filter, and it does; each is read once a session. The Bot tab also notes it above the live scan.
- **Live scan:** a "News filter" column shows a stock that is blocked today.
- The causal rule needs the open, so a no-time report is decided at the signal (09:40 or later), from today's first
  bar and the warm-up bars.

### Backtest (C signal, delta 0.15, your stop + overnight hold, fair list, Feb 2024 – Oct 2026, from $100,000)

| Run                    | V1 end   | V1 worst drop | V1 + news filter end | worst drop |
| ---------------------- | -------- | ------------- | -------------------- | ---------- |
| 1% a trade             | $257,698 | 26%           | $297,160             | 16%        |
| 2% a trade             | $499,412 | 46%           | $688,039             | 30%        |
| 151 unseen stocks, 1%  | $107,869 | 21%           | $121,443             | 11%        |
| Delta 0.10, 1%         | $495,349 | 23%           | $503,674             | 15%        |
| Delta 0.10, unseen, 1% | $86,369  | 20%           | $102,663             | 9%         |

The causal earnings rule above reproduces these numbers exactly (the research's "whichever gapped more" rule
gave the same trades).

## Orders and timing (2026-10-23, user request)

- **Buys chase until filled.** After the usual raises from the mid toward the ask, the bot's buy
  keeps raising its limit to the current ask every 3 s for up to 10 minutes (`chase: true`,
  `chaseMs` on the buy; `buyWithLadder`'s `chaseMs`). It never lowers the price and never pays
  more than 10% over the planned budget (`chaseSlack`); when the ask is above that, the order
  waits at the cap. What is still unfilled after the chase and the usual 2-minute watch is
  canceled, as before. The spread is not checked while chasing.
- **Sales wait 10 minutes.** The bot's sales are re-priced at the bid every 5 s for up to
  10 minutes (`waitMs` on the sell; was 2). A remainder is tried again by the next exit check.
- **Exit checks every 10 seconds.** The service ticks the bot every 10 s (was 15), and the exit
  rules (the 10- and 20-minute checks, −30%, 15:50, the morning rule, the night cap, expiry day)
  run on every tick, in the minute now, with the stock's last trade (`BotMarket.lastPrices`,
  Alpaca `trades/latest`) and a fresh option quote. So a check fires at the start of its minute
  instead of after the minute closes, and −30% is seen within 10 s. Entries still need closed
  minute bars and run once per minute; the level watch (failed break) reads closed bars only.

## The t-stat exit (2026-10-24, the champion the user called)

On the entry day the bot keeps the signal's own statistic alive for each open position: the t-stat of the stock's
1-minute moves against SPY × beta, cumulative from the open (`cState` in signal.ts, the number that had to reach
`minT` 1.8 to enter), from the closed minutes. When it falls to `weaknessT` (0.5) or under in the bet's direction,
the stock has given back its edge over the market since the open and the bot sells all (reason `strength-gone`,
checked every tick with the other exits, before the +10 / +20 checks and the stop). Carried days are not touched.
Settings `sellOnWeakness` (default on) and `weaknessT` (0–1.5, step 0.1); version 2.2. A stock the bot no longer
watches has no prior data, so its position is not checked for this.

Backtest (`thesis.py` on research/indi-v2, all champion trades 2024–2026): champion $585,593 / 11% → $610,096 / 11%
at 1% ($2.44M → $2.65M at 21% at 2%), every year positive; unseen $123,028 → $122,679. With the failed-break sale
(the bot's rules) $526,469 / 10% → $549,153 / 9%. Wider stops with it (-35 / -40 / -50%), stock-price thesis stops
and stall rules were all worse (docs/research/best-algorithms.md on research/indi-v2).

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

The Portfolio → 🤖 Bot tab is read-only and shown to every signed-in user (only the Trade tab is
owner-only). It refreshes every 15 seconds and shows:

- status, settings and how long ago the bot last checked;
- **today's session**: a strip from the open to the close in Israel time with the entry window, the day
  exit, a mark per signal and a now line, plus what the bot is doing at this moment;
- a **funnel**: stocks watched → close to a signal (75%+ of both checks) → signals → bought;
- **what the bot sees**: a signal map with every stock placed by volume vs normal (x) and strength vs
  SPY (y, up for a call and down for a put), the two signal corners shaded, today's signals ringed and
  news-blocked stocks hollow; a tap shows the stock's two meters and what it still needs. Beside it, the
  stocks as rows with the same two meters, closest first;
- **holding**: each open position with its exits ahead (10- and 20-minute checks or the morning rule, the
  day exit, the standing −30% rule), each marked done, next or later;
- today's signals and their outcome, the activity feed (`bot_events`), closed trades and the rules.
- `GET /v1/bot` also carries `entries`, the signals that entered a position in the last five sessions, for a
  closed trade's story (docs/tasks/frontend-trade-story.md).

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
| `BOT_ALPACA_API_KEY` / `…_SECRET` | trader env, Worker  | The bot's own paper account (docs/tasks/backend-bot-account.md); unset: the owner's  |

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
- News filter (`feat/indi-bot-news-filter`), synthetic data in `tests/indi-bot.test.ts`:
  - reaction day before the open, after the close, on a weekend listing, and both causal no-time branches;
  - pre-market 4× blocks, under 4× passes, under 10 sessions of history passes;
  - a failed calendar or pre-market read fails open and says so in the feed;
  - a blocked stock gives no buy (live) and no "would buy" (dry run); a held position still exits on its
    reaction day;
  - contracts in words in the Bot tab ("Put 75 · 2DTE"), and the bars reader's seconds fix.
  - `npm run check` passes: 559 tests (558 pass, 1 skipped as before, 0 fail), formatting, types, builds.
  - Checked by hand: the Nasdaq endpoint answers with `data.rows[]` on a session date and `rows: null` on a
    weekend; the code handles both. Not checked: a real Alpaca pre-market read.
- Fixed on the same branch: `toSessionBars` read Alpaca's bar start (seconds) as milliseconds, so the live bot on
  `main` would get no bars and never signal. The runner tests use a fake market and could not see it.
- The Bot tab shows contracts in words (side, strike, calendar days to expiry from the trade or entry date) in the
  signals, holdings, closed trades and activity feed. Telegram posts keep "110 Call 10/23".
- Not verified yet: a real session (dry run), real fills, the Railway setup, and the Bot tab against the real
  service.
- V2 rules (`feat/indi-bot-v2-rules`), synthetic data in `tests/indi-bot.test.ts` and `tests/bot-settings.test.ts`:
  - t 1.8: the defaults are 1.8 / 1.5×; a slow climb signals at t 1.8–2 earlier than at 2; normal volume still
    gives nothing; `minT` 1.8 parses on the 0.1 step and a saved 2 still loads;
  - `nightCapPct`: default 8, range 0–25, not in `untested`; 0 sells nothing (unit and runner);
  - `nightCapSell`: the excess above the cap, the held part at most the cap, never more than the count;
  - runner, live: up 400% at 15:50 (33 × $3.00 = $9,900 > $8,000) sells exactly 7 ("Overnight cap"), holds 26
    ($7,800), and the morning rule sells the 26; with the account holding 30 it sells 4; under the cap (13) no
    cap sale;
  - runner, equity read fails at 15:50: caps with the warm-up's $100,000 (sells 7); no read all day: sells all
    33 with the reason and an error line, nothing held overnight;
  - runner, dry: the cap sale is a "would sell", no orders.
  - `npm run check` passes: 591 tests (590 pass, 1 skipped as before, 0 fail), formatting, types, builds.
  - Not run: `scripts/bot-parity.ts` at 1.8 (local data); a real 15:50 with a capped position.

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
- News filter: each source is read once a session; a failure leaves that filter off for the day (no retry). The
  Nasdaq calendar is an unofficial public endpoint and can change or block requests.
