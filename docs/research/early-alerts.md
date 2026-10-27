# Early-sign alerts: how to use them in a backtest

Instructions for a session that backtests a bot (the volume bot first) on the
early-sign alerts instead of the bot's built-in volume alert. Study background:
the "Fast volume alerts" and "Early signs" work of 2026-10-27, branch
`research/early-rules`.

## The task

Run the volume bot backtest once per alert source and compare each with today's
rule (`A`) on the same days, stocks and bot settings. Only the alert source
changes; every other bot rule stays as it is. Do not change the live bot.

Sources, in this order:

| `rule` value           | What it is                                                                             | Alerts/day (66 stocks) |
| ---------------------- | -------------------------------------------------------------------------------------- | ---------------------- |
| `A`                    | Today's live rule (rvol-v6): 3 closed minutes, volume >= 4x, move >= 3x. The baseline. | ~22                    |
| `3 steady + 6 range`   | Steady burst AND range expansion within 2 minutes                                      | ~61                    |
| `6 range + 4 no block` | Range expansion AND the fast rule without one-print bursts, within 2 minutes           | ~50                    |
| `F60x2` (optional)     | Rolling 60 s, volume >= 2x, every 10 s. Most early catches, most noise                 | ~252                   |

What the alert study found (stock prices only, no options):

- The combinations catch more of the biggest moves, and earlier, than `A`. Per
  alert, the 60-minute move that follows is about the same as `A`'s.
- No direction method beat a random side. The alerts say "a big move is likely",
  not which way, so they suit a bot that does not need the direction.

Expect more trades than `A` (about 1.5-1.7x the stock-days). The open question
is whether earlier entries buy cheaper options. Only this backtest can answer it.

## The file

`/Users/alonmo/Desktop/Personal/stock-market-assistant/data/local/early_alerts.csv`
(local only, not in Git, about 34 MB). One row per alert:

| Column    | Meaning                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `rule`    | Alert source (see above). The file also holds the other single rules and, for `tune` only, every two-rule pair. |
| `period`  | `tune` = 2025-11-21 .. 2026-05-29, `check` = 2026-06-01 .. 2026-10-22 (the alert study's own split)             |
| `symbol`  | One of the 66 Favorites that have 10-s data (AMBA, GLD, UAL are missing)                                        |
| `date`    | New York date                                                                                                   |
| `time_ny` | New York time the alert is known: the END of its 10-s slot                                                      |
| `slot`    | 10-s slot of the regular session, 0 = 09:30:00-09:30:10                                                         |

Read it with `csv` or pandas and filter on `rule`:

```python
import pandas as pd
alerts = pd.read_csv("data/local/early_alerts.csv")
src = alerts[alerts.rule == "3 steady + 6 range"]
```

## Rules for using it

1. Enter only after `time_ny`. With 1-minute bars, the honest first fill is the
   open of the minute that starts after `time_ny`. Example: alert at 10:31:20,
   so enter at the 10:32 bar's open. Do not use the bar that contains the alert;
   its close comes after the alert and holds future prices. If the bot already
   models fills inside the minute, start at `time_ny` plus its fill delay. Say
   which you used.
2. Option prices under a minute don't exist. Entries inside a minute are priced
   from the minute data (about +/-2-6% off). Say so in the result.
3. Map each alert to the bot's own signal. The bot's built-in alert takes the
   first minute of the day its condition holds, with no cooldown, and up to 2
   trades a stock a day. In this file `A` has the live 120-minute cooldown and
   every other source a 30-minute cooldown. Apply the bot's own trades-per-day
   limit on top. Run `A` from this file as the baseline, not the bot's built-in
   alert, so the cooldown difference doesn't skew the comparison. Report the
   built-in result next to it as a reference.
4. Keep the bot's other settings and the standing rules: the cost model (fees
   both ways plus the fill correction already in the simulator), the 10%
   overnight cap, never short an option, and moves in sigma/IV units. Read the
   live settings and reproduce the baseline before testing (see the
   `bot-backtest` and `new-test` skills).
5. Periods: the file covers 2025-11-21 .. 2026-10-22 only, regular hours only.
   Follow the `new-test` skill's split (tune on even entry weeks, check once on
   odd weeks) inside that range. Warn about one thing: these alert rules were
   chosen with the alert study's `check` period (Jun-Oct 2026) in view, so that
   part of the range is not fully unseen for the alert choice.
6. No look-ahead fields are in the file. Don't join anything computed after
   `time_ny`.

## How to report

- Use the `backtest-report` skill: Backtest Reports dashboard plus the fixed chat
  summary, one row per alert source.
- Also give, per source, the return-per-trade table in the same shape as the
  current test: buckets -100..-80% up to +500% and up, then the trades and P&L
  of losers, winners and net. Put `A` and each new source side by side.
- Add trades/day, average P&L per trade, and the result without the best 5
  trades.

## Rebuilding the file

The scripts are on branch `research/early-rules` and need the local 10-s data
(`data/local/bars-10s.sqlite`):

```bash
python3 -I scripts/research/early_rules.py --split tune  --tickers <favorites.txt> --out er_tune.json
python3 -I scripts/research/early_rules.py --split check --tickers <favorites.txt> --out er_check.json
python3 -I scripts/research/combo_states.py --split tune  --tickers <favorites.txt> --out cs_tune.json
python3 -I scripts/research/combo_states.py --split check --tickers <favorites.txt> --out cs_check.json \
    --pairs "3 steady|8 vs SPY,6 range|4 no block,3 steady|6 range"
python3 -I scripts/research/export_alerts.py --runs er_tune.json,er_check.json,cs_tune.json,cs_check.json \
    --out data/local/early_alerts.csv
```

`<favorites.txt>` holds the 66 symbols, one per line: the live bot's Favorites
(`data/local/x/review/live/bot.json` → `favorites.tickers`) minus AMBA, GLD
and UAL. New days after 2026-10-22 need `npm run bars:10s -- --from ... --to ...`
first, then these steps with a new date split.
