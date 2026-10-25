# Best algorithms log

Every time a backtested version beats the current champion, it is added here, and the user gets a big signal
(see the rule in [AGENTS.md](../../AGENTS.md)). Losers and ties are not logged here; they go in the research log
(`docs/tasks/research-indi-backtest.md`) and the report doc.

## What counts as better

A version beats the champion only when **all** hold, on the same period (Feb 2024 – Oct 2026), the same trade model
(fills at the bar middle ± 2%) and the same sizing (1% of the current account from $100,000):

**Costs (the user's rule, 2026-10-25):** every strategy pays for every contract on the buy and on every sale, and
every fill is corrected against us. The simulator has done this from the start: `params.json` `size.commission` =
**$0.62 a contract** each way (IBKR's rate; `sim.result` charges it on the entry, on each sale and on a rebuy), and
`cost.spread_half` = **2%**: a buy fills at the bar's middle × 1.02, a sale at × 0.98. Every number in this file and on
both dashboards is net of both. The user's floor is **$0.40 a contract each way**; the simulator stays at the stricter
$0.62. At the user's $0.40 the ladder reads (fair list; the drop moves at most one point):

| Version | At 1%: $0.62 → $0.40 | At 2%: $0.62 → $0.40 | A trade at $10K |
|---|---|---|---|
| D2 bonus entry (champion) | $1,005,221 → $1,042,426 | $6,384,240 → $6,863,332 | +2,639 → +2,676 |
| The current bot 2.4 (`bot24`) | $695,451 → $716,630 | $3,372,316 → $3,579,948 | +2,656 → +2,693 |
| Rest stop -20% | $811,356 → $836,040 | $4,502,081 → $4,778,745 | +2,859 → +2,896 |
| Overnight from +50% | $795,641 → $819,848 | $4,330,004 → $4,596,132 | +2,835 → +2,872 |
| t-stat exit | $610,096 → $628,667 | $2,647,108 → $2,809,916 | +2,479 → +2,516 |
| News filter + t ≥ 1.8 | $585,592 → $603,419 | $2,444,629 → $2,595,019 | +2,427 → +2,464 |
| Favorites year, current bot 2.4 (`fav_rest_bot`) | $179,263 → $184,458 | $279,558 → $295,990 | |
| Favorites year, D2 + the sale (`fav_d2_bot`) | $191,220 → $198,075 | $310,176 → $332,807 | |

The median paid price of a champion trade is $0.67, so the two commissions take 1.8% of a trade's premium at $0.62
(1.2% at $0.40); 9% of the trades pay under $0.30, where they take 4% or more. The sensitivity to a wider fill
correction (5%, 10%) is the "Cost sensitivity" set on the Bot vs Indi dashboard. To re-state a stored trade at another
rate without walking again: ret + (0.62 − rate) × (1 + shares sold) / (100 × paid price).

**The overnight cap (the user's rule, 2026-10-25: "10% cap overnight ALWAYS and everywhere"):** what goes into the night is
worth at most **10% of the account** (contracts × the 15:50 close × 100, against the account at the day's start); the part
above it is sold at the close, as the live bot's `nightCapPct` (Bot settings page, 10% by default). `params.json`
`exit.night_cap` = 0.10 (`BT_NIGHT_CAP` overrides, 0 = off); `sim.result(cost, steps, pct)` applies it for the size it is
asked for (`sim.cap_steps`), 1% unless told (`size.risk_pct`), so a walk's stored steps stay uncapped and any size can be
read from them. `lists.py` writes `ret` (1%, capped), `ret_2pct` and `ret_nocap`; `night_cap.py` applied it to every stored
list and to both dashboards (a return per size in their trade files; the pages show the cap sale in the trade window at
the chosen size). The cap binds rarely at 1% (5 nights of 130 on the champion's fair list) and often at 2% (25 nights):

| Version | At 1%: no cap → cap | At 2%: no cap → cap |
|---|---|---|
| D2 bonus entry (champion), fair list | $1,005,221 / 11% → $1,108,678 / 11% | $6,384,240 / 21% → $5,321,917 / 21% |
| the same, 151 unseen | $127,303 / 11% → $126,188 / 11% | $149,228 / 22% → $143,045 / 22% |
| The current bot 2.4 (`bot24`) | $695,451 / 9% → $719,943 / 9% | $3,372,316 / 18% → $2,738,900 / 18% |
| D2 + the sale (`d2-bot`) | $669,237 / 14% → $734,521 / 14% | $3,042,777 / 27% → $2,847,902 / 26% |
| Rest stop -20% (`t18-rest20`) | $811,356 / 11% → $844,029 / 11% | $4,502,081 / 21% → $3,717,980 / 21% |
| Favorites year, champion (`fav_d2`) | $183,487 / 14% → $183,253 / 14% | $284,993 / 26% → $243,846 / 26% |
| Favorites year, current bot 2.4 (`fav_rest_bot`) | $179,263 / 12% (no night capped) | $279,558 / 23% → $256,924 / 23% |

At 1% the cap even helps on the fair list (FSLR 2024-05-22: the excess sold at the close before a morning gap against,
+$113K of the 2024 gain); at 2% it costs 15-17% of the end result and leaves the worst drop as it was, because the drops
come from the day trades, not the nights. **Every figure logged from here on carries the cap at the size it names**; the
figures above this line and in the log below were computed before it (the cap moves a 1% figure by under 1% except where a
capped night is named).

1. **Fair list:** it ends higher than the champion on the stocks Indi traded the year before (no look-ahead), or
   ends about the same with a clearly smaller worst drop.
2. **Every year positive** on the fair list (2024, 2025, 2026).
3. **Unseen stocks:** on the 151 stocks outside his 40 it is no worse than the champion. A filter that helps only
   on his 40 stocks does not count; the sector filter failed exactly this way.
4. It was not tuned on the result it is judged by. If its thresholds were picked from these numbers, say so.

**Before any run (the user's rule, 2026-10-24):** read the champion row above at that moment (it moved three times on
2026-10-24), read the simulator's configuration (`params.json`: delta, `min_price`, `min_vol30` = 200 for the champion,
the exits the champion needs such as the t-stat exit and the overnight hold from +50%), pin them through the
environment (`BT_CONTRACT`, `BT_EXIT_EXTRA`), run from a frozen copy of `scripts/research/indi_bt` when another
session may be editing it, and reproduce the champion in the same pipeline first (its fair-list trade count, 813, and
its money). A baseline that does not match the log means the configuration differs: stop and find out why. On
2026-10-24 a 10-contract floor left in `params.json` during a sweep made a baseline of 1,484 trades; nothing read
against it was comparable. On 2026-10-25 a frozen copy whose `lists.py` predated the `BT_REST` switch ran the favorites
without the rest stop: a frozen copy has to be refreshed with every switch the run needs, and the exit labels in the
output (`U_rest`, `T_tstat`, `F_break`) checked against the version before anything is reported.

## Champion

| Since      | Version                                                                                                                                                                                         | Fair list: end / worst drop / years           | 151 unseen: end / worst drop |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| 2026-10-25 | **D2 bonus entry**: the rest-stop champion below, plus an entry when t ≥ 1.2 and D2 ≥ 1.5 (D2: the stock's excess move, stock minus beta × SPY, summed over the SPY-down minutes of the last 30, in S30 units; day volume ≥ 1.5× as always; `defence_signals.py` rule c12_15), the user's idea | $1,005,221 / 11% / +3,062 +2,382 +2,630 a trade | $127,303 / 11%               |
| 2026-10-24 | **Rest stop -20%**: the overnight-from-+50% champion below, plus on the entry day, once the +10 check sold half, the rest out at -20% (not -30%) with the stock against (the user's idea: be more careful with trades we already cut) | $811,353 / 11% / every year higher: +692K +865K +768K at $10K | $124,471 / 10% |
| 2026-10-24 | **Overnight from +50%**: the t-stat exit champion below, holding winners up 50% (not 100%) overnight at 15:50 (the user's number; +75% also beats +100%) | $795,638 / 11% / +3,329 +2,417 +3,018 a trade | $122,890 / 10%               |
| 2026-10-24 | t-stat exit: the champion below, plus on the entry day sell all when the signal's own cumulative t-stat vs SPY × beta falls to 0.5 or under (the entry needs 1.8); the -30% stop stays (the user's call, 2026-10-24) | $610,096 / 11% / +2,768 +2,153 +2,703 a trade | $122,679 / 11%               |
| 2026-10-22 | News filter + t ≥ 1.8: the C signal with t ≥ 1.8 (not 2.0) and day volume ≥ 1.5×, no entry on earnings reaction days or with pre-market volume ≥ 4×, delta 0.15, your stop + overnight hold | $585,592 / 11% / +2,762 +2,039 +2,699 a trade | $123,028 / 11%               |

- Rest stop -20% (`rest_stop.py` on the 2.1 bot, `rest_stop2.py` on today's bot and champion; levels -20% / -15% / -20%
  on the option alone set before running, -20% the main one): champion $811,353 / 11% vs $795,638 / 11% at 1%,
  $4,502,047 / 21% vs $4,329,976 / 22% at 2%; without the best 5 $304,317 vs $298,445; every year higher (+692K / +865K /
  +768K vs +689K / +858K / +758K at $10K); unseen $124,471 / 10% vs $122,890 / 10%. A band: -15% $822,300 / $124,026,
  -20% on the option alone $812,373 / $123,731. Broad: 159 trades change, the largest gain GME 2025-07-21 +1,818,
  the largest loss SMCI 2025-10-01 -8,767. On the bot 2.3 (+ failed break): $695,450 / 9% vs $690,515 / 10% ($3,372,307
  / 18% vs $3,325,165 / 19% at 2%), unseen $127,433 / 9% vs $125,788 / 10%. Small (+2% fair, +1.3% unseen) but on every
  check. sim.py: `after_half {out}`.
- Overnight from +50% (`hold50.py`): at 2% $4,329,976 / 22% vs $2,647,105 / 21%; without the best 5 +1,483 vs +1,127 a
  trade; 39 trades change (15 better), TSLA 2024-07-01 +150,319 and SMCI 2025-02-14 +80,126 the largest; 146 nights
  held instead of 101. Unseen $122,890 / 10% vs $122,679 / 11% (14 trades). With the bot's rules (failed break +
  t-stat exit): $690,515 / 10% at 1%, $3,325,165 / 19% at 2% vs $549,153 / $2,183,362; unseen $125,788 vs $125,260.
  +75%: $636,985 (bot). Passes the rule: fair list higher, every year positive, unseen no worse.
- D2 bonus entry (`defence_signals.py` + `defence_sum.py`, the user's idea 2026-10-24: "holding against a drop should
  give a huge extra bonus"), against the rest-stop champion with the same exits (rest stop -20%, hold from +50%, the
  t-stat exit): at 1% $1,005,221 / 11% vs $811,356 / 11%; at 2% $6,384,240 / 21% vs $4,502,081 / 21%; without the
  best 5 $348,085 vs $304,318 (+1,432 vs +1,516 a trade); unseen $127,303 / 11% vs $124,471 / 10% (349 trades vs
  273). Against the +50% hold champion (no rest stop) the same picture: $983,435 vs $795,641, unseen $126,688 vs
  $122,891. Fair list 981 trades vs 813: 776 shared days (137 entered earlier: +3,395 vs +2,612 a trade on the shared
  days), 205 new days (−330 a trade, 21 winners), 37 champion days lost to an earlier minute with no contract. The
  money is the earlier entry on days the champion enters anyway, not the new days. Picked as the best of a 9-cell grid (t 1.0 / 1.2 / 1.5 × D2
  1.0 / 1.5 / 2.0) on the fair list; its neighbours c12_20 ($955,902 / 11%) and c10_20 ($921,223 / 13%) also beat
  the champion, so a band; the unseen run once, on this cell only. Controls: t ≥ 1.2 alone $467,580 / 18% and t ≥ 1.5
  alone $503,036 / 18% against the t-stat exit champion's $610,096, so the lower bar alone loses; the defended minutes
  pick the entries. Not better: D (only fully defended minutes: beta × SPY's drop when the stock did not fall) in
  every form, D or D2 as a filter on the champion (fewer trades, less money), D or D2 instead of t (negative or far
  under). Found at a 10-contract floor first (see "Before any run") and re-earned at 200.
- D2 champion + the failed-break sale (2026-10-25, the user: "the current is the failed-break sale with all the others"): fair list
  $669,237 / 14% at 1% ($3,042,777 / 27% at 2%) against the current bot 2.4's $695,451 / 9% ($3,372,316 / 18%) and the D2 champion's
  $1,005,221 / 11%; 2024 +1,513 a trade (2.4: +2,839), 2025 +2,191 (+2,184), 2026 +2,715 (+3,172); without the best 5 $258,174 vs $260,845.
  Unseen $137,446 / 9% vs $127,434 / 9% (349 vs 273 trades); favorites year $191,220 / 12% vs $179,263 / 12%. The failed break sells the
  early D2 entries (a stock entered at t 1.2 is often still under its level), so the two rules do not combine on the fair list; the
  champion stands without the sale. If the D2 entry goes live, decide the sale again (off, or only after the t 1.8 entry).
- D2 bonus entry on the app's 63 favorites, 2025-10-24 to 2026-10-23 (`lists.py` with `BT_ENTRY=c12_15`, lists `fav_d2`
  vs `fav_rest`, the rest-stop champion's exits, floor 200; on the Backtest Reports dashboard): $183,487 / 14% at 1%
  ($284,993 / 26% at 2%) vs $171,685 / 14% ($256,107 / 27%); 495 trades vs 405, 17% vs 16% winners, +1,432 vs +1,544 a
  trade; without the best 5 both negative (−452 vs −478 a trade): on this list the money is a few trades. With the
  failed-break sale (the live bot's exits; `fav_d2_bot` vs `fav_rest_bot`): $191,220 / 12% ($310,176 / 23%) vs $179,263 / 12%
  ($279,558 / 23%), +1,513 vs +1,649 a trade; here the sale helps both. (A first export of these lists, 2026-10-25 01:30,
  had run from a frozen copy whose `lists.py` predated `BT_REST`, so without the rest stop: $181,885 vs $169,910; replaced.
  Check the exit labels in the output, `U_rest` here, before reporting.) 383 shared
  days (55 entered earlier: −409 → +2,859 a trade in that first run), 112 new days (+1,313 a trade, 15 winners; MSTR +176K, META +92K),
  22 champion days lost because the earlier minute found the contract illiquid, among them COIN 2026-08-19 (+1,499%)
  and GOOGL 2026-07-31 (+1,407%): the sim and the bot do not try again later. A retry when t reaches 1.8 later the
  same day is the next thing to test.
- The t-stat exit (`thesis.py`): at 2% $2,647,105 / 21% vs $2,444,640 / 21%; without the best 5 +1,127 vs +1,075 a trade; 38
  trades change (24 better), MSFT 2025-04-09 +25,781 the largest (without it still +$17K). Unseen $122,679 vs $123,028
  (8 trades, -$349): a hair under "no worse", declared champion by the user. Neighbours: t ≤ 0 changes 5 trades, t ≤ 1
  is worse; the stop at -35% / -40% / -50% with it is worse than -30% on the fair list.
- The t ≥ 1.8 champion at 2% a trade: $2,444,629 / 21% (news filter at t ≥ 2: $688,039 / 30%).
- It holds at delta 0.10: $808,028 / 13% (t ≥ 2: $503,674 / 15%), unseen $104,830 / 6% (t ≥ 2: $102,663 / 9%).
- Without the 5 best trades a year it is better in 2025 and 2026 (+$39K / -$139K vs -$167K / -$350K).
- Picked from a 4 × 5 grid (t 1.7-2.0 × volume 1.2-1.7). Its neighbour t ≥ 1.9 also beats t ≥ 2 on both lists at both
  deltas ($426,571 / $128,979 at 0.15), so the gain is a band, not one cell. Lower volume cut-offs (1.2-1.3) do more on
  the fair list but worse on the unseen; t ≥ 1.7 falls on the unseen.

The previous champion, the news filter at t ≥ 2: $297,160 / 16%, unseen $121,443 / 11%.

## Chosen for the bot (the user's pick)

| Since      | Version | Fair list at 1% / 2% | 151 unseen at 1% |
| ---------- | ------- | -------------------- | ---------------- |
| 2026-10-25 | **The current bot (version 2.4 = "the current"): the failed-break sale on top of everything else** (t ≥ 1.8 + news filter, the t-stat exit, overnight from +50%, the rest at -20% after the half): fair list $695,451 / 9% at 1%, $3,372,316 / 18% at 2%, 813 trades, +2,656 a trade (2024 +2,839 / 2025 +2,184 / 2026 +3,172); unseen $127,434 / 9%; the 63 favorites over the last year $179,263 / 12% (`sb_base`, `lists.py` `fav_rest_bot`). On the Bot vs Indi dashboard as `bot24`. The sale costs money at a smaller drop on the fair list (the rest-stop champion without it: $811,353 / 11%), helps a little on the unseen ($124,471 / 10% without) and on the favorites ($171,685 / 14% without). | see the rows below | |
| 2026-10-24 | **Champion + the failed-break sale + the t-stat exit + overnight from +50%** (the live bot, version 2.3: $690,515 / 10% at 1%, $3,325,165 / 19% at 2%; unseen $125,788 / 10%) | see the rows below | |
| 2026-10-24 | Champion + the failed-break sale + the t-stat exit (version 2.2; with the failed break the t-stat exit gives $549,153 / 9% at 1%, $2,183,362 / 18% at 2%; unseen $125,260 / 10%) | see the row below | |
| 2026-10-23 | Champion + the failed-break sale: on the entry day, sell all when the stock reaches the next level ahead (yesterday's / 5-day / 15-minute / the day's high or low) and falls back 0.5 S30 within 30 minutes without breaking it (`fail_rebuy.py` "all") | $538,923 / 9%; $2,107,921 / 18% | $127,476 / 10% |

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
- Re-test of version 2.3 on the user's Favorites as the app lists them on 2026-10-24 (63 stocks; `universe_fav` in
  `params.json`), 2025-10-24 to 2026-10-23 (`lists.py`, `favorites_23` = BT_FAILED_BREAK=1 BT_THESIS=0.5 BT_HOLD=0.5 vs
  `favorites_21` = the failed break only): 1,895 signals, 405 trades in both (`min_vol30` 200; a first run that had loaded
  the 10-contract floor gave 907 and was thrown away). Bot 2.3 at 1%: $178,543 / 12%, at 2%: $277,307 / 23%; bot 2.1:
  $169,984 / 10% and $252,782 / 20%. Per trade at $10K +$1,639 vs +$1,511; winners 68 vs 77 (the t-stat exit sells 22
  trades early); held overnight 48 vs 30; without the best 5 at 1% $84,531 vs $80,447. The Oct–Dec 2025 part loses
  (−$36,762 over its trades at $10K each), 2026 carries the year. 39 trades end differently, +$52,207 at $10K in all;
  the largest are QCOM 2026-05-07 (+530% vs +74%) and AMZN 2026-04-09 (+462% vs +45%) kept overnight, against AVGO
  2025-12-17 (−3% vs +106%) and AAPL 2026-01-20 (−52% vs +46%). On the Backtest Reports dashboard.

V1 (C signal t ≥ 2 vs SPY × β, day volume ≥ 1.5×, delta 0.15, your stop + overnight hold for winners ≥ +100%) is the
paper bot: $257,698 / 26% on the fair list, $107,869 / 21% on the unseen.

## Log

| Date       | Version                                                                | Fair list: end / worst drop | 151 unseen     | vs champion                                             | Status                                          |
| ---------- | ---------------------------------------------------------------------- | --------------------------- | -------------- | ------------------------------------------------------- | ----------------------------------------------- |
| 2026-10-21 | V1                                                                     | $257,698 / 26%              | $107,869 / 21% | —                                                       | paper bot (deploy pending)                      |
| 2026-10-21 | V1 + guard 500 → 200                                                   | $278,941 / 25%              | $109,188 / 20% | +$21K, −1 pt drop; unseen +$1K                          | champion until the news filter; fragile at 0.10 |
| 2026-10-21 | V1 + news filter (no earnings reaction day, no pre-market volume ≥ 4×) | $297,160 / 16%              | $121,443 / 11% | +$18K, −9 pts drop; unseen +$12K, −9 pts; holds at 0.10 | champion until t ≥ 1.8                          |
| 2026-10-22 | News filter + t ≥ 1.8 (volume ≥ 1.5×)                                  | $585,592 / 11%              | $123,028 / 11% | +$288K, −5 pts drop; unseen +$2K; holds at 0.10         | champion until the t-stat exit                  |
| 2026-10-24 | + t-stat exit (signal t ≤ 0.5 on the entry day), -30% stop             | $610,096 / 11%              | $122,679 / 11% | +$25K, same drop; unseen −$349 (8 trades)                | champion until the +50% hold (the user's call)  |
| 2026-10-24 | + hold overnight from +50% (was +100%)                                 | $795,638 / 11%              | $122,890 / 10% | +$186K, same drop; unseen +$211, −1 pt                   | champion until the rest stop -20%               |
| 2026-10-25 | + D2 bonus entry (t ≥ 1.2 and D2 ≥ 1.5 enters too)                     | $1,005,221 / 11%            | $127,303 / 11% | +$194K, same drop; unseen +$2.8K, +1 pt                  | 🏆 champion (backtest only)                     |
| 2026-10-25 | D2 champion + the failed-break sale (the live bot's exits, `BT_TAG=b`)  | $669,237 / 14%              | $137,446 / 9%  | −$336K, +3 pts drop vs the D2 champion; unseen +$10K, −2 pts | not better: the sale cuts the early D2 entries (2024 +1,513 a trade vs +2,839); on the Bot vs Indi dashboard as `d2-bot` |

## Tested, not better (V2, 2026-10-21)

- D2 bonus entry + the failed-break sale (2026-10-25, `d2_failed_break.py`; the user: "is there a place for both?"; the
  live bot 2.4 is the rest-stop champion + the failed break): fair list $669,231 / 14% at 1% ($3,042,721 / 27% at 2%)
  vs bot 2.4 $695,450 / 9% and the D2 champion $1,005,207 / 11%; 2024 falls to +392K at $10K (D2 alone +793K);
  without the best 5 $258,171. The 151 unseen like it: $137,444 / 9% vs $127,302 / 11% (D2) and $127,433 / 9% (2.4).
  Fails the fair list: the failed break costs D2 $336K against $116K on the t >= 1.8 entry, and adds 3 points of drop.
  Baselines reproduced in the same run: $811,353, $695,450, $1,005,207 (981 trades).
  The middle way (the user: "go and test it"): the failed break only on the 642 entries with t >= 1.8, never on
  the early D2 ones: $855,938 / 13% at 1% ($4,712,111 / 24%), +693K / +900K / +824K, without the best 5 $296,392;
  unseen $130,487 / 11%. Under the D2 champion in money and worse in drop (13% vs 11%): in D2's trades the failed
  break no longer lowers the risk. Not better.
- "Defence broken" exit for the D2 bonus (2026-10-25, `defence_exit.py`, sim `defence`): on the entry day, from 15 (30)
  minutes after the entry, sell all when the D2 of the last 15 (30) minutes is at or under a level; main cell 15 min
  at 0, set before running. Fair list $75,590 / 26% at 1% vs $1,005,207 / 11% (593 of 981 trades sold; saved
  +$1.40M on losers, cost -$4.25M on the rest, BA 2024-08-01 -$297K, ORCL 2026-04-13 -$253K); -0.5: $111,061 / 17%;
  -1: $308,920 / 16%; 30 min at 0: $84,008 / 19%. Unseen worse in every cell ($87,016 / 14% for the main one vs
  $127,302). Winners rise (305 vs 171) because it sells the runners early at small gains. A 15-minute D2 is noise
  after the entry; no cell close. Not better.
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
- The close trade, Indi's way (`eod3.py`, 2026-10-24): no volume condition; the strongest stock at 15:55 (t vs SPY ×
  β over the last hour, or the day's C measure, >= 1.0 / 1.5 / 2.0) in the top 20% of its day's range our way, the
  nearest expiry 1-4 days out, delta 0.15 / 0.20 / 0.25, out in the next morning's first 30 minutes (open, 09:45,
  10:00, +50% / -30% till 10:00). 72 versions: the unseen lose with every one; none is positive every year on both
  lists. Best fair list: day strength >= 2.0, delta 0.20, sold at 10:00: $114,663 / 11% on 178 trades, positive every
  year (+1,348 / +1,036 / +384 a trade), $79,493 without the best 5; unseen $87,557. Day strength >= 1.5, delta 0.20,
  10:00: fair $121,919 / 16%, unseen $74,742, Favorites (a year) $145,759 on 142 trades. Selling at 10:00 is the best
  exit, the open the worst. Indi's own late overnight entries make +$4,450 a trade at $10K; the mechanical pick does not.
- The close trade held longer (`eod4.py`, 2026-10-24, eod3's entries with day strength >= 1.5 / 2.0): out at -30%
  else 15:50, +100% / -30%, a 30% trail from +50%, the champion's stop on the stock: all worse than selling at 10:00
  (median fair end $76K-$99K vs $113,713 at 10:00; unseen $74K-$83K vs $86,442).
- The close trade with support / resistance and a hedged winner (`eod5.py`, 2026-10-24, what the user meant the two
  ideas for): candidates filtered at 15:55 by "above a level it broke today" (true for 7,756 of 7,795 candidates: it
  filters nothing) and / or "not stuck under a level in the last hour" (797 stuck); the next morning, an option up
  +50% at 09:40 kept with a 30% trail (RUN), and the same with a stock hedge of contracts x 100 x delta x 0.5 shares
  (HEDGE). 72 versions: none positive every year on both lists. The filters add a little on the fair list (median
  $104,043 with both vs $100,119 without) and nothing on the unseen ($83,301 vs $84,557). Keeping the winners is
  worse than selling at 10:00 (median fair $102,691 RUN, $100,475 HEDGE vs $113,623; worst drop 14% vs 12%); the
  hedge helps the unseen a little over RUN and costs the fair list. Best: t >= 2.0, not stuck, delta 0.25, 10:00:
  fair $112,594 / 10% (175 trades), unseen $94,663.
- The close trade added to the chosen bot in one account (2026-10-24, the user: "if we add the trades to the champion
  it won't add more money?"; close trades sorted after the day's bot trades, 1% / 2% of the start-of-day account). eod5
  best (t >= 2.0, not stuck, d0.25, 10:00): fair $566,885 / 15% vs $526,469 / 10% alone, unseen $118,832 vs $125,581;
  eod3 best (day t >= 2.0, d0.20): fair $573,712 / 16%, unseen $109,967. At 2% the worst drop goes 18% -> 29-30%.
  More money only on the fair list, where the rules were chosen; less on the unseen, and the drop grows by half. Not
  better.
- Support / resistance at the 15:50 hold (`night_levels.py`, 2026-10-24, on the chosen bot): "above a support it broke
  today" is true for every held trade (74 of 74), so it filters nothing; "stuck under a level in the last hour" (8 of
  74): no hold when stuck $517,868 vs $526,469, unseen +$1K. Not better. What looked like a level gain (hold from +50%
  when above support and not stuck, $663,272) is the lower hold threshold alone: hold from +50% with no levels
  $661,989 (see Candidates).
- A stock hedge on the held night (`night_levels.py`): short contracts x 100 x delta x 0.5 shares at 15:50 (buy for a
  put), closed at the next morning's first sale: fair $373,951 vs $526,469 (2%: $1.11M vs $2.01M), unseen $115,724 vs
  $125,581; the full delta $260,414. It saves the worst nights (QCOM -45% -> +27%, BA -43% -> +4%) but gives back the
  gaps our way, which are where the held winners make their money.
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
- The +10 / +20 minute checks need the option down too (`opt_check.py`, 2026-10-24; the user's idea: "the stock not
  only needs to be against the entry but also the option should be worth 10% less"). Against the bot today (champion +
  the failed-break sale), all champion trades 2024-2026. "At the check" (the check fires only if both hold, else it
  passes, as today): -10% fair list $540,852 / 10% at 1% ($2,106,518 / 19% at 2%) vs $526,469 / 10% ($2,011,681 / 18%),
  every year positive, but unseen $123,253 vs $125,581; -5% $561,761 / $124,670; -15% $537,646 / $120,704; -20%
  $569,276 / $120,477. The fair-list gain is four trades (ORCL 2025-01-21 +39,670 points, MSFT 2026-04-08 +26,422,
  FSLR 2024-03-27 +24,680, META 2024-08-07 +11,496); the other 106 changed trades sum -$71K at $10K, and the unseen
  loses at every level. "From the check on" (the check stays armed until both hold): much worse, $374K-$440K on the fair
  list, it becomes a trailing stop that fires on the first dip (GOOGL 2026-07-31 -142K points). Not better: the fair
  list is a handful of trades and the unseen falls. sim.py: user_stop `opt_below` / `opt_wait`.
- Hours without the option up, and the stock weak vs SPY (`stall_rs.py`, 2026-10-24; the user's idea): on the entry
  day, from 1 / 2 / 3 hours after the entry, the option never closed +10% over the cost and (with rs) the stock's move
  vs SPY x beta since the entry, or over the last hour, is against us -> sell all. Against the bot today, all champion
  trades 2024-2026. The rule has almost nothing to act on: of the 813 fair-list trades, 258 are still open an hour after
  the entry and only 8 of those never got above +10% (3 at two hours, 1 at three); unseen 96 open, 8 under. So it
  changes 1-8 trades: fair list $521,248-$526,675 vs $526,469 (1h alone -$10K at $10K, SMCI 2025-10-01 -8,647;
  2h alone +$384), unseen $125,474-$125,822 vs $125,581. Not better, not worse: the +10 / +20 checks, the -30% stop and
  the failed break already sell the flat trades in the first 20 minutes, and a 0.15-delta option that survives them is
  rarely still under +10% an hour later. sim.py: `stall_rs {hours, gain, rs}`.
- The stock itself not moving (`still.py`, 2026-10-24; the user's idea): on the entry day, from W minutes after the
  entry, the stock's high-low range over the last W minutes under k x its usual move for that span (its 1-minute
  spread over the 5 sessions before x sqrt(W), the S30 unit of levels.py) -> sell all; W 30 / 60, k 0.5 / 0.75 / 1.0,
  pure and only while the option is under +10%. Against the bot today, all champion trades 2024-2026. Pure: much worse
  at every setting but one. 30-min under 0.5x $319,188 / 13% vs $526,469 / 10%; 0.75x $181,145; 1x $140,324; 60-min
  0.75x $270,673, 1x $173,205; unseen $97K-$119K vs $125,581. Most changed trades end better (119 of 206 at 30-min 1x:
  small losers cut earlier), but the rule sells the few big winners in their pauses (BA 2024-08-01 -210K points, ORCL
  2026-04-13 -224K, SMCI 2025-05-13 -207K, GOOGL 2026-07-31 -135K, AAPL 2025-08-06 -115K; NFLX 2026-02-25 -265K on the
  unseen), and the money is those trades. The one setting that gains on the fair list, 60-min under 0.5x ($534,866 /
  9%, 28 trades change, PDD 2024-09-04 +21,650 vs AVGO 2025-11-24 -30,290), loses on the unseen ($118,794 / 13%). With
  the option under +10% as a condition the rule fires on 0-7 trades and changes nothing ($523K-$528K; unseen $125.5K-
  $125.9K). Not better. sim.py: `still {window, k, under}`.
- A wider -X% stop, by days to expiry (`stop_dte.py`, 2026-10-24; the user's request: "50% for 1-2 days and 40% for
  4-7 days", 3 DTE taken with 4-7). Against the bot today (-30%), all champion trades 2024-2026 (fair list: 373 trades
  at 1-2 DTE, 440 at 3-7). Fair list at 1%: -30% $526,469 / 10%; flat -40% $510,995 / 10%; flat -50% $521,758 / 11%;
  -50% / -40% by DTE $511,473 / 11%; -40% / -30% $511,163 / 10% (at 2%: $2.01M / 18% vs $1.89M / 22% for the user's
  version). Unseen: $125,581 / 10% vs $133,590 / $132,061 / $132,393 / $132,894 (11%). Every year positive everywhere.
  The unseen gain is two trades (UNH 2024-12-05 +53,000 points, LLY 2025-10-01 +23,120); the other 93 changed trades
  sum -$22K at $10K. On the fair list the wider stop loses $15K and adds a point of drop (4 points at 2%): the extra room
  mostly lets losers run to -50% (311 trades change, 93 better). The 1-2 DTE trades do not gain from the wider stop on
  the fair list (+2,217 vs +2,290 a trade); the 3-7 DTE trades are flat. Not better by the rule; the user's call on
  the live bot (more room, more drop). sim.py: user_stop `out_by_dte [[max dte, out], ...]`.
- Exits in the first minutes (`early_exits.py`, 2026-10-24; the user's question: how many exits before the 10-minute
  check cut trades off). Bot today, fair list: 168 of 813 trades are sold within 10 minutes of the entry (98 by the
  -30% stop, 68 by the failed break); they made -$484,558 at $10K. Held past 10 minutes (no stop and no failed-break
  sale before +10, the checks keep their times) the same trades make -$511,021; past 20 minutes -$519,333. Whole list at
  1%: $526,469 / 10% today; no early exit before 5 min $517,487 / 10%; 10 min $507,145 / 10%; 20 min $504,482 / 11%
  (2%: $2.01M / 18% -> $1.84M / 22%). Unseen: 59 of 273 sold early (-$163K); held past 10 min -$112K, and the list goes
  $125,581 -> $132,436 / $133,308, but it is UNH 2024-12-05 (+53,000 points); the rest is about even. First sale after
  the entry on the fair list: 78 within 5 minutes, 192 within 10, 472 within 20, 590 within 60, of 745 same-day sellers.
  Verdict: the early stops and failed-break sales are right more often than wrong; delaying them costs money and adds
  drop. Not better. sim.py: `first_exit_min N`.
- A wider stop right after the entry (`early_stop50.py`, 2026-10-24; the user: "check 50% stop only for the first 10
  minutes"): -50% in the first N minutes, then -30%; checks and failed break as today. Fair list at 1% vs $526,469 / 10%
  ($2.01M / 18% at 2%): -50% / 10 min $508,356 / 10% ($1.87M / 20%), 114 trades changed, -$34,715 at $10K; -40% / 10
  $507,446; -50% / 5 $521,374; -50% / 20 $513,523 / 11%. Unseen vs $125,581: -50% / 10 $131,653, -40% / 10 $132,307,
  -50% / 20 $130,943, but it is UNH 2024-12-05 again (+53,000 of +48,703; the other 31 changed trades -$4.3K). Lower on
  the fair list in every version and every year. Not better. sim.py: `early_out {min, out}`.
- Buy back the half (`rebuy.py`, 2026-10-24; the user: "buy back the half if the stock goes back"): after the +10
  check sold half, buy it back once on the entry day (until 15:00 NY) at the next bar's middle + 2%; then the stop and
  the hold use the average cost. A at the 20-minute check when the stock is not against (55 rebuys on the fair list):
  $537,970 / 10% vs $526,469 / 10% ($2.09M / 19% vs $2.01M / 18% at 2%), but +25,059 of changed trades is ORCL
  2025-01-21 +39,080 and FSLR 2024-03-27 +24,153; the other 53 sum -$38K, and 2026 is lower. B0 at the first close back
  past the entry (99) $527,872; B1 0.25 S30 past it (72) $526,825. Unseen lower in all: A $123,372 / 11%, B0 $122,377,
  B1 $123,173 vs $125,581 / 10%. Not better: a second try at the same trade loses except for two big ones. sim.py:
  `rebuy {mode, off, until}`.
- Sell the rest after the +10 half (`rest20.py`, 2026-10-24; the user: "if buying the half back is not helping, isn't
  selling in that spot saving money?"). The mirror of the rebuy: the rest always out at +20 once +10 sold half, fair
  $508,588 / 13% vs $526,469 / 10% ($1.88M / 24% vs $2.01M / 18% at 2%), 55 trades changed -$35,761: ORCL 2025-01-21
  -39,404, FSLR 2024-03-27 -24,560, HOOD 2025-06-24 -9,608 (without ORCL and FSLR the change is +$28K). Unseen $127,475
  vs $125,581 (+$14.9K on 15 trades). All at +10 when against: fair $485,867 / 14%, unseen $123,613. Not better: the
  kept half is a loser on most trades and pays for itself with the rare ORCL; selling it raises the drop. sim.py:
  `user_stop.rest_after_half`.
- More air unless the thesis breaks (`thesis.py`, 2026-10-24; the user's goal: a -50% stop "if our thesis is not
  broken"). Thesis exits on the stock, entry day: a close k S30 against the entry (k 0.5 / 1 / 1.5), a close past the
  signal bar's low (put: high), or the signal's own cumulative t-stat vs SPY x beta down to 0 or 0.5; with the option
  stop at -50%; checks, failed break and overnight hold as today, plus "no checks" versions. Fair list at 1% vs
  $526,469 / 10% today ($2.01M / 18% at 2%): -50% alone $521,758 / 11%; + 0.5 / 1 / 1.5 S30 $388,408 / $364,100 /
  $486,665 (14-16% drop); + signal bar broken $326,532 / 15%; + t ≤ 0 $510,221 / 11%; + t ≤ 0.5 $539,410 / 11%
  ($2,103,523 / 21% at 2%); all three $329,646; no checks + 1 S30 $377,987 / 18%; no checks + t ≤ 0 $532,492 / 14%
  ($2.00M / 26%, 28% winners). Unseen vs $125,581 / 10%: -50% alone $132,061, + 0.5 S30 $134,655 / 9%, + t ≤ 0.5
  $131,152 / 11%, no checks + t ≤ 0 $131,804 / 12% (UNH 2024-12-05 and LLY 2025-10-01 in all of them). The stock stops
  (S30, signal bar) are right on most trades (305 of 454 better at 0.5 S30) and sell the few big winners on a normal
  pullback (COIN 2026-08-19 -152K points, GOOGL 2026-07-31 -142K, COIN 2025-06-18 -107K): the money is lost there. The
  t-stat is the one thesis measure that does not do that: t ≤ 0.5 fires on 99 trades, 18 at t ≤ 0. Candidate, not
  champion: -50% + t ≤ 0.5 is ahead on both lists (+$13K fair, +$5.6K unseen), every year positive, but one point more
  drop (3 at 2%) and the fair gain is a few trades (MSFT 2025-04-09 +25,781, MSFT 2026-06-26 +19,437, HIMS 2025-09-04
  +15,071 of +26,235 total). sim.py: `thesis {s30, bar, t}`.

- The volume alert as a second way through the volume gate (`alert_gate.py`, 2026-10-24; the user's question after ORCL
  2026-09-29, where the bot bought at 10:27 at the top because the day's volume reached 1.5× only then, while the site's
  alert fired at 10:18): t ≥ 1.8 and (day volume ≥ 1.5×, or an rvol-v6 alert our way in the last 5 / 15 minutes), the
  alert as in `packages/alerts/src/relative-volume.ts` on regular-session bars (3-minute volume ≥ 4× the same minutes'
  median or today's pace, move ≥ 3× the usual and ≥ 0.5%, one-direction candle; no cooldown). Against the champion (fair
  $585,592 / 11%, unseen $123,028 / 11% at 1%): ag5 fair $510,706 / 13% ($1.83M / 24% at 2%), lower per trade every
  year, a bigger worst drop, worse without the best 5; unseen $118,877 / 12%. ag15 the same ($510,512; $117,584).
  The signal changes 1,392 stock-days (507 earlier on a champion day, 885 new days) but only 178 trade: 715 are illiquid
  and 328 too cheap at that minute. Three parts: (1) earlier entries on champion days, 59 trades, +4,430 a trade vs the
  champion's +1,568 on the same days, all of it PLTR 2025-02-19 (+158K vs +8K, 23 minutes earlier) and GOOGL 2025-05-07
  (+40K vs −1K); (2) 14 champion trades lost because at the earlier minute the contract had not traded 200 contracts in
  the last 30 minutes, among them ORCL 2025-07-02 +101,315 (2 minutes earlier) and FSLR 2024-03-27 +26,626; the sim and
  the bot do not try again later; (3) 90 new days, where the day's volume never reached 1.5× by the signal: 6 winners,
  −2,346 a trade, negative in every year, −2,500 a trade under 1.2× day volume and −759 at 1.2–1.5×. Unseen: 10 earlier
  (+418), 7 lost (+3,250), 11 new (−2,040). ORCL 2026-09-29 itself: the alert-gated signal at 10:17 at 137.30 finds the
  contract illiquid, so the bot would not have bought there either. Not better: the burst-only days lose, as with the
  3× 5-minute burst, and the earlier minutes hit thin contracts.
  - **Contract fallbacks: a higher delta when the 0.15 option is under $0.20, and the nearest liquid strike when it has
  under 200 contracts (`cheap_up.py`, the user's rule, 2026-10-25):** on the champion's own signals after the news
  filter (fair list 2,242: 813 bought, 365 too cheap, 1,064 illiquid; unseen 5,977: 273 / 1,732 / 3,972), re-picked
  and walked with the rest-stop champion's exits (baseline reproduced: 813 trades, $811,353 / 11%) and the live bot
  2.3's. *Cheap* (the nearest-the-money strike at $0.20 or more, the one closest to $0.20; delta median 0.30, price
  median $0.25): fair 990 trades, $903,025 / 11% ($5,227,611 / 21% at 2%), the 177 added trades +844 each (+$149K),
  but +$210K of it is IBIT on 28 trades and RBLX / ROKU / UPST on 9; the unseen 627 trades, $85,156 / 34%
  ($66,255 / 56%), the 354 added trades −1,052 each (−$372K), 2024 and 2025 negative. *Liquid* (the nearest strike
  toward the money with 200 contracts, delta up to 0.35; median 0.22, $1.04): fair 1,451 trades, $914,253 / 14%, the
  638 added +286 each; unseen 827 trades, $87,682 / 34%, the 554 added −594 each (−$329K). On the live bot 2.3's exits
  the same picture ($793,727 / 13% and $794,075 / 16% fair; $84,850 / 31% and $90,270 / 30% unseen). Not better:
  both fail the unseen test as the retry-until-200 did. Three different ways of taking the signals the contract rule
  refuses (wait for the crowd, step to a liquid strike, pay up for a dearer strike) all lose on the unseen stocks: the
  thin or cheap contract is a symptom, the options crowd is not in that stock at that moment, and the signal there has
  no edge. The fair-list gain is hot names (IBIT, MSTR, ARM) where any contract works. The live bot (checked 2026-10-25) is at
  `minVolume` 200 and `minPrice` 0.15, so it already takes the $0.15–0.20 contracts the research refuses; a lower
  volume floor would be the 10-contract baseline in practice (twice the trades, twice the drop, real fills on thin
  contracts worse than the simulator's mid ± 2%).
  On the user's Favorites year (`fav_cheap_up.py`, the 63 stocks, 2025-10-24 to 2026-10-23, the live bot 2.3's exits;
  baseline 405 trades, $178,542 / 12%): *cheap* adds 82 trades (18 winners, +2,418 each, +$198K at $10K) for
  $209,861 / 11% ($362,903 / 20% at 2%), but IBIT is +$233K of it on 20 trades (two of them +128K and +115K); the other
  62 added trades lose, SMCI −22K on 10. Eight of twelve months negative. *Liquid* adds 423 trades (+341 each) for
  $197,184 / 15%, MSTR / NOW / IONQ / META +$391K against ORCL / MRNA / ASTS / LLY / IREN −$143K. Both together
  $234,105 / 17%. The same hot-name effect as the fair list, one stock deep here; not a rule.
  The liquid fallback the user's way (`cheap_up2.py`, 2026-10-25, on the live bot 2.4; baseline $695,450 / 9%
  reproduced): an illiquid 0.15 goes first further out to delta 0.10, then toward the money to 0.30, the nearest
  to 0.15 with 200 contracts and $0.20. Fair $745,199 / 15% at 1% ($3,394,783 / 31% at 2%), 2025 +535K vs +775K,
  without the best 5 $242,100 vs $260,844; the 551 added trades +156K, -524K without their best 5 (ARM 2024-04-17
  +339K alone). With cheap (both2): $823,762 / 20%. Unseen: $107,981 / 24% and $75,568 / 42% vs $127,433 / 9%.
  Further out (155 picks) +237K on the fair list but -98K on the unseen. Not better, as the other fallbacks.
  Under the risk manager (`fallback_risk.py`, risk_overlay.py's account): at 2% with today's (refused when over)
  the bot 2.4 is $3,147,385 / 26% fair, $138,363 / 23% unseen; liquid2 $2,877,072 / 34% and $101,165 / 46%; both2
  $2,725,172 / 34% and $61,388 / 65%. With PR #130 (half under the brake) both2 is $2,709,158 / 26% and $69,515 / 47%
  vs the plain bot's $2,173,513 / 16% and $106,773 / 16%. The risk manager trims the drop but not the unseen losses:
  the fallbacks still fail. At 1% it never binds on the plain bot.
  On the unseen stocks whose options trade (`active_unseen.py`: 10%+ of their signals had a tradeable 0.15 contract,
  17 stocks, NFLX / UNH / XOM / JPM / COST / V ...; the fair list's median is 30%): bot 2.4 $132,559 / 7% at 1%; cheap
  $125,406 / 14%, liquid2 $114,579 / 12%, both2 $106,656 / 15%; the added trades -52K / -141K / -212K at $10K. At 5%+
  (42 stocks) the same order. The fallbacks lose on liquid unseen stocks too.
  On the live bot 2.4's exits (the rest at −20% after the +10 half; `BT_LIST=fav_rest_bot BT_REST=-0.2`, baseline 405
  trades, $179,264 / 12%): *cheap* $210,297 / 11% ($364,578 / 20% at 2%), the 82 added +2,391 each, IBIT +$235K of
  +$196K; *liquid* $200,816 / 15%; *both* $238,611 / 16%. The same as on 2.3 within $4K; the exits do not change it.
  On the champion (the D2 bonus entry, `BT_LIST=fav_d2 BT_REST=-0.2 BT_FAILED_BREAK=0`; baseline 495 trades,
  $183,487 / 14%): *cheap* 595 trades, $235,837 / 14% ($435,239 / 27% at 2%); *liquid* 988 trades, $253,152 / 16%;
  *both* 1,060 trades, $313,196 / 17% ($688,676 / 31%). On the champion with the bot's failed-break sale (`fav_d2_bot`;
  baseline $191,220 / 12%): *cheap* $231,953 / 14%; *liquid* $243,929 / 16%; *both* $306,762 / 17% ($674,145 / 31%).
  All twelve are on the Backtest Reports dashboard ("The contract rules on the favorites year"). The favorites year is
  the user's own list in-sample, so these are re-tests, not the champion test: on the fair list and the 151 unseen
  (`cheap_up.py` above) both rules fail.
  **Fixing the fallbacks' drop (`fallback_drop.py`, the user, 2026-10-25: "the 2 rules make more trades but hurt the drop very
  much ... cut losses or check for gain taking somehow to reduce the drop"; the grid set before running):** version 2.5 (the D2
  entry, rest-stop exits, no failed break) with *both* fallbacks, the champion's own contracts keeping their exits, the fixes on
  the fallback trades or on the account. Baselines reproduced: fair $1,005,221 / 11% (981 trades), unseen $127,303 / 11%,
  favorites $183,487 / 14%. *Both* on 2.5: fair 1,913 trades, $1,100,066 / 20% ($6,333,859 / 37% at 2%), the 932 fallback
  trades +237 each (the illiquid route +7 on 686, the too-cheap route +878 on 246), 2024 +650K vs +793K; unseen 1,377 trades,
  $67,770 / 51%, the 1,028 fallback trades -584 each; favorites $313,196 / 17%. Exits on the fallback trades: the -20% stop
  (not -30%) $1,132,002 / 18% fair, unseen $67,738 / 49%; half out at +50% $838,769 / 19% and at +100% $847,556 / 19%
  (unseen $76-83K / 43-45%); -20% stop + half at +50% $861,076 / 17%; out at 60 minutes if under water $1,174,700 / 20%.
  Account overlays: the fallback trades at half size $1,071,556 / 15% (unseen $93,635 / 33%); a cap of 3 / 4 / 5 new trades a
  day cuts the champion's own trades and ends at $520-526K / 23-27%; no new entry once the day's closed trades lost 1 / 1.5
  trade sizes $785,022 / 27% and $890,444 / 28%; at most 1 / 2 fallback trades a day (champion contracts untouched)
  $856,892 / 19% and $820,650 / 20%; fallback trades only on days without a champion trade $907,586 / 16%, and only one of
  them $1,051,883 / 14% (118 trades, unseen $99,283 / 26%). Not better in any cell: no fix brings the drop back to 11% while
  keeping the money, and every one leaves the unseen far under $127,303 / 11%. Why: the fallback trades have no edge (+237 a
  trade on the fair list against +2,639 for the champion's contracts, -584 on the unseen), so they add variance and no return;
  the drop goes with the trade count (3.2 a day instead of 1.6; the 20% fair drop is 253 trades from 2024-08-21 to
  2025-01-17, 130 of them fallbacks, where 2.5 alone had 61 trades and 11%). Cutting the losers tighter or taking gains
  reshapes each trade's loss but not the edge; only fewer fallback trades reduce the drop, and then the added money goes too.
  The fallbacks stay out of the bot; the drop lever remains the size (D2 at 1.75% ~ 2.4's drop at 2%).
  **The overnight cap, everywhere (`night_cap.py`, 2026-10-25):** the user saw "Held overnight ... $541,545 at risk (34.7% of
  the account)" in a trade window and asked for the live bot's 10% night cap always and everywhere. Done in the simulator
  (`sim.cap_steps` / `sim.result(cost, steps, pct)`, `params.json` `exit.night_cap`, `BT_NIGHT_CAP`), in `lists.py`
  (`ret`, `ret_2pct`, `ret_nocap`), on every stored list and on both dashboards (the trade files carry a return per size,
  the pages apply the cap at the chosen size and show the cap sale in the trade window). The numbers are in "The overnight
  cap" above the champion table. Also found and fixed: the Backtest Reports "Overnight" column read only the first fills
  file, so every list whose fills are in parts 2-5 (the favorites lists) showed a dash.
- **Second round, the user's changes (2026-10-24):** the contract's liquidity floor is 10 contracts in the last 30
    minutes instead of 200 ("contract liquidity is not my concern"), now the default in `params.json` (`min_vol30`; the
    live bot's `minVolume30` in `packages/trading/src/bot/picker.ts` is still 200), and the alert route needs day volume
    ≥ 1.0× (`ag5r10`). The champion re-run at 10 contracts (`sv10_t18r15`) is a different baseline: fair list 1,484
    trades (813 at 200), +1,931 / +932 / +1,579 a trade, $603,077 / 21% at 1% ($2,332,447 / 37% at 2%) vs $585,592 /
    11% ($2,444,629 / 21%); unseen 1,484 trades (273), $124,227 / 23% vs $123,028 / 11%. The floor roughly doubles the
    trades and the worst drop for about the same end: the thin contracts it lets in make little. Against that baseline,
    ag5r10: fair $584,717 / 24% ($2,121,184 / 42% at 2%), per trade +1,941 / +860 / +1,253, without the best 5 −29K /
    −230K / −193K vs −101K / −150K / −95K; unseen $118,933 / 26% vs $124,227 / 23%. The 1.0× floor drops 276 of the
    885 new days, but the 139 that trade still lose −2,132 each (13 winners), and 21 champion trades are lost to the
    earlier minute; the 121 earlier entries make +3,262 vs the champion's +1,415 on the same days (PLTR 2025-02-19,
    FSLR 2024-03-27 +134K, COIN 2025-06-18, PDD 2024-04-22). ag5 without the floor at 10 contracts: fair $538,587 /
    25%, unseen $119,276 / 26%. Not better either way.
  - **The liquidity floor swept (2026-10-24, the user asked about 50):** the 10-contract run sliced by the contract's
    volume in the 30 minutes before the signal (recomputed from the cached option bars; the ≥ 200 slice is the logged
    champion's 1,134 trades exactly). Fair list at 1%: 10 → $603,077 / 21%; 25 → $542,485 / 20%; 50 → $534,950 / 18%;
    100 → $642,229 / 18%; 200 → $585,592 / 11%; 300 → $360,952 / 12%. Unseen: 10 → $124,227 / 23%; 25 → $87,583 / 28%;
    50 → $95,931 / 22%; 100 → $146,787 / 11%; 200 → $123,028 / 11%; 300 → $135,715 / 8%. By band, fair list per trade:
    10–25 +870 (138), 25–50 +150 (142), 50–100 −906 (199), 100–200 +694 (192), 200–500 +2,358 (275), 500+ +2,462 (538);
    unseen 10–25 +998, 25–50 −269, 50–100 −1,535, 100–200 +850, 200–500 +136, 500+ +2,170. Under 200 the added bands
    are near zero and not monotonic (noise); the money is in contracts with 200+ traded. 100 is one good cell between
    two bad ones, picked from these numbers, so not a champion. The simulator fills thin contracts at the mid ± 2%, so
    every slice under 200 is an upper bound. 200 stays the research default (reverted from 10 in `params.json`).
  - **Volume-fade exit on the alert-route entries (`alert_gate.py fade`, sim.py `vol_fade`, 2026-10-24, the user's rule:
    "if the volume stops increasing and we are not reaching 1.5×, exit"):** for an entry taken with day volume under
    1.5×, sell all at the first minute, N minutes or more after the entry, when the day-volume ratio is lower than N
    minutes earlier and still under 1.5×; off once 1.5× is reached. On ag5r10 at the 200-contract floor (fair
    $528,844 / 12%, unseen $118,941 / 12%, 149 changed trades). N = 5: fair $551,049 / 11% ($2,130,980 / 22% at 2%),
    unseen $119,207 / 12%; N = 10: $552,442 / 12%, $118,022; N = 20: $552,834 / 12%, $118,896. The exit does what
    it should on its group: at N = 5 it cuts 42 fair-list trades from −1,460 to −492 a trade (7 → 16 winners after
    the cut), at N = 20 22 trades from −1,233 to +764. It is not enough: ag5r10 + fade still ends under the champion
    ($585,592 / 11%) on the fair list and under it on the unseen, because the 14 champion trades lost to the earlier
    minute (+7,653 a trade, the contract under 200 contracts at the alert) and the new days that never fade (26 of
    68) are not touched. A working component, not a champion; it belongs with an entry that waits for the options
    crowd (arm on the alert, enter when the contract has 200 contracts), not yet run.
  - **The 1.2× alert route, and the entry that waits for the options crowd (`alert_gate.py retry` / `champrt`, tiers.py
    `BT_RETRY_ILLIQUID`, 2026-10-24, the user's pick of 1.2×):** ag5r12 = t ≥ 1.8 and (day volume ≥ 1.5×, or an alert
    our way in the last 5 minutes with day volume ≥ 1.2×). Plain: fair $496,737 / 12% vs $585,592 / 11%, unseen
    $118,761 / 12% vs $123,028 / 11%; with the volume fade (5 / 10 / 20 min) $493K / $506K / $507K, unseen $117-119K.
    The wait: a signal whose contract has under 200 contracts in the last 30 minutes is tried again every minute until
    it has them (or 15:44), the entry moving to that minute. On the champion's own signals it adds 660 fair-list
    trades (813 → 1,473; +878 a trade, +$579K at $10K; median wait 11 min) and ends $912,400 / 17% ($4,848,880 / 32%
    at 2%), better without the best 5 (−98K / −7K / +41K vs −193K / +39K / −139K). On the 151 unseen it adds 657
    trades at −708 each (−$465K) and ends $75,818 / 33% vs $123,028 / 11%: a failure of the unseen test as clear as
    the sector filter's. No wait bucket, follow-through band or hour rescues it there (the 1-5 minute waits are the
    only positive bucket, +412 a trade on 112; a 15-minute cap, picked after the fact, still ends the unseen at
    $99,299). The fair-list gain is MSTR, COIN, QCOM: hot names where a late entry still catches the run. ag5r12 +
    the wait tracks the champion + the wait a little lower on both lists ($846,441 / 19%; unseen $72,636), so the
    alert adds nothing on top of the wait. Verdict: the wait is a hot-name effect, not a rule; the alert route loses
    at every volume floor tried (0, 1.0, 1.2) with or without the fade and the wait. The alert engine's use for the
    bot, if any, is not at the entry.
  - **The champion's trades tagged with the alerts (2026-10-25):** before the signal the alert does not travel (a
    same-side alert before: fair +4,511 vs +1,807 a trade; unseen −1,373 vs +1,536). After the entry it reads whether
    the trade is alive on both lists: a same-side alert within 30 minutes fair 170 trades, 35% winners, +9,099; unseen
    41, 41%, +5,536; no alert at all after the entry fair 434, 12%, −1,244 (−$540K), unseen 196, 16%, −1,259. But the
    unseen's big trades (COST, WMT, PEP: overnight gaps) never alert during the day, so an "alert-silence" exit would
    cut 6 of its top 10; not run. The 15:50 hold shows nothing (83–94% winners with or without a late alert).
  - **Double the position on the first same-side alert after the entry (`alert_add.py`, tiers.py `BT_RISK`, 2026-10-25,
    the user: "double the premia"):** the champion's signals with the alert minute as the B add (same contract, same
    premium again, only if the option is above cost and nothing sold), within 30 / 60 minutes. Fair list: $777,680 /
    17% ($3,742,497 / 31% at 2%) vs $585,592 / 11%; 130 trades got the add, the add leg +2,991 a trade but 23%
    positive and BA 2024-08-01 is +234K of its +389K; worse without the best 5. 60 min: $832,687 / 17%, 152 adds.
    Unseen: $114,260 / 13% vs $123,028 / 11%; 28 adds, the add leg −2,666 a trade, 11% positive. Not better: the
    unseen loses, the fair-list gain is one trade, and the worst drop grows with the size.
  - **Conclusion on the volume alert and the bot (2026-10-25, after the two days above):** the site's rvol-v6 alert does
    not improve the bot's rules. Tested and not better: the alert as a route through the volume gate at floors 0 / 1.0 /
    1.2×, with and without the volume-fade exit; the entry that waits for 200 contracts (fails the unseen); doubling
    the position on a same-side alert after the entry (fails the unseen, one trade on the fair list); the alert-silence
    exit was not run because it would cut the unseen's big overnight trades. Why: the champion already measures what
    the alert measures, the stock's volume and move, only more slowly; what the alert adds at the entry is a burst
    without follow-through (loses) or an earlier minute at which the options are not yet tradeable; and the money is
    made where the alert does not look, in the options crowd arriving (contract volume, the 200-contract floor is a
    step not a slope) and in the overnight gaps. What it does give: (1) for the user, its own validated "look now"
    value (a big move within 30 minutes about a third of the time against a one-in-ten base); (2) for the bot, a live
    read of open trades, an alert after the entry means the trade is alive on both lists and none means the loser pool,
    which belongs on the Bot tab as a state per position, not as an order trigger. Open, and testable only live
    because the bar cache has no extended hours: log pre-market alerts on the bot's watchlist before the open and
    post-market alerts on carried positions in the paper bot, next to what the 09:40 morning rule then did, for a few
    months, then judge whether they help that decision. Scripts: `alert_gate.py` (the port of the alert, the routes,
    the fade and the wait), `alert_add.py` (the add); sim.py `vol_fade`, tiers.py `BT_RETRY_ILLIQUID` and `BT_RISK`.
- **0DTE with the volume alert (`zero5.py`, sim.py `alert_silence`, `rvol_alert.py`, 2026-10-25; fair list only, the
  user dropped the unseen test that day; zero4's breakout signals and walks reused, deltas 0.15 / 0.25, exits S / T100
  / THIRDS):** (1) the alert-silence exit, no alert on the stock within 30 (15) minutes of the entry → out: on the
  stop-only strategies that make the 0DTE money it halves the worst drop and lifts the hit rate from 9% to 16–24%,
  but the end is mixed (any|c2 δ0.15 S $147,567 / 20% → $122,020 / 15% at 30, $130,363 / 13% at 15; day|c2 δ0.15 S
  $131,964 / 18% → $140,232 / 13% and $156,589 / 10%); on the take-profit exits it changes nothing. A risk reducer, not
  an edge, and every 0DTE strategy is still under $100,000 without its best 5. (2) The alert-confirmed entry (a
  same-side alert in the last 5 / 15 minutes at the breakout): 27–76 trades per strategy, very low drawdowns (3–6%)
  because few trades, but no year pattern (any|c2 δ0.15 S, alert in 15: 37 trades, −5,396 / +10,277 / +10,334,
  $127,994 / 4%); the 2024 money sits in the breakouts without an alert. (3) The alert as a bonus (the user's idea, as
  read here: the confirmation's day-volume ratio counts 1.5× for 15 minutes after a same-side alert, c1b / c2b):
  1–8% more signals, results within noise of c1 / c2 (S a little worse, THIRDS a little better; prev|c2b δ0.25 THIRDS
  $97,645 / 4% vs $94,548 / 6%). (4) **The alert straddle**, the first alert of the day in either direction, 09:40–
  13:00 New York, the nearest OTM call and put of the same-day expiry, one contract each, both legs at 200+ contracts
  (274 of 988 first-alerts qualify; 70% skipped as illiquid or under $0.20): held 60 minutes $115,906 / 6% at 1%,
  41% winners, +1,188 / +590 / +91 a trade, every year positive, $103,259 without the best 5; 30 minutes about the
  same ($115,567); longer holds lose to theta (90 min $95,818, to the close $86,137); a +50% take hurts ($104,253),
  a −50% stop changes nothing. By parts: Fridays 238 trades $114,296 / 4%; alerts down 140, $112,627 / 3% vs alerts up
  134, $102,928; 10:30–12:00 best ($115,738), 12:00–13:00 negative; spread over META, AMD, NVDA, AMZN, MSTR; worst
  HIMS, MU, ORCL. Median trade −1,273, 14% of trades over +50%, 19% under −30%; 2026 nearly flat. The one 0DTE result
  that is positive every year and without its best 5, and the one use of the alert that matches what it is validated
  for (a move within 30 minutes, direction unknown). Small: about +6% a year at 1% a trade with a 6% worst drop; the
  fill model (mid ± 2% a leg) flatters a two-leg trade. Not a champion by the log's rule (a different strategy, not
  a better version), logged here as the only alert finding with a live edge. Not run on the unseen (the user's call).
  - **The user's version, the 0.35-delta strangle with leg management (`zero5.py strangles`, 2026-10-25):** on the first
    alert, buy the 0.35-delta call and put of the same-day expiry (one each, both legs 200+ contracts; 307 of 988
    first-alerts); when the side is confirmed, sell the wrong leg and ride the right one. Confirmation: the stock 0.25
    (or 0.5) of its typical 30-minute move (`levels.ctx` S30) from the entry close, or the leading leg up 30%; no
    confirmation within 60 minutes → both legs out. The kept leg: the 60-minute clock, a 30% trail off its high to
    15:30, the champion-style −30% stop with the stock against, or +100% / 120 minutes. On the same 307 entries: the
    near-the-money straddle held 60 min $110,363 / 6% (256 tradeable), the 0.35 strangle unmanaged $108,521 / 9%;
    confirm 0.25 S30 + trail 30%: **$120,078 / 2%**, 39% winners, +1,010 / +628 / +375 a trade, $106,954 without the
    best 5; confirm 0.25 + 60-min clock $119,302 / 5%; confirm 0.5 + clock $118,288 / 8%; leg +30% + clock $118,144 /
    8%. The stop-30 keeps lose the hit rate (21–24%) and the +100% take gives the edge back. It is a band, not a cell:
    at delta 0.30 confirm 0.25 + trail $120,773 / 4% (clock $113,052), at 0.40 $115,049 / 2% (clock $119,697 / 4%),
    every year positive in all of them. Breakdown at 0.35 / trail: Fridays 263 trades $118,158 / 2%, not Friday 44
    about flat; alerts up $109,005 and down $110,218; 09:40–10:30 $107,754, 10:30–12:00 $115,787, 12:00–13:00
    $96,229 (negative in every variant and in the straddle; not applied as a cutoff, it would be picked from the
    result); by stock CVNA, GOOGL, QCOM, AMZN, AMD, TSLA, MSTR positive, COIN and ORCL the worst; median trade −533,
    7% of trades over +50%, 1% under −30% (selling the wrong leg recovers part of the premium, which is where the 2%
    worst drop comes from). Better than the straddle on end, drawdown and 2026, at the same small scale: about +7% a
    year at 1% a trade with a 2–4% worst drop, two trades a week, Fridays. Caveats: four fills a trade at the mid ± 2%
    (the fill model's weakest case), 0DTE only on expiry days, liquid names only. The best alert result of the study;
    a strategy of its own, next to the bot, not a rule for it.
  - **The strangle, wider (`zero6.py`, 2026-10-25; the user asked for a 45% trail and a wider look; results page
    https://claude.ai/artifact/Uug3uh6G7MWQcvRTMfq3tM):** 630 variants, delta 0.30 / 0.35 / 0.40 × confirmation 0.15 /
    0.25 / 0.35 / 0.5 S30 or leg +30% × wait 30 / 60 / 90 × kept-leg exit trail 20 / 30 / 45 / 60%, 60 / 90-minute clock,
    hold to 15:30 × fill mid ± 2% or 5% a leg. At 0.35, confirm 0.25, 2%: trail 20 $118,397 / 2% (the best without the
    best 5, $109,282), trail 30 $120,078 / 2%, **trail 45 $113,401 / 6%** (2026 negative, $99,725 without the best 5),
    trail 60 $111,158 / 11%, clock 60 $119,302 / 5%, clock 90 $106,030 / 11%, hold to close $92,559 / 19%: the trail band
    is 20–30%, 45% gives the kept leg's gains back. The wait cap never binds: the stock reaches 0.25 S30 within a median
    of 3 minutes of the alert, in every trade, so 30 / 60 / 90 give identical results; the rule is in effect "buy both,
    sell the wrong one within minutes". Confirmations 0.15–0.35 S30 all work (trail 30: $117K–$120K), 0.5 and the leg
    rule are weaker. Deltas: 0.30 trail 30 $120,773 / 4%, 0.40 $115,049 / 2% (clock 60 $119,697 / 4%). **Fill: at
    mid ± 5% a leg the edge is gone**, trail 30 $99,260 / 7% (2025 flat, 2026 negative), trail 45 $94,095 / 13%. Four
    fills a trade at 3 points more each is the whole edge, so the live result hangs on execution: tight spreads, limit
    orders at the mid, and a paper run before any size. Everything else as before: Fridays carry it, 12:00–13:00 loses,
    spread across names.
  - **Market filters, the D bonus, fills 2–5%, sizing 1–4% (`zero7.py`, 2026-10-25; the user: "is it using any other
    filter? the SPY strength and the D bonus; when SPY drops the alerts go crazy"):** the strangle used only the alert,
    the 09:40–13:00 window, the news filter, 200 contracts a leg and the fair list. Context at the alert: breadth (how
    many of the 40 stocks alert within ±2 minutes: 0 on 105 of the 307 trades, 3+ on 73), SPY's own 3-minute move vs its
    normal (3× or more on 107), the stock's C t-stat vs SPY × β. **The market-move alerts are not worse:** breadth < 3
    drops 73 trades and ends lower ($111,817 / 3% vs $120,078 / 2%; 2025 turns −28), SPY calm (< 2×) $111,775 on 152
    trades, (< 3×) $111,043; for a non-directional trade that sells the wrong leg within minutes a market move is still a
    move. **Strength agreeing with the kept leg** (the C t-stat's sign = the kept side; 158 trades) is a risk filter, not
    a money one: $115,586 / 1% at 1%, the most even years (+1,018 / +996 / +817), at 4% a trade $174,530 / 3% vs the
    base's $197,293 / 7%, and the best survivor at a 4% fill ($107,989 / 2% vs $105,641 / 5%). Confirming on the excess
    move (stock − β × SPY) is a little worse ($116,535). **D bonus, the wrong leg's proceeds reinvested in the kept
    leg at confirmation** (a first run double-counted the proceeds as premium and was wrong): $134,414 / 3% at 1%
    (2%: $177,439 / 6%; 4%: $294,868 / 11%), 39% winners, +1,922 / +879 / +589, **$113,977 without the best 5**, the
    highest of the study; with the strength filter $123,772 / 2%, +1,944 / +1,301 / +1,095. A second unit of new premium
    instead: $124,037 / 2%. Fills: base at 3% $112,561 / 3%, at 4% $105,641 / 5%, at 5% $99,260; D-recycle at 4%
    $111,460 / 5%; the recycle and the strength filter are the two things that keep a positive edge at a 4% fill (D-recycle
    + strength at 4%: $112,068 / 3%). Sizing is near-linear in the simulator (base: 1% $120K / 2%, 2% $143K / 4%, 3%
    $169K / 6%, 4% $197K / 7%). Current best reading of the strangle: 0.35 delta, the first alert, confirm 0.25 S30, sell
    the wrong leg and put its proceeds into the right one, trail 30%, prefer trades where the stock's own strength vs SPY
    agrees. The page: https://claude.ai/artifact/Uug3uh6G7MWQcvRTMfq3tM (card "Market filters, the D bonus and the fill").
  - **Which leg to drop, and not only 0DTE (`zero8.py`, 2026-10-25):** the bot's direction is worse than the stock's raw
    move at picking the leg, in every form. On the 307 same-day strangles (2% fill, trail 30%): the move 0.25 S30
    $120,078 / 2% (D bonus $134,414); the sign of the C t-stat at the fill $100,429 / 7% (2025 flat, 2026 negative);
    the sign only when |t| ≥ 1 $107,058, ≥ 1.8 $110,181 / 3%; waiting for the bot's full C signal within the hour
    $108,686 / 7%; the move only when it agrees with the sign $110,641 / 6%. |t| at the fill is a median 1.24, ≥ 1.8 on
    81 trades. The alert's own burst is the fresh information; the day-long strength is stale against it, and the
    "agree" rule loses trades waiting. At a 4% fill every strength-based rule is under $100,000. **Not only 0DTE:** the
    same rule with the bot's expiry (nearest 1–7 days), on every day's first alert, 2026 only (1,380 fair first-alerts,
    1,013 without a same-day expiry): 271 tradeable, 29% winners, −215 a trade, $94,266 / 7% (4% fill $84,879 / 15%);
    the same-day expiry on the same year's expiry days $104,607 / 2% (122 trades, +375); on the same 37 alerts, 0DTE
    +259 a trade vs 1–7 days −545. The strangle needs the same-day expiry's gamma: with a week of time value the kept
    leg barely moves on the burst and the wrong leg still costs. Not run for 2024–2025 (new option bars to fetch;
    2026 is decisive enough). So the strangle stays a Friday strategy on the names with same-day expiries.
  - **Deltas 0.25 and 0.20 (`zero7.py` with `BT_STRANGLE_DELTA`, 2026-10-25):** the band runs 0.25–0.40 with 0.35 in the
    middle. At 0.25 (283 tradeable; more strikes fail the $0.20 minimum): base $119,459 / 3% (+1,723 / +321 / +401),
    D-recycle $135,470 / 3% (+2,746 / +606 / +746, $116,320 without the best 5, the highest, but 2024-heavy), with the
    strength filter $111,012 / 1%; at a 4% fill D-recycle $113,847 / 7%. At 0.20 (255): base $116,421 / 5%, D-recycle
    $128,856 / 5%, at 4% sizing the worst drop doubles against 0.35 (20% vs 11%); the cheaper legs make the recycle
    buy more contracts of a thinner option and the swings grow. 0.35 remains the pick: the same end as 0.25 with the
    most even years and the smallest drops; 0.25 is a fair alternative, 0.20 is not.
  - **The strategy's own page (`zero9.py export`, 2026-10-25):** https://claude.ai/artifact/H8gGya26BFsnqxsw97TDsN, in the
    Bot vs Indi shape: the rule in words, the headline figures, the account against SPY with the same money, every trade
    as a bar, the breakdowns, the sortable trade table, and a trade window with the numbered fills, the two legs against
    what was paid and the two-day stock chart with SPY scaled to the same start. 307 trades, +$305,480 at $10,000 a
    trade, 119 winners. The research page stays https://claude.ai/artifact/Uug3uh6G7MWQcvRTMfq3tM.
  - **Two false-alarm filters for the strangle (`strangle_filters.py`, 2026-10-25, the user's ideas), on the final rule's
    trades (fair list 2024–2026, 307; favorites 2025-10-23 to 2026-10-22, 192).** (1) The bounce: in the 30 minutes
    before the alert the stock's high came within 0.25 S30 of a level above (low of one below) without a close 0.25 S30
    beyond it, and the alert points away from it. Fair: 39 bounces at +60 a trade (2024 and 2026 negative) vs +1,264
    for alerts with no failed test; skipping them $134,098 / 4% vs $134,414 / 3% (no change). Favorites: 28 bounces at
    −1,431 (21% winners), the day's own high / low the worst (20 at −2,104); skipping them $109,279 / 3% vs $104,976 /
    4%. Over 15 minutes the fair list's bounces were good (+1,350), so the window matters. Any failed test in 30
    minutes (either alert side) is the weaker group on both lists (fair +439 a trade, favorites −1,000) and "no failed
    test" the stronger (fair +1,264, favorites +816); as a filter fair $128,604 / 5%, favorites $111,014 / 3%.
    (2) Against a big move: the move from the open (or the last hour) ≥ 1.5 / 2 / 3 S30 one way and the alert the
    other. Fair: these are the best trades in 2024–2025 (+3,713 / +5,040 a trade at 1.5 from the open: a reversal is a
    big move, which a strangle wants) and lose in 2026 at every threshold (−1,692); skipping costs $13K–$24K. Favorites
    (the last year): against-the-open ≥ 3 at −762 a trade, ≥ 1.5 / 2 about −150; skipping ≥ 3 $106,772 vs $104,976.
    Verdict: (1) helps where the strategy is weak and costs nothing where it is strong: worth a setting in the paper bot
    (skip the alert after a failed test of the day's high / low or yesterday's within 30 minutes), not proven; (2) is a
    regime effect (bad in 2026, good before), not a rule. Small groups everywhere (13–53 trades).
  - **No strangle when the alert breaks a level (`strangle_break.py`, 2026-10-25, the user: "when we break support or
    resistance - no need strangle"):** an alert whose close is 0.25 S30 beyond a level in its direction (yesterday's,
    the 5-day, the first 15 minutes', the day's extremes before the window) and was not 3 minutes earlier; then only
    the leg it points to, same contract, same fills, trail 30% (± a −30% stop), the same premium as the pair. More than
    half the alerts are breaks (fair 173 of 307, favorites 107 of 192, mostly the day's own high / low), and the
    stock went the break's way, by the strangle's own side, on only 56% of them (97 / 173; favorites 60 / 107). On the
    breaks: strangle +658 a trade vs one leg +535 (+572 with the stop) on the fair list; favorites +460 vs −92 (−11).
    As a rule (a break: one leg, else the strangle): fair $131,411 / 5% vs $134,414 / 3%; favorites $98,909 / 6% vs
    $104,976 / 4%. Not better: a break fails almost as often as it holds, and the other leg is what pays then.
  - **The confirmed leg alone, a trail on the stock, D2 and the falling SPY (`strangle_more.py`, 2026-10-25; the replay
    reproduces the export's returns on 307 / 307 and 192 / 192).** At the 2% fill, fair list / favorites (last year), at
    1% a trade: the strangle as now $134,415 / 3% and $104,976 / 4% (without the best 5 $113,977 / $93,429). **A trail
    on the stock instead of the option** (the kept leg sold when the stock gives back k S30 from its best since the
    side): k 0.25 $142,560 / 1% and $121,659 / 1% (50% winners on both, without the best 5 $130,401 / $112,792);
    0.5 $141,043 / $112,707; 0.75 $154,578 / 4% and $118,625 / 4%; 1 $141,688 / 7% and $111,561; 1.5 worse ($114,329
    / 16%). Every year positive on both lists from 0.25 to 1: the first change that lifts the favorites' year above
    $100K without its best 5. **Only the leg, bought at the side** (no strangle; the same 0.25 S30 side from the stock at
    the alert's fill, the pair's premium on one leg): with the option trail $136,199 / 2% and $107,599 / 3%; with the
    stock trail 0.75 $157,440 / 3% and $122,233 / 3% (0.5: $143,774 and $115,432), the best of the study on both lists.
    It makes 2 fills instead of 6, so it holds up at a 4% fill a leg: $137,179 / 6% and $112,497 / 4%, vs the strangle
    as now $111,460 and $93,996, and the strangle with the 0.25 stock trail $117,685 and $108,024. **D2** (a second unit
    of new money at the side) is worse than D on both lists ($124,038, $103,736). **Falling SPY**: on the fair list the
    alerts while SPY falls are not worse (down 0.3%+ in 30 min: +1,314 a trade; skipping costs $7.5K); on the favorites
    they are (13 trades at −1,057; with 3+ stocks alerting 9 at −2,438, 1 winner), skipping +$1.4K. Small and not on
    both lists: a tag to watch, not a rule. Also: alerts with SPY within ±0.25% of its open are the weakest group on both
    lists (+8 and −74 a trade). Candidate for the paper bot: the stock trail (0.25 to 0.75 S30) and the one-leg entry
    at the side; picked from these runs, so in sample, but a band on both lists and robust to the fill.
  - **The Alert leg with the two contract fallbacks (`leg_fallback.py`, the user, 2026-10-25: "try to add the 2
    fallbacks. cheap and liquid").** The rule as the live bot runs it: the side from the stock's price at the alert,
    the leg picked at the side minute (only that leg must be liquid). Note this plain baseline is wider than the page's
    export, which needed both legs liquid at the alert: fair 446 trades, $208,776 / 4.1% at 1% (page 306, $154,676 /
    3.2%); favorites 253, $131,322 / 5.4% (page 191, $119,831 / 3.3%). Cheap (under $0.20: the nearest-the-money strike
    at $0.20+) / liquid (under 200: out to 0.25 first, then in to 0.50, the nearest to 0.35) / both: fair +12 / +27 /
    +38 trades, $216,618 / $216,994 / $222,121, drop 4.1% each (CRCL +5.6K and CVNA +3.1K the bulk of liquid's +6.2K);
    favorites +8 / +25 / +33, $128,777 / 6.6%, $132,594 / 6.0%, $130,623 / 6.7% vs $131,322 / 5.4%. Not better: on the
    favorites cheap and both lose money and add a point of drop, liquid +$894 on 25 trades with more drop; the fair
    gain is two trades. The fallbacks stay out, as for Indi.
  - **Half at a big gain, the rest with more air (`leg_half.py`, the user, 2026-10-25: "at 200% selling 50% only if did
    not sell with back, the rest give more air"),** on the page's trades. Half at +100 / +200 / +300% (sale price over
    the buy) while the 0.75 give-back has not fired; the rest at a 1.0 / 1.5 / 2.0 S30 give-back or 15:30. Fair as now
    $154,676 / 3.2%: +200% $143,616-$149,915, +300% $144,992-$155,235, +100% $124,733-$142,506. Favorites as now
    $119,831: +200% $120,336-$122,103, +300% $119,884-$123,555 (5 trades), +100% $113,677-$115,818. Not better: +200%
    loses on the fair list, +300% touches 8 and 5 trades (a tie), +100% sells the runners. The 0DTE 0.35 leg rarely runs
    past +300% in a day (fair 3 of 306, favorites 0 of 191), so the half caps what is near its top already.
- The signal's t-stat as an exit with the -30% stop (`thesis.py`, 2026-10-24; the user's follow-up). Sell all on the
  entry day when the signal's own cumulative t-stat vs SPY x beta falls to 0.5 or under (the entry needs 1.8). With
  the bot today (failed break on): fair list $549,153 / 9% at 1% ($2,183,362 / 18% at 2%) vs $526,469 / 10%
  ($2,011,681 / 18%), every year positive, without the best 5 +986 vs +932 a trade; 34 trades change (22 better),
  +43,683 at $10K, MSFT 2025-04-09 +25,781 and AMD 2025-10-10 +9,201 the bulk; unseen $125,260 vs $125,581 (7 trades
  change). Against the champion itself (BT_NO_FB=1, no failed break): $610,096 / 11% ($2,647,105 / 21%) vs $585,593 /
  11% ($2,444,640 / 21%), every year positive, without the best 5 +1,127 vs +1,075; unseen $122,679 vs $123,028 (8
  trades, -$349). Neighbours: t ≤ 0 changes 5 trades (nothing), t ≤ 1 is worse ($514,882, ASTS 2025-03-04 -38,745);
  -40% / -50% stops with it are worse than -30% on the fair list. Candidate, a hair short of the rule: the unseen is
  $349 lower, and most of the fair-list gain is one trade (MSFT 2025-04-09; without it still +$17K over 33 trades).
  Cheap to run live: the bot computes the t-stat every minute for the scan already.
  With the stop at -35% / -40% (user, 2026-10-24): fair list $531,488 / 10% and $518,434 / 10% (2%: $2.04M / 19%,
  $1.94M / 19%) vs $549,153 / 9% at -30%; unseen $133,047 / 10% and $132,146 / 11% vs $125,260, but that is UNH
  2024-12-05 (+53,000) and LLY 2025-10-01 (+23,120) again, as for -35% / -40% alone ($507,090 / $510,995 fair; $134,444
  / $133,590 unseen). -30% stays the stop; the wider ones give back on the fair list what the t-stat exit earns.

## Candidates

- (Now the champion, see above.) A tighter stop on the rest after the +10 half (`rest_stop.py`, 2026-10-24; the user: "be more careful with trades we
  already cut - maybe move the stop higher"; levels set before running). Entry day, once +10 sold half: R20 the rest
  out at -20% with the stock against: fair $529,302 / 9% vs $526,469 / 10% ($2,033,193 / 17% vs $2,011,681 / 18% at
  2%), every year higher (+469K / +666K / +726K vs +468K / +665K / +724K), unseen $127,223 vs $125,581 (every year
  higher). R15 $529,398 / $127,130; R20o (-20% on the option alone) $530,309 / 9% / $126,815. Broad, not a few trades
  (fair: 130 changed, biggest gain GME 2025-07-21 +1,818, biggest loss SMCI 2025-10-01 -8,767). Passes the bar on both
  lists with a smaller drop, but by a small margin (+0.5% fair, +1.3% unseen). Not yet re-tested on the Favorites
  year. Worse: RHalf (under the half's sale price) $507,398 / 13% and RStock (out when the stock is against after +20)
  $506,032 / 13%: both sell ORCL 2025-01-21 (-40K points). sim.py: `after_half {out, need_against, stock}`.

- Hold overnight from +50% instead of +100% (`hold_from.py`, 2026-10-24, on the chosen bot). Delta 0.15: fair list
  $661,989 / 10% vs $526,469 / 10% (2%: $3,063,613 / 19% vs $2,011,681 / 18%), every year better (+585K / +732K /
  +792K vs +468K / +665K / +724K), $248,168 vs $196,717 without the best 5; a band, not one cell (+25% $645,804, +75%
  $610,664, +150% $430,414). Unseen: $126,110 vs $125,581 (2025 lower, 2024 and 2026 higher). Delta 0.10: fair
  $743,023 / 13% vs $698,307 / 11%, but unseen $103,289 vs $106,261, and there the higher the threshold the better.
  Strong on the fair list, not confirmed by the unseen: the user's call.

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
- **The fair list plus the hot stocks (`hot_universe.py`, `opt_volume.py`, `opt_fit.py`, `hot_fit_test.py`,
  2026-10-25; the user: "the test stocks to be both the core and the hot stocks ... looking 3 to 6 months before", then
  only the hot stocks whose options fit the bot, with the fallback up to delta 0.30 to test).** Hot = each month's top
  50 of the whole optionable US market (5,679 Alpaca symbols; price ≥ $5, median day $ volume ≥ $100M, leveraged ETFs
  and a few funds out) by daily-return volatility over the 6 (and 3) months before; the core 40 removed; kept to the
  67 whose nearest weekly has a liquid 0.15-delta option, or one up to 0.30 (opt_fit.py, Oct 2026 snapshot). A hot
  stock trades only in a month it is hot. Feb 2024 – Oct 2026, the 10% overnight cap at each size, so the baselines
  are bot 2.4 $719,943 / 9% and 2.5 $1,108,662 / 11% on the fair list. **The hot stocks lose with the bot's own
  pick:** 2.4 hot-6m 90 trades, 18 winners, −661 a trade, $93,985 / 8%; 2.5 115 trades, −192, $97,409 / 9%; the
  3-month-only months lose too (−1,730 / −1,722 a trade on ~20 trades). Fair + hot 6m: 2.4 $675,010 / 10%, 2.5
  $1,078,809 / 12%, both below the fair list alone. **The fallbacks turn the hot stocks positive only through IONQ:**
  2.5 + liquid2 hot-6m 326 trades $119,336 / 12%, but IONQ is +410K of it (23 trades) and the rest lose; $70,268
  without the best 5. 2.4 + both2 hot-6m $109,546 / 11%, $71,285 without the best 5. Fair + hot 6m + both2 lifts the
  end (2.5 $1,263,646) at twice the drop (23%). Losers by stock with the plain pick: RKLB, RDDT, IREN, BMNR, ENPH;
  money only in IONQ and one ALAB trade. Not better: a stock being hot (volatile, busy) is not what makes the bot win;
  the core stocks are where Indi trades and where the signal works. A lead from the same run, to test before believing:
  **2.5 + the cheap fallback** on the fair list $1,297,219 / 11% (2%: $6,599,909 / 21%), every year positive,
  $422,022 without the best 5 vs $360,679; on 2.4 the cheap fallback failed the unseen ($86,373 / 31% vs $127,433).
  - **The fallbacks on the 151 unseen (`hot_fit_test.py` with the unseen, 2026-10-25; the user: "add both fallback
    features to the test"):** the lead fails. Bot 2.5 on the unseen: plain $126,187 / 11%, cheap $78,322 / 38%,
    liquid2 $95,922 / 36%, both2 $67,096 / 49% (2024 −386K). Bot 2.4: plain $126,312 / 9%, cheap $85,613 / 31%,
    liquid2 $107,025 / 24%, both2 $74,899 / 42%. Every fallback loses money on the unseen with both bots; the fair-list
    gain of cheap on 2.5 ($1,297,219) is in-sample in stocks. The plain pick stays.
  - **The neighbouring strike (`hot_fit_test.py` modes `adj` / `cheap_adj`, 2026-10-25; the user: "just check one
    above and one below the delta if there is no liquid ... 247.5 ... 250"):** when the 0.15-delta strike has under
    200 contracts in 30 minutes, the next listed strike on each side (OTM) that has them and costs $0.20+, the nearer
    to 0.15 if both. The user set the unseen aside for the fallbacks ("the 151 unseen is irrelevant here"). Fair list,
    10% night cap: **bot 2.4 + adj $1,177,582 / 12%** (2%: $4,336,561 / 22%) vs plain $719,943 / 9%, every year higher
    (+958K / +1,060K / +824K), $324,001 without the best 5 vs $269,257; the new best trade MU 2025-04-03 +397K.
    2.4 cheap_adj $1,321,691 / 15%. Bot 2.5 + adj $1,164,855 / 18% vs plain $1,108,662 / 11%: a little more money
    for a much bigger drop; cheap_adj $1,324,417 / 17%; 2.5 + cheap ($1,297,219 / 11%) stays the best 2.5 pick at the
    same risk. Unseen: adj loses least of the fallbacks (2.4 $117,576 / 20%, 2.5 $121,053 / 22% vs plain ~$126K /
    9–11%), cheap_adj $70–72K / 42–45%. Fair + hot 6m: 2.5 cheap_adj $1,778,863 / 21%.
- **The D2 entries and the 200-contract floor (`d2_liquid.py`, `d2_nofloor_fill.py`, 2026-10-25; the user: "if there is
  D2 involved buy even if there are less than 200 contracts; if it's D2 and fails on liquidity, try again after 5
  minutes if the rules still mark going in"):** bot 2.5, a D2 entry = one in through the bonus (t < 1.8); 470 of them
  illiquid on the fair list. 10% night cap. Fair list (the unseen below for the record):
  - **nofloor** (buy the 0.15-delta contract anyway, $0.20+, a bar in the last 10 minutes, the usual fill):
    **$2,725,559 / 12%** (2%: $24.9M / 23%) vs $1,108,662 / 11%, every year higher (+1,211K / +1,220K / +1,282K),
    $875,155 without the best 5; 325 added trades, 77 winners, +1,006K at $10K, +273K without their best 5 (ARM
    2024-04-17, COIN 2026-08-19, SMCI 2026-05-28, CVNA 2024-09-16). By the contract's 30-minute volume: 0–24 +221K
    (105), 25–49 +99K (66), 50–99 −25K (65), 100–199 +711K (89): no clean threshold. **It rests on the fill:** at a 5%
    spread a side on the added trades $2,165,150 / 12% (added +77K without their best 5), at 10% $1,533,009 / 15%
    (−214K without their best 5). The simulator fills at a bar's middle ± 2%; a contract with a few trades in 30 minutes
    has a wider real spread, and at 1% of a compounding account the order is often more than its whole volume.
    Unseen: $110,285 / 24% vs $126,187 / 11% (912 added, −83K). cheap+nofloor $2,899,149 / 13%.
  - **retry1** (once, 5 minutes later, if c12_15 still holds): $1,216,760 / 11% vs $1,108,662 / 11%; unseen $130,489 /
    11% vs $126,187: passes the bar on paper, but 26 added trades and COIN 2026-08-19 (+179K) is all of it (−60K
    without the best 5). **retry** (every 5 minutes while the rule holds) $1,382,773 / 13%, 68 added, −152K without
    their best 5 (ARM +15m, COIN +5m); unseen $127,817 / 13%. **retryday** (every 5 minutes to 15:44, skipping checks
    where the rule fails) $1,322,942 / 12%, 121 added, −217K; unseen $123,867 / 15%. The rule sits at its threshold, so
    it often fails at exactly +5. On cheap: cheap+retry $1,551,002 / 13%, cheap+retryday $1,504,181 / 13%.
  Verdict: the retries are a few trades; nofloor is the largest result logged on the fair list, but its size depends on
  fills the backtest cannot see (no quotes), so it needs a live paper check of the real fills before it counts.
- **The eight-version benchmark on the Favorites (`fav_bench.py`, 2026-10-25; the user: "the same benchmark on my
  favorites, last 6 months? then last 12 months?"):** the 86 Favorites (23 of them added that day from the hot list, so
  in-sample in stocks), lists.py runs fav86_24 / fav86_25, 10% night cap, 1% from $100,000. Last 12 months: 2.4
  $176,352 / 9% ($83,541 without the best 5), 2.5 $192,534 / 12% ($82,775), 2.5 + cheap $239,826 / 14% ($99,337),
  2.4 + next strike $165,870 / 18%, 2.5 + D2 under 200 $270,491 / 19%, 2.5 + next strike for D2 $238,367 / 13% (IONQ
  2026-04-14 +221K), **2.5 + cheap + next strike for D2 $285,889 / 15% ($115,777)**, 2.5 + cheap + D2 under 200
  $318,405 / 18% ($135,556). Last 6 months: 2.4 $118,562 / 9%, 2.5 $121,303 / 12%, 2.5 + cheap $155,536 / 14%,
  2.5 + cheap + next strike for D2 $158,329 / 15%, 2.5 + cheap + D2 under 200 $173,090 / 18%; 2.4 + next strike
  the worst ($108,746 / 18%). On the Favorites the money is the same few trades (ORCL 2026-04-13, QCOM 2026-05-05, MSTR
  and IBIT 2026-08-19); without the best 5 only the cheap versions stay above $100,000 over 12 months.
- **The failed-break sale on every 2.5 version (`export_bench.py` <slug>@fb, 2026-10-25; the user: "can you add the failed
  to break to the 2.5 versions as well?"):** 10% night cap, 1% from $100,000. Fair list: 2.5 $1,108,678 / 11% → with
  the sale $734,522 / 14%; 2.5 + cheap $1,297,233 / 11% → $890,789 / 16%; + next strike for D2 $1,128,279 / 13% →
  $731,018 / 16%; cheap + next strike for D2 $1,277,250 / 13% → $859,329 / 18%; D2 under 200 $2,725,610 / 12% →
  $1,713,858 / 15%; cheap + D2 under 200 $2,899,179 / 13% → $1,906,120 / 18%. Every one loses money and gains 3–5 points
  of drop. Favorites, 12 months: 2.5 $192,533 / 12% → $186,064 / 11%; 2.5 + cheap $239,826 / 14% → $219,924 / 14%;
  cheap + next strike for D2 $285,889 / 15% → $257,523 / 16%; 6 months within a few thousand either way. Not better:
  the sale cuts the early D2 trades before they work (as the d2_failed_break.py study found). On the dashboard as a
  switch.
- **Cutting the drop of 2.5 + cheap + the next strike for D2 (`dd_reduce.py`, 2026-10-25; the user: "find a way to reduce
  the drop in the cheap + liquid; I do not care to lose some money but I need this data"):** fair list, 1%, 10% night
  cap; base $1,277,250 / 13%. Yardstick = a smaller flat size (0.9% $1,022,256 / 12%, 0.8% $812,977 / 10%, 0.7%
  $642,282 / 9%, 0.6% $503,951 / 8%); "edge" = the end against the flat size with the same drop. **Known at entry and
  better than flat: the fallback-added trades at half size, $1,203,557 / 11% (+22% over flat 0.85%), $391,482 without
  the best 5**; with the 10-minute check selling all $1,202,544 / 11%; with the 7.5% night cap $1,154,371 / 11%.
  After a losing streak (in entry order, so it knows same-day results early: an upper bound): x0.5 after 3 losers
  $745,269 / 9% (+17%), with the fallback half $695,361 / 8% (+28%); x0.5 after 8 $1,008,750 / 11%; after 5 worse
  than flat (-16%), so the streak rule is noisy. Worse than flat: at most 1 / 2 / 3 trades a day ($457K / 10%, $695K /
  15%, $790K / 16%), the D2 entries at half size ($726,143 / 13%), stops at -25% / -20% ($896K / 13%, $763K / 15%),
  holding from +100% ($911,438 / 13%), the night cap at 5% ($1,027,938 / 13%), cutting the size below a 10% drawdown
  ($700,333 / 13%); the drawdown cuts at 15%+ never fire. The drop is not made by a few bad days a rule can see coming;
  only taking less of the trades the fallbacks add, and the streak rule, beat simply trading smaller.
- **D2 entries at half size, the other half added on the real signal (`d2_scale.py`, 2026-10-25; the user: "D2 entries at
  half size but then increase (buy the next delta 0.15) if we hit the right direction and hit the real bot alert"):**
  on 2.5 + cheap + the next strike for D2 (base $1,277,234 / 13%; 528 of 1,323 trades are D2 entries). The add is a
  fresh 0.15-delta contract at 2.4's signal minute (t >= 1.8, same side), half size, the same exits. D2 at half, no add
  $710,523 / 13%; + the add when the first half is still held $1,003,428 / 11% (153 adds, +8% over flat 0.8%); held and
  its option up $1,017,698 / 11% (131 adds, +10%), $374,819 without the best 5; always $988,390 / 11% (174, +4%). The
  adds themselves earn: +$874K at $10K a full trade, +$133K without their best 5 (held-and-up). Better than trading
  smaller, but below the fallback-added trades at half size ($1,203,557 / 11%, +22%) at the same drop.
  - **By fallback (the user: "fallback trades at half size but only for the liquid fallback"):** the liquid-fallback
    trades (the next strike for D2) at half size $1,278,782 / 12% (+16% over flat 0.95%), $415,950 without the best 5:
    the same money as the base for a point less drop; the cheap-fallback trades at half size $1,206,495 / 12% (+3%);
    both at half $1,203,557 / 11% (+22%). The liquid fallback's trades add drop but no money at full size.
