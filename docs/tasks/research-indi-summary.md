# Summary: what @ultrawavetrader (Indi) does, 2023–2026

Status: done (2026-10-19). Final write-up of the trader study. Details, tables and method are in
[research-indi-2026.md](research-indi-2026.md); this page is the conclusion.

## In one paragraph

He buys short-dated, out-of-the-money options on a stock that is already beating SPY, about a minute
after it breaks a level (new day high/low, yesterday's high/low). He cuts a loser fast, at about −17% of
the premium within about 15 minutes, and lets a winner run. Only a quarter to a third of his trades win;
a handful of large overnight holds make each year. His entries are only a little better than chance at
picking direction; the edge is in how he exits and sizes. That much has been the same for four years.
Which entry becomes a big winner cannot be told at entry.

## What was studied

- **Trades:** every daily summary he posted on X from Jan 2023 to Oct 9 2026, transcribed by hand from
  his Order Book and Portfolio screenshots and checked against his Portfolio totals each day.
  About 1,600 option trades. Missing: Jan 2–30 2024, a few days without a summary.
- **Market data:** 1-minute bars for the stocks, SPY and (from Feb 2024) the option contracts.
- **His words:** 367 posts with his stated reasons (2026), 737 posts on risk (2022–2026).
- **Comparison:** each entry against 20 random minutes on the same stock, day and direction.
- Data stays outside Git (`data/local/x`); tools are in `scripts/research/` (see the detail doc).
- Trade Log page: https://claude.ai/artifact/Xxu7MtakANMEkBY3F6CUKC

## Results by year

| Year | Option trades | Win rate | Net P&L | Top 10 trades | Avg win / avg loss | Held overnight |
| ---- | ------------- | -------- | ------- | ------------- | ------------------ | -------------- |
| 2023 | 398           | 33%      | +$2.41M | +$2.97M       | +$39K / −$10K      | +$2.26M        |
| 2024 | 402           | 29%      | +$1.70M | +$2.75M       | +$52K / −$15K      | +$1.23M        |
| 2025 | 470           | 25%      | +$3.30M | +$4.36M       | +$82K / −$18K      | +$3.03M        |
| 2026 | 346           | 24%      | +$4.41M | +$6.62M       | +$133K / −$25K     | +$3.80M        |

(Main account, gross of commissions; 2024 without Jan 2–30; 2026 to Oct 9.) In every year the top 10
trades made more than the whole year: the other ~95% of trades lost money together.

The account went from $0.49M to $8.3M. Gross fills add up to about +$12.6M; the gap is commissions
(about $0.62 per contract, ~$2.2M), money set aside for taxes each January (~$1.6M in Jan 2026) and
about $0.9M not explained.

## How he enters

- **Stock already beating SPY** (adjusted for beta): 57–71% of entries vs 41–48% of random minutes.
- **Near the day's extreme in his direction** (top 20% of the range): 52–61% vs 35–39%.
- **On his side of VWAP:** 75–85% vs 65–67%.
- **Right after a level breaks:** first break of yesterday's high/low is 3.3–4.6× as common in the 10
  minutes before his entries as at random; a new day high/low 2.0–2.4×. He enters a median ~1 minute
  after the event; he chases, he does not wait for a pullback.
- About a fifth of his entries have no chart event at all.

These are tendencies, not a filter. Entries do not predict direction much better than chance, and no
entry feature separates winners from losers in more than one year.

## Which entries paid

Without each group's top 2 trades (so one lucky trade doesn't decide it):

| Entry type          | 2023    | 2024    | 2025    | 2026    |
| ------------------- | ------- | ------- | ------- | ------- |
| Breakout + strength | +$0.03M | +$0.10M | +$0.17M | +$0.16M |
| Breakout only       | −$0.03M | −$0.53M | −$0.27M | −$0.76M |
| Strength only       | −$0.01M | −$0.45M | −$0.30M | +$0.10M |
| No chart event      | +$0.25M | +$0.47M | −$0.44M | −$1.38M |
| Last 15 minutes     | −$0.21M | −$0.15M | −$0.14M | +$0.80M |

Only **breakout + strength vs SPY** stayed positive every year, with the best or near-best win rate
(30–38%). The margin is thin. The 2026 "end-of-day entries carry the year" finding was 2026 only.

## How he exits

- **Losers:** first sale at −16% to −18% of the premium after 14–17 minutes, about half the size;
  the rest when the stock stalls or turns. Same in all four years.
- **Winners:** almost never sold while the option is +25% to +100%; scaled out above +100%.
- **After his last sale** the options lost ~95% by expiry (2024–2026). His exits were right on average,
  although cut options often bounce first.
- **His stated reason to exit** is mostly the stock stalling ("stuck", "too calm"), then the stock
  turning, then rolling the strike. No stop orders: the premium is the stop.

## How he sizes (from his posts)

- Before buying, he decides how much of the premium is real risk: 50% a month out, 70% a week out,
  75–90% with 5–2 days left, 100% at 4 hours or less.
- Premium = account × risk % ÷ that share. Limits: 5% per trade / 7% per day at account highs; cut to
  2% / 3% after a drawdown (25%, 12.5% from 2025) or two daily stops in a row; back up in steps as he
  recovers.
- Never add money to a loser; a roll is paid from what is left. Sell a third to cover. Expect to lose
  half a premium 5–8 times for one 4–5× winner. Beginners: at most 2% per options trade.

## The rules

What held in all four years and could be copied:

1. Enter on a breakout (new day high/low or yesterday's level) in a stock already beating SPY, about a
   minute after it.
2. Cut a loser at about −17% within about 15 minutes, half first, the rest when the stock stalls.
3. Let a winner run while it is +25% to +100%; scale out above that. Never add to a loser.
4. Size so a full loss of the premium fits the risk budget; cut the budget after a drawdown.
5. Expect few winners (24–33%) that are 4–6× the losers; a few overnight holds make the year.

What cannot be copied: knowing at entry which trade will be one of the few big winners. Dropped as
not repeating: the last-15-minute entry, and every winner-vs-loser entry filter.

## Related studies in this repo

- His 182 entries from a spreadsheet (2024–2026, branch `research/alert-tuning`, commit cad5fe3): same
  entry profile; options fairly priced; a −40% stop plus target ≈ break-even.
- Alert studies: big-move signals ≈3× as likely before big moves, but no direction edge.

## Limits

One trader. P&L is dominated by a few trades, so most yearly figures move a lot with one trade.
Exploratory: many comparisons, no correction for that. Fills inferred for rows hidden in screenshots.
Options left after expiry with no sale are taken as worth 0. 2023 has no option price data.
Index options are measured on SPY/QQQ.

## If this continues

Backtest rules 1–3 on 2024–2025 option bars and check on 2026 as unseen data, with real spreads and
$0.62 per contract. Only then would an alert or a trading rule be worth building.
