# Best algorithms log

Every time a backtested version beats the current champion, it is added here, and the user gets a big signal
(see the rule in [AGENTS.md](../../AGENTS.md)). Losers and ties are not logged here; they go in the research log
(`docs/tasks/research-indi-backtest.md`) and the report doc.

## What counts as better

A version beats the champion only when **all** hold, on the same period (Feb 2024 – Oct 2026), the same trade model
(fills at the bar middle ± 2%) and the same sizing (1% of the current account from $100,000):

1. **Fair list:** it ends higher than the champion on the stocks Indi traded the year before (no look-ahead), or
   ends about the same with a clearly smaller worst drop.
2. **Every year positive** on the fair list (2024, 2025, 2026).
3. **Unseen stocks:** on the 151 stocks outside his 40 it is no worse than the champion. A filter that helps only
   on his 40 stocks does not count; the sector filter failed exactly this way.
4. It was not tuned on the result it is judged by. If its thresholds were picked from these numbers, say so.

## Champion

| Since      | Version                                                                                                                                                                                         | Fair list: end / worst drop / years           | 151 unseen: end / worst drop |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| 2026-10-22 | **News filter + t ≥ 1.8**: the C signal with t ≥ 1.8 (not 2.0) and day volume ≥ 1.5×, no entry on earnings reaction days or with pre-market volume ≥ 4×, delta 0.15, your stop + overnight hold | $585,592 / 11% / +2,762 +2,039 +2,699 a trade | $123,028 / 11%               |

- At 2% a trade: $2,444,629 / 21% (news filter at t ≥ 2: $688,039 / 30%).
- It holds at delta 0.10: $808,028 / 13% (t ≥ 2: $503,674 / 15%), unseen $104,830 / 6% (t ≥ 2: $102,663 / 9%).
- Without the 5 best trades a year it is better in 2025 and 2026 (+$39K / -$139K vs -$167K / -$350K).
- Picked from a 4 × 5 grid (t 1.7-2.0 × volume 1.2-1.7). Its neighbour t ≥ 1.9 also beats t ≥ 2 on both lists at both
  deltas ($426,571 / $128,979 at 0.15), so the gain is a band, not one cell. Lower volume cut-offs (1.2-1.3) do more on
  the fair list but worse on the unseen; t ≥ 1.7 falls on the unseen.

The previous champion, the news filter at t ≥ 2: $297,160 / 16%, unseen $121,443 / 11%.

## Chosen for the bot (the user's pick)

| Since      | Version | Fair list at 1% / 2% | 151 unseen at 1% |
| ---------- | ------- | -------------------- | ---------------- |
| 2026-10-23 | **Champion + the failed-break sale**: on the entry day, sell all when the stock reaches the next level ahead (yesterday's / 5-day / 15-minute / the day's high or low) and falls back 0.5 S30 within 30 minutes without breaking it (`fail_rebuy.py` "all") | $538,923 / 9%; $2,107,921 / 18% | $127,476 / 10% |

- Not a champion by the rule above (less money at the same size on the fair list); the user chose it for the lower
  risk at the same 2% size (2026-10-23). At the same worst drop it beats the champion on both lists. In the live bot:
  `sellFailedBreak` (on by default), branch feat/bot-failed-break; `level_parity_export.py` + the bot's
  `scripts/bot-level-parity.ts` match on 1134 of 1134 trades.
- In the simulator as `failed_break` (sim.py F, `lists.py` with BT_FAILED_BREAK=1). With the commission on the extra
  sale counted: fair $526,469 / 10% at 1%, $2,011,681 / 18% at 2%; unseen $125,581 / 10%.
- The user's app lists over 2025-10-23 to 2026-10-22 (`lists.py`, `semis_fb|software_fb|favorites_fb` vs `_y`
  without the sale), at 2%: Favorites (51) $294,375 / 14% vs $256,531 / 18%; Software (30) $112,183 / 7% vs
  $111,761 / 7%; Semis (27) $103,524 / 16% vs $103,677 / 18%. Without the best 5 at 1%, Favorites $86,053 vs $80,400.
  Same 335 / 49 / 111 trades in both. On the Backtest Reports dashboard.

V1 (C signal t ≥ 2 vs SPY × β, day volume ≥ 1.5×, delta 0.15, your stop + overnight hold for winners ≥ +100%) is the
paper bot: $257,698 / 26% on the fair list, $107,869 / 21% on the unseen.

## Log

| Date       | Version                                                                | Fair list: end / worst drop | 151 unseen     | vs champion                                             | Status                                          |
| ---------- | ---------------------------------------------------------------------- | --------------------------- | -------------- | ------------------------------------------------------- | ----------------------------------------------- |
| 2026-10-21 | V1                                                                     | $257,698 / 26%              | $107,869 / 21% | —                                                       | paper bot (deploy pending)                      |
| 2026-10-21 | V1 + guard 500 → 200                                                   | $278,941 / 25%              | $109,188 / 20% | +$21K, −1 pt drop; unseen +$1K                          | champion until the news filter; fragile at 0.10 |
| 2026-10-21 | V1 + news filter (no earnings reaction day, no pre-market volume ≥ 4×) | $297,160 / 16%              | $121,443 / 11% | +$18K, −9 pts drop; unseen +$12K, −9 pts; holds at 0.10 | champion until t ≥ 1.8                          |
| 2026-10-22 | News filter + t ≥ 1.8 (volume ≥ 1.5×)                                  | $585,592 / 11%              | $123,028 / 11% | +$288K, −5 pts drop; unseen +$2K; holds at 0.10         | 🏆 champion (backtest only)                     |

## Tested, not better (V2, 2026-10-21)

- IV filters (own IV rank, low-IV stocks, IV / realized vol): about the same as trading less; fail at 0.10 and unseen.
- Rolling out when the stock nears the strike fast (to delta 0.15 or 0.30): $161K – $206K; it sells the big winners.
- Rolling again on t >= 1.8 (`roll2.py`): "fast" as a share of the time to expiry (10% / 25%), the stock 50% / 25% of
  the way left to the strike, sell 25% / 50% of the contract into a delta 0.30 roll funded by its cost or its
  proceeds (16 versions): $335K – $509K vs $585,592, and worse on the unseen in every version. The fast movers are
  the future +1000% trades; the 0.30 contract makes a smaller % on the same move.
- Drawdown sizing (`dd_sizing.py`, 2026-10-23, the user's risk rule): half-size trades once the account is 12.5% under
  its high, full size back at two-thirds of the fall recovered. An overlay on finished trades: at 1% a trade it never
  fires (worst drop 11%); at 2% the fair list ends $1,096,514 / 17% vs $2,444,629 / 21%, the unseen $128,201 / 17% vs
  $140,443 / 22%. The big winners come inside the drawdowns. Not added to the bot: the trading service's risk manager already has this rule (brake 12.5% below the high, off at two-thirds recovered) for every buy, the owner's included; the bot reacts to it.
- The real risk manager (`risk_overlay.py`, 2026-10-23: brake 12.5% below the high or two daily stops, 2% a trade / 3% a
  day at risk under it, recovery 3% / 5% at two-thirds back, risk = premium x the loss share by DTE) over finished trades.
  At 1% a trade it never binds anywhere. At 2%: fair list $1,962,613 / 29% when the bot is refused (14 trades, 138 brake
  days) vs $2,444,629 / 21% without; sized to fit instead of refused $2,214,380 / 25%. Unseen $128K / 28% refused,
  $137K / 23% sized, $140K / 22% without. All lists, Apr-Oct 2026: refused $141,713 / 15%, sized $135,515 / 18%,
  without $131,848 / 20%. Under the brake the bot's 2% buy is exactly at the 2% limit, so what gets refused is the
  second buy of a brake day after a loss (the 3% day cap); six of the 14 refused on the fair list were +51% to +617%.
- Half size under the risk manager's brake, as built in the bot (PR #130; `risk_overlay.py` mode "half"): at 1% a trade
  never binds. At 2%: fair list $1,096,514 / 17% vs $2,444,629 / 21% (213 brake days instead of 138, since half-size
  trades recover the fall more slowly); unseen $128,201 / 17% vs $140,443 / 22%; all lists Apr-Oct 2026 $110,231 / 16%
  vs $131,848 / 20%; core $123,747 / 17% vs $133,428 / 20%. Four points less worst drop for about half the end value
  at 2%; the user's risk rule, chosen knowing that.
- At 4% a trade the risk manager rules everything: 4% is over its brake cap (2%) and recovery cap (3%), and two 4%
  trades on one day are over the full-state day cap (7%). Fair list 2024-26 without it $20.4M / 39% (in-sample
  compounding of a few +1000% trades); refused as today 54 of 813 trades taken, $145K / 13%; half under the brake
  $399K / 32% (289 still refused, in recovery mostly); sized to fit $3.85M / 36%. Core Apr-Oct 2026: $150K / 37%
  without, $122K / 13% refused, $172K / 22% half, $169K / 25% sized to fit. Above 2% the bot has to size to the risk
  manager's cap, not to a fixed share.
- Tiered sizing by distance from the high (`tier_sizing.py`, 2026-10-23, the user's idea): 5% a trade within 5% of the
  high, 2% from 5% to 12.5% below, 1% deeper; day stop 5% (4% in the deep band). Fair list 2024-26 $1,135,304 / 20% vs
  flat 2% $2,444,629 / 21% and flat 1% $585,592 / 11%; the 151 unseen $92,295 / 19% (a loss) vs $123,028 / 11% at flat
  1%; core Apr-Oct 2026 $110,569 / 19% vs $118,534 / 10% at 1%; all lists $96,259 / 20%. The account is within 5% of
  its high only 114 of 676 days: a few 5% losers right after each high push it into the 2% band, and the winners that
  make the year arrive in the 1% band. Sizing up near highs and down in drawdowns is the reverse of where this
  strategy's P&L comes from.
- Sizing sweep (`sizing_sweep.py`, 2026-10-23): 534 rule-and-size combinations (cut x0.5 / x0.25 below a 7.5-20%
  drawdown with the size back at 1/3, 2/3 or a new high; size up x1.5 / x2 below a drawdown; daily stops 2-5%; cuts
  after 3-8 losers; monthly stops 5-12%; size up after a 1x / 3x win) at 1-3% a trade, judged against the flat size
  with the same worst drop. No drawdown-cutting rule beats the flat line on all three trade sets (fair list, 151
  unseen, all lists Apr-Oct 2026): the most consistent, 2% x0.5 below 15% back at 2/3, is +0% / -8% / -6%, i.e. a
  flat 1.7%. Cuts that look good on the fair list (2% x0.5 below 7.5%: +46%) lose 19% on the unseen. The only rules
  with a positive edge everywhere size UP in drawdowns or after a big win, and they raise the worst drop. To cut the
  biggest drop, lower the flat size; the drawdown is proportional to it (1% ~11%, 1.5% ~16%, 2% ~21%, 3% ~31%).
- Overnight: no hold after a 5/10-minute premium drop; a 3–5% cap on what goes into the night: all worse or mixed.
- Give-back locks 200 → 50 and 300 → 100, trails 100/50, 200/40, 300/50, the ladder: worse or worse on the unseen.
- End-of-day entries for tomorrow (volume-free strength vs SPY, near the high): lose 2024 and 2025.
- Score and moving-volume entries (t ≥ 3 with 1×, t ≥ 2.5 with 1.2×, t ≥ 1.5 with 2.5×, scores 2.0 / 3.0, moving-volume
  blend, speeding-up boost, 5-minute burst): none better on both lists.
- Selling 25% at +150% and 25% at +250%: $142,572 / 20%. Carried-day trailing stops (25 / 40 / 50%): worse.
- False alarms (the stock or SPY against the bet at the signal): only 3 of 820 trades; filters do not help.
- Scale-in on the t >= 1.8 champion: worse (A $476,299 / 12% vs $585,592 / 11% at 1%; unseen $115,967 vs $123,028).
- Stall exit (after a big spike, no new stock extreme for 30-60 minutes, optionally 40% under the peak or volume fading),
  on t >= 1.8: $135K-$499K vs $585,592; even only for trades under +100% (not going overnight): $265K-$465K. A stall
  often comes before the next leg or the overnight gap.
- Buying back what a 10/20-minute check sold when the stock turns our way within 60 minutes (cross the entry, 0.2% past
  it, or a new day extreme), on t >= 1.8: $507K-$555K vs $585,592, worse on the unseen; the false recoveries cost more
  than the real ones bring. Each bought-back part runs as a new entry (its own +10 / +20 checks, -30%, overnight hold);
  up to 3 buy-back cycles: $510K and $556K, no better.
- No trade when the contract's IV at entry is >= 100% (`iv_cap.py`), on t >= 1.8: fair list $560,872 / 11% vs $585,592
  (cuts 119 trades, 28 winners, net +$398 per trade thanks to ASTS); unseen $126,141 vs $123,028; delta 0.10 $789K vs
  $808K. Caps at 80-200%: none clearly better; 150% looks good at 0.10 only (fragile).
- 0DTE allowed in the champion: worse (doubles the worst drop; loses 2025 and 2026).
- A separate 0DTE strategy (expiry days only, entries 09:40-12:30 New York, V1 or lower thresholds, with or without a
  breakout; exits checked every minute: option stops, trails, half at +100%, your stop + trail, F4; delta 0.15 / 0.30;
  32 + 6 runs): the best balanced one makes $109,397 / 11% on the fair list over 2.7 years and loses 2025; the 151
  unseen lose with every version. F4 + breakout ($152,567) rests on a few 2024 trades with 12% winners.
- Wait 5 minutes, then check every minute for the half (F1-F4): F1 / F3 (stock against) help the unseen ($133,098 /
  8%) but cost about 20% on the fair list; F4 (option -15%) ends higher at the same size ($315,345 / 19%) but loses at
  equal worst drop (F4 at 1.75% $630,783 / 31% vs the champion at 2% $688,039 / 30%) and on the unseen.
- Selling half at the first minute the stock is against the entry (instead of the +10 / +20 checks): $183K – $207K.
- A second entry on a trend (`second_entry.py`, 2026-10-23): after a champion trade on the stock lost the same day, wait
  30 / 60 / 90 minutes, then re-enter at the first minute the stock is past the first entry our way by 0.5 to 3 sigmas
  (the move minus beta x SPY, over the spread of the day's 1-minute excess moves x sqrt of the minutes since entry) with
  the trend still on (same side, t >= 1.8, volume >= 1.5x); a third try the same way after a losing second. Fair list:
  $566K / $531K / $557K vs $585,592 (second entries 89 / 74 / 58, 20-27% winners, -$367 to -$1,322 a trade); with the
  third try $572K / $525K / $549K. Unseen: $125K (wait 30, 11 trades) / $122K / $122K vs $123,028. The cap never binds:
  the first minute past 0.5 sigma is under 1.8 sigma in every case, and the entries are no better in any sigma or IV
  band. The trend holding for an hour is not new evidence; the first entry already had it.

- Less overnight risk on t >= 1.8 (`night_risk.py`, re-walked: champion $594,613 / $2.52M at 1% / 2%, worst night
  -8.8% / -17.6%): keeping 75% / 50% of the winner, "free ride" (sell the cost back at 15:50), half free, holding only
  +150% / +200%, tiered: all cost 13-60%, and most leave the worst night where it was. The cap is the cheap tool:
  10% -> $615,090 / $2.11M, worst night -6.6% / -6.6%; 15% -> $599,107 / $2.65M, worst night -7.8% / -10.0%;
  unseen about the same ($122-124K at 1%).
- The night by days to expiry and moneyness at 15:50 (`night_dte.py`, 98 held trades): no steady pattern by days left
  (1 / 2 / 3 / 4+ days all positive in sum); still out of the money is a lottery (median night -13% to -22%, mean
  +24% to +83%) and holds most of the money, so "no hold when OTM" or "with 1 day left" cost 14-70%. Only the few
  deep in the money (2%+: 5 trades) lost; "half when ITM 5%+" $612,565 vs $594,613 on 2 trades (noise).
- Overnight caps: 5% and 10% cost a lot; 15–20% cost nothing at 0.15 but do not cut the worst drop (kept as a safety idea).
- The close trade (`eod1.py`, 2026-10-24, the user's idea): at 15:55 New York the list's best stock on the last hour's
  strength vs SPY × β and volume, within 0.25 / 0.5 S30 of its day high (call) / low (put), no earnings tomorrow, a
  next-session contract at delta 0.15 / 0.20 / 0.25, sold the next morning (open, 09:40, the morning gap rule, +50% /
  +100% take with a -30% stop till 10:30); floors none or t >= 1.5 and volume >= 1.2x. 60 versions a list: none is
  positive every year on both the fair list and the unseen, and every one ends under $100,000 without its best 5.
  Few trades (fair 93-154 in 2.7 years, 22-40 with the floors; next-session expiries are mostly Thursdays before
  2026). Best-looking: near 0.5, floors, delta 0.25, sold at 09:40: fair $113,393 / 9% (40 trades, 2024 -$5,323 a
  trade), unseen $102,454 / 6% (30); Favorites (a year) up to $116,433 on 19 trades. The morning gap rule is the
  worst exit nearly everywhere.
- 0DTE, the user's spec (`zero4.py`, 2026-10-24): breakouts first (a close 0.25 S30 past yesterday's / the 5-day /
  the 15-minute / the day's high or low, or any), lower confirmations (c0: t >= 0, volume >= 1x; c1: t >= 1, 1.2x;
  c2: t >= 1.5, 1.5x), signals 09:40-12:59 New York (buys by 20:00 Israel), delta 0.15 / 0.20 / 0.25, the champion's
  stop first, then all at +30 / +50 / +100%, half +50% and half +100%, or thirds with a 30% trail (and the stop alone),
  out by 15:30. 270 strategies on 24,233 signals: none positive every year on both lists; no strategy makes money on
  the unseen. Lower thresholds are worse (median fair end c0 $55,632, c1 $73,925, c2 $94,514). The take-profits cut the
  worst drop and lift the median vs the stop alone, but none pass $100K on both lists. Top fair list: any breakout, c2,
  0.15, the stop alone, $147,567 / 20% on 212 trades with 9% winners, $69,123 without the best 5; unseen $81,313.
- Exits checked every 10 seconds (`exits_10s.py`, 2026-10-24; the live bot ticks every 10 s since 2026-10-23), on the
  10-second bar database (`data/local/bars-10s.sqlite`, Alpaca SIP trades, one year to 2026-10-22, 196 symbols; 67 of
  the window's 424 champion-bot trades are on 29 other symbols and left out of both versions). Stock at each tick from
  the 10-second bars; option mark MODELED: Black-Scholes at the tick's stock price with the last closed minute bar's
  implied vol (median error 1.9%, 90th percentile 6.2% against the real minute closes). The same rules (your stop,
  overnight hold, failed break) once a minute vs every 10 s, 2025-10-23 to 2026-10-22: fair list (288 trades) at 1%
  $195,674 / 6% vs $149,938 / 11% (2%: $335,077 / 12% vs $202,718 / 21%), per trade +$2,613 vs +$1,629 at $10K; 151
  unseen (61) $93,946 vs $93,705. 286 of 288 trades end differently (167 better, 119 worse), and the whole gap is
  three knife-edge trades: GOOGL 2026-07-31 (the -30% stop: minute 117 closed at -29.97%, its low exactly -30%; the
  10-s check sold inside the minute, the champion went on to +1406%), COIN 2026-08-19 (15:50 at +101%: at 15:50:10 the
  modeled mark was +93% and it sold instead of carrying; the carry made +1499%), ASTS 2025-12-04 (-30%: minute 24
  closed at -28.9%, a tick dipped under; then +440%). Without those three the 10-s version is ahead by $48.8K at $10K
  over the other 285 trades (+$171 a trade): the earlier stop-outs save a little on the ordinary losers. More stops
  overall (U_out 142 -> 164 of 357 trades). Not a rule, a cadence: the live bot runs the 10-s version. The lesson is
  that the champion's figures lean on three thresholds hit by a hair, and the model's +-2-6% is wider than those
  margins, so neither cadence is "right"; a stop or a carry that needs the condition on two ticks (or on the closed
  minute) would take the coin-flip out. Not tested yet.

## Candidates

- Fade cut on carried days (`night_fade.py`): from 10:00 New York on a carried day, sell the rest at the first minute
  the stock's t vs SPY x beta since that day's open is < 0.5 and its volume is under normal. Fair list $598,184 / 11%
  vs $585,592 (2%: $2.54M vs $2.44M); unseen unchanged (no trade cut). Only 4 trades cut (COIN, META, AMD x2), all
  better; picked as the best of 5 variants, so tuned. "t < 0 and volume under normal": $591,416. Strength alone
  (t < -1) is much worse ($484,515): it cuts the big winners on a morning dip; the volume test is what keeps them.
  Too few trades to call it a champion; worth adding to the paper bot's log, not its rules.

- 0DTE on the user's favorites list (50 stocks, first hour, news filter): 21 of 96 results positive every year. Best
  cluster: a new day-high breakout (t >= 2, volume >= 1.5x), the -40% stop only, delta 0.20-0.30: about $158-162K / 8-10%
  at 1% over 2.7 years ($112-122K in 2026 alone), only 15-16% winners. The list is today's, so it carries hindsight.

- Sector-relaxed thresholds (t 1.5 / volume 1.2, or 1.7 / 1.3, when the sector ETF is 0.3% our way): worse or worse on
  the unseen ($264,568 / $380,820 / $297,768 fair; $119,808 / $103,173 / $122,185 unseen, with bigger drops).
- A $0.10 minimum price: worse at 0.15; better-looking at 0.10 but the backtest's 2% cost is far too low for $0.10 options.
- 0DTE in Indi's range (delta 0.20 / 0.25 / 0.30, first hour or 14:30-15:30 New York, SPY filter at ±0.5%; 352 strategy
  results): the SPY filter helps a little (median fair end $98,672 vs $96,028; 5 of the 6 steady ones use it); the late
  window does not work for us (median $93,720, none steady); 0.30 is the only delta with steady results; Fridays make
  the money for us (Mon / Wed lose). Steadiest: yesterday's-level breakout (E6, volume >= 1.5x), first hour, thirds (X7),
  delta 0.30, SPY filter: 34 fair-list trades in 2.7 years, 68% winners, $110K / 1% at 1% and $159K / 5% at 5%; unseen
  $105K / $126K. Too few trades to trust yet.
- Overnight cap at 8% of the account: free at 1% a trade (+4%; worst night -8.8% -> -4.2%), -25% at 2% (worst night
  -17.6% -> -5.4%), -60% to -71% at 4-5%; the worst drop hardly changes.

- 0DTE, the big run (360 strategies: 6 breakout entries x 10 exits x delta 0.15 / 0.30 / 0.45 x fill on the breakout
  bar or the next open): the median strategy loses; only 2 of 360 are positive every year on both lists. The one
  cluster that holds across deltas and fill timing: a breakout of yesterday's high/low (E5: t >= 1, volume >= 1.2x),
  a third sold at +50%, a third at +100%, the rest trailing 30% (X7), delta 0.45: 112 fair-list trades, 55% winners,
  $110,987 – $111,220 / 2% at 1% and $163K / 10% at 5%; unseen $102K / 3–4% at 1%, $108–110K at 5% (2026 slightly
  negative there). Small but steady; far below the champion ($297,160 at 1%).

- Scale in, D (half at the signal, the other half at minute 5 only if the stock is our way): at the same nominal size
  it ends lower ($267,990 / 14% vs $297,160 / 16% at 1%), but at equal worst drop it beats the champion on both lists
  (fair at 2%: $597,796 / 25% vs the champion at 1.6%, $504,560 / 25%; unseen at 2%: $138,725 / 14% vs $121,443 / 11%
  at 1% and $129,966 / 17% at 1.5%), and it is positive every year on the unseen (+370 / +948 / +1,280).
- Scale in, A (add at the first minute 1-5 the stock is our way): fair list better ($306,316 / 14%; $741,653 / 27% at
  2%), unseen worse ($109,776 / 9%).
- Buying on the signal bar's close instead of the next bar's middle: $516,519 / 13% (champion $297,160 / 16%); an
  optimistic upper bound (a bar's close is its last trade, not the ask). The live bot should be faster.

- Entry score ≥ 2.5 (t/2 + volume/1.5, floors t 1.5, volume 1×): fair list $490,168 / 11%, but unseen $82,370 / 30%.
- Sell everything at the morning gap (not half): about 27% more at the same worst drop on the fair list at 0.15, but
  worse at 0.10 and on the unseen.

- Day-end decision later (`eod_late.py`, 2026-10-23): decide the overnight hold and sell the rest at 15:55 or 15:58
  (sold on the 15:59 bar) instead of 15:50; the stops keep working until then. Not better. Fair list at 1%:
  15:50 $585,593 / 11%, 15:55 $553,953 / 15%, 15:58 $588,287 / 13% (2%: $2,444,640 / 21% vs $2,446,247 / 24%);
  unseen at 1%: $123,028 vs $117,738 and $94,618 (2026 turns negative). The extra minutes add more swings than
  profit; a winner that slips under +100% in the last minutes is sold and misses its night (NFLX 2026-02-25: -2660
  points on the unseen).
- Day-end decision earlier (`eod_late.py 375 370`): 15:45 fair list $639,671 / 14% at 1% ($2,879,093 / 27% at 2%),
  15:40 $656,269 / 15%; unseen about the same ($122,102 / $123,990 vs $123,028). Not better: the gain is one trade
  (TSLA 2024-07-01 call, +1503 points held from 15:45); without it 15:45 is $550,669 vs $579,603. At the same worst
  drop (14%) the champion at 1.25% a trade makes $860,919 vs $639,671.
- Stops and profit taking on the carried days, from last night's 15:50 price (`night_x.py`, 2026-10-23; set before
  running). A: from 09:40, all out at -30% under it, half of the rest at +50% over it, then the rest out back at it.
  B: A from 09:31, with a wider -40% stop in the first 30 minutes. Not better: fair list at 1% A $520,415 / 11%,
  B $468,175 / 11% vs $585,593 / 11% (2%: $2.01M / $1.66M vs $2.44M); unseen $102,271 / $100,144 vs $123,028 (2026
  turns negative). Worse on both the +100-300% and the +300%+ first days. The take profit sells the half that runs
  on (AAPL 2025-08-06 -509 points, QCOM 2026-05-05 -482, NFLX 2026-02-25 -2595 on the unseen); B's early stop fires
  on 39 of 80 held trades: the open dips -40% and comes back. Real early spreads are wider than the 2% modeled, so
  B is if anything optimistic.
- Rules for the big carried winners only (`night_y.py`, 2026-10-23; the user's ideas, with a grid around them): only
  trades up >= +300 / 400 / 500% at the first 15:50 hold (23 / 17 / 11 on the fair list, none on the unseen).
  1) from 10:00 on a carried day, all out at 40 / 50 / 60% under last night's price, or when the gain falls under
  +50% of cost: worse or no change everywhere (400% / -50%: $567,828 vs $585,593; SMCI 2025-05-13 -420 points).
  2) after the morning gap sale, the rest out 30 / 40 / 50% under the option's highest close since the buy: 400% is
  better ($596K / $621K / $597K at 1%, same 11% drop; trail 40% $2.75M vs $2.44M at 2%), 300% and 500% are worse.
  Candidate, not champion: 400% / trail 40% changes 4 trades (MRNA 2026-01-21 +541 points, AMD +144, PLTR +131,
  SMCI -228); without MRNA $573,628 vs $569,305; no unseen trade reaches +400%, so nothing out of sample; the
  neighbours at 300% / 500% lose, so it is tuned on 17 trades.
- A general trail (`night_z.py`, 2026-10-23): all out when the option is 30 / 40 / 50% under its highest close since
  the buy. Much worse. Always on (every trade, every day): 40% $282,789 / 13% vs $585,593 / 11%, unseen $89,274 vs
  $123,028 (30%: $106,968; 50%: $374,560). Only once up +100%: 40% $320,515. Only on carried days: 40% $540,922 / 10%,
  unseen $104,827. A 0.15-delta option often falls 40% from its high on the way to a big win (BA 2024-08-01 -2595
  points, GOOGL 2026-07-31 -1401, COIN 2026-08-19 -1250).
- The same trail only once the option has been up +500% (`night_w.py`, any day, entry day included): 40% under the
  high $543,255 / 10% vs $585,593 / 11% (2%: $2.19M / 20% vs $2.44M / 21%), unseen $122,821 vs $123,028; 30%
  $339,678, 50% $493,508. Armed at +300 / 400 / 600 / 800%: $500,593 / $527,557 / $573,481 / $579,395. Not better at any
  level; a little less drop. It sells many entry-day runs that keep going (COIN 2026-08-19 -1250 points, BA 2024-05-23
  -771); the +400% carried-day-only version (night_y) stays the one candidate.
- Support and resistance study (`levels.py`, 2026-10-23; no rule yet). Levels: yesterday's, the 5 sessions before's,
  the first 15 minutes' and the day so far's high / low; distances in S30 (the stock's typical 30-minute move).
  Entry: a signal right at a level (< 0.25 S30 to the next one ahead) is the best group on both lists (+$5,736 /
  +$1,075 a trade at $10K, fair / unseen); 1+ S30 of room is weak on the fair list (-$1,049 / +$5), mixed on the
  unseen: no filter. Failed break (reached the level, fell back 0.5 S30 within 30 minutes) on the entry day, sell
  all there: helps 97 of 118 fair-list trades (median +$1,079) and 40 of 49 unseen (+$35K), but the fair list sums
  -$93K: BA 2024-05-23 -1304 points and ORCL 2025-07-02 -955 failed first and then ran; 2024 / 2025 negative. Indi
  buys at levels (41% of his entries within 0.25 S30 vs 26% for a random minute) but does not sell at them (27% vs
  26%). Next: the failed-break sale as a rule (half / all), set before running.
- Failed-break sale, and a buy-back on the second try (`fail_rebuy.py`, 2026-10-23; set before running). Fair list at
  1%: all $538,923 / 9%, half $563,493 / 10%, all + rebuy $501,017 / 11%, half + rebuy $543,564 / 11% vs $585,593 /
  11%; unseen $127,476 / $125,245 / $122,879 / $122,962 vs $123,028. The second try is bad: 78 bought back on the fair
  list, 15 winners, -$70K at $10K; it does not catch BA 2024-05-23 or ORCL 2025-07-02 (both bought back and stopped
  out at -32% / -33%). Candidate: "all" without the buy-back, on risk. At the same worst drop it beats the champion on
  both lists (fair 1.25% $778,298 / 11% vs 1% $585,593 / 11%; 2.5% $3.79M / 22% vs 2% $2.44M / 21%; unseen 1.25%
  $133,752 / 12% vs $123,028 / 11%), every year positive, but less money at the same size (2024 and 2025 lower per
  trade). Like scale-in D: a candidate, not a champion.
- The same with the buy-back as the original trade going on (`fail_rebuy2.py`: no new +10 / +20 checks; -30% with the
  stock against the buy-back, 15:50 hold): fair list $492,458 / 11%, unseen $120,983 (one buy-back) vs $585,593 /
  $123,028. Up to 3 buy-backs: fair $601,675 / 11% ($2.55M / 20% at 2%), but it is one trade (BA 2024-05-23, third
  try at 10:43 NY, +1901%; without it the buy-backs sum -$62K at $10K) and the unseen is worse ($120,005 / 13%). Not
  better: buy-backs at the same level mostly lose (fair 33 of 113 win, unseen 8 of 39).
