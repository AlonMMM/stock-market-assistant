# Backtest: his rules without his judgement

Status: done for the backtest stage (2026-10-21); next is paper trading. Follows [research-indi-summary.md](research-indi-summary.md).
Question: do the rules that held in all four years make money when applied mechanically, with no
discretion about which signal becomes a big winner? Research only; nothing places orders.

## Data

- Alpaca read-only market data: 1-min SIP stock bars, 1-min option bars for any contract, and the
  lists of listed (also expired) contracts. Option data starts Feb 2024, so 2023 is not tested.
- No historical bid/ask. Fills are the bar middle (high+low)/2 ± 2%, measured from his own fills:
  his buys were +1.8% and his sells −1.9% from the same minute's bar middle (4,561 fills, 2024–2026).
  Every result is also shown at ± 4%. Commission $0.62 per contract.
- Some days have no option bars at all (e.g. 2024-02-02); signals then are "no_prices", not filled.
- Cache in `data/local/x/bt/market.sqlite` (not in Git).

## Rules (all numbers in `scripts/research/indi_bt/params.json`)

- **Stocks:** his 40 most-traded single stocks in 2024–2025 (no index options, no macro ETFs).
- **Entry:** in the last 5 minutes a breakout (new day extreme, first opening-range break or first
  break of yesterday's high/low) and a 5-min move vs SPY×β ≥ +0.5%; on the bet side of VWAP, in the
  top 20% of the day range, beating SPY×β since the open by ≥ 1% and over 15 minutes by ≥ 0.25%
  (his medians, 2024–2025); 09:45–15:44 (his opening entries lost in every year). First such minute,
  one per stock per day; filled on the next option bar.
- **Contract:** nearest expiry 1–7 days out, strike with delta closest to 0.15 (his entries 2024–2026:
  median 0.17, middle half 0.14–0.22); skipped when under $0.20 or under 200 contracts in 30 minutes.
- **Size:** 2% risk per trade: premium = equity × 2% ÷ real-risk share of the expiry (70% at 7 days …
  100% on the last day); at most 3 open; at most 10% of the contract's last-30-min volume. Also every
  signal at a fixed $10K.
- **Loser:** −17% sell half; then below cost and the stock stalls 10 min or drops 0.3% vs SPY in 5 min,
  sell the rest; −50% sell all.
- **Winner:** after +25%, back to cost sells all; +100% and +200% sell a third each; the rest at 40% off
  the peak or 20 min without a new stock extreme.
- **Overnight:** at 15:50 carry only with ≥ +25%, stock at ≥ 0.9 of the day range, not Friday, ≥ 2 days
  to expiry. Next day 09:40: gap ≥ +0.5% his way sells half, otherwise all. Expiry day: out by 15:30.

## Test

- Rules and filters set on Feb 2024–Dec 2025 only. Before 2026 is run, `params.json` is committed and
  not changed again; 2026 (to Oct 9) is run once.
- Controls with the same exits: random minutes on the same stock, day and direction; his own entries
  (his contract and minute).
- **Pass:** 2026 positive after ± 4% fills, positive without the best 5 trades, and better than the
  random-minute control. Otherwise the rules fail and that is the result.

## Run

```
node --env-file=.env scripts/research/indi_bt/run.mjs fetch_stocks.py 2024-01-02 2026-10-12
python3 scripts/research/indi_bt/signals.py 2024-02-01 2025-12-31
node --env-file=.env scripts/research/indi_bt/run.mjs sim.py <signals.csv> data/local/x/bt/bot
python3 scripts/research/indi_bt/report.py data/local/x/bt/bot
python3 scripts/research/indi_bt/controls.py random|his ...
```

## Results (2026-10-21)

Full report with charts and every test: https://claude.ai/code/artifact/50f7263c-8a6a-4b52-b798-9ee70c5c40d7
(tab "Backtest: every test"). Bot vs Indi page with every trade: https://claude.ai/artifact/34CHCtYWPgexzP51zze9vV.
Per trade = P&L at $10K a trade. Goal: get close to his results, not beat them.

### 1. The breakout rules above and the C/B/A tiers

- The rules above did not pass on 2026. They were replaced by the tier signals: C = steady strength vs SPY×β
  (t-stat of 1-min excess moves ≥ 2, from 09:40) + day volume ≥ 1.5× normal; B = C + a 15-min burst, the day
  extreme or beyond yesterday; A = all five. Exit: your stop (half at 10 min and the rest at 20 min if the stock
  is against the entry, all out at −30%), sold at 15:50.
- Flat 1% C entries were the best of the round: per trade +$1,115 / −$134 / +$151 (2024 / 2025 / 2026).
  Tiers, adds and rolls added swings, not edge. Day volume 1.1× and 2× were worse than 1.5×. 191 stocks
  diluted it. Copies of his setups (trend pause, big mover, end-of-day hold) and a "would he trade this
  stock" model all failed.

### 2. Where the gap to him comes from

- His entries under our exit: +$744 / +$682 / +$1,492. His own management: +$833 / +$840 / +$2,043.
  In 2025–26 the entry is about 75% of the gap per trade, the exit about 25%.
- His exits: he cuts losers fast (76% the same day, median −20% after 27 min). On 47 trades whose first sale
  came at +200% or more he sold a quarter and let the rest run to a median +315%: $11.1M, 60% of his winning
  money. Same-day trades tie with our exit; his overnight holds are where he is better.
- Exit halves on his entries: your stop beats his-style cut on the loss side. On the profit side, holding a
  winner up ≥ +100% at 15:50 overnight was best (+$1,230 a trade in 2025–26 vs his +$1,338); early profit
  taking was worst.

### 3. Context of his entries (993 entries, 2023–Oct 2026, vs 35,709 stock-days)

- Busiest on news days (first day after earnings 3.6×, pre-market volume ≥ 4× 2.3×, big gaps), but his money
  comes from quiet opens in a calm market where one stock moves on its own. Avoids the days before earnings.
  Calls far better than puts; repeats within 5 days and very jumpy stocks are weak.
- A sector filter (skip when the sector ETF or peers move ≥ 0.5% against the bet) fixed the bot on the 40
  stocks but failed on 151 unseen stocks; dropped.

### 4. The overnight hold on the bot, contract delta, liquidity, sizing

- Overnight hold (your stop; at 15:50 hold winners up ≥ +100%; next morning 09:40 sell half on a gap our way,
  else all): bot flat C entries become positive every year on the 40 and on 191 stocks. The gain rests on about
  12 trades in three years; without the best 5 a year it still loses.
- Delta: on the same 466 trades every delta could take, selling at 15:50 makes about +$450–525 a trade at any
  delta; the help comes from trading only where the cheap options are busy. With the hold, lower delta makes
  more and rests more on a few trades.
- The 151 stocks outside his 40 lose with every version: the edge sits in his kind of stocks.
- Fair stock list (each year only the stocks he traded the year before, so no look-ahead), overnight hold,
  1% of the current account from $100,000, Feb 2024 – Oct 2026:

| Delta | 2024 | 2025 | 2026 | End | Worst drop | At 5% cost each way |
| ----- | ---- | ---- | ---- | --- | ---------- | ------------------- |
| 0.10 | +58% | +77% | +77% | $495,349 | 23% | $312,418, positive every year |
| 0.15 | +33% | +34% | +44% | $257,698 | 26% | $152,776 |
| 0.20 | +21% | +12% | +21% | $163,356 | 26% | $91,394 |
| 0.25 | +6% | +12% | +11% | $132,565 | 21% | loses |
| Indi, his own trades | +22% | +25% | +45% | $220,836 | 11% | |

- At 2% a trade: delta 0.10 ends at $1.63M with a 41% worst drop, 0.15 at $499K with 46%, Indi at $433K with 21%.
- Costs: the backtest pays the bar middle ± 2%, which matched his own fills (+1.8% / −1.9%). Cheap options can
  cost more; delta 0.10 stayed positive every year even at 10% each way, 0.15–0.25 did not.

### Caveats

- These versions were chosen after seeing 2024–26, so no further backtest can confirm them; paper trading is the test.
- No historical bid/ask; morning fills after an overnight hold are not checked against real quotes.
- Results rest on a few large overnight winners; drawdowns are about twice his at the same size.

### Candidate for paper trading

Universe: stocks he traded in the past year. Entry: the C signal (steady strength vs SPY×β, day volume ≥ 1.5×),
one per stock per day, 09:40–15:44. Contract: nearest expiry 1–7 days, delta 0.10 (alternative 0.15), skip under
$0.20 or under 200 contracts in 30 minutes; buy only, never short. Exit: your stop, then the overnight hold.
Size: 1% of the current account per trade; 2% only after paper results hold.

### Scripts (`scripts/research/indi_bt/`)

tiers_round.py (runs: flat, flat_n100, flat_d*, flat_n100_d*), his_vs_ours.py, his_exit_profile.py,
his_exit_mix.py, context.py, sector_filter.py, liq_filter.py, low_delta.py, delta_sum.py, earnings.py,
fetch_context.py.
