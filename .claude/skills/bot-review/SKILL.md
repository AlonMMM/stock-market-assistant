---
name: bot-review
description: The day summary and the week summary of the live bots (the Indi bot and the Alert leg). Every live trade is checked against the backtest of the same day, the paper fills are priced again at the real market, the trade charts are read, and a conclusion is written. Use when the user asks for a day/week summary, a review of what the bots did, or "live vs backtest".
user-invocable: true
argument-hint: "day <YYYY-MM-DD> | week <first day> <last day>"
---

# Bot review: day and week

The output goes on the **Bot Live Review** page, https://claude.ai/artifact/U4VoWGfPQMEQeSFA4JFuzY. Each review is one
tab, with the newest first: `Day · <weekday> <d> <Mon>` or `Week · <d>–<d> <Mon>`. Read the page first
(`Artifact read`) and add the new tab to what is there. Charts are published files under `charts/`.

## Run (from the main checkout's root)

```bash
R=../sma-indi-backtest/scripts/research/indi_bt
$R/live_fetch.sh                                                     # live records, read-only (Railway logged in)
node --env-file=.env $R/run.mjs week.py <first> <last>               # Indi backtest, ~10 min a week (background)
node --env-file=.env $R/run.mjs live_review.py <first> <last>        # match, real prices, charts (background)
# -> data/local/x/review/<first>_<last>/review.json + <bot>_<day>_<sym>_<side>.png
```

A day review uses the same day for first and last. Never read `.env`; no orders, ever.

## What review.json holds

- `indi.trades` / `leg.trades`: each live trade with the paper fills, `real_buy` and the sales' `real` (the median
  exchange print from 60 s before to 120 s after the fill, else the recorded bid/ask mid, else the bar close: say
  which), `paper_ret` / `real_ret`, `backtest` (the matching backtest row, or none), `rewalk` (the backtest's exits on
  the live contract from the live minute).
- `backtest_only`: backtest trades the live bot did not take, with `on_list` (was the stock on the live list that
  morning). `backtest_skips`: the backtest's news and contract skips.
- The Alert leg's backtest: the live rules on the live Favorites, the first alert and again when flat, 2 a stock a
  day, **before** the 5-a-day / 3-open caps (say so when a day has more than 5).

## Write each review

1. **Verdict first:** one heading sentence (live P&L, real-price P&L, backtest P&L), then 2 lines on why.
2. **Four figures:** live paper P&L, the same trades at real prices, the backtest on the same list, signals → trades.
3. **Each live trade:** a card with its chart and the chips "backtest: same trade / other contract / no trade (why)"
   and "paper % · real %". **Look at the chart** (Read the PNG) and write what it shows: where the entry sat in the
   move (end of a spike, a pullback, a slow grind), the stock vs SPY × β, the volume, whether the stop or the exit
   came at a low, and what holding would have done.
4. **Backtest-only trades and skips:** a table, each with why live did not take it (not live yet, not on the list,
   a setting, a cap, a missed fill).
4b. **Alert leg section, always, live trades or not:** its own figures (with and without the live caps of 5 a day
   and 3 open, and which trades the caps drop), a table with each trade's 30-minute move, and its charts
   (`leg_*.png` live, `leg_bt_*.png` backtest: alert, side levels, best since the buy, give-back line). Read every
   chart: was the alert a climax bar, did the side pick the bounce or the continuation, was the exit a shake-out,
   and are any fills doubtful (sparse option prints, halts).
5. **Conclusions:** what matched, what the paper fills cost, and patterns seen in the charts. A pattern from a
   few trades is a **test to run** (`new-test` skill), never a rule; say so.

Rules: Israel time everywhere; label estimates (a bar close is an estimate); state the live version of the day
(the backtest is the champion rules, not each day's exact version); size like live (Indi 2%, Alert leg 1% of the
account); the overnight cap is 10%. In chat, send the link and 3–5 lines; the details belong on the page.
