# Backtest: his rules without his judgement

Status: in progress (2026-10-19). Follows [research-indi-summary.md](research-indi-summary.md).
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

## Results

Pending.
