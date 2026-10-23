---
name: bot-backtest
description: Run a backtest or replay of the Indi options bot - what it would have bought on past days (Python research backtest), a full end-to-end replay of the live TypeScript bot on a past session, or a test of a new rule against the champion. Use when asked to backtest the bot, replay a day/week/months, check what the bot would have bought, compare the bot with the backtest, or test a new algorithm idea.
---

# Backtesting the Indi bot

The bot copies the trader Indi (@ultrawavetrader). The goal is to get **close to Indi**, not beat him.
Report results as the gap to him, and log every test (see "Logging a test").

There are three tools. Pick by the question:

| Question                                                                    | Tool                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| "What would the bot have bought on <days>?" / "run it on the last N months" | **A. Python replay** (`week.py`)                     |
| "Does a new rule beat the champion?"                                        | **B. Python research backtest** (fair list + unseen) |
| "Does the live code do what the backtest says?" / "test it end to end"      | **C. E2E replay** (`scripts/bot-replay.ts`)          |

## Ground rules

- **Never read `.env`.** Scripts get the Alpaca keys with `node --env-file=.env ...`.
- **No orders, ever.** Backtests and replays never touch a broker account. The E2E replay uses the in-memory `SimBroker`.
- Never short options: any sell in new code is close-only and never more than held.
- Show every time to the user in **Israel time** (NY + 7h, except the weeks around the DST changes).
- Label synthetic data as synthetic (the E2E replay's option bid/ask are synthetic, see C).
- Local data (`data/local/x/...`) and account data stay out of Git.

## Where things are

- Research code: branch `research/indi-v2`, folder `scripts/research/indi_bt/`. The local worktree is usually
  `~/Desktop/Personal/sma-indi-backtest` (`git worktree list` to find it).
- Bar cache (not in Git): `data/local/x/bt/market.sqlite` in the **main checkout**
  (`~/Desktop/Personal/stock-market-assistant`). Run every Python script **from the main checkout's root**, or the
  cache paths break.
- Results log: `docs/research/best-algorithms.md` on `research/indi-v2`. It defines the champion and what "better" means.
- Live bot: `apps/trader/src/bot.ts` (runner), `packages/trading/src/bot/` (signal, picker, exits, news, settings),
  `config/bot-universe.json` (Indi's 35-stock core list).

## The champion (as of 2026-10-22)

- Signal C: t-stat of 1-minute moves vs SPY × beta ≥ **1.8**, day volume ≥ **1.5×** normal, from 09:40 NY (16:40 Israel).
- News filter: no entry on the earnings reaction day, or with pre-market volume ≥ 4× normal.
- Contract: delta **0.15**, nearest expiry 1-7 days, min $0.20, ≥ 200 contracts traded in the last 30 minutes.
- Exits ("your stop"): sell half at +10 min and the rest at +20 min if the stock is against the entry; sell all at
  -30% with the stock against. At 15:50 NY, hold winners ≥ +100% overnight (max 2 nights); morning gap rule at 09:40.
- Python name: rule `t18r15` with `nf` news filter; trade files `data/local/x/bt/s_t18r15_20*.[0-9]_trades.csv`.
- Reference result, fair list at 1%: $585,592 / 11% worst drop; at 2%: $2,444,629 / 21%; unseen stocks: $123,028.

## A. Python replay of recent days (`week.py`)

What the champion would have bought on the bot's watchlist (core list from `origin/main:config/bot-universe.json`
plus the favorites in `params.json` `universe_fav`). It fetches missing bars first.

```bash
cd ~/Desktop/Personal/stock-market-assistant
node --env-file=.env <worktree>/scripts/research/indi_bt/run.mjs week.py <first day> <last day>
# -> data/local/x/bt/week_<first>_<last>.json
```

- Long ranges take a while (option bars are fetched per signal): run in the background, one week ≈ 10 min,
  5 months ≈ 30+ min.
- Each row has `status`: `bought`, `skipped: earnings reaction day`, `skipped: pre-market volume …`,
  `no contract: illiquid | too_cheap | no_expiry | no_prices`, `no fill`.
- Bought rows have `ret` (fraction, after all exits), `steps` (`date minute side share @price rule`), `contract`,
  `cost`, `list` (`core` / `favorites`).
- Account math: compound at 1% or 2% of the **start-of-day** equity from $100,000, `pnl = pct * equity * max(-1, ret)`.
  Report: end equity, worst drop, by-month P&L, winners/trades, the biggest winners, skip counts, core vs favorites.
- A day that hasn't closed yet (or the current day before 16:00 NY) has no data; say so.
- Entry minute → Israel time: `16:30 + minute` (in the usual DST overlap).

## B. Testing a new rule against the champion

1. Start from `docs/research/best-algorithms.md`: read the champion row and the definition of "better":
   fair list higher (or the same with a smaller drop), **every year positive**, no worse on the **151 unseen
   stocks**, and not tuned on the judging result.
2. Write the test as a new script in `scripts/research/indi_bt/` next to the similar ones (e.g. `night_risk.py`,
   `roll2.py`, `iv_cap.py`, `scale_in.py` are good templates). Reuse:
   - `sim.walk(und, date, minute, right, sym, exp, cal)` → (cost, steps, flag); `sim.pick(...)` for the contract;
     `sim.X` exit params, `sim.C` contract params; `sim.X.update(dict(H, **NIGHT))` for the champion exits
     (`from tiers_round import H, NIGHT`). Merge dicts with `{**a, **b}`, not `dict(a, **b, **c)` (duplicate keys fail).
   - `news_filter.features(T)` then `t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)`.
   - Lists: fair list = `t["sym"] in HIS40 and t["sym"] in PRIOR[t["date"][:4]]`, unseen = `t["sym"] not in HIS40`
     (`from low_delta import HIS40, PRIOR`).
   - `score_sum.account(rows, pct)` → (end equity, worst drop).
   - Scripts that fetch data run through `node --env-file=.env <worktree>/scripts/research/indi_bt/run.mjs <script.py>`.
3. Report a table: version | per-trade average by year 2024/2025/2026 | at 1% | at 2% | unseen. Compare to the
   champion re-walked by the same script (later data fetches can move it slightly).
4. Known simulator gap: on a carried day with no option bar at or after minute 380, the 15:50 rule does not fire
   (ORCL 2026-04-13). Mention it if a result leans on such a trade.

## C. End-to-end replay of the live bot (`scripts/bot-replay.ts`)

Runs a past session through the **real** `IndiBot`, `TraderService` and `TradeEngine` (ladder pricing, short checks,
stops, Telegram posts) on the in-memory `SimBroker`, on a clock that moves one minute at a time.

```bash
cd <checkout of main or the branch that has the script>
BOT_REPLAY_FAVORITES="NVDA,META,..." \
  node --env-file=<main checkout>/.env --import tsx scripts/bot-replay.ts <YYYY-MM-DD> <report.md>
```

- Data: stock 1-minute bars (SIP), pre-market volume and the Nasdaq earnings calendar are the recorded data the
  live bot reads. Option quotes are **synthetic**: the last complete 1-minute option bar's close -/+ 2%
  (the backtest's fill cost), delta by Black-Scholes; a buy fills at the ladder's ceiling (85% of mid → ask),
  a sale at the bid. Alpaca has no historical option quotes, so this is the closest model.
- `BOT_REPLAY_FAVORITES` (optional) is the favorites list the site would send; without it only the core list.
  Use the **app's** "Favorites" watchlist: it is what the live bot receives every morning. Read it (read-only)
  from the site's D1 database, from a checkout with Wrangler logged in (takes ~1-2 minutes):

  ```bash
  npx wrangler@4 d1 execute sma-bars-cache --remote --json --command \
    "SELECT w.name, group_concat(s.ticker, ',') AS tickers FROM watchlists w LEFT JOIN (SELECT * FROM watchlist_symbols ORDER BY position) s ON s.watchlist_id = w.id GROUP BY w.id ORDER BY w.position" > lists.json
  ```

  The bot takes the list named `BOT_WATCHLIST` (worker env), else the first own list whose name contains
  "fav" (`favoritesList` in `packages/trading/src/bot-api.ts`). The IBKR paper account's "Favorites" watchlists
  (IBKR connector `get_watchlists` / `get_watchlist`) are a different, shorter list; use them only when asked,
  and leave out SPY and futures (CL, GC, SI), which the bot never watches.
  The bot uses its default settings (t 1.8, 2% size, 10% night cap), not the owner's saved ones.

- The report has the bot's feed (signals, skips and why, orders), the Telegram posts, the positions and the
  end account. A trade held overnight stays open unless the next session is replayed too.
- Compare with A for the same day: the same signals (stock, side, minute) are expected; fills differ a little
  (ladder vs bar price). The broker's -50% safety stop can sell before the bot's rules when the stock is not
  against the entry; the replay does not post that fill to Telegram (the live service does).
- One day takes ~5 minutes (it calls Alpaca every minute of the session).

Parity checks of single parts also exist: `scripts/bot-parity.ts` (signal vs the Python signal files) and
`scripts/bot-exit-parity.ts` (exits).

## Logging a test

- Every test goes in `docs/research/best-algorithms.md` (what was tried, the numbers, the verdict).
- If a version **beats the champion** by the rule above: log it, start the reply with a big **🏆 NEW CHAMPION**
  banner, send a push notification, and add it as the **default version** of the Bot vs Indi dashboard
  (https://claude.ai/artifact/34CHCtYWPgexzP51zze9vV; trades/paths/bars datasets, `export.py` on research/indi-v2).
  A partial win (fair list only, or one year negative) is a "candidate": log it, no banner.
- Commit research scripts on `research/indi-v2` and push as AlonMMM
  (`GH_TOKEN=$(gh auth token --user AlonMMM)`).
