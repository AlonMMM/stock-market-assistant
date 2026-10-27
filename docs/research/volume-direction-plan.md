# The Volume bot: a plan for a clearer direction (2026-10-27)

## Where we start

- The alerts do find moves: after 79% of the top-50 alerts (9,305 of 11,846 with a side, 3 years) the stock moves
  1 x S30 within 30 minutes of the buy.
- The direction is a coin flip: the live side rule (the first 0.25 x S30 cross, per second) names the side of that
  move 49.7% of the time (2024 50.7%, 2025 49.5%, 2026 48.9%). `dir_label.py`.
- The losses are the wrong-side trades: 47% of trades are out within 10 minutes at about -30%; the trades that
  survive 15 minutes make money on average. The bigger side line and a wider early give-back only add about a point.

So every idea below is first judged on one number: how often it names the side of the next 1 x S30 move.

## How each idea is judged

1. **The direction scorecard (cheap, stock prices only).** For every top-50 alert: the label (the side the stock moves
   1 x S30 first within 30 minutes, `dir_label.py`), and the idea's side or "no trade". Report: % right, how many
   alerts it covers, and a t-stat against 50%. Two uses for each idea: pick the side, or skip the alert when it
   disagrees with the live side.
2. **Split.** Tune on Feb 2024 - Jun 2025, check once on Jul 2025 - Oct 2026. An idea passes when it is right
   55% or more on the check months, t >= 2, on at least a third of the alerts.
3. **Only passing ideas go to the option backtest** (`leg_seconds.py`, real bid/ask, top 50, 3 years), compared with
   the baseline (-9.1% a trade) and with the best version so far (0.5 side line + 1.25x give-back for 5 minutes,
   -8.0%; top 15 +5.0%).

## Phase 1: from data we have (minute bars, 1-second stock windows, SPY and sector ETFs)

| # | Idea | How it is measured |
|---|---|---|
| 4 | Already stretched: fade it | Move since the open and from yesterday's close in S30 units at the alert, at or near the day's high/low. Above k (2, 3, 4) take the opposite side; inside the range follow it. |
| 6 | Time of day | The scorecard by part of the day: 09:40-10:00, 10:00-11:00, 11:00-13:00. Fade or follow per part. |
| 5 | Key levels | Distance to yesterday's high/low, the opening range (first 15 minutes) and the nearest round number, in S30 units. Breaks vs turns back. |
| 7 | The sector moves with it | SMH/SOXX (chips), IGV (software), XLK, XLF, XLE, XBI, IWM, QQQ; or the 3 most correlated peers in the top 50 (60-day minute returns). Same side within the alert minute = confirm; opposite or flat = skip. |
| 8 | A peer moved first | A peer's own alert or a 1 x S30 move 1-5 minutes before, on the same side. |
| 10 | Two waiting orders | Buy stop above the alert minute's high + room, sell stop below its low - room (room 0.1-0.25 x S30); first fill is the side; none in 10 minutes = no trade. Today's rule is the same idea around the alert price, so this tests the burst's range as the line. |
| 11 | Burst, pause, hold | After the burst, a pullback of under half the move that holds 2-5 minutes, then follow the burst's side; more than half given back = skip. |

Sector ETF minute bars (market.sqlite): SMH, XLK, XBI, ARKK to 2026-10-12, SOXX, IGV, IWM, QQQ, SPY to 2026-10-26,
XLE/XLF from 2024. Refresh to 2026-10-26 first.

## Phase 2: who is buying or selling (new data, cheap)

Databento EQUS.MINI `tbbo` (every trade with the bid/ask just before it) and `mbp-1` (the top of the book with
sizes), from 2023-03-28, for 2 minutes from each alert: about $0.0002 a window, under $5 for every top-50 alert.
This replaces the Alpaca REST fetch in the list: same data, from the source we already use, back to 2023.

| # | Idea | How it is measured |
|---|---|---|
| 1 | Trades at the ask vs at the bid | Signed volume (at or above the ask = buy, at or below the bid = sell, inside = by the nearer side) over 10, 30 and 60 s after the alert. Net side = the side; also a minimum imbalance (60/40, 70/30) with "no trade" in between. |
| 2 | Bid vs ask size | Size imbalance (bid size - ask size) / (sum) at the alert and averaged over 30 s; is the ask eaten (falls) or refilled. |
| 3 | The burst's biggest prints | The top 10% of trades by size in the burst: at the ask or at the bid. |

Order flow must be measured only from data known at the buy second (no prints after it).

## Phase 3: news (needs the Alpaca news API)

| # | Idea | How it is measured |
|---|---|---|
| 9 | The news says which way | Headlines in the 30 minutes before the alert (Alpaca news, the keys stay in Railway), scored positive/negative by the alert analysis's sentiment step. Follow the score when there is a fresh headline. |

## Phase 4: combine (only if something passes)

| # | Idea | How it is measured |
|---|---|---|
| 12 | A small model | Logistic regression on the passing features, trained on the tune months and checked once on the check months. Only the features that passed alone. |

## Phase 5: the bot

The best passing idea in the option backtest on the top 50 (3 years), then on the early-sign alert sources
(`early_prep.py`). Each result logged in `volume-bot.md` with the losing ideas too. No change to the live bot without
the user's go-ahead.

## Order of work

1. Phase 1 scorecard: 4, 6, 10, 11 first (one pass over the minute and second data), then 5, 7, 8.
2. Phase 2 download and scorecard: 1, 2, 3. It runs in the background while Phase 1 is scored.
3. Option backtest for what passed.
4. Phase 3 and 4 only if 1-3 leave something to add.
