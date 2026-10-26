---
name: backtest-report
description: How to show any backtest result in this project (a watchlist test, a new entry or exit rule, a parameter sweep, a period re-run). Use whenever a backtest finishes or the user asks to see, compare or report backtest results. Results always go to the Backtest Reports dashboard in the Bot vs Indi format, plus a short fixed-shape summary in chat; never a loose table in chat alone.
user-invocable: true
argument-hint: "[study name] [first day] [last day]"
---

# Backtest report

Every backtest result in this project is shown the same way, so results from different days and sessions can be
read against each other. Two outputs, always both:

1. **The Backtest Reports dashboard** — https://claude.ai/artifact/C2bvuRCGY8LSLbVB4Ma7QC (a Dashboard-type artifact; the earlier copy XCbzBbPgumnDYLXq5dq5XY stopped refreshing for the user on 2026-10-24 and is retired,
   written through its store with `ArtifactData`). One study = one set of rows tagged with the study's `list`/`version`
   slug, so the page's picker shows it next to the earlier studies. The champion itself lives on the Bot vs Indi page,
   https://claude.ai/artifact/34CHCtYWPgexzP51zze9vV; a new champion also goes there (see the `new-champion-signal` memory).
2. **A chat summary in the fixed shape below**, with the dashboard link first.

## The fixed shape

The same seven figures, in this order, for each version or list, always at $100,000 start and the account sizing
(each trade costs 1% of the account at the start of its day; 2% as the second column where room allows):

| Figure | Why it is there |
|---|---|
| Signals → news filter → no contract → trades | the funnel: how much of the idea is tradeable at all |
| Trades, winners (%) | the hit rate; the champion is 15–20%, so a result on under ~100 trades is noise |
| Per trade at $10K | comparable across sizes and periods |
| Account at 1% (and 2%), return | the headline, from $100,000; with the overnight cap (10% of the account) at that size: `ret` is the 1% return, `ret_2pct` the 2% one, never the 1% return sized at 2% |
| Worst drop from a high | the risk |
| **Without the best 5 trades**: per trade and account | the overfitting check; the money is always a few trades |
| By stock: P&L, trades, winners, in his 40 or not | where the money came from, and whether from stocks the rules were tuned on |

Then, for every study:
- **The in-sample warning, in one line.** The rules were chosen after seeing Feb 2024 – Oct 2026 on Indi's 40 stocks.
  Any window inside that is in-sample in time; the core list and 24 of the favorites are in-sample in stocks. Say which
  applies. Only paper trading from here is a clean test.
- **A champion comparison** when the study changes a rule: fair list ($585,592 / 11% as of 2026-10-22) and the 151 unseen
  ($123,028 / 11%), every year positive; see `docs/research/best-algorithms.md` in the research checkout for the bar
  and the log of everything already tried.
- The best 5 trades by name, so the reader can see what the result rests on.

Never show a result as a percent of price without normalising to the stock (the user's rule): moves are in the
stock's own sigma (the spread of its 1-minute excess moves vs SPY × beta) or in IV units, never "2%".

## How to produce it

All from the main repo root (`stock-market-assistant`), scripts in the research checkout `../sma-indi-backtest/scripts/research/indi_bt/`:

```
# a watchlist or any symbol list, champion rules, a date range
node --env-file=.env ../sma-indi-backtest/scripts/research/indi_bt/run.mjs lists.py run <A> <Z> <slug> SYM1,SYM2,...
python3 ../sma-indi-backtest/scripts/research/indi_bt/lists.py summary <A> <Z> <slug> [...]        # the chat figures
python3 ../sma-indi-backtest/scripts/research/indi_bt/export_lists.py <A> <Z> <slug> [...]         # -> data/local/x/bt/viz_lists/
```

`export_lists.py` writes the four files the dashboard reads: `trades.csv` (one row per trade, with `list`, `key`, IV,
return, exit words, overnight), `funnel.csv` (per list: signals, skipped, no_contract, no_fill, bought), `bars.csv`
(5-minute closes of the stock and SPY on the day before and the trade day) and `paths.csv` (fills and the option's
5-minute path). Always export **every** study together so the files hold all lists; then:

1. Upload each CSV as an asset (`Artifact` publish with `asset: true`, one call per CSV).
2. `ArtifactData` batch: update `datasets/trades|funnel|bars|paths` with the new `/_blob/<id>` url and `updated.at`
   (pin `if_version`). Then delete the replaced assets.
3. Read `data/users/me/check` once or twice; fix only what it confirms.
4. New list slug → add its display name to `LIST_NAMES` in `files/index.html` and the "The lists" card.

For a rule study (not a list): the chat summary carries the champion comparison table (fair list and 151 unseen, from
`second_entry.py summary` or the study's own summary), and the result is logged the same day in
`docs/research/best-algorithms.md` in the research checkout: a winner in the Champion table and the Log (then the
`new-champion-signal` memory applies), a loser as one entry under "Tested, not better" with its numbers against the
champion. Its trades go on the dashboard as a `list` slug named for the version (e.g. `se60`) only when it wins or the
user wants to browse them; a study on a different period than the lists on the page says so in its "How it works" card.

## The page

`files/index.html` is the Bot vs Indi layout: a sticky control bar (tabs Overview / Trades / By stock / How it works, a
list picker, a 1% / 2% size switch), KPI tiles, the account curve with every list on it (chosen list in full, others
muted), the lists side-by-side table, every trade as steps with P&L bars, the sortable and searchable trade table, and
the trade window (paid → got back, the fills as numbered steps, the two-day chart with SPY scaled to the same start
and the option against what was paid). Keep that structure; add a card, don't restyle. Phone width works: tabs scroll,
the date column sticks, tooltips open on tap.

## Don'ts

- No result only in chat, no screenshots instead of the dashboard, no new dashboard per study.
- No account figure without "without the best 5" next to it.
- No comparison across different periods, sizes or fill models without saying so.
