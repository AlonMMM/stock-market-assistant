# Best algorithms log

> 🏆 **New champion 2026-10-27 (later the same day): the champion below + early entry** (buy at the first second inside the signal minute the rule holds): 1-second real fills, tune $330,459 vs $306,551, check $484,041 vs $428,884 (fair list), Favorites 12m $238,078 vs $212,222 (export_early.py, Bot vs Indi `champ-early` / `champ-1s`). Not live yet.

> ⚠️ **2026-11-01: the real-quote fills were a minute late; app and research now agree trade for trade.** The app
> parity run (the user: "I expect it to be the same trade exactly"; "I want them to be align") found
> `real_bench.quote(minute)` returning the row labelled minute + 2 (the book as minute + 1 closed), not minute + 1 as its
> docstring and the 2026-10-27 label fix say: every real buy and sale since then was priced a minute late. Fixed, on by
> default (`BT_QUOTE_LATE=1` = the old lookup), with two more: a day's books are read from every `dbx_cache` folder as the
> app's store holds them, $0 bids kept (`BT_BOOKS=all`; `list` = the old one folder), and a real-fill walk (`paid`) checks
> its exits on the entry bar as the app and the live bot do (`BT_PAID_SKIP=1` = old). Live 2.7.0 settings, its 75 stocks,
> 2026-07-31..10-30, 3%: app Backtest engine and `app_twin.py` 184 / 184 trades identical, same fills, $100,949 / 42.4% drop
> both (before: 6 of 184 the same). **Every real-quote figure in this log before this date moves**; re-run a result
> before leaning on it. App side: PR fix/backtest-align (`scripts/bot-backtest-compare.ts`).

> ⛔ **Early entry fails the fair test (2026-10-31, early_fair.py).** sec_timing.py's "early" used SPY's end-of-minute
> move inside the minute and only searched signals that held at the close. Re-tested on real stock and SPY trades the way
> bot.ts runs it (5-s checks, forming volume 0, fades included), it loses to the minute-close buy on both halves and both
> lists (2%, fair: tune $271,292 vs $391,079, check $302,557 vs $580,989). The live bot's `earlyEntry` should be off.

> ⚠️ **Audit 2026-10-31: the champion's figures are high.** The walk (sim.py) checked every exit only on minutes the
> option traded (a thin option's 10-minute check, -30% stop and 15:50 ran at its next print) and marked it at trade
> prices, and the 1-second buy's runaway cap (+10%) could fill under the bid. Fixed behind switches: `BT_CLOCK=stock`
> (every stock minute, the option at its book mid as the live bot marks it; implies `BT_KEEP=1`, a signal with no option
> print in 3 minutes is kept), `BT_CHASE=ask` (the live bot chases the ask, no cap). champ-early, fair list, 2% / 1%:
> as logged $7,258,326 / $1,484,410 (drop 24.1%); clock only $4,126,647; chase only $4,981,518; both **$2,845,332 /
> $857,745** (drop 27.6%; tune $448,187, check $634,854, without 10-10 $2,798,469); keep only $7,182,743. Every later
> Main bot test runs on the fixed walk (the default since 2026-10-31). The champion's rules were rechecked the same day: no verdict flips, 2.7 stays the champion; fixed figures: fair $2,845,332 / 27.6%, Favorites 12m $244,185, 36m $3,953,742 (minute entries). See "Read first" below for the whole story.
>
> 🏆 **Version 2.8.0 chosen 2026-10-31 (the user: "add the Staged + stop −60% as our new version"):** 2.7 with the
> 10 / 20-minute checks off, the staged stock exit (half at 0.5 S30 against the signal price, the rest at 1.0) and the
> stop at −60%. Fixed walk, 2%: fair $4,161,285 / 25.5% vs $3,202,862 / 26.6%; Favorites 12m $269,142 vs $243,492; 36m
> $4,678,380 vs $4,490,376. The check half is lower on 3 of 5 lists: live to be proven. App PR #223 (live bot +
> Backtest page; includes #218). Research overlay: `BT_X={"user_stop": {"checks": [], "out": -0.6}, "stock_stages":
> {"half": 0.5, "full": 1.0}}`; Bot vs Indi version `x-stop60`.
>
> 🏆 **Champion 2026-10-27 (morning): 2.5 + IBIT down to $0.10 + the pyramid (no cheap fallback).** Real quotes: fair list 2024-25 $415,971 / 14% vs the live 2.6 $302,905 / 16%; Favorites 24 months $403,255 / 17% vs $299,707 / 18%. Not live yet.

## Read first: the 2026-10-31 audit, and the exit work built on it

Every Main bot number before 2026-10-31 came from a walk with three bugs. Everything after it runs on the fixed walk.
This section is the map: what was wrong, what changed, and the chain of tests that followed (details in the dated
entries at the end of the Candidates section). The Volume bot had its own audit the day before
(`STR_WALK_KEEP=1 STR_CHASE_NOFILL=ask`, see [volume-bot.md](volume-bot.md)).

**Why the audit.** The user doubted a 35-40% options win rate ("very very rare"). The live bot buys on the second
and checks its exits on every closed minute at the option's mid; the research walk did neither.

**The bugs** (sim.py / sec_timing.py / opt_spread.py, commit caef5f0). **On by default since 2026-10-31** (the user:
"all the fixes should be on by default"); to reproduce a run logged before the audit, set `BT_CLOCK=trade BT_CHASE=cap
BT_KEEP=0` (the Volume bot's: `STR_WALK_KEEP=0 STR_CHASE_NOFILL=cap`):

| # | Bug | What it did | Fix |
|---|---|---|---|
| 1 | Exits ran on the option's trade-print clock | A thin option's 10/20-minute checks, -30% stop and 15:50 overnight decision ran only at its next print, often minutes late, at that print's price | `BT_CLOCK=stock`: one bar per stock minute, the option marked at the real book mid at the minute's end (as the live bot does) |
| 2 | Signals with no option print in 3 minutes were dropped | Losers vanished from the list | `BT_KEEP=1` (implied by `BT_CLOCK=stock`) |
| 3 | The 1-second buy's runaway cap (+10%) | On a runner the fill could land under the bid | `BT_CHASE=ask`: chase to the ask with no cap, as the live bot (`bot.ts` buy chase) |

**What it cost** (champ-early, fair list, 2% / 1%): logged $7,258,326 / $1,484,410 (drop 24.1%) → clock alone
$4,126,647, chase alone $4,981,518, keep alone $7,182,743, **all fixed $2,845,332 / $857,745** (drop 27.6%; tune
$448,187, check $634,854). The champion was about 60% high. About 85% of the clock fix's loss came from overnight
holds: the 15:50 carry read the last trade print instead of the mid, 15:50 decisions were skipped when the option
did not trade after 15:50, morning sales ran late, and late checks let trades that had recovered through.

**What this means for older entries.** Every rule in this log above this date was chosen on the old walk. The
direction of a comparison may still hold, the sizes do not; a rule that touches exits, overnight or the buy price
needs a recheck on the fixed walk before it is trusted. Not yet rechecked: early entry, the pyramid, IBIT $0.10,
the D2 bonus.

**Still not modelled:** the broker safety stop (`safetyStopPct`, 50% by default) that can fire at any second; fills
better or worse than the book.

**The exit tests on the fixed walk, in order** (all `BT_CLOCK=stock BT_CHASE=ask`, champ-early, fair list, both halves
every run; S30 = the stock's usual 30-minute move, moves measured from the signal price):

| Step | The user's question | Tested | Result (2%, drop) | Verdict |
|---|---|---|---|---|
| 0 | - | The fixed champion (checks 10/20 min, stop -30%, carry from +50%) | $2,845,332 (27.6%) | The new baseline |
| 1 | "check 25%+ go overnight" | Carry from +25% | $3,037,966; tune -4%, check +11% | Not clean; maybe +35/+40% |
| 2 | "test 35%-50% stop" | Stop -35 / -40 / -45 / -50% | $2.71-2.82M, drop +1.5-2.3 pts | Keep -30% (with the checks on) |
| 3 | "one second exit, Black-Scholes -3% / bid" | 1-second price stops (`BT_SEC_EXIT=1`) | $677,487 (41.8%) | Far worse: second noise |
| 4 | "an exit by the movement on the stock" | Trails 1.0/1.5/2.0 S30, 1.0 S30 against entry, level stop | Best: 1.0 S30 against $2,967,242 (26.4%), check a tie | Near tie |
| 5 | "remove the 10-20 minutes check" | Checks off, with and without the 1.0 S30 stock stop | Checks off + stock stop $3,239,866 (27.8%), both halves up | Candidate |
| 6 | "multiple exits ... exit half, bring back" | Staged exits, buy-backs | **Half out at 0.5 S30 against, rest at 1.0: $3,431,770 (26.7%)**, tune +13%, check +7% vs step 0 | **The candidate**; buy-backs worse |
| 7 | "add 50% if it goes our direction in the first 10 minutes" | Add half size at +0.25 / +0.5 / +1.0 S30 within 10 min, staged exit on all of it | Add at +1.0: $7,980,114 (28.6%), tune +29%, check +81% vs step 6 | Promising, giant-driven (10 trades = 74% of the gain, median added trade -20 pts) |
| 8 | "move the stop to 50/60/70%, as now we have a better stop" | Stop -50 / -60 / -70% on steps 6 and 7 | On step 6, -60%: $3,767,288 (25.1%), tune +6%, check +3%; on step 7 the check slips (-1.5%) | Giant-driven: median changed trade -2.9 pts; not adopted yet |
| 9 | "add on this the add rule" | Stop -60% + staged exit + add 50% at +1.0 S30 within 10 min | $8,594,137 (29.7%), tune +32%, check +72% vs stop -60% alone | The best total; the add still giant-driven (10 trades = 85% of its points, median added trade -20 pts) |
| 10 | "run it on the favorite" | Steps 6-9 on the Favorites (12 and 6 months) | 12m: champion $244,185 -> staged $256,014, stop -60% $272,126, + add $313,855 (drop 35.3%); check half lower for all (-3% / -3% / -10%) | Tune-only gains; the add fails the check half. Page: https://claude.ai/artifact/1TmWPpHbU7vSoAuKtKwmS1 |
| 11 | "how is this working now ... after a fix that dropped 60%?" | Checks off / + stock stop / staged exit on the OLD walk | Old walk: staged $7,265,390 vs $7,258,326 (tie), check half -8%; checks off + stop -1.5% | The stock exits only help on the fixed walk: the fix hurt the option-price exits more |
| 12 | "run this on the last 3 years" | Favorites 36 months (minute entries) | Champion $3,953,742 (30.4%); staged $3,595,914 (-9%); stop -60% $4,173,507 (check -12%); + add $11,124,421 (30.9%), tune +105%, check +37%, every year up | Staged and -60% fail; the add passes here (but median added trade -15 pts) |

The candidate exit (step 6), as a `BT_X` overlay on the champion:
`{"user_stop": {"checks": []}, "stock_stages": {"half": 0.5, "full": 1.0}}`; step 7 adds
`"add": {"within": 10, "move": 1.0, "share": 0.5}` inside `stock_stages`. The -30% stop (with the stock against),
the 15:50 carry from +50%, the morning rules, takes and the thesis exit are unchanged. All in-sample (fair list, the
rules' own period); the Favorites confirmation is next before any live change.

Every time a backtested version beats the current champion, it is added here, and the user gets a big signal
(see the rule in [AGENTS.md](../../AGENTS.md)). Losers and ties are not logged here; they go in the research log
(`docs/tasks/research-indi-backtest.md`) and the report doc.

## What counts as better

**Since 2026-10-27 the tune / check split is by entry week** (the user: "split the test into 2 from now on. one for
tuning and one for vaulting", "i want 2026 to be in both list"; `split.py`): even ISO weeks tune, odd weeks check, on
the fair list and today's Favorites (24 months), real quotes. A version is better only when it beats the champion on
both sets and both lists, also without the best 5; at most 3 check looks an idea. Baselines (`floor_exception.py`,
real quotes, 1%, end / worst drop):

| Version | Fair tune | Fair check | Favorites tune | Favorites check |
| --- | --- | --- | --- | --- |
| 🏆 Champion (2.5 + IBIT $0.10 + pyramid) | $257,982 / 16% | $368,105 / 12% | $289,355 / 11% | $139,363 / 15% |
| 2.6 (live) | $229,933 / 15% | $272,798 / 18% | $244,689 / 13% | $122,485 / 17% |
| 2.5 | $187,746 / 16% | $328,303 / 11% | $210,385 / 11% | $138,030 / 13% |
| Pyramid on 2.5 (no IBIT) | $191,801 / 16% | $379,882 / 11% | $215,090 / 11% | $143,819 / 14% |

The champion leads 2.6 on all four. Its IBIT floor is a tune-week gain (+$66K fair, +$74K Favorites: IBIT's big days,
2026-08-19 among them, fall in even weeks) and a small check-week loss (-$12K, -$4K): on this split the floor is not
proven; the pyramid gains on both.


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
| 2026-10-27 | 🏆 **2.5 + IBIT down to $0.10 + the pyramid, no cheap fallback** (the user's call: "lets make this our champion"): 2.5's entries and exits; IBIT's 0.15-delta option bought down to $0.10, every other stock $0.20, no cheap fallback; on a D2 entry, half a size more when the same stock reaches t >= 1.8 that day while the first leg is held and up on the real mid (`floor_exception.py`, `export_champ.py` slug `champ`) | +-2%: $1,790,161 at 1% (2.6: $1,297,233); **real quotes: 2024-25 $415,971 / 14%, 2026 $228,296 / 14%** (2.6: $302,905 / 16%, $207,079 / 15%); Favorites 24m real $403,255 / 17% (2.6 $299,707 / 18%) | not run (IBIT is not in it; the pyramid on 2.5 alone loses on 2024-25 by $16K to the same without IBIT) |
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

### The tests of 2026-10-28 / 29 (all not better; the champion stays)

The champion of retry_roll.py (2.5 + IBIT down to $0.10 + the pyramid, real quotes) unless said; tune AND check
(split.py) in one run, 2% from $100,000, fair list / Favorites. Each line: the pick on tune -> its check (look 1 unless
said). **The research Favorites are now favorites.txt (the user, 2026-10-29): today's app Favorites (69) minus AMBA,
SIRI, SOFI, XYZ, ONDS, LLY, CVX, MRVL, ARM, GLD, plus USO = 60; the app keeps 69 ("Research only").** New champion
baseline on the 60 (fav_baseline.py): tune $596,437 / 20%, check $206,879 / 25% (the 69 + USO: $491,304 / $159,808;
the user chose the 10 removals knowing their results, so judge Favorites tests by the gap to the champion).

| Test (script) | Pick on tune | Tune fair / fav | Check fair / fav (champion $928,510 / $160,100; on the 60 $206,879) | Verdict |
|---|---|---|---|---|
| Rolling a big winner, new leg 0.20 / 0.25, funding half / all gain / everything (retry_roll.py) | roll-night-all | $821,058 / $995,807 | $591,506 / $109,686 (look 4) | no: rolling never wins both halves |
| Cap on trades that move together, group / side (risk_tests.py) | grp2 | $434,351 / $489,851 | $921,339 / $161,399 | no (ties) |
| Overnight on house money (risk_tests.py) | hm-back05 | $391,608 / $464,728 | $779,929 / $147,900 | no |
| SPY hedge overnight 5-20% (risk_tests.py, hedge_fetch.py) | hedge05 | $378,841 / $461,708 | $894,314 / $153,313 | no: costs, same drop |
| Strength exit off / t 0.25 / 0.0 (strength_exit.py) | t0.25 | $404,837 / $501,601 | $943,107 / $162,901 | no: loses tune; keep t 0.5 |
| Hold by strength at 15:50, 6 combos (night_strength.py, sim carry_strength) | w100-s20 | $400,946 / $486,400 | $760,652 / $152,630 | no |
| Hold by the sign of t (NS_SET=sign) | sign-100 | $418,121 / $510,521 | $928,510 / $157,064 | no (ties) |
| No / half / quarter second night (NS_SET=night2, sim night2_keep) | half-2nd | $402,716 / $483,519 | $772,307 / $140,737 | no |
| Wait for a % pullback after a big 10-minute move, open / rest of day (pullback.py) | open-k2-p15 / rest-k3 | $356,600 / $386,697; $321,744 / $392,033 | $1,034,514 / $155,522; $655,854 / $114,402 | no: tune and check disagree |
| Opening, industry style: VWAP / range retest / half / open type (pullback2.py, real quotes 100%) | half | $388,215 / $453,841 | $996,741 / $166,924 (look 2) | no: wins check, loses tune |
| Sum entry t + D2 + volume > 4 / 4.5 / 5, t >= 0.8 (sum_entry.py) | added-40 | $1,315,071 / $658,180 | $305,234 / $124,681 | no: drops 36-56% |
| First entry 09:35 / 09:45 (entry_start.py; 09:40 rebuilt matches) | f10 = champion | — | 09:35 $455,853 / $73,514; 09:45 $412,125 / $152,044 | no: 09:40 stays |
| No entry in the first 30 minutes unless very strong (late_start.py; the user 2026-10-30 "Simply try to not to trade in the first 30 minutes unless the tresholds are very big" after his_vs_bot.py: bot median entry 09:51, Indi 11:35): c12_15 regenerated from 10:00 / 10:30, an earlier signal kept if t >= 2.5 & V >= 2.5 / t >= 3 & V >= 3 / t >= 3 / V >= 3; 6 versions, look 1 | f30-t30 (best new; f10 control = champion) | $238,140 / $306,269 vs $422,807 / $594,175 | $249,482 / $128,197 vs $929,849 / $206,879 | no, by far (40-65% of the champion on tune, 25-60% on check): the moved stock-days made +$621K with 9 giants entered early vs +$178K with 3 later (tune fair); the early stock-days with no later signal lose -$317K but can't be told from the giants. 10:30 start: worst drop 20% but half the money. Bot vs Indi card "latestart" |
| The most liquid names trade without conditions (liquid_free.py; the user 2026-10-31: "the names that are in the top liqude option will be trade without conditions", after skip_funnel.py): top 5 AAPL AMD TSLA AMZN NVDA / top 10 + META GOOGL MSFT PLTR IBIT, set before running; no news (pre-market 4x) and no earnings-reaction skip, or no skip at all (thin / cheap picks too); 4 versions, look 1 | top5_nf | $376,142 / $557,144 vs $422,807 / $594,175 | $1,008,433 / $228,936 vs $929,849 / $206,879 | no: loses on tune (0.89); the check gain is two news-day giants (AAPL 2025-01-31 after its report, AMZN 2024-11-06 election); new trades median -$2.3K to -$3.0K both halves, no tune giant. Like premarket_toggle.py (2026-10-27): the skips protect the liquid names too. Bot vs Indi card "liquidfree" |
| Early entry re-tested the way the live bot runs it (early_fair.py; the user 2026-10-31, after a friend's review: "The current champion peeks ahead. Its "early entry" buys partway through a minute using SPY's price at the end of that minute. It also only tests signals already known to hold at the minute's close."; "do it all"). Confirmed in sec_timing.py early_second(): SPY inside the minute = its close spread evenly; only the champion's legs searched (no fades); the forming minute's volume counted, every second. Fair: every possible forming minute (exact bound from the minute bars) on Alpaca's real stock and SPY trades, the last trade at each check, forming volume 0, the day's first fire (early or closed) per stock-day as bot.ts; 1-second buys 2 s after the check (Databento, $0.09 more); the champion's exits and pyramid on the fixed walk. Versions close-min / close-1s / early-old / early-5s / early-10s; regenerated closed signals = the champion's 2,778 fair and 3,341 Favorites stock-days exactly; look 1 (fair) | early-5s (0.64 of close-1s) | 2%: early-5s $271,292 / $307,701, early-10s $221,630 / $243,596 vs close-1s $391,079 / $477,741; early-old (the look-ahead) $458,140 / $583,629 | early-5s $302,557 / 41% and $77,567 / 43% vs close-1s $580,989 / 26% and $159,090 / 32%; without the best 5 $64,459 / $32,785 vs $132,836 / $58,339 | **no, by far: the champion's early entry was look-ahead.** 4,921 early fires (5 s): 3,089 inside the closed signal's minute, 1,288 in an earlier minute, 544 on days with no closed signal. The faded ones lose (35-37 trades a half and list, 2-3 winners, median -$2.8K to -$3.2K, -$13K to -$107K) and the earlier-minute entries buy the first spike; even the held group is far below close-1s. Every 10 s is worse still. The live bot runs early entry (2.7 / 2.8): turn it off (`earlyEntry`), the user's call. Bot vs Indi card "earlyfair" |
| An early thin skip comes back at 10:00 (ten_back.py; the user 2026-10-30: "if 1540 skip, return the stock gain at 1600 (isr time)", Israel = NY+6 this week): 1,983 main signals before 10:00 with a thin pick; from 10:00 the first rule minute with a liquid pick trades, same side / either side / same side to 10:30; look 3 on the thin-skip idea | ten_same30 | $754,533 / $896,569 vs $422,807 / $594,175 | $842,766 / $164,758 vs $929,849 / $206,879 | no, like back30 in thin_retry: new trades median -$2.5K to -$2.9K both halves, without giants -$166K to -$386K a half; tune 4-5 giants (MU, ARM, COIN 2026-08-19, SMCI, MSTR), check 3-4. Bot vs Indi card "tenback" |
| A fair liquidity bar in the first 30 minutes (open_window.py; the user 2026-10-30: "in the openning after 10 minutes at 1640 isn't unfair question?"): the 200-in-30-minutes floor counts the clock, so before 10:00 only minute+1 trading minutes count; a thin main signal before 10:00 trades at the same minute when the pick clears 200 x n/30 (pro), floor 50 (pro50 = pro) or 100 (pro100); 341 signals, look 1 | pro100 | $338,563 / $715,723 vs $422,807 / $594,175 | $897,915 / $151,760 vs $929,849 / $206,879 | no: the new trades win 7-20%, median -$2.7K to -$3.5K both halves, without giants -$124K to -$229K a half; the tune Favorites gain is 5 giants (CRDO, CRWV, UBER, DELL x2). A contract thin at the opening rush (~140 contracts in 10 min) is a poor trade; keep the clock window. Bot vs Indi card "openwindow" |
| Try a thin signal again / back on the watchlist after 30 min (thin_retry.py; the user 2026-10-30 after the live CSCO 15:43 thin skip: "When do we check again if even?", "bring the stock back the watchlist after half hour"): 3,197 of 6,119 main signals have a thin pick; retry at later rule minutes within 10 / 20 / 30 min (same side), or back on the watchlist from +30 min (either side), or both; 5 versions, look 1 | retry30 | $648,965 / $973,965 vs $422,807 / $594,175 | $608,845 / $87,643 vs $929,849 / $206,879 | no: the added trades have the usual shape (median -$2.4K to -$3.2K both halves, without giants -$260K to -$680K a half); tune = 8 giants (incl. COIN 2026-08-19), check 4-5. back30 the same (check $760,986 / $140,522). One signal a stock a day stays. Bot vs Indi card "thinretry" |
| 09:35 on the pre-market (bell_entry.py): pre-market only / + first 5 min | bell18 | $459,094 / $552,773 | $974,758 / $170,305 (bell18-fb $938,768 / $163,059; look 2) | passes on paper, ~25 changed trades losing at flat $10K: not robust |
| Pre-market move sizing (pre_agree.py diagnostic, pre_size.py) | skip-flat | $783,912 / $944,413 | $166,788 / $89,081 | no: the tune bucket was its giants (10 of 19), check reversed |
| Expiry rules (expiry_rules.py, sim nocarry_trail; Favorites = 60) | **the user's Thursday rule = thu-next-fb** (next week only when tomorrow's finds no contract: adds trades only) / fri-0dte-15 / nc-50-30 | $404,764 / $567,781; $382,396 / $374,477; $460,694 / $647,337 | $883,546 / $199,567; $764,800 / $105,925; $799,670 / $183,826 | no: the added Thursday trades lose (10 / 11 a half, -$17K / -$25K at $10K, no giants); thu-next (every Thursday to next week, replacing trades) wins tune and loses check; 0DTE Fridays drop 35-45% |
| SPY against us (spy_rules.py, sim carry_spy / spy_cut; spy_drag.py analysis). A: skip / halve the night after SPY weakens >= 0.3-0.5% into 15:50. B: sell 1/2 or 1/3 of a winner up +50/100/200% when SPY falls 0.3-0.5% from its best | A ny-60-30h / B cut-100-50t | $420,343 / $591,261; $393,450 / $540,890 | $829,038 / $192,379; $872,111 / $203,033 | no. A: SPY's close does not predict the gap (after a weak close the gap median is +0.4% our way; every bucket gaps against 30-50%), 1-4 trades a half. B: the median changed big winner +$600-1,600 on both halves and better without the best 5 on check, but 3 of 9 tune giants cut early: slightly less money |
| The market's day at entry (mkt_rules.py, defence_signals.py mL_T; only the picks on check, the user's rule 2026-10-29). Filter: skip / halve calls when SPY is down >= 0.5% from the day before's close at the signal (puts when up). Lower: t >= 1.2 when SPY moved >= 0.3-1% with the side. Both | filter-50-half / lower-50 / both-100 | $451,625 / $601,479; $211,860 / $293,786; $446,218 / $552,025 | $812,132 / $207,854; $581,909 / $144,608; $836,945 / $178,173 | no. The close-based finding (calls on red days ~1% giants) does not hold at entry time: the halved trades were -$61K on tune but +$178K (2 giants) on check; the lower bar's added trades lose both halves (-$103K / -$163K, no giants). Control matches the champion |
| The Indi close (indi_close.py, champ_entries.py; the user 2026-10-30 from his overnight trades and 623 posts): at 15:57 buy stocks up 2-4% (1.5 / 3+), top 15% of the range, above VWAP, stronger than SPY x beta over the last hour, volume >= 1.3x, no earnings that night, not Friday, <= 3 a night; delta 0.20 (0.15 / 0.30), 2-4 day or next-day expiry; out his way (09:31-09:32 without a gap, else half then 10:00) or at 10:00; "above the all-time high" | m3-n (up 3%+, next-day expiry) | alone $136,107 / $115,214 (5 / 3 giants); + champion $573,603 / $689,610 | alone $93,537 / $80,288 (0 giants); + champion $858,756 / $164,476 | no: the tune result was 5 giants, none on check; it takes 19 of his 149 late overnight buys on our stocks. His overnight trades: +$11.15M of ~$12.8M, +$5.1M from entries after 15:00 (actions.csv) |
| The Indi close, strength vs SPY (indi_close.py IC_SET=rs; the user 2026-10-30: "we do not need the stock to be up. only strong against the spy and on the top 90% of the day", "strong with spy mean t>1.2 and D2 ... bigger than 0.5"): no move or VWAP rule; top 10% of the range; the bot's t at 15:57 >= 1.0 / 1.2 / 1.5 and D2 >= 0.5 over the last 30 min / the best 30 min of the day / the last 120 min / the whole day (+ D2 >= 1.0); volume, earnings, Friday, top 3 as before; both expiries (26 versions + m3; look 2 on the close idea) | t15-c30-n (t >= 1.5, the bot's D2 at 15:57, next-day expiry) | alone $153,012 / $135,510 (14 / 16 trades, 4 / 3 giants; the rest -$26K / -$51K); + champion $646,460 / $816,169 | alone $99,757 / $98,639 (8 / 10 trades, 0 giants, median -$4.8K); + champion $926,326 / $204,113 vs $928,510 / $206,879 | no: in every one of the 26 versions the non-giant trades lose (median about -$3K to -$8K a trade); the money is 1-6 giants on tune and none came on check; next-day beat 2-4 days on tune in every pair, only through the giants; it takes 8 of his 149 late overnight buys |
| Analysis, not a rule: his entries by the bot's measures (his_tvd.py; the user 2026-10-30: "analyse the data from indi enters? gather T V D2"): 1,120 of his trades (Jan 2023 - Oct 2026, stocks / ETFs) at his first-buy minute, vs the other stocks of our lists at that minute | - | median t 1.02, volume 1.36x, D2 0.32; range position 0.87; his stock ranks 86 / 77 / 69 of 100 on t / volume / D2 among peers; the bot's rule (t 1.8, v 1.5) holds on 9%; it had held earlier that day on 239 entries, a median 95 minutes before him | winners and losers have the same t / v / D2 (t 1.08 vs 1.00, v 1.32 vs 1.39, D2 0.39 vs 0.30); the 36 giants (3x premium, +$13.15M of +$11.30M) are stronger (t 1.31, v 1.52, D2 0.55, D2 best today 2.45, position 0.96, rank t 93): giants per 100 entries 6.0 when D2 best today >= 2 vs 1.5 below 1, 5.1 in the top 5% of t vs 1.0 in the bottom half | no level of t, v or D2 moves his median return (-8% to -20% in every bucket); like the bot, his money is the giants. Page: https://claude.ai/artifact/Xs6PdavjhSgx2mUkLkVDTd |
| The champion only on the leader (peer_rank.py; the user 2026-10-30 after his_tvd.py: "take best 2, than best 1. try d 2 as suggested and d 1.5 as well"): keep a champion entry only if its t is 1st / top 2 among our lists' stocks at that minute, and / or the day's best 30-min D2 so far >= 2 / 1.5 (8 versions; look 1) | d2-20 (D2 best today >= 2) | $222,835 / $180,631 vs $422,807 / $596,437 (keeps 175 / 165 of 503 / 506 trades, 8 / 7 of 19 / 21 giants) | $704,514 / $205,799 vs $929,849 / $206,879; without best 5 $165,916 / $82,193 vs $211,746 / $71,230 | no as a filter: every version loses money on tune. The rank filters are the worst: top1 keeps 3 of 19 giants, so being the leader does not make the bot's giants (unlike his). D2 best >= 2 does sort them: giants per 100 trades 4.6 vs 3.4 (tune) and 6.9 vs 2.9 (check) on the fair list; per trade +$2.9K vs +$1.5K (tune), +$6.5K vs +$0.6K (check); Favorites check +$2.6K vs +$0.1K, tune equal. The dropped trades still make money, so a size-up on D2 >= 2 is the follow-up, not a filter. Baseline here $422,807 tune fair vs $418,875 in bots.md (data through a later day) |
| Analysis: his big winners caught and the bot's added (giants_match.py; the user 2026-10-30: "show me how many big winners we catch from indi and how many we added") | - | fair list, Feb 2024 on: his 15 giants (3x+) on the list's stocks; the champion traded 2 of them (1 a giant for us), and 7 of his 38 trades of 1x+ (3 giants for us); the champion's 40 giants: 6 on a stock-day he traded, 34 he did not | Favorites (24 m): his 15 giants, champion traded 3 (1 giant); its 38 giants: 5 with him, 33 without. Every filter of peer_rank.py keeps fewer of his and of ours; top1 / top2 catch none of his giants | the bot's money is its own giants, not his: it catches about 1 in 15 of his big winners. Every version but top2, top2-d2-15 and top1-d2-15 (tune) ends above the $100K start on both halves |
| Last 3 minutes: the volume rule and Fridays (indi_close.py IC_SET=vol; the user 2026-10-30 "yes" after his_vol.py showed his late giants had normal volume, 0.97x day, and his losers the most): volume >= 1.3x / none / under 1.3x x Fridays out / in (Monday expiry), x t 1.0/1.2/1.5 x D2 window (30 min / 2 h / best 30 / day), next-day expiry; 72 versions | t10-c30-min-fri | $ (tune pick) | check $101,866 / $99,245 (19 / 22 trades, 1 giant each) | no change: the 1.3x rule stays. Median of the 12 versions, check fair / fav: >= 1.3x $109,596 / $98,396 (4 of 12 above $100K on all four), no rule $92,820 / $92,618 (0 of 12, twice the trades, median trade -$5.9K), quiet $81,362 / $84,402 (0). Fridays: more on tune, less on check. Of his 6 late giants: META in every rule, IBIT 2026-09-18 only with Fridays; NVDA, IBIT 2025-08-28, APP, AAPL in no version (D2 window, top 3 a night or no fitting option). His quiet giants can't be had by dropping the rule |
| Last 3 minutes: D2 as a bonus or alone (indi_close.py IC_SET=d2b; the user 2026-10-30: "D2 is not a constrain - it's a bonus, or it's come alone"): strong = t >= 1.2 / 1.5 / 1.8, or D2 alone >= 1.0 / 2.0, or t >= 0.8 and D2 >= 0.5 (bonus), D2 over the last 30 min / 2 h; volume 1.3x, top 10% of range, no earnings, no Friday, next-day expiry, top 3 by t; 21 versions; look ~5 on the close idea | tonly-t18 (t >= 1.8, no D2 path) | $126,829 / $124,413 (24 / 24 trades, 3 / 3 giants, median -$6.2K / -$8.0K) | $115,916 / $111,205, worst drop 3% / 3% (17 / 19 trades, 65% / 53% winners, median +$4,747 / +$2,453, 1 giant each, without giants +$40.7K / +$20.1K, every year positive) | passes on its own (no champion compare, per the user): first close version picked on tune that wins on check on both lists with a positive median. D2 paths add trades that lose: no D2 version beats t-only at the same t on check. Weak points: ~20 trades a half, tune median negative, the close idea has been looked at ~5 times. 4 of 21 above $100K on all four, all at t 1.8 |
| Last 3 minutes: D3 in place of D2 (indi_close.py IC_SET=d3, d3.py; the user 2026-10-30 "Go"): D3 = how much the stock joined SPY's real drops (swings of SPY's 30-min move) vs its own 20-day usual; D3-last = the latest drop; as a bonus (t >= 1.8, or t >= 0.8 and D3 >= 0.5 / 1.0), alone, or required with t >= 1.0-1.5; 15 versions | tonly-t18 again | D3 bonus: fair $143,441 vs $126,829 (+6 trades, +1 giant), Favorites $113,687-$116,815 vs $124,413 | (shown, not judged) D3 bonus x1.0: fair $119,123 vs $115,916, Favorites $106,551 vs $111,205 | no change: D3 helps on the fair list in both halves and hurts on the Favorites in both; D3-last and D3-required are worse. t >= 1.8 alone stays the pick |
| nightly-bet: 2 bets almost every night (indi_close.py IC_SET=many; the user 2026-10-31: "lets try to make a lot more trading. I want that almost every night we'll take a 2 bets"): rank, not a bar: each night the stock-sides passing the filters ranked by the bot's t at 15:57, the best N bought; next-day expiry, his exit, no earnings night; t18-top3 (= tonly-t18) / t18-top2 / r2-v13 (best 2, top 10% of range, volume 1.3x) / r2 (no volume rule) / r2-p80 (top 20%) / r2-fri (+ Fridays) / r2-t10 (t >= 1.0); 7 versions, look ~6 on the close idea | r2-v13 | $135,444 / $124,503 (55 / 41 trades, 6 / 4 giants, median -$5.3K / -$6.1K, the rest -$176K / -$129K) vs t18-top3 $126,770 / $124,387; r2 $122,388 / $81,998, r2-p80 $150,825 / $93,610, r2-fri $133,988 / $79,821, r2-t10 $123,019 / $83,996; t18-top2 $131,896 / $133,944 | r2-v13 $105,547 / $92,552 (46 / 40 trades, median -$2.8K / -$5.0K, 1 giant each) vs t18-top3 $115,789 / $111,205 (17 / 19, median +$4.2K / +$2.5K) | no: the added trades lose (median -$5K to -$7K, the non-giant sum -$130K to -$240K a list on tune) and the pick loses to t18-top3 on check on both lists. And it does not give 2 a night: even best-2-with-no-floor buys 2 on only 3-6% of nights, nothing on 78-84%. The limit is the option, not the stock rule: of 3,570 candidate bets only 330 had a next-day expiry with >= 200 contracts in the last 30 min and >= $0.20 (most stocks have no next-day expiry most nights). Next: a 1-4 day expiry fallback when there is no liquid next-day one |
| nightly-bet: fill down the list + a 1-4 day expiry fallback (indi_close.py IC_SET=fill, nb_why.py; the user 2026-10-31 "why we still have 84% with no night bets?" then "go."). nb_why.py: only 1% of nights have no stock passing the stock rules (median 7 candidates fair, 12 Favorites); of the candidates 70% have no next-day expiry, 17% a thin / < $0.20 one, 12% trade; IC_SET=many stopped at the top 2. Versions: t18-top3 (reference) / r2v13-down (best 2, volume 1.3x, down the list, next-day only) / t18-fill, r2v13-fill, r2-fill (down the list + the nearest liquid expiry 1-4 days out); look ~7 on the close idea | t18-fill | t18-fill $138,886 / $124,528 (55 / 60 trades, median -$3.7K / -$5.6K); r2v13-down $129,992 / $109,141; r2v13-fill $149,229 / $105,014 (175 / 176, 2 bets on 17% / 30% of nights); r2-fill $103,093 / $63,402, worst drop 46% (415 / 329 trades, 2 bets on 69% / 80% of nights, the non-giant sum -$717K / -$927K) vs t18-top3 $126,770 / $124,387 | t18-fill $106,585 / 14% and $114,689 / 9% (60 / 61 trades, median -$2.8K / -$2.4K) vs t18-top3 $115,789 / 3% and $111,205 / 3% | no: nearly every night is possible (r2-fill: 2 bets on 69-80% of nights, every weekday 61-74%) but it loses: the weaker stocks' bets lose ~$3.5-4.3K each (median) and the drop reaches 46%. The pick (t >= 1.8 + fill + fallback) is worse than t18-top3 on check on the fair list with 4-5x the drop. Next-day expiries are a Thursday thing (r2v13-down: 2 bets on 29% of Thursdays, ~1% of other nights). The close idea's money is only in the strongest few stocks; more nights means weaker stocks |
| nightly-bet: a score, not thresholds (indi_close.py IC_SET=score; the user 2026-10-31 after the chart page of his last 12 night trades: "he like volume but this is not a trshold but a score", against SPY "more important than the volume", "volume burst during the day", a run-up in the last hour "is most likely exustade", a pullback adds score; weights "Against SPY = 5, Pullback = 4, Burst = 3, Volume = 2", given before any result): gates t >= 1.0 and >= 0.70 of the range its way, no earnings night, no Friday; parts as percentiles of the tune pool: t, log day volume vs usual, log of the day's largest 5-minute volume vs that stock's usual 5 minutes (20-day median per minute), minus the last hour's excess move in S30; bet when the score is in the tune pool's top 10% / 5%, at most 2 a night down the list, next-day or nearest liquid 1-4 day option, his exit; versions w5432-90 / -95, w-noburst-90, w-nopull-90, w-equal-90 (1,1,1,1); look ~8 on the close idea | w5432-90 (the user's weights) | w5432-90 $192,753 / 8% and $155,352 / 7% (64 / 60 trades, median -$943 / -$2.6K, 6 / 4 giants, the rest +$29.6K / +$7.1K); w5432-95 $144,022 / $134,112 (median +$552 / +$880); w-noburst $135,139 / $112,847; w-nopull $198,487 / $154,904 (the rest -$53K / -$103K); w-equal $197,882 / $154,861 vs t18-top3 $126,770 / $124,387 | w5432-90 $92,435 / 26% and $83,482 / 27% (80 / 81 trades, median -$3.9K / -$4.1K, the rest -$132K / -$133K) vs t18-top3 $115,789 / 3% and $111,205 / 3% | no: the best tune result of the close idea so far (more money, a smaller drop, the non-giant sum positive, the burst and the pullback each helped on tune) collapses on check to a loss on both lists with a 26-27% drop. The two halves are the same months (alternate weeks), so the tune gain is the luck of which nights fell in it, not a steady edge. Still about 1 bet on 20% of nights; 2 bets are rare |
| Analysis, not a rule: nightly-bet v2 measurements on ~310 stocks (nightly_feat.py, nightly_bins.py; the user 2026-10-31: "it should be much more sofisticated - for each messurment we need to figure out how to messure", "I want atlist 300 ayer", "go ahead"): every stock-side-night Feb 2024 on at 15:57, tune weeks only, no earnings / Friday; 21 measures (RS: residual vs SPY + sector ETF in z, gap, 3-day, t, consistency, SPY-down blocks; volume: rvol vs the per-minute profile, last 2 h, up/down volume, dollar; bursts as events with impact x hold; last hour: run, depth from the high, range, gap hold, VWAP stretch); target: the 15:57 -> 09:45 move in its 60-day sd and a modelled 0.20-delta next-day option. Pool rs_day >= 0.5 and pos >= 0.6: 96 a night | - | every measure's rank correlation with the modelled option is tiny (|rho| <= 0.03); the big-winner share (+300%) rises with activity: day volume quintiles 2.2% -> 6.8%, last-2-hour volume 2.0% -> 7.0%, burst count 2.5% -> 6.4%, last-hour range 2.6% -> 6.7%, rs_day 3.2% -> 6.3%, t 3.7% -> 5.1%, depth 3.6% -> 5.1% | the same stock-night's opposite side (direction vs volatility): part of the activity effect is volatility (the opposite side's +300% share also rises, 2.0% -> 4.2% by volume, which real IV prices), but our side's lead grows with it: by volume +0.2 -> +2.6 pts and the mean move our way -0.002% -> +0.203%; by burst count -0.1 -> +2.7 pts (+0.234%); rs_day +0.7 -> +2.0; t +0.8 -> +1.9; pulled back from the last hour's high (depth) +0.5 -> +1.6 pts (+0.11%); a last-hour pullback (lh_run bottom quintile) +1.3 pts and +0.135% vs a run-up (4th quintile) -0.011% | a direction edge exists on the active nights (volume, bursts) and the strong ones, and the user's pullback idea holds (a pullback is better than a run into the close); the modelled option ignores today's higher IV, so the size is unproven until real quotes. Next: a score from these, ~300 bets a year, real option quotes, tune and check |
| nightly-bet v2: the score on ~310 stocks with real option quotes (nightly_bt.py; the user 2026-10-31 "yes"): gate rs_day >= 0.5 and pos >= 0.6; parts as tune-pool percentiles: ACT (rvol, rvol_late, burst_n), RS (rs_day, t), PULL (depth, -lh_run); score >= the tune pool's 80th percentile, the night's 6 best tried, the first 2 with a liquid option (next-day, else 1-4 days, delta 0.20) bought at 15:57, his exit; versions a3r2p2 / a3r2p0 / equal / user (5,5,4) and ref (t >= 1.8, pos >= 0.9, volume 1.3x, top 3, next-day only, on the same stocks); look 1 on v2 (~9 on the close idea) | a3r2p0 | a3r2p2 $77,989 / 28%; a3r2p0 $109,662 / 29% (169 trades, ~126 a year, median -$4.6K, 7 giants, the rest -$367K); equal $73,601; user $95,788 vs ref $134,996 / 7% (27 trades, 3 giants, the rest -$48K) | a3r2p0 $83,598 / 30% (155 trades, median -$3.4K, the rest -$286K) vs ref $91,826 / 15% (27 trades, 0 giants) | no: the stock-level lead (+0.1-0.2% a night our way on the active / strong nights) does not survive a 0.20-delta 1-4 day option: the typical bet loses ~$4K at $10K (spread, the night's time decay, the higher IV on busy nights), and every score loses on tune too. ~120 bets a year, not 300: of 6,256 tried only ~560 had a liquid option. Today's rule on the wider list also loses on check. The edge, if any, is too small for cheap OTM options; a test with shares or a deeper / longer option is the open question |
| nightly-bet: the morning exit, half at 09:32 and the rest to the close (indi_close.py IC_SET=o2; the user 2026-10-31: "if the 2 minutes openning goes in our way- sell after 2 minutes half and let the other run to the end of the day", against us "Sell all at 09:32"): today's pick (t >= 1.8, top 10%, volume 1.3x, top 3, next-day expiry); our way = 09:32 vs the 09:30 open (o2open) or vs the entry day's close (o2close); the rest sold 15:55 on the expiry day; reference his exit; look ~10 on the close idea | t18-o2close | o2open $147,971 / 12% and $140,703 / 14%; o2close $141,457 / 13% and $140,929 / 15% (25 / 25 trades, 4 / 4 giants, median -$7.4K / -$7.8K, the rest -$140K / -$142K) vs his exit $126,770 / 9% and $124,387 / 11% (3 / 3 giants, the rest -$84K / -$93K) | o2close $113,433 / 5% and $105,430 / 5% (17 / 19 trades, median -$4.6K / -$4.7K) vs his exit $115,789 / 3% and $111,205 / 3% (median +$4.2K / +$2.5K) | no: holding half to the close catches one more big winner a half on tune (+$15-21K), but the other trades do worse (the expiring option decays all day when the move stalls: the rest -$140K vs -$84K), and on check it is below his exit on both lists with a negative median where his is positive. ~20 trades a half: small |
| nightly-bet: the main bot's day signals as the night's bet (sig_night.py, sig_combo.py; the user 2026-10-31: "these signals durong the day might be a good predict to the next morning but we do need to filter it somwhow"): every c12_15 signal-day Feb 2024 on (19,574 on 191 stocks, bought or not; 2,043 bought) joined to its 15:57 measures and the 15:57 -> 09:45 move, stock only, 0.04% cost; 7 filters (last-hour pullback, signal after 10:30, volume 1.5x / 2.5x, t >= 2 at 15:57, 11+ bursts, range position >= 0.7) in 64 combinations, picked on tune by the mean move (n >= 300) | pullback + vol2.5 | every signal-day +0.037% a night vs +0.000% for the same stocks' other sides; pullback + vol2.5 +0.388% (483, ~360 a year, median +0.01%, 51% up, mean / se 2.0) | pullback + vol2.5 -0.028% (532, median -0.14%, 47% up); every signal-day -0.004% | no: a signal during the day does not predict the next morning (every signal-day +0.04% tune, -0.00% check), and the best of 64 filters on tune is flat on check. The same pattern as nightly-bet v2: the tune leads are noise. Confirms the intraday-strength study of 2026-10-09 |
| nightly-bet: the big-winner game by the option's delta (indi_close.py IC_SET=delta, nightly_bt.py NB_SET=delta, bigrate.py; the user 2026-10-31: "we want a big move, and if we hit 1/8 big we will win", "go and test it"): A today's pick (t >= 1.8, the fair list + Favorites counted once, next-day option) and B the v2 score a3r2p0 (~310 stocks, next-day or 1-4 day option) at delta 0.10 / 0.15 / 0.20 / 0.30; per version the big-winner rate (+300%), their average, the others' average, the break-even rate, the average per bet; picked on tune by the average per bet; look ~11 on the close idea | d10 (both) | A: d10 18 bets, 3 big (1 in 6), +114% a bet, $142,075; d15 +11%; d20 31 bets, 3 big (1 in 10), +27%, $113,518; d30 +20%. B: d10 89 bets, 3 big (1 in 30), +6%; d15 -9%; d20 169, 7 big (1 in 24), +5%, $109,256; d30 223, 6 big (1 in 37), -2% | A: d10 20 bets, 1 big, -17% a bet, $93,073; d20 23 bets, 1 big, +32% a bet (others +18%), $115,377 / 3%. B: d10 83 bets, 1 big (1 in 83), -16%, $75,288 / 31%; d20 155, 5 big (1 in 31), -5%, $83,598 / 30% | no to a cheaper option: delta 0.10 wins tune on both rules and loses check on both. The big-winner rate does not rise with a cheaper option (1 in 20-80 on check); the $0.20 floor drops most 0.10-delta contracts (fewer, pricier stocks' bets). The break-even rate is 1 in 15-30; the v2 score sits at it (d20 +5% / -5% a bet); today's pick at d20 is positive on both halves (+27% / +32% a bet) but on 54 bets with 4 big winners. 1 in 8 is not in sight on any rule |
| nightly-bet: the main bot's bought signals held overnight when the last hour is flat or gave back (sig_lasthour.py; the user 2026-11-01: "lets take only what it's theoreticaly buy during the day, and buy it if the last hour (check on 15:50) its flat or give back"): c12_15 signal-days with status ok (2,043; Feb 2024 on, no Friday / earnings 1,453), the last hour 14:50 -> 15:50 on its side in the day's usual hour move; all / <= 0 / <= +0.5 / <= +1.0; bought 15:57 delta 0.20 (next-day or nearest liquid 1-4 days), his exit, real quotes (open29), 766 got an option; every bet 2%; picked on tune by the average per bet; look ~12 on the close idea | lh000 (gave back) | all 380 bets, 14 big (1 in 27), +3% a bet, median -36%, $105,099 / 33%; lh000 155, 4 big, +3%, $104,635 / 25%; lh050 267, 6 big, -1%, $88,095; lh100 338, 11 big, +0%, $90,604; contrast: ran (> +0.5) 113, 8 big (1 in 14), +13%, $124,414 | all 386, 5 big (1 in 77), -4% a bet, $67,742 / 46%; lh000 199, 3 big (1 in 66), -1%, median -29%, without best 5 -11%, $92,603 / 18%; contrast ran 97, 0 big, -11%, $80,671 | no: the main bot's bought day signals do not carry into the next morning as an option (all -4% a bet on check), and the last-hour check does not fix it (gave back -1%, flat worse on tune); the run-up side won tune and lost check, the same noise pattern. Matches sig_night.py (stock only). Follow-up (the user 2026-11-01: "if we take only the signals that came after 14:30?"), the same 766 bets by the bought signal's minute: 717 came before 12:30, only 33 at 13:30 or later; tune t1430 10 bets +62% a bet, t1330 17 bets 2 big +77%, t1500 9 bets, with gave back / flat 2 bets; picked t1330; check t1330 16 bets, 0 big, -4% a bet, $98,682; t1430 7 bets +20% (without best 5 -81%). Too few bets to read; no edge shown. Then every signal, not only bought (SL_SET=late; the user: "not the bought - the signals"): 764 signal-days with a signal at 13:30 or later, 572 without Friday / earnings, only 73 with a liquid option at 15:57 (open30); tune t1330 36 bets 2 big +35% a bet $125,646 (without best 5 -23%), t1430 23 bets 1 big +34% $115,824, t1500 13 bets 1 big +47% $112,006, t1430-flat 8 bets 0 big +43%; picked t1500; check t1500 13 bets 0 big -15% a bet $96,117, t1430 19 bets 0 big -10% $96,040 (without best 5 -45%). No: no big winner on check, every tune lead is one +547% trade. Then no filter at all (SL_SET=all14; the user: "lets not filter it for now and place the bbet"; the signal files keep only a day's first signal, so s_all_c12_15 with every minute): 4,383 stock-side-days with a signal at or after 14:30 (3,866 first fired earlier), no Friday / earnings / last-hour filter, open31; floor ($0.20, 200 contracts) 541 got an option, nofloor (any priced option) 1,635 (the rest: no expiry within 4 days); floor tune 286 bets 13 big (1 in 22) +2% a bet, median -42%, $98,167 / 29%; check 255, 9 big (1 in 28), -0%, $92,224 / 46%; nofloor tune 819, 1 in 39, -11% a bet, $13,339 / 90%; check 816, 1 in 41, -15%, $6,568 / 95%. No: break-even on the liquid ones, a wipe-out on thin options (the spread) |
| nightly-bet: the main bot's morning rule as the 15:57 bets' exit (indi_close.py IC_SET=mb, nightly_bt.py NB_SET=mb; the user 2026-11-01: "What if we go with main bot overnight strategy? Half if its in our direction on the morning and run with the other half. Sell all otherwise unless we have less than 10% remaind - sell them after 30m"; answered: the 15:57 bets, 10% = the option under 10% of its cost): at 09:40, the open's gap from the entry close >= 0.5% our way: half at 09:40, the rest at 15:55; else all at 09:40 (mb-no10), or at 10:10 when the option is under 10% of its cost (mb); vs his exit; today's pick (t >= 1.8, next-day, d20) and v2 a3r2p0 (d20); quotes open26 / open25; look ~15 on the close idea | t18-mb-no10; a3r2p0-mb | A his: fair 24 bets +58% a bet $126,770 / 9%, fav $124,387 / 11%; mb fair 25 bets 4 big +102% $152,562 / 11%, fav +93% $148,129 / 14%; mb-no10 $152,811 / $148,265. B his $109,256 / 29%; mb $111,943 / 39%; mb-no10 $111,493 / 39% | A his fair $115,789 / 3% (+45% a bet, median +42%), fav $111,205 / 3%; mb-no10 fair $113,093 / 6% (+40%, median -24%), fav $105,837 / 7% (+18%); mb $113,372 / $106,097. B his $83,598 / 30%; mb $71,374 / 40% | no: the main bot's morning rule wins tune on both rules (the kept half rides tune's big days) and loses check on both, with more drop; his exit's quick sale keeps the median positive (+42% vs -24%). The 10% clause almost never fires (under $300 difference) |
| A better D2 (d2_fix.py, defence_signals.py BT_D2_MODE; the user 2026-10-30 after ORCL 10-28 read D2 5.0 on two shock minutes: "maybe we can improve how we calculate D2? check in the industry", "fix the D2 before the shock ... do also D2 0.5"): the D2 bonus measured 6 ways (today's; each minute capped at 2.5x / 3x the stock's typical minute; 3x + beat SPY x beta on >= 60% of >= 8 SPY-down minutes; only SPY minutes >= half its typical move; weighted by SPY's move, the downside-capture idea), each at D2 >= 0.5 / 1.0 / 1.5 (18 versions, look 1) | every measure picks 1.5 | control $430,585 / $594,175 (= the champion + 9 trades past its file end); clip25-15 $463,349 / $647,864, clip30-15 $335,269 / $451,697, clip30hit-15 $343,904 / $483,641, floor-15 $278,059 / $436,848, wspy-15 $278,150 / $451,395; D2 0.5: $147,333 / $184,568 (today) and $150-190K for every measure; 1.0: $219-280K | champion $929,849 / $206,879; clip25-15 $478,524 / $135,233, clip30-15 $744,288 / $167,194, clip30hit-15 $362,430 / $160,260, floor-15 $521,407 / $142,515, wspy-15 $418,365 / $112,842 | no: keep today's D2 at 1.5. The D2 entries the caps drop are losers on both halves (clip25: 34 / 32 days, -$74K / -$99K, no giants, median -$2.5K to -$3.1K), but the caps also delay the jump days the champion enters on early, and those early entries are the money (clip25 moved 50 / 70 days: +$580K -> +$411K tune, +$477K -> +$204K check). A jump on the SPY-down minutes is what D2 pays for; the ORCL reading is the rule working. Lower D2 levels fire earlier on weaker moves and lose 55-65% of the money: 0.5 is far worse. Supports the shock test (enter on the jump) |
| Lower thresholds after a volume shock (shock_test.py, defence_signals.py shC / shvC, f60_alerts.py K=15 with the move's side; the user 2026-10-30: "see the shock alert and if we get one - you can reduce the T V D trshvolds by 30%-50%. after you enter you need to confirm that during the next Xminutes we do go thouruhgt that trshgold"; ORCL 10-28 example: shock_lower.py): for 30 min after a 15x 60-second shock (10-second bars: 42 stocks from Feb 2024, 29 from Oct 2025), on its side, t / bonus t / D2 / day volume cut 30% / 50%, or no volume floor (vol); unconfirmed (full rule not within X = 10 / 20 / 30 min) sold at the bid; + the liquid fallback (12 versions, look 1) | cut30-c20 / cut50-c20 / vol30-c20 / cut50-c20-liq | $461,151 / $655,483; $340,792 / $515,854; $445,808 / $647,221; $376,699 / $528,686 vs control $430,585 / $594,175 (= champion + 9 trades past its file end) | $861,537 / $186,483; $831,836 / $189,717; $885,810 / $198,743; $730,340 / $175,453 vs $929,849 / $206,879 (worst drop 32-34% vs 22%) | no. The lowered entries are rare (33-72 a half) and their money is one giant a half: cut30-c20 lowered +$40K / +$72K tune, +$75K / +$59K check, 1-2 giants, median -$2.0K; the unconfirmed ones (75-80%) lose -$46K to -$62K a half, never a giant; the confirmed ones (6-11) make it all. 10-minute confirmation and 50% cuts are worse; the liquid fallback adds bleed (-$118K to -$207K unconfirmed). Fast entry on a shock does not pay for its failures |
| Half size after a losing run (streak_size.py; the user 2026-10-30: "checking the drop manage half size after: 1. 5 losers in a row, 10 losers, not big winner for 20 trades, etc"; streaks after 3/5/8 losers were in sizing_sweep.py 2026-10-23 on the old champion): overlay on the champion's real-quote positions (main + add), each half its own $100K account, an outcome counted once closed; half size after 5 / 10 / 15 losers in a row until a winner, or while the last 20 / 40 trades had no +100% (D) or no +300% (Dg) until one; flat 1.5% / 1.75% as the yardstick (8 rules, look 1) | L15 (streak) / D40 (drought) | champion $422,807 / 30%, $596,437 / 20%; L5 $235,877 / 24%, $232,882 / 15%; L10 $348,126 / 26%, $414,190 / 19%; L15 $344,123 / 28%, $495,625 / 21%; D20 $221,213 / 25%, $346,393 / 16%; D20g $190,640 / 21%, $277,772 / 16%; D40 $431,588 / 29%, $596,437 / 20% (15 / 0 half trades); flat 1.5% $349,290 / 24%, $454,457 / 16% | champion $929,849 / 22%, $206,879 / 25%; L15 $723,376 / 25%, $149,402 / 26%; D40 $824,424 / 23% (5 half trades, 2 of them giants), $206,879 / 25%; flat 1.5% $625,873 / 17%, $188,068 / 20%; flat 1.75% $776,257 / 19%, $200,097 / 22% | no: every streak and drought rule ends below the flat size with the same worst drop (L5 cuts the tune drop 30% -> 24% / 20% -> 15% for $236K / $233K; flat 1.5% does it for $349K / $454K). The half-size trades hold the giants: L5 240 / 276 half trades with 11 / 17 giants, +$1.0M / +$1.4M at $10K full. The money still comes right after the losing runs; to cut the drop, lower the flat size |
| Universe: Nasdaq-100 2026, hot 20s (ndx_test.py, ndx_hot.py) | — | Fav + 77 new: $210,604 | $200,273 (one NFLX giant) | no: 30 trades in 10 months; NFLX +$269K on 11 |
| Universe: 10 liquid movers (opt_liq.py screen, liq_test.py) | — | 2026: 7 trades | — | no: 65% of signals "too cheap" ($10-40 stocks) |
| Universe: 12 leveraged ETFs SOXL TQQQ ... (liq_test.py LQ_NAME=lev12) | — | 43 trades in 22 months, 0 giants | 2026 Fav + ETFs $141,233 vs $143,000 | no |
| Analysis, not a rule: his first 15 minutes (session scratchpad early/feat.py + summ.py, 04:00-16:00 SIP bars fetched for his stocks; the user 2026-10-30: "show me Indi first 15 minutes enter? what special about them? what can we say about the pre market? check V D T"): 187 of his 1,532 option trades (Jan 2023 - Oct 2026) with the first buy 09:30-09:44, vs his later entries | - | 29% winners, median -16.5%, +$656K but -$499K without the top 3 (10:30-15:00: +$3.1M without the top 3); gap his way 70% (later 63%), gap 1.6 S30 (0.8), pre-market volume 1.5x (1.3x), yesterday vs SPY +0.6% (0.0%); only 31% already past the pre-market high / low (later 67%); t 0.84, v 1.39x, D2 0.11, the bot's rule holds on 5% | winners and losers have the same gap / pre-market volume / range; pre-market volume >= 2x -$578K without the top 3, past the pre-market extreme -$502K; range position >= 0.8: 39% winners, about flat without the top 3, below 0.8 -$954K (held 2024-25, not 2023) | the opening is his weakest window; the only lead, the range position, went to rangepos.py. Page: https://claude.ai/artifact/RyRbm6txgFGZJn6fEua3ky |
| The range position as an entry filter (rangepos.py; the user 2026-10-30 "go with it" on the first-15-minute study): no champion entry when the stock is under 0.7 / 0.8 / 0.9 of the day's range so far (his side), on every entry or only before 10:00 (6 versions, look 1) | pos70 (0.864) / e-pos70 (0.844): neither beats the champion | $434,591 / $515,144; e-pos70 $424,691 / $503,318 (champion $422,807 / $596,437) | pos70 $606,839 / $174,106; e-pos70 $946,889 / $218,977 (champion $929,849 / $206,879) | no: the champion already buys at the extreme (93% of its tune entries are at 0.8+, 77% at 0.9+), so the filter removes few trades and those hold giants (pos90 drops 7 of 21 on the fair list); every bucket's median is -$2.4K to -$3.2K; e-pos70 is a little better on check but loses the Favorites on tune |
| Who are the fast losers, and half size on them (fastloser.py; the user 2026-10-31: "so you can't find anyway to drop the drop with smal-mid los of money where the rick-rewered stay?" then "do it"; the next step runup.py logged): label = a champion main leg sold out by 20 minutes (40% of the trades on both halves, never a giant); 17 entry features (t, v, D2, c_e, pre-market volume / gap, the 10-minute run, range position, minute, SPY day / last 10 min, the option's price / IV / 30-min volume / delta / spread, entries already that day) + D2 entry; half size (main + add) on each feature's bottom / top tune quintile = 34 rules, judged against the flat line (1% / 1.5% / 2%) at the same worst drop (look 1) | spy10-low (SPY moved most against the bet over the last 10 minutes): 1.351 / 1.264 of the flat line | $519,976 / 27% and $660,277 / 18% vs the line $384,935 / $522,360 (champion $422,807 / 30%, $596,437 / 20%) | $684,567 / 22% vs the line $942,817 (0.726) ; $206,201 / 24% vs $203,262 (1.014) | no: the pick fails the check on the fair list. Nothing separates the fast losers well: their share is 25-50% in every quintile and most patterns flip between halves. Two hold on both halves: a bigger 10-minute run (Q1 29-33% fast, Q5 47-51%) and an earlier entry (minutes 10-14 45-46%, the last fifth 28-37%), but those same entries hold the giants (runs Q5 3-7 giants, minutes 10-14 10 of 19 on the tune fair list), so halving them loses to the flat line (run-high 0.87 / 0.99). The bleed and the giants come from the same entries: a smaller flat size stays the cheapest way to a smaller drop. delta-low (1.36 / 1.18 on tune) was not the pick and was not checked |
| Analysis, not a rule: the champion's signals in 2022-2023 (fetch22.py: 1-minute stock bars Dec 2021 - Dec 2023 for his 40 + the 60 Favorites into market.sqlite; sig22.py; the user 2026-10-31: "why i cant run the backtest in 2022?" then "OK give me signals for 2022-2023"): no option prices before Feb 2024 (Alpaca option bars, Databento quotes) and no fair list before 2024, so the stock side only; rule c12_15 on 75 stocks, every year the same; the news filter has no data in 2022 | - | all signals per year (2022 / 2023 / 2024 / 2025 / 2026): 2,169 / 2,679 / 2,837 / 2,832 / 2,476, 14.5-17 per 100 stock-days; closed our way 50% / 50% / 53% / 51% / 54%; mean to the close +0.03% / +0.16% / +0.27% / +0.17% / +0.29%, vs SPY x beta -0.08% / +0.09% / +0.23% / -0.01% / +0.29%; failed both checks 38% / 40% / 39% / 40% / 36%; a giant-size stock move (>= 6.8% our way by the close or the next close, the 25th percentile of the champion's 76 giants of 2024-26, whose median is 9.7%; 8% of its other trades reach it) 16.9% / 10.9% / 12.6% / 12.5% / 12.2% (a first 3-S30 measure, 53-60% in every year, was too loose to mean anything) | 2022 (a bear market: 50% calls) has no direction edge at the close, as 2025, the year the bot still made money on the giants; 2022 has more giant-size moves than 2024-26 (17% vs 12-13%: a volatile year, and options cost more then), 2023 a little fewer (11%); the day range was widest in 2022 (median best +1.70% / worst -1.71%) | no P&L: the stock side looks like 2024-25 in every count; whether 2022-23 paid depends on option prices we do not have (Databento OPRA, not bought) |
| MODELED, not market data: the champion (2.7 at minute fills) on 2022-2023 with Black-Scholes options (bsmodel.py, bs22.py; the user 2026-10-31: "lets start with Black-Scholes"): weekly Friday expiries, a strike grid, the volatility 1.43 x the 20-day realized (the median implied / realized of the champion's 0.15-delta picks, 1.42-1.44 every year 2024-26), fixed volume; bar-model fills; his 40 and the Favorites, each year its own $100,000 account at 2%; checked on 2024-26 against the real Alpaca option bars of the same signals | - | per trade at $10K, model, his 40: 2022 +$800, 2023 +$123, 2024 +$1,378, 2025 +$1,219, 2026 +$1,161 (Favorites +$858 / +$66 / +$553 / +$1,150 / +$1,742); worst drop his 40 59% / 57% / 31% / 43% / 31%; giants 23 / 14 / 22 / 31 / 26 | the check: on the same 2,958 legs the model matches IV (0.64 / 0.64) and premium (x1.03) and the sign 90%, but its mean return is +21.7% vs +14.4% real (x1.5), giants 110 vs 97 (65 shared); it trades 2-3x more (fixed volume: the floors never bind) with drops of 43-70% vs 18-36% real | read only year against year: 2022 positive at ~60-70% of a 2024-26 year with a deeper drop; 2023 about flat on the model, so likely a losing year for real (fewest giants). Real data for 2022-23 (Databento OPRA, cbbo-1m and ohlcv-1m from 2013): dbx_cost.py's first estimate ($0.0001 a contract-day, ~$7) was wrong (quotes only, on cheap 2024 contracts). dbx22.py (2026-10-31) priced the real 2023 request on his 2023 list (63 stocks, 4,339 signals): chain definitions 2,433 stock-days ~$17 (BOUGHT, in data/local/x/bt/y2023/defs), pass A (16 candidate strikes a signal, quotes + minute bars) 26,715 contract-days x $0.0036 = ~$96, pass B ~$25-30: ~$140 a year. The user stopped there ("Stop here"); a 6-strike scan pre-picked by the IV model would be ~$80 a year |
| REAL option data, 2023: the champion (2.7 at minute fills) on his 2023 list (dbx22.py; the user 2026-10-31: "yes, download it" and "extract only the stock list he used to trade ... these are the hot stock"): the 63 stocks / ETFs he traded in 2023 (CVNA, UPST, COIN, AI, RBLX, RIVN, NIO, MARA, KRE, FRC, PACW ...; index options out), chosen with that year's knowledge; Databento OPRA: definitions (the chains), cbbo-1m (the option's minute bars as the mid, and the fills), ohlcv-1m only for the 30-minute volume floor on the 4 strikes nearest delta 0.15 by the real quotes; total Databento cost ~$30 (definitions $17, the rest ~$12) | - | 4,339 signals (2,433 main); 6.5% of the main signals find a contract (2024 fair list: 10%; 54% too thin, 33% under $0.20); 113 main legs + 4 adds; at 2% from $100,000: $164,402 / 18% worst drop, +$2,564 a trade, 18% winners, median -$2,551; without the best 5 $68,857 (a loss); 4 giants, the rest -$153,894; Q1 -$689, Q2 -$9,960, Q3 +$100,076, Q4 +$214,648 at $10K | the best 5: ENPH 2023-12-13 +$157K, AAPL 2023-09-06 +$139K, PANW 2023-11-28 +$79K, GOOGL 2023-05-10 +$78K, TSLA 2023-01-06 +$30K (at $10K) | the bot's shape holds in 2023 on real data: positive only through 4-5 giants, the rest bleeds; about a third fewer trades than 2024 because the options were thinner and cheaper. The model sketch (bs22.py) read 2023 as about flat. 2022: waiting for his 2022 list (the X token was refused, 401) |
| REAL option data, 2023, re-run on the fixed walk and the new exits (the user 2026-10-31: "yes run it with the new backtesting and new exits"; dbx22.py, same saved data, no new purchase; `TAG` names the output): BT_X overlays as in the audit map steps 6, 8, 9. Note: here the option's minute bars ARE the quote mids every minute, so the clock bug barely applied, and minute fills mean the chase fix does not apply | - | at 2% from $100,000 (worst drop; without the best 5; giants · non-giant sum at $10K): old walk (re-run on today's code) $161,172 (19%; $67,638; 4 · -$162,760); **fixed walk $179,857 (19%; $72,511; 5 · -$156,841)**; staged exit $183,598 (17%; $73,950; 6 · -$191,059); staged + stop -60% $181,652 (16%; $73,173); staged + stop -60% + the add $182,211 (26%; $66,529; 7 · -$285,548); medians -$2,552 to -$2,689 | the add lifts ENPH 12-13 to +$223K and AAPL 09-06 to +$178K but the rest bleeds more | 2023 is not ~60% high like the fair list (the bars were already mids); the staged exit and stop -60% are about a tie (+2%, a lower drop); the add does not pay here: same end, drop 16% -> 26%, the second sample outside the fair list where it fails (after the Favorites check half) |
| REAL option data, 2022, the fixed walk and the new exits (the user 2026-10-31: "no need stock list for now use the same as 2023-2024"; dbx22.py 2022 with LIST_FILE = his 2023 + 2024 lists, 99 stocks, chosen with later knowledge; the X token is still refused, 401; the run's header says "his 2022 list" but it is this union): Databento ~$29 (definitions 3,059 stock-days ~$21, quotes ~$2.3, volume windows on the 4 strikes nearest 0.15 by the real quotes ~$4.9, pass B ~$0.5); stock bars for 27 missing names fetched from Alpaca (fetch22.py with SYMS_FILE / LAST_MONTH) | - | 5,473 signals (3,059 main); 169 picked, 88 main legs + 3 adds; at 2% from $100,000 (worst drop; without the best 5; giants · non-giant sum at $10K): **fixed walk $115,107 (18%; $69,719; 3 · -$125,277)**, 14% winners, median -$2,765; staged exit $112,587 (17%; $71,307); staged + stop -60% $112,787 (17%; $71,389); + the add $117,052 (21%; $65,014; 4 · -$184,496); fixed walk by quarter at $10K: Q1 +$160K, Q2 +$37K, Q3 -$30K, Q4 -$60K | the best 5 (fixed): MSFT 2022-02-24 +$126K (the invasion-day reversal), UPST 02-24 +$70K, PYPL 04-21 +$34K, BA 06-02 +$28K, COIN 02-28 +$26K | 2022 (a bear year) is a small win, +15%, all from one week of late February; the rest of the year bleeds. Fewer contracts than 2023 (88 legs). The staged exit and stop -60% are a tie again (-2%, drop -1 pt); the add again raises the end only through the giants and raises the drop: the third sample outside the fair list where it does not hold up |
| REAL option data, 2022 + 2023 on the POINT-IN-TIME HOT LIST (the user 2026-10-31: "we do not know what hot stock was at that time", "ok build it", "go to finance that talks about hot tech stock and gather from there"): each month's list from data before the month only (hot_scan.py h50_rng_400: 40 by 20-day dollar volume + 40 by median day range among the next 360; leveraged / inverse / VIX, duplicates and bond ETFs out; plus tickers named by 2+ outlets in the 90 days before (909 article rows) and Wayback trending pages of the month before (yahoo / stocktwits / apewisdom / finviz, 2+ sources, 3+ days, up to 15); hot_final_lists.py -> data/local/x/bt/hot_final_2022_2023.json); ~84 names a month, 173 in 2022, 207 in 2023; it covers 85% of his 2023 opens; dbx22.py (a frozen copy with HOT_FILE: a signal counts only when its stock is on that month's list) + the audit-fixed walk; Databento ~$22 (definitions $18.85, the rest ~$3.5: only contracts and windows not already held) | - | at 2% from $100,000 (worst drop; without the best 5; giants · non-giant sum at $10K): **2022 fixed walk $97,793 (25%; $60,649; 3 · -$208K)**, 107 trades, 15% winners; staged $97,098 (22%); staged + stop -60% $96,995 (21%); + the add $100,902 (20%); **2023 fixed walk $147,379 (19%; $64,995; 4 · -$182K)**, 127 trades, 17% winners; staged $146,470 (18%); staged + stop -60% $144,877 (17%); + the add $140,517 (31%) | vs the hindsight lists (2022: the 99-stock 2023+2024 union $115,107; 2023: his 2023 list $179,857): the names the hot list adds (not on those lists) are 40 trades / -$112K in 2022 and 37 / -$75K in 2023, no giant (best DDOG 2022-12-08 x1.2, DASH 2023-02-17 x2.3); the hindsight trades it misses: 2022 16 / -$18K (BA 06-02 x2.8), 2023 25 / +$41K, mostly PANW 2023-11-28 x7.9 (off the November list) | without hindsight: 2022 about flat (-2%, vs +15% on the hindsight list), 2023 +47% (vs +80%), all from the same giants (MSFT / UPST 2022-02-24, ENPH / AAPL / GOOGL 2023); the extra hot / volatile names only bleed. The exits again tie on the end and cut the drop 2-4 pts; the add raises the drop (31% in 2023): the fourth sample where it does not hold up |
| REAL option data, 2022 + 2023 on the user's STATIC lists + a max-spread cap (the user 2026-11-01: "this is too much. in 2022 go with [the names on the hot list 9-12 months] ... in 2023 [6-12 months] ... try to not buy big spreads. let me know from where come the looses"): 2022 56 names, 2023 75 names ("Z" read as ZS), the whole year (hot_static_2022_2023.json; picked by the user from the full-year hot-list counts, so partly hindsight); dbx22.py frozen copy + SPREAD_MAX (skip a pick whose entry book (ask-bid)/mid is above the cap); Databento ~$4.2 more (~$26.5 for all hot-list work) | - | at 2% from $100,000 (worst drop; without the best 5; giants · non-giant sum at $10K): 2022 fixed walk $112,069 (18%; $67,878; 3 · -$138K); **2.8 (staged + stop -60%) $109,132 (16%; $69,075)**; 2.8 + spread <= 30% $85,267 (15%), <= 20% $84,797 (15%), <= 15% $85,141 (15%); 2023 fixed walk $164,125 (18%; $72,380; 4 · -$128K); **2.8 $153,664 (16%; $65,759)**; + spread <= 30% $122,481 (15%), <= 20% $127,366 (14%), <= 15% $126,326 (15%) | the spread cap removes the year's biggest giant both years: MSFT 2022-02-24 (spread 32%, x12.6) and ENPH 2023-12-13 (42%, x15.7); the other giants had 3-10%. Where the losses come from (2.8, main legs at $10K): 76 / 96 losers (-$246K / -$308K), none lost 80%+ (the -60% stop), 42 / 46 lost 30-80% (-$178K / -$201K); spread spreads evenly, no bucket bleeds more than its share (<5% spread: 2022 -$57K on 55 trades); entries at minute 10-14 lose both years with no giant (29 trades -$34K / 30 -$56K; all giants are minute 15+); the worst stocks are the busy names (NVDA -$16K / -$27K, TSLA, RIVN, BA, BABA); every month bleeds except a giant month | don't cap the spread: the giants are often the wide-spread picks (the third time: 2026-10-26 spread rules, the real-cost study). The bleed is the normal 75-80% losers at -$2.5-3K each, spread over all stocks and months. A lead to test on 2024-26 with both halves: no entry before minute 15 (0 giants on 59 trades in 2022-23) |
| LAST FEATURE TEST, 2022 + 2023: 2.9.1 (2.8 + be_lock {arm 0.5, update}; the size ladder never binds under $300K) vs 2.8 (the user 2026-11-01: "We have 2.9.1 already. You can test it"; 2022-23 stays a last feature test, never tuned on): dbx22.py on today's sim.py (frozen scratchpad frozen-29 + the sale-day account of 2d90602), BT_X = 2.8 (user_stop -0.6, stock_stages 0.5 / 1.0, late_hold from 330) with / without be_lock; the user's static lists (56 / 75 names), real Databento quotes, minute fills, each year its own $100,000; no new data bought | - | at 2% (worst drop; without the best 5; winners): **2022: 2.8 $109,264 (22%; $69,147; 17.4%), 2.9.1 $90,550 (24%; $64,030; 15.2%)**; **2023: 2.8 $152,417 (16%; $65,753; 18.6%), 2.9.1 $120,410 (24%; $61,960; 18.6%)**; at 3%: 2022 $117,674 / 28% vs $85,806 / 33%, 2023 $167,355 / 23% vs $124,884 / 34% | the lock changes 14 / 17 main trades: it helps 8 / 13 (+$25K / +$45K at $10K; RIVN 2022-01-06 x0.41 -> x0.96, NVDA 2023-03-22 x0.37 -> x1.28) and hurts 6 / 4 (-$91K / -$185K): the giants that dip to cost first, AAPL 2023-09-06 x14.7 -> x1.24, AVGO 2023-12-12 x3.9 -> x0.70, BA 2022-06-02 x3.8 -> x0.91, COIN 2022-02-28 x3.6 -> x0.99, MSFT 2022-06-02 x2.0 -> x0.78 | 2.9.1 FAILS the last feature test both years: -17% (2022) and -21% (2023) at 2%, worst drop up 2 / 8 points, no gain in win rate (2022 down 2 points). The 2024-26 gain (+6% fair list) does not carry to 2022-23: the median changed trade improves, but one or two giants a year dip to the level first and are sold near cost. For the 2.9 release gate (PR #231) |
| LAST FEATURE TEST, 2022 + 2023: 2.10 (2.9.1 + t3A volume tiers: 50% under 1.75x the usual volume since the open, 100%, 150% from 2.5x; the pyramid add 0.5x its leg, the position within 5% of the account) vs 2.9.1 (the user 2026-11-01: "run 2.10 on both year"): dbx22.py frozen-29 + VOL_TIERS (c_rvol of each signal) and size_volume's uncapped row account; same walks as 2.9.1 (the re-run _v291r matches _v291 to the dollar); no new data bought | - | at 2% (worst drop; without the best 5): **2022: 2.9.1 $90,550 (24%; $64,030), 2.10 $92,022 (22%; $67,972)**; **2023: 2.9.1 $120,410 (24%; $61,960), 2.10 $101,017 (21%; $66,555)**; at 3%: 2022 $85,806 / 33% vs $87,479 / 31%, 2023 $124,884 / 34% vs $98,643 / 30%; vs 2.8 ($109,264 / $152,417) 2.10 is lower both years | main legs by tier at $10K, 2%, sum (n): 2022 50% -$64,804 (52), 100% +$84,289 (21), 150% -$51,778 (19); 2023 50% +$180,502 (64), 100% -$21,201 (39), 150% -$31,847 (15): 2023's giants ENPH 2023-12-13 and AMZN 2023-01-25 were low-volume (half size), and the 150% trades lose both years | 2.10 FAILS the last feature test on money in 2023 (-16% vs 2.9.1) and is flat in 2022 (+2%); the drop is 2-4 points less both years (the half size on most trades). The 2024-26 finding (more volume = better trades) does not hold on 2022-23: the 150% tier loses both years. |

Analyses (no check look): SPY while a trade is open (spy_drag.py): of the trades that reached +100%, 79% ended under
+50% when SPY moved against them vs 15% when SPY moved >1% our way; overnight, the 18 nights with SPY gapping >0.5%
against (of 169) all lost (median -52%, -$259K at $10K) and the 24 gapping >0.5% our way made +$706K. The worst drops are runs of same-day stop-outs, nights net positive (risk_tests.py); peak paths
(peak_paths.py): of 54 trades that reached +500% one ended a loss, the give-backs are in the +100-300% band; night moves
(15:50 -> 09:40): 41-47% of nights win, a dozen +100% gaps pay for all; the second night wins ~1 in 3. **Lesson
(memory giants-decide-buckets):** the median trade is about -$2.5K in every bucket on both halves; ~20 giants per half
decide every split. Judge splits by the median and the non-giant sum, not by sums.


### The Favorites over 2 and 3 years (2026-10-27)

The user: "also add favorite 3 years and 2 yers". `export_fav_long.py`: today's 69 Favorites, signals Oct 2023 - Oct 2026
(lists.py; the first year's quotes bought for $2.21), real quotes, 1% (fav36 / fav24, end / worst drop):

| Version | 36 months real | 24 months real | 36 months +-2% |
| --- | --- | --- | --- |
| 2.4 | $366,710 / 13% | | $745,031 / 9% |
| 2.5 | $413,123 / 18% | | $876,078 / 12% |
| 2.6 | $386,958 / 28% | $298,550 / 18% | $1,023,030 / 20% |
| champion (minute fills) | $612,717 / 18% | $403,258 / 17% | $1,386,464 / 14% |

The 2.6 cheap fallback adds 10 points of drop over 3 years and less money than 2.5 on real quotes; the champion leads.
On Bot vs Indi (Stocks: 24 / 36 months); the early-entry version needs the first year's 1-second data (not bought).

### Second-level entries; the fair-price limit re-checked (2026-10-27: enter early BETTER; the fair limit UNPROVEN)

The user: "Timing with 1-second stock moves"; "you can wait 5 seconds ... go up to the next price every 5 seconds".
`sec_fetch_main.py` (Databento, $6.46: the stock's 1-second bars on the champion's entry days, the option's 1-second
book from 2 min before to 10 after each entry), `sec_timing.py` on the champion's legs, real quotes, the sales as
walked, the bot acting 2 s after a decision. The runaway rule's look-ahead matters as much as any rule: "now" (the
minute model, the next minute's bid) $257,982 / $289,355 on tune (fair / Favorites); the same buy on the 1-second
book with a 10-s look-ahead $340,035 / $389,708, with a 60-s one $303,315 / $342,239. So every real-quote figure
here may be 15-30% too harsh; compare inside one model only.

| Tune, 1% (fair / Favorites) | 10-s look-ahead | 60-s look-ahead |
| --- | --- | --- |
| the usual price at the decision second | $340,035 / $389,708 | $303,315 / $342,239 |
| **early: the first second inside the signal minute the rule holds** | **$358,686 / $419,579** | **$327,719 / $377,912** |
| the fair limit (microprice + 3 ticks, 1 min), the ask as the only fill proof | $292,725 / $339,120 | $276,511 / $321,616 |
| 5-s ladder from the microprice (+0 / +1 tick), 10-s ladder | $295,421 / $294,654 / $297,850 (fair) | |
| wait out a 15-s spike (0.15 / 0.25 S30) | $342,701 / $341,328 (fair) | |

Check weeks: early $538,063 / $198,358 vs $490,110 / $174,365 (10 s); $478,197 / $174,439 vs $423,430 / $155,442
(60 s): +10-14%, smaller drop, better without the best 5. Enter early is BETTER (look 1/3; SPY's move inside the
minute is spread evenly, no SPY seconds: live, the bot has SPY's ticks). The fair limit loses to paying at once when
only a falling ask proves a fill (check $387,078 vs $490,110); fair_fill.py's +11-25% counted a print at or under the
limit in the minute, which a resting bid would catch, but not provably. So the fair limit is UNPROVEN until paper
fills settle it (3 of 3 check looks used: closed unless the user reopens it).
At the live bot's pace (early5 / early10: the rule checked every 5 / 10 seconds, the 60-s look-ahead): tune $328,276 /
$374,326 and $310,054 / $355,900 vs $330,459 / $377,912 every second and $306,551 / $342,239 at the minute's end;
check $477,551 / $171,081 and $461,107 / $167,403 vs $484,035 / $174,439 and $428,880 / $155,442. Every 5 s keeps
almost all of it; every 10 s about half: the live bot should look at least every 5 seconds.

### Buy near the fair price: a limit at the microprice, 1 minute, then the usual price (2026-10-27, better on the minute model; UNPROVEN on the second data, see above)

The user: "can we calculate the real stock equity before we buy? ... if we add a order with 1.06 which is behind the
mid we probably get it done no? ... start with couple of click above the value"; "do it all". `fair_fill.py` on the
champion, real quotes, tune / check by entry week (split.py). Step 1: at our buys fair sits at or above the mid, not
under it: the size-weighted microprice +0.08 / +0.13 half-spreads (fair list / Favorites; under the mid at 44-46% of
buys), the chain-IV price +0.32 / +0.22 (under at 28-32%); winners and losers alike. Step 2, 48 settings set before
running (fair micro / chain; +0-3 ticks; wait 1-3 min; not filled: skip or chase). A limit fills only when the option
prints at or below it or the ask comes down to it; never above what the bot pays now; the chase keeps the fill model's
runaway rule. Look 1 had a chase without that rule (too kind: $458,486 / $165,585 on check); look 2 (fixed) counts:

| Buy | Fair tune | Favorites tune | Fair check | Favorites check | Without the best 5, check (fair / fav) |
| --- | --- | --- | --- | --- | --- |
| now (mid + half to the ask) | $257,982 / 16% | $289,355 / 11% | $368,105 / 12% | $139,363 / 15% | $152,135 / $75,608 |
| **microprice + 3 ticks, 1 min, then the usual price** | $321,727 / 15% | $363,827 / 10% | **$428,607 / 12%** | **$155,291 / 13%** | $171,208 / $83,225 |

+25% / +26% on tune, +16% / +11% on check, the same or a smaller drop, better without the best 5. A filled limit saves
1.2% of the premium; the chase settings beat every skip setting (missing a runaway costs more than the saving). The
whole family is above "now" with the chase (+20-25% on tune), so it is not a knife edge. The fill proof is strict (a
print at or under the limit), so live fills can only be as good or better. Looks used on check: 2 of 3.

### Open interest as the strike choice (2026-10-27, not better: fails the check)

The user: "OI as the strike choice: among strikes near 0.15 delta, take the one with the most OI". `oi_strike.py` on
the champion, the morning's OI. Tune: the most OI of the 0.15 strike and its neighbours $324,772 / 17% (fair) and
$403,764 / 20% (Favorites) vs $257,982 / 16% and $289,355 / 11%; within delta 0.12-0.18 $234,071 / $240,094 and
0.10-0.20 $229,998 / $257,148 (both lose on tune). Check, the picked rule: $211,068 / 26% and $91,722 / 30% vs
$368,105 / 12% and $139,363 / 15%. Its tune gain was ~250 trades today's rule skips (a thin 0.15 strike): a liquidity
fallback again, and it falls apart on the odd weeks.

### A $0.10 floor for IBIT, and for the tickers with options 3+ days a week (2026-10-27)

The user: "IBIT is special - because it have best trades for al the times. I want you to add IBIT as a default to have a
limit of 0.1$ in premina and not 0.2. also test after it what will happen if we add like this all the tickers that have
options 3 times or more a week". `floor_exception.py`, `expiry_days.py`. On the list the 0.15-delta option is bought
down to $0.10 (the cheap fallback, where on, under $0.10). Lists: IBIT; today's 3+-expiry-days tickers (AAPL AMD AMZN
AVGO GLD GOOGL IBIT INTC IWM META MSFT MU NVDA SPCX TSLA) over the whole period; the same point in time (single stocks
got them from 2026-02; before that only GLD / IWM). Real quotes, every trade fully on the book, 1%:

| Bot | Fair 2024-25 | Fair 2026 | Favorites 24m | Favorites 12m |
| --- | --- | --- | --- | --- |
| 2.6 (live) | $302,905 / 16% | $207,079 / 15% | $299,707 / 18% | $166,361 / 18% |
| 2.5 | $366,671 / 16% | $168,101 / 13% | $290,395 / 16% | $140,439 / 16% |
| 2.5 + IBIT $0.10 | $352,856 / 16% | $227,661 / 13% | $378,539 / 16% | $191,537 / 16% |
| pyramid (with cheap) | $363,710 / 14% | $216,868 / 17% | $332,278 / 20% | $170,452 / 20% |
| pyramid, no cheap | $432,235 / 14% | $168,569 / 14% | $309,341 / 17% | $139,095 / 17% |
| **pyramid, no cheap + IBIT $0.10** | $415,971 / 14% | $228,296 / 14% | **$403,255 / 17%** | $189,705 / 17% |

IBIT is the only fair-list ticker the floor changes. It costs 4% on 2024-25 (-$14-16K) and adds ~$60K in 2026 and
$88-94K on the Favorites over 24 months, at the same drop. The 3+-days list adds nothing over IBIT on the fair list
and loses $25-28K on the Favorites over 24 months (its other names' $0.10-0.20 options lose); point in time it is
small. Against the live 2.6, 2.5 + IBIT is ahead on every list and period; the pyramid without the fallback + IBIT is
ahead of the current candidate (the pyramid with the fallback) on every list and period. Caveat: IBIT was named after
seeing its trades, so this is in-sample in the stock; the 2024-25 cost is the honest part of the check.

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

### The Volume bot's stock give-back as a Main bot stop; the Main bot on real quotes (2026-10-27)

- **The stock trail as a stop** (`indi_trail.py`, `sim.py` option `stock_trail`): sell on the entry day when the stock
  gives back K x S30 from its best since the buy (K 0.75 to 2.0, one part or two: a tighter K for the first 10 or 20
  minutes, all trades or the losing ones only). Fair list 2024-25 on 2.6 (and 2.5): every version is worse; the best,
  2.0 on the losing trades only, nearly ties the fair list but on Favorites 2026 cuts 2.6 from $409K to $288K with a
  deeper drop. Not better.
- **Real quotes for the Main bot** (`indi_real.py`, Databento cbbo-1m of every candidate strike, the fill mid + half
  to the ask with the chase, sold at the bid), 2%: 2.6 2024-25 $1.52M -> $973K, 2026 $434K -> $337K, all $6.6M ->
  $3.28M; 2.5 $1.85M -> $1.28M and $288K -> $235K; 2.4 $854K -> $651K and $321K -> $273K. About 3 points a trade lower,
  still +18-22% a trade; the bars' sim acts on the next bar (bar vs real mid: buys +0.9%, sales 0%), so no look-ahead.

### Entry audit: the real quotes were read one minute early (2026-10-27, CORRECTION)

The user: "go and review yourself and try to find issues with the entries - we had huge issue in the volume bot".
`entry_audit.py`, `quote_label_test.py`. Found: `real_bench.quote()` read the cache row labelled `minute` as the book at
the END of that minute; the row is the book as that minute BEGAN (cbbo-1m ts_recv = the interval end). Proof: an option
trade bar's last print sits inside the row labelled j + 1 86% of the time, j 65%, j - 1 52% (254,770 bars). So every
real-quote fill was priced on the book from before the bar that triggered it: a breakout buy cheaper, a stop sale
higher. Fixed in `real_bench.quote()` (every script uses it); `indi_real.py` (other session) has its own copy of the
bug. All real-quote runs below were re-run with the fix on 2026-10-27; the numbers in their entries are the old ones,
the corrected ones are here. Every conclusion holds; the amounts drop.

| Run (fair list unless said, 1%) | Before the fix | Fixed |
| --- | --- | --- |
| 2.6, Feb 2024 - Oct 16 2026 | $910,069 / 14% | $646,213 / 16% (2% $1,893,155 / 29%) |
| 2.5 / 2.4, whole period | $839,088 / $574,459 | $629,620 / 16% ; $432,210 / 13% |
| 2.6, 2024-25 / 2026 | $390,392 / 12% ; $233,116 / 14% | $305,729 / 16% ; $211,368 / 15% |
| 2.6, pre-market skip off, 2024-25 / 2026 | $324,342 ; $199,465 | $254,353 / 18% ; $180,967 / 19% (keep 4x) |
| Pyramid, 2024-25 / 2026 | $483,650 ; $243,614 | $367,102 / 14% ; $221,359 / 17% |
| Pyramid + cheap at half, 2024-25 / 2026 | $521,715 ; $218,888 | $403,317 / 13% ; $200,669 / 16% |
| Best spread rule (now look10 cap30), 2024-25 | $287,792 | $270,718 / 16% (still worse) |
| Mid-limit sale, 2024-25 / 2026 (fill unproven) | $419,727 ; $250,212 | $366,658 / 14% ; $223,853 / 16% |
| Favorites 12 months: 2.6 / pyramid / pyramid + cheap at half | $186,294 ; $191,345 ; $175,383 | $165,718 / 18% ; $169,792 / 19% ; $157,269 / 18% |

Checked and clean: the signals (t, volume, D2) and the contract pick use bars up to the signal minute; no signal is
lost for want of an option print (0 of 981); the stock-days dropped for 300 bars or fewer are half sessions and IPO
days (known in advance). Not modelled (the owner's paper settings, not rules): the live caps (buys a day, open, day
loss, the 15% pause).

### The pre-market volume skip, on and off, on real quotes (2026-10-27)

The user: "can you ran a test for this toggle of an on after all of our changes on indi fair list 2024-2025?" The live
bot runs 2.6* with the skip off. `premarket_toggle.py`: the fair list on real quotes (as `cand_real.py`), the earnings
filter kept, the skip off / 3x / 4x (default) / 6x, set before running; 2026 held out. At 1% (2%) from $100,000:

| Bot | Skip | Trades 24-25 | Per trade | 2024-25 1% / drop | 2% / drop | Without best 5 | 2026 1% / drop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2.6 | off | 998 | +1,388 | $324,342 / 13% | $668,444 / 24% | $120,692 | $199,465 / 19% |
| 2.6 | 3x | 741 | +2,119 | $393,744 / 12% | $980,378 / 21% | $146,517 | $198,453 / 13% |
| 2.6 | **4x** | 822 | +1,905 | $390,392 / 12% | $973,157 / 22% | $145,270 | $233,116 / 14% |
| 2.6 | 6x | 885 | +1,741 | $379,940 / 12% | $921,654 / 23% | $141,380 | $218,621 / 16% |
| live 2.6* ($0.15) | off | 987 | +1,359 | $310,286 / 14% | $611,305 / 25% | $115,461 | $208,336 / 17% |
| live 2.6* ($0.15) | 4x | 813 | +1,839 | $363,562 / 12% | $843,455 / 22% | $135,286 | $244,271 / 13% |
| pyramid | off | 1079 | +1,538 | $401,870 / 14% | $995,100 / 26% | $154,584 | $207,955 / 20% |
| pyramid | 4x | 903 | +2,038 | $483,650 / 13% | $1,448,202 / 24% | $186,042 | $243,614 / 16% |

Verdict: keep the skip on at 4x. Off costs every bot 17-28% of the 2024-25 end at 1% (31% at 2% on 2.6) with a
deeper drop, and 2026 agrees. The 176 trades it removes on 2.6 (2024-25) sum -$181K at $10K a trade, 32 winners, and
lose more the louder the pre-market: 4-6x -$404 a trade, 6-10x -$506, 10-20x -$1,638, 20x+ -$2,733. 3x and 6x are
within 3% of 4x in 2024-25; 4x is best in 2026. Live 2.6* (min $0.15) is below 2.6 ($0.20) in 2024-25, a little above in
2026. Dashboard tab "Pre-market skip": https://claude.ai/artifact/8hwVRYjvFphR4Ro6kQC1am

### Real quotes check (2026-10-26)

The user: "we have now real bid and ask from databento. I would like to run our main bot tests with this real data to
confirm." `real_bench.py`: every Bot vs Indi benchmark version, the fair list, Feb 2024 - Oct 16, 2026, the same trades
priced twice: old (trade bar mid ± 2%) and real (Databento OPRA cbbo-1m at the end of the minute before the fill; buy at
mid + half the way to the ask, or the next ask up to +10% when it ran away; sale at the bid). Quotes for all but 2 of
~3,000 fills a version. Dashboard: https://claude.ai/artifact/8hwVRYjvFphR4Ro6kQC1am

| Version | Old 1% / drop | Real 1% / drop | Real 2% / drop | Real without best 5 |
| --- | --- | --- | --- | --- |
| 2.4 | $719,943 / 9% | $574,459 / 11% | $1,775,077 / 20% | $216,017 |
| 2.5 | $1,108,662 / 11% | $839,088 / 12% | $3,011,787 / 23% | $282,830 |
| 2.6 (live, 2.5 + cheap) | $1,297,219 / 11% | $910,069 / 14% | $3,278,794 / 26% | $306,756 |
| 2.5 + D2 under 200 | $2,725,559 / 12% | $1,484,595 / 13% | $7,672,495 / 24% | $501,595 |
| 2.6 + D2 under 200 | $2,899,149 / 13% | $1,427,171 / 15% | $6,488,479 / 29% | $482,193 |

Real costs 20-50% of the end at 1% (about -$300 a trade at $10K; the bot's normal contracts have a median half-spread of
2.6%, so the 2% guess was close). Every version stays profitable every year; the order holds: 2.6 > 2.5 > 2.4, the
failed-break sale worse everywhere, D2 under 200 still the most money although its contracts pay most for the spread
(median half-spread 7.7%, -$1,040 a trade; order size at the bid/ask is not modelled). Wide-spread entries (12%+) are
the big winners on average, so a max-spread filter would cut winners.

## Tested, not better (V2, 2026-10-21)

### No entry right after a big run; where the giants come from (2026-10-29, not better by far; the diagnostic is the finding)

The user: "both - alwaays permotation on the tune than if candidate found on the check". From the live reviews of 23-28
Oct (CRWV, SPCX, AVGO, MU and TSLA bought at the top of a steep opening run; four lost). `runup.py` on the champion
(entries, picks, exits, the pyramid, real quotes), tune / check in one run: the run = the stock's move over the 10
minutes before the signal, the bet's way, in typical 30-minute moves (levels.ctx sd); skip15 / skip20 / skip25 = no trade
at a run >= 1.5 / 2.0 / 2.5; pb15 / pb20 = at a run >= 1.5 / 2.0 wait up to 15 minutes for a 0.25 pullback from the
run's extreme and buy then (picked at that minute). Tune at 1% (fair / Favorites): base $260,535 / 16% and $312,304 / 11%; skip15 $90,625 / 19% and $109,823 / 12%; skip20 $89,889 / 30% and $107,079 / 16%; skip25 $170,489 / 22% and $238,228 / 15%; pb15 $162,353 / 19% and $195,944 / 12%; pb20 $178,385 / 19% and $217,426 / 12%. 🎯 pb20 (0.685 of the
champion), check: base $372,332 / 12% and $158,412 / 13%; pb20 $322,663 / 11% and $163,819 / 14%; skip25 $352,518 / 12% and $165,164 / 11%. Not better: a big run is how the signal works (283 of 543 tune fair trades come after a run
>= 1.5, holding 15 of 21 giants, +$1.2M); the run's size does not sort the trades (medians -$2,150 to -$3,200 in every
bucket, both halves). Diagnostic (the champion, main legs at $10K), tune fair: full at 20: 238 trades, 18 giants, median -1,972, sum +1,830,784, without the giants -120,071; half at 10, held at 20: 63 trades, 1 giants, median -1,057, sum -43,225, without the giants -74,103; out by 20: 203 trades, 0 giants, median -3,216, sum -660,994, without the giants -660,994. Check fair:
full at 20: 240 trades, 20 giants, median -2,303, sum +2,041,540, without the giants -146,680; half at 10, held at 20: 58 trades, 0 giants, median -1,819, sum -88,706, without the giants -88,706; out by 20: 204 trades, 0 giants, median -3,150, sum -631,640, without the giants -631,640. All the giants are trades the 10 / 20-minute checks never touched; the trades sold by 20 minutes
(37%) are never a giant and lose $630-660K a half; the half kept after the 10-minute check is almost never a giant (0-1 a
half), which is why the refill test lost. Next: what at the entry tells the fast losers from the trades that hold. Look 1.
On the Bot vs Indi page, Research tab.

### More checks, and back to full size when the stock is stronger (2026-10-29, not better: the pick fails the check)

The user: "test on the main bot - way of exists - add more checks - if we passed the 20minutes check but only with half
size - double it if we have stronger parameters. any way add 30minutes and 60 minutes checks. do a tests with all
togeterh and seperates." `refill.py` on the champion (entries, picks and exits of d2_failed_break.CHAMP, real quotes,
the pyramid), tune / check in one run, fair list + Favorites 24 months, set before running: rb20 = after the 10-minute
half, the 20-minute check passes -> buy the half back once (sim.py rebuy "at20", the 2026-10-24 rebuy.py "A" on today's
bot); rb20_t / rb20_t03 / rb20_t22 = only when the stock's t vs SPY x beta now is >= its t at the entry / + 0.3 / >= 2.2
(new: rebuy `t_over`, `min_t`); c30 / c60 / c3060 = a 30 / 60-minute check (the stock against sells what is left); all
= rb20_t + c3060. Tune at 1% (fair / Favorites): base $260,535 / 16% and $312,304 / 11%; rb20 $264,049 / 18% and $320,138 / 11%; rb20_t $262,492 / 17% and $315,312 / 11%; rb20_t03 $251,078 / 16% and $295,469 / 11%; rb20_t22 $246,216 / 17% and $297,480 / 11%; c30 $252,130 / 16% and $302,135 / 11%; c60 $253,908 / 16% and $290,289 / 11%; c3060 $245,387 / 16% and $280,461 / 11%; all $246,973 / 17% and $282,952 / 11%. Baselines: fair tune $260,535 vs $257,982 logged (+2 days of
data); Favorites higher than logged ($312,304 vs $289,355) because today's 69 Favorites are not the 86 of the baseline.
🎯 Picked on tune: rb20 (+1.3% on both lists, drop 18% vs 16% on fair). Check at 1%: base $372,332 / 12% and $158,412 / 13%; rb20 $371,515 / 12% and $157,686 / 14%; rb20_t $370,318 / 12% and $156,763 / 14%; c30 $379,110 / 12% and $160,131 / 13%; c3060 $379,184 / 12% and $160,162 / 13%; all $375,616 / 12% and $158,153 / 14%. The pick is below the
champion on the check (−0.2% fair, −0.5% Favorites, drop 14% vs 13%). Every refill version's changed trades lose without
their best 5 on both halves (rb20 tune fair 32 trades +3,735, without the best 5
-46,847; check 26 trades +2,283 / -38,201): as on 2026-10-24, a second buy of the
same trade pays only on a few giants; the strength condition cuts the refills (32 -> 21 / 15 / 17 on the tune fair
list) without making the rest pay. The 30 / 60-minute checks lose on tune (c3060 fair -49,532 on
26 trades, Favorites -98,992) and win a little on the check (fair +22,299, without the best 5
+9,418): the halves disagree, no edge. Look 1 (the buy-back idea's second look). On the Bot vs Indi page,
Research tab, "Test 2026-10-29".

### A stop for the huge winners, from +1000 / +1500 / +2000% (2026-10-27, not better: fails the check; CLOSED, 3 of 3 looks)

The user: "when we hit 1000% gain we start a stop of 30% of the trade. lets make another test for moving the stock - only
those that have more than 1000% gain. do the same for 1500% and 2000% ... in max 2 days trades there is a percentile of
how big the winner can be for our delta ... remember to run it on the tune list." On the champion (2.5 + IBIT $0.10 + the
pyramid, minute model, real quotes), exit_tests.py EXIT_RUN=big; set before running: once the option was up the level
(any day held), all out when the option falls 30% from its best (`guard {arm, trail 0.3}`, opt*) or when the stock gives
back 1.0 x S30 from its best since then (sim.py `big_trail`, stk*).

Tune weeks, from $100,000 (fair list / Favorites 24m), trades changed (fair / fav):

| Version | Changed | 2% | 3% |
|---|---|---|---|
| champion | — | $418,875 / 30% · $511,670 / 21% | $460,190 / 41% · $629,548 / 30% |
| opt1000 | 11 / 14 | $544,268 · $586,263 | $687,636 · $803,058 |
| opt1500 | 6 / 7 | $466,136 · $569,753 | $552,612 · $756,712 |
| opt2000 | 2 / 2 | $380,519 · $464,690 | $419,891 · $574,203 |
| stk1000 | 16 / 19 | $531,669 · $582,085 | $683,981 · $814,598 |
| stk1500 | 11 / 12 | $476,542 · $596,022 | $582,311 · $815,062 |
| stk2000 | 5 / 5 | $377,593 · $461,191 | $418,280 · $572,104 |

The worst drop is the same in every row. Picked on tune: opt1000 at 2%, stk1000 at 3%. **Check weeks (2 of the idea's 3
looks used):** 2% champion $928,510 / $160,100 against opt1000 $545,259 / $150,104; 3% champion $1,538,450 / $155,881
against stk1000 $684,097 / $155,999. The check giants the stop sold early (return on cost at 2%, champion -> option /
stock stop): BA put 2024-08-01 +2,001% -> +665%, QCOM call 2026-05-05 +1,824% -> +648%, TSLA call 2024-07-01 +1,460% ->
+475% / +568%, FSLR call 2024-05-22 +2,621% -> +2,066% / +824%, AMD call 2024-02-29 +1,310% -> +913% / +958%; it wins
smaller ones (TSLA 2024-11-08 +518% -> +781%, QCOM 2026-05-07 +447% -> +755%). In the tune half the giants mostly faded
(QCOM 2025-10-27 +51% -> +720%). 11-19 trades over 2.5 years reach +1000%: the result is which giants fall in which half.
Verdict: not better; the champion keeps riding its huge winners. On the Bot vs Indi page as big-opt / big-stk (export_big.py,
fair list and fav24:), with a Weeks filter and "Only the trades the stop changed".

**The same at 45% (the user: "if I put 45% stop?", EXIT_RUN=big45).** Tune weeks (fair / Favorites 24m) at 2%: champion
$418,875 / $511,670; 45% from +1000% $585,314 / $685,543 (8 / 10 trades changed, worst drop unchanged 30% / 21%, without
the best 5 $138,422 / $156,148); from +1500% $493,094 / $593,157; from +2000% $410,233 / $501,114. At 3%: champion $460,190
/ $629,548; 45% from +1000% $715,180 / $927,721. **Check, the 3rd and last look (2%):** champion $928,510 / $160,100
against $771,581 / $140,584. Less bad than 30% ($545,259) but still below on both lists; the 3% check was stopped at the
user's word. The 45% level was set after seeing the 30% check, so this look was not clean either. The idea is closed.
Also run: the loss stop at -45% (stop45, the option -45% with the stock against the entry), tune only: $407,588 / 33% and
$512,722 / 19% at 2%, 133 / 129 trades changed: about the same money, a bigger drop on the fair list; not better.

### A second try on the same stock after an early first trade (2026-10-27, not better)

The user: "try again the same ticker - but only if the first attemp was in the first 30minutes of open". retry_roll.py
(on defence_signals.py BT_ALL=1: every minute the champion's rule holds, s_all_<rule>_<year>.csv; its first minutes match
the signal files 7,241 of 7,241). After a champion trade that entered before 10:00 and was fully sold the same day, a full
size trade at the first minute after that sale where the champion's rule holds again; set before running: the same side
(retry), either side (retry-any), the same side after a loss only (retry-loss). New legs' fills 98% on the real book.

| 2% | Tune fair | Tune fav 24m | Check fair | Check fav 24m |
|---|---|---|---|---|
| champion | $418,875 / 30% | $511,670 / 21% | $928,510 / 22% | $160,100 / 28% |
| retry (picked) | $396,223 / 34% | $485,986 / 21% | $777,113 / 24% | $134,343 / 33% |
| retry-any | the same | the same | $759,702 / 25% | $131,409 / 33% |
| retry-loss | the same | the same | $781,056 / 24% | $134,343 / 33% |

56 / 54 retries on tune, together -$24,415 / -$23,407 at $10K a trade, +3-5 points of drop; 3% says the same (tune
$419,796 / $578,123 vs $460,190 / $629,548). On tune every retry came after a loss on the same side (an early trade sold
the same day is nearly always a loser), so the three versions read the same there. The early stop-out was right.

### Rolling a big winner while the stock still looks good (2026-10-27, not better on tune; the check disagrees)

The user: "when big winner come a close/into the mony - we start to check if and when the stock is still locking good.
when the stock in a place that the bot would enter (t > 1.8 bla bla) we are rolling and buy with half of the gain the next
0.15 delta. we sell all the old position and keep going with the half". retry_roll.py: once the stock has reached the
strike (any day held), at the first minute after that the rule holds on the same side, sell all at the bid and put half of
the gain into a fresh 0.15-delta pick with the champion's exits; return = old + old / 2 x new; one roll a trade. Set
before running: at the money with the champion's rule (roll), with t >= 1.8 only (roll-t18), at 75% of the way to the
strike (roll-near25). New legs' fills 70-85% on the real book (the rest at the walk's +-2%: partly unproven).

| | 2% tune fair | 2% tune fav | 2% check fair | 2% check fav | 3% check fair | 3% check fav |
|---|---|---|---|---|---|---|
| champion | $418,875 / 30% | $511,670 / 21% | $928,510 / 22% | $160,100 / 28% | $1,538,450 / 31% | $155,881 / 39% |
| roll (picked) | $365,240 / 30% | $445,560 / 21% | $1,398,739 / 22% | $173,375 / 25% | $3,367,307 / 31% | $195,374 / 34% |
| roll-t18 | $339,301 | $413,908 | $1,513,872 | $158,759 | $3,655,810 | $171,614 |
| roll-near25 | $324,556 / 27% | $381,619 / 24% | $543,456 | $143,878 | $1,474,390 | $200,759 |

At 3% on tune: roll $462,143 / $595,167 vs $460,190 / $629,548. Without the best 5 on check (2%): roll $150,153 / $56,545
vs $211,442 / $55,123, so the check win is a few trades. 14 / 15 tune rolls: it cuts the tune giants (SMCI 2025-05-13
+2,093% -> +605%, ORCL 2026-04-13 +1,892% -> +560%, AAPL 2025-08-06 +1,201% -> +229%: the stock at the strike is often the
middle of the move, and the new far-out leg rarely matches the old in-the-money one) and saves the faders (SMCI 2024-06-13
-48% -> +67%, QCOM 2025-10-27 +51% -> +330%, GOOGL 2026-10-01 -87% -> +169%). Verdict by the rule: not better (loses the
tune pick); the check-week rolls are being listed. Follow-ups the user asked (running): roll when the option reaches delta
0.65 (0.80 beside it), roll before the night (15:30 / 15:00 to 15:44 on a carry day, the new leg held that night), and the
new leg at 0.25 delta instead of 0.15 for every roll version.



### A volume-weighted strength and D2 (2026-10-27, not better)

The user: "more weight to a big size burst and also more weight on the against spy by volume". defence_signals.py
BT_VWEIGHT (rel = the minute's volume over its usual, cap 10, floor 0.1; sqrt) and BT_VW_PARTS (both / t / d2): the
weighted t = mu_w / sd_w x sqrt(sw^2 / sw2). d2_window.py DW_SET=vw, tune weeks at 2% (fair / Favorites 24m): c12_15
(the champion, reproduced exactly) $418,875 / 30% · $511,670 / 21%; vw $152,973 / 48% · $168,898 / 40%; vw-sqrt $169,596 ·
$224,298; vw-t $195,178 / 45% · $261,758 / 34%; vw-d2 $167,055 / 38% · $205,203 / 31%. More D2 entries, each worth much
less (vw: 286 at +69 a trade against 167 at +2,519). Check (vw-t, run by the script though nothing passed tune): $166,662 /
$53,828 against $928,510 / $160,100. Weighting by volume lets the bursts swamp the steady grind the t-stat is built to find.

### A volume burst that makes the stock independent of SPY (2026-10-27, not better)

The user, on CBRS 2026-10-27 (12:00 New York: 1.1M shares in a minute, 35x, +5.6%, then above the jump while SPY fell):
"When burst of valume comes in and make the ticker independed its a good news and should be treaded as bonus".
`burst_bonus.py`, 2% a trade: a minute with volume >= 8x / 15x the stock's usual for that minute and a move >= 0.5 / 1.0
S30; confirmed when 15 / 30 minutes later the stock beats SPY x beta by 0.25 S30 its way (54,675 stock-days: 11,398
confirmed bursts). Tune (fair / Favorites 24m): the champion $402,140 / 31% and $511,670 / 21%. (A) a new entry at the
confirmation (stock-days the champion did not trade; +-2% fills, a screen): 8x/0.5 15 min $389,998 / 38% and $312,661 /
27% (210 / 201 trades, +33K / -241K at $10K), 30 min $253,739 / $299,150; 15x/1.0 15 min $344,384 / $510,333, 30 min
$362,383 / $487,205. (B) 1.5x on the champion's signals after a confirmed burst on their side: 4-20 trades, within 2%
of the champion (8x/0.5 15 min $411,618 / 28% and $510,760 / 21%; check $875,778 / $159,984 vs $869,036 / $160,100).
A burst plus independence is late: entered after the jump, the option is priced for the move. Rare as a bonus.

### Overnight only from +100 / +150 / +200% (2026-10-27, not better)

The user: "What if we go overnight only if bigger than 100% 200% 150%?". `exit_tests.py` EXIT_RUN=hold on the champion,
real quotes, tune (fair / Favorites 24m; overnight trades on the fair list): +50% (live) $255,238 / 17% and $289,355 /
11% (78); +100% $260,584 / 16% and $286,247 / 11% (55); +150% $267,007 / 15% and $278,403 / 11% (39); +200% $263,773 /
14% and $268,298 / 12% (33). The fair list gains a little with a smaller drop, the Favorites lose; the picked +100%
on check $286,229 / 12% and $124,889 / 15% vs $360,295 / 12% and $139,363 / 15%. The +50-100% winners held overnight
are worth more the next morning than at 15:50. Keep +50%.
At 2% / 3% a trade (EXIT_SIZE; the cap at each size), tune fair / Favorites: +50% $402,140 / 31% and $511,670 / 21% |
$432,964 / 41% and $629,548 / 30%; +100% $422,268 / 30% and $505,635 / 21% | $467,803 / 40% and $623,340 / 29%; +150%
$448,074 / 27% and $484,332 / 21% | $503,732 / 37% and $577,412 / 30%; +200% $438,985 / 26% and $451,708 / 23% |
$490,303 / 36% and $519,046 / 33%. Check (+100%): 2% $561,510 / 23% and $129,782 / 28% vs $869,036 / 23% and $160,100 /
28%; 3% $797,840 / 33% and $116,175 / 39% vs $1,392,030 / 33% and $155,881 / 39%. Same verdict at every size.
Around +50% (the user: "show me the overnight for 25 75 60 40", EXIT_RUN=hold2), tune fair / Favorites at 2% | 3%: +25%
$359,779 / $444,525 | $365,835 / $508,428; +40% $374,334 / $478,846 | $388,802 / $569,878; +50% $402,140 / $511,670 |
$432,964 / $629,548; +60% $411,531 / $490,759 | $449,422 / $594,011; +75% $423,962 / 30% and $515,543 / 20% | $469,867 /
40% and $640,328 / 29% (picked: up on both lists). Check (look 2/3): +75% $692,524 / $129,797 at 2% vs $869,036 /
$160,100; $1,006,654 / $115,630 at 3% vs $1,392,030 / $155,881. Under +50% loses on tune; over it loses on check. +50%
stays (the check looks: 2 of 3 used).

### Stock-move exits: support / resistance and a big move against (2026-10-27, not better)

The user: "exit by the moving of the stock too. Lets re testing the support and resistance approch to stop. Also big
move against - more than a correction might be an exit even if we are winning". `exit_tests.py` EXIT_RUN=stock, sim.py
`level_stop` (new) and `stock_trail`, on the champion, real quotes, tune (fair / Favorites 24m): base $255,238 / 17% and
$289,355 / 11%; the support / resistance behind the entry broken by 0 / 0.25 / 0.5 S30: $259,855 / $286,466, $254,614 /
$284,285, $255,180 / $287,951; the second level behind, 0.25: $259,498 / $292,358; a give-back of 2.5 S30 from the
stock's best (winning or not) $178,433 / $190,304, of 3.0 $213,548 / $207,369. Picked the second level: check $340,261 /
16% and $128,863 / 18% vs $360,295 / 12% and $139,363 / 15%. The level stops cut the same-day loss a little and as many
overnight carries; a big give-back sells the winners in their normal swings (it halves the overnight holds).

### Exits to cut the losers (2026-10-27, not better)

The user: "lets take care of the huge drops ... improve our exits - strategy and cut the big losers". The champion's
loss on the tune weeks is the same-day trades (465, -$1,156,219 at $10K; overnight 78, +$2,584,905), mostly -20% to
-50% (293, -$970,705), the -30% stop alone 134 trades -$512,958; 194 of 432 same-day losers had been up 30%+ first.
`exit_tests.py` on the champion (real quotes, minute model), tune (fair / Favorites 24m): base $255,238 / 17% and
$289,355 / 11%; out at cost once up 30% $257,663 / $286,371, at +10% $265,383 / $288,582; once up 50% at cost $255,759
/ $285,629, at +10% $255,858 / 9% and $297,277 / 9%; the first stop at -20% $264,721 / $288,413, at -25% $266,077 /
$299,649; overnight from +25% $241,522 / $269,963, from +35% $244,845 / $278,037. Picked -25% (both tune lists up
4%): check $211,772 / 16% and $131,041 / 18% vs $360,295 / 12% and $139,363 / 15%: it stops out winners that dip
before they run. The protect-the-gain stops cut 9-25 overnight carries each; holding from a lower gain carries more
losers. The exits sit close to their best; the drop is the same-day bleed of the entries, not an exit that is off.

### A second try for the looser D2 entries only (2026-10-27, not better)

The user, after d2_window.py: "Can we test second try only for enters with D2 bonus?". `d2_second.py`: the champion
unchanged, plus an EXTRA trade from a looser D2 signal that fires before the champion's own entry on that stock and day.
Tune (fair / Favorites, extra trades and their P&L at $10K a unit): base $260,535 / $289,355; t 0.8 full $213,624 /
$238,946 (111 / 123, -197K / -189K), half $235,992 / $263,046; t 0.6 full $212,660 / $241,846, half $235,468 / $264,640;
120-min full $258,970 / 18% and $305,680 / 13% (69 / 66, +60K / +123K), half $260,247 / $298,054. None beats the
champion on both lists; check (120-min, half) $368,173 / $135,196 vs $372,332 / $139,363. The early weak D2 signals
lose on their own; the 2-hour one is a small, uneven plus.

### D2 over 2 hours, D2 at t >= 0.8 / 0.6 (2026-10-27, not better)

The user: "can we go with D2 for the last 2 hours? except the 15 minutes of the openning.. also try it with t>=0.8/0.6".
`defence_signals.py` (BT_D2_WINDOW / BT_D2_SKIP), `d2_window.py` on the champion, real quotes, D2 >= 1.5 everywhere.
Tune (fair / Favorites): the champion (30 min, t >= 1.2) $260,535 / $289,355, D2 entries +2,837 / +2,262 a trade at
$10K; t >= 0.8 $190,032 / $210,389 (+340 / -3); t >= 0.6 $189,166 / $213,920; 120 min without 09:30-09:45 $196,307 /
$227,573 (+987 / +1,210); 120 min at t 0.8 $183,989 / $210,381; at t 0.6 $174,152 / $203,828. Check (the picked 120 min):
$230,481 / 17% and $121,350 / 25% vs $372,332 / 12% and $139,363 / 15%. One signal a stock a day: a looser D2 fires
earlier on a weaker move and takes the place of the day's later, stronger entry. 84-94% of the new trades fully on the
book (new minutes); the losses are far beyond that. Keep 30 minutes and t >= 1.2.

### An analyst-action bonus (2026-10-27, not better: too rare to matter)

The user: "what do you think about testing a bonus for stock that had upgrade/downgrade from an know analyst
organisation?". `analyst_news.py` (Benzinga through Alpaca, 82 stocks, 2024 - today: 14,019 analyst headlines; from 25
big houses with a direction 500 upgrades / downgrades and 6,415 target changes), `analyst_bonus.py` on the champion,
an action between the previous close and the signal. Only 10 of the champion's trades are confirmed by an upgrade /
downgrade, 6 go against one, 16 pre-market-skipped signals are confirmed. Tune (fair / Favorites): base $257,982 /
$289,355; 1.5x on upgrade / downgrade $257,200 / $288,949; 1.5x incl. target changes $253,152 / $280,909; skip against
$257,782 / $290,900; trade the confirmed pre-market skips $259,838 / $288,196; all three $259,742 / $288,745. None beats
the champion on both tune lists; check (skip against) $368,105 / $140,443 vs $368,105 / $139,363. The bot's signals
rarely fall on an analyst day (an upgrade mostly moves the stock before the open, a day the news filter and the
pre-market skip already treat as news).
Then (the user: "try only for those trades turn off these filters"): on an upgrade / downgrade day only, the pre-market
skip and the earnings-day filter off. lift-conf (the action in the trade's direction) tune $258,153 / $291,758 vs
$257,982 / $289,355, check $364,957 / $135,829 vs $368,105 / $139,363; lift-any tune $257,766 / $288,529. The added
trades (lift-conf): 15 on the fair list, 3 winners (UPST 2024-11-08 +15,834, PLTR 2026-08-04 +17,867, BA +603), net
-6,857 at $10K; 10 on the Favorites, 1 winner, net -17,445. The filters hold on analyst days too.

### Fridays (2026-10-27, not better: keep trading them)

The user: "on friday- consider buy for next week"; then "(c) On Fridays buy the nearest Monday or Wednesday expiry when
one is listed". (c) is the rule already (the nearest expiry 1-7 days out): of the champion's 180 Friday trades 33 buy a
Monday (3 days, +1,299 a trade at $10K), 142 next Friday (7 days, +617) where no nearer one was listed (before 2026 only
IWM and GLD). Skip or halve the Friday next-week trades (champion, real quotes, from the export): tune $262,697 /
$260,483 vs $257,985; check $341,020 / 14% and $354,995 vs $368,104 / 12%; Favorites 12m $180,501 / $185,858 vs
$191,008. Weak but positive trades; dropping them loses on check.

### Drawdown sizing on the champion (2026-10-27, not better: a smaller flat size does more)

The user: "if we're down 12.5 from the top use 0.5 size. until we claim half the way back - than move to regular
size. on the top you can double the size until we loosing 5%". `dd_sizing_rule.py` on the champion's real-quote
trades (export_champ.py), each return recomputed at its size with the 10% overnight cap; neighbours 10% / 15%. End /
worst drop:

| Base | Rule | Fair 2024-25 | Fair 2026 | Favorites 12m | Favorites 6m |
| --- | --- | --- | --- | --- | --- |
| 1% | off | $415,954 / 14% | $228,295 / 14% | $191,006 / 18% | $141,544 / 18% |
| 1% | 12.5% rule | $290,775 / 14% | $192,553 / 15% | $143,819 / 17% | $111,941 / 17% |
| 2% | off | $1,147,942 / 27% | $324,558 / 25% | $231,482 / 32% | $152,070 / 32% |
| 2% | 12.5% rule | $455,388 / 23% | $228,278 / 21% | $172,399 / 25% | $122,129 / 25% |
| 3% | off | $2,095,111 / 37% | $316,663 / 35% | $198,925 / 44% | $123,976 / 44% |
| 3% | 12.5% rule | $696,107 / 30% | $270,221 / 28% | $212,436 / 33% | $138,323 / 33% |

The 10% and 15% triggers land the same way. The rule loses money on every list at 1% and 2%; at 3% it gains on the
Favorites ($212K / 33% vs $199K / 44%) but 2% flat beats it there ($231K / 32%) and on the fair list. Why: the bot's
money comes in a few big days after long losing runs, so the half size is on when the winners come (fair 2024-25 at
2%: 181 of 337 days at half size) and the double size after a high meets the next losing run. The Favorites' early
drop is real (Oct 2025 - Jan 2026, -11% at 1%), but the worst one is May - Aug 2026 (-18%), recovered by IBIT and
MSTR on 2026-08-19. At 3% on real quotes the flat size is past the best: 2% is the better live size on the Favorites.

### Optimizing the cheap fallback (2026-10-27, not better: no fallback beats none on 2024-25)

The user: "Can we optimized the cheaper fallback?" `cheap_opt.py`, on 2.5's entries and exits, every signal re-picked,
only the contract changes; set before running: 2.6 (the live rule: under $0.20, the cheapest strike at $0.20+ toward the
money), 2.6* ($0.15 floor and fallback, as live), the fallback's floor at $0.30 / $0.50, the fallback at delta 0.25 /
0.30, and band10 (the fallback only when the 0.15-delta option is still $0.10+). Fair list at +-2% and on the real
book (98-100% of trades fully on it), and the 151 unseen (+-2%). 1% a trade:

| Version | Fair 2024-25 +-2% | Fair 2024-25 real | Fair 2026 real (held out) | Unseen +-2% |
| --- | --- | --- | --- | --- |
| 2.5, no fallback | $544,522 / 11% | $366,671 / 16% | $168,101 / 13% | $126,582 / 11% |
| 2.6 (live rule) | $491,519 / 11% | $302,905 / 16% | $207,079 / 15% | $78,181 / 39% |
| 2.6* ($0.15, live) | $455,583 / 12% | $278,979 / 17% | $216,370 / 14% | $69,024 / 46% |
| floor $0.30 | $468,740 / 12% | $299,725 / 18% | $187,282 / 14% | $82,579 / 33% |
| floor $0.50 | $516,443 / 10% | $336,106 / 16% | $173,403 / 13% | $116,636 / 13% |
| delta 0.25 | $480,583 / 11% | $297,732 / 16% | $208,445 / 15% | $72,571 / 43% |
| delta 0.30 | $489,959 / 11% | $302,792 / 16% | $202,790 / 15% | $71,143 / 44% |
| band10 | $483,796 / 13% | $307,274 / 18% | $207,058 / 14% | $105,939 / 22% |

On the tuning years every fallback loses to none (real: -$30K to -$88K), and on the unseen every one loses (2.6 and
the delta rules lose a third and add 30 points of drop). The fallback's money is 2026 (+$39-48K real over 2.5), the
year it was chosen on (2026-10-25 used the whole period), so 2026 is not a clean check for it. The least bad is the
$0.50 floor (fewer, pricier fallback trades): -$30K real on 2024-25, about even on the unseen. Verdict: the cheap
fallback does not survive optimization; the evidence says 2.5's plain pick (no fallback). The Favorites (where the
fallback's IBIT trades won) are the next check before any change to the live bot.


### The candidates on today's Favorites, real quotes (2026-10-27)

`fav_real.py`: today's 69 Favorites (fav68 + TSEM, which had no tradeable signal), 2025-10-23 to 2026-10-23, real
Databento quotes for every fill ($4.76, fav_dbx.py). Old prices reproduce the earlier Favorites runs exactly.
| Version | Old 1% / drop | Real 1% / drop | Real 2% / drop | Real w/o best 5 | Real 6 months |
| --- | --- | --- | --- | --- | --- |
| 2.4 | $184,085 / 10% | $150,271 / 13% | $183,782 / 25% | $70,737 | $108,950 / 13% |
| 2.5 | $192,845 / 12% | $153,998 / 15% | $170,800 / 26% | $65,137 | $113,322 / 15% |
| 2.6 (live) | $246,637 / 14% | $186,294 / 17% | $228,963 / 31% | $76,016 | $141,526 / 17% |
| pyramid | $255,262 / 15% | $191,345 / 18% | $234,738 / 32% | $80,053 | $149,243 / 18% |
| pyramid + cheap at half | $227,598 / 14% | $175,383 / 17% | $208,767 / 30% | $76,466 | $134,592 / 17% |
The pyramid holds (+3% at 1%, +1 point of drop; better without the best 5 and over 6 months); cheap at half loses (the
Favorites' cheap trades are winners). 2.6 stays ahead of 2.4 and 2.5 on real prices. Dashboard tab "Favorites".

**24 months (the user: "6 12 24 months"; `fav_real.py` with the first year's lists fav69_24 / fav69_25, Oct 23 2024 –
Oct 22 2025, quotes bought for $4.11, every fill on the book), at 1%:** 2.4 $277,457 / 13%; 2.5 $289,276 / 16%; 2.6
$298,548 / 18%; pyramid $330,993 / 19%; pyramid + cheap at half $329,054 / 18%. Over two years the cheap fallback adds
+$9K over 2.5 (+$26K in the last 12 months, so it lost in the first); the pyramid holds (+$32K over 2.6). Today's
Favorites, so the first year knows which stocks were kept. Dashboard tab "Favorites", "Last 24 months".

**The pyramid without the cheap fallback (the user, 2026-10-27: "Do the pyramid without the chip test on favorites";
`fav_real.py` pyramid-nocheap: the pyramid on 2.5, no fallback on either leg), real quotes, 1%:** 24 months $308,149 /
17% (2%: $554,378 / 32%; without the best 5 $123,957), 12 months $138,559 / 17%, 6 months $106,392 / 17%. Against 2.5:
+$19K over 24 months, even over 12 and 6. Against the pyramid with the fallback ($330,993 / 19%; 12m $169,792): -$23K
and -$31K, one to two points less drop; the gap is the fallback's IBIT trades (2026-08-19 +$187K, 2026-09-18 +$98K at
$10K). On the Favorites the cheap fallback still earns, all of it in 2026; on Indi's stocks in 2024-25 it loses
(cheap_opt.py). The add itself is worth +$19K over 24 months without the fallback and +$32K with it.

### Candidates on real quotes: delta, what the exits read, sizing (2026-10-26)

The user: "lets try to find more candidates - after that we will take the candidate and test them on my favorite".
`cand_real.py` on 2.6, the fair list, real Databento quotes; tuned on 2024-2025, 2026 held out. 2.6 flat: 2024-25
$390,392 / 12%, 2026 $233,116 / 14%.
- Delta 0.20 / 0.25 / 0.30: all far worse (2024-25 $139K-$270K): 0.15 stays.
- Exits reading the real quote every minute instead of trade bars: worse (mid $342,165 / 13%, bid $276,805 / 15%). The
  live bot reads live quotes, so the live bot may trail the backtest on this count.
- Sizing: pyramid (a D2 entry full + half of 2.4's entry later that day while held and up on the real mid) $483,650 /
  13%, 2026 $243,614 / 16%; pyramid + cheap-fallback trades at half $521,715 / 11% (without the best 5 $200,684 vs
  $145,270), 2026 $218,888 / 14% (2026's big winners were cheap-fallback trades); cheap at half alone $420,831 / 11%,
  2026 $208,777; half size under 500 contracts $313,038 / 11%.
Candidates for the Favorites check: the pyramid, and the pyramid + cheap at half. Dashboard tab "Candidates":
https://claude.ai/artifact/8hwVRYjvFphR4Ro6kQC1am

### Spread rules, sale limits, a lower floor on real quotes (2026-10-26, not better; the sale limit is unproven)

The user: "1. when spread is more than 15% - go one delta down and one delta up to see if the spread is better. if yes -
buy - if not try again on 20%-30% and blocks if it's more than 30%. play with the numbers here 2. try to add a stop
limit and selling not in bid 3. you can try on 50 or 100 contract as long as they are fit with rule number 1."
`opt_spread.py` on 2.6, the fair list, real Databento quotes; tuned on 2024-2025, 2026 held out. Baseline 2.6 on real
quotes: 2024-25 $390,392 / 12% at 1% (whole period $910,069 / 14%, = real_bench.py).

- Spread rules (only on a pick the bot would buy; a middle level picks the same strike as the cap, so look / cap):
  all worse in 2024-25. Best: look 30% cap 30% $287,792 / 13%; the user's look 15% cap 30% $270,138 / 14%; block over
  30% $225,039 / 15%. The blocked or swapped wide-spread picks are the cheap contracts that become the big winners.
  (A first run that also let a neighbour replace a too-thin or too-cheap pick was a liquidity fallback: $272,052 / 21%.)
- Floor 100 / 50 with a spread rule: more trades, still worse (look 15 cap 30 at 100: $309,269 / 15%).
- Sale: a limit at the mid (filled unless the next minute's ask is below it, else that bid) $419,727 / 12% (+7.5%), 2026
  $250,212 vs $233,116, whole $1,050,206 / 12%; halfway to the bid is worse than the bid ($374,680), the fallback after a
  drop costs. Fill unproven: quotes cannot show whether a mid limit fills; a live trial (limit at the mid for a minute,
  then the bid) would settle it.
Dashboard tab "Optimisation 2024-25": https://claude.ai/artifact/8hwVRYjvFphR4Ro6kQC1am


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
  - **Next-day expiries and overnight (`leg_1dte.py`, the user, 2026-10-25: "what if we add 1DTE as well here - and let
    it also have overnight").** The live way (leg at the side). Days whose nearest expiry is the next trading day
    (mostly Thursdays) as a second set: the 0.35 leg of tomorrow's expiry, the same give-back. Fair (3,346 alerts on
    0DTE days, 3,393 on 1DTE days): as now 446 trades $208,776 / 4.1%; 1DTE days alone 395 trades $144,438 / 2.6% out
    by 15:30, $151,550 overnight (41% winners, every year positive); both sets 842 trades $308,991 / 5.0% by 15:30,
    $321,568 / 5.0% overnight (±4%: $222,708 / 5.9%; 2%: $1,008,947 / 9.9%; without best 5 $227,111). Favorites: as
    now 253 $131,322 / 5.4%; 1DTE alone 187 $114,435 / 1.6% (45% winners); both 440 $151,341 / 5.1% (±4% $125,184 /
    7.3%). Overnight barely matters: the 0.75 give-back fires before the close on almost every trade (4 of 395 held
    on the fair list, all winners +$20K; none on the favorites); "only when up" is the same 4. The 1DTE leg instead of
    the 0DTE one on 0DTE days rarely exists (the next expiry is usually a week away). Better on both lists: the
    1DTE days are a second, calmer stream (the dearer leg buys fewer contracts) that adds money at a similar or lower
    drop. Same rule, so less in-sample than a new parameter; candidate for the live bot.
    **Run overnight from +50% (the user, 2026-10-25: "let the 1DTE run over night if it's up more than 50%"; `leg_1dte.py`
    1d_b1..b3).** Once the 1DTE leg's sale price is +50% over the buy the day's give-back stops; held overnight if still
    +50% at the close, else sold there; next day the 0.75 give-back, out by 15:30. With the 0DTE days, fair: $391,875 /
    6.3% (b1, 42 held overnight, those +$134K at 36 winners), with a +20% floor $384,149 / 5.5%, next day's give-back
    from its open $396,864 / 6.3%, a 1.5 give-back after +50% $321,765 / 5.6%; vs $308,991 / 5.0% out by 15:30 (±4%
    $268,557 / 9.5% vs $211,991; without best 5 $260,331 vs $230,295; but 2026 +91.5K vs +97.8K: the gain is 2024-25).
    Favorites: $140,636 / 7.3%, $132,997 / 5.9%, $142,797 / 7.4%, $146,519 / 5.9% vs $151,341 / 5.1%: every version
    worse; the 20 overnight trades win (+$19K) but the legs that reach +50% and fall back the same day, with no give-back,
    lose more. Not better: wins on the fair list, loses on the favorites (the user's own list) with 2 points more drop.
    **The morning rule on top (the user: "sale after the night - 50% if we win, 100% if we loose"; 1d_b1h / b1hc /
    b1fh / b1fhc):** at the leg's first bar next day, up from the buy (or from the close): half sold, the rest on the
    give-back; down: all sold. Fair: b1 $391,875 → $351,647 (from the buy) / $355,120 (from the close), drop 6.3% each;
    b1f $384,149 → $352,060 / $353,444. Favorites: b1 $140,636 → $134,655 / $135,762; b1f $132,997 → $132,088 /
    $132,907. Less money on both lists, no less drop: the overnight winners keep running the next morning (the half
    sold at the open caps them), and few are down at the open. The 1DTE days out by 15:30 stay the candidate.
    **Other deltas for 0DTE + 1DTE out by 15:30 (`leg_delta.py`, the user, 2026-10-25).** Same rule, the target delta
    on both kinds of day, 1% at ±2%: fair 0.20 $329,523 / 5.4% (625 trades), 0.25 $301,827 / 4.2%, 0.30 $304,337 /
    4.9%, 0.35 $308,991 / 5.0% (842), 0.40 $288,571 / 4.9%, 0.45 $244,586, 0.50 $245,443. Favorites 0.20 $131,772 /
    5.3%, 0.25 $134,625 / 5.7%, 0.30 $140,752 / 5.5%, **0.35 $151,341 / 5.1%**, 0.40 $145,149 / 6.1%, 0.45 $141,932,
    0.50 $141,231. Each kind's best delta differs by list (fair 0DTE 0.20 / 1DTE 0.35 → $328,898 / 4.1%; favorites
    0.35 / 0.25 → $154,316 / 6.0%), so a split is fitting noise. 0.45 and 0.50 are the same leg (the picker scans only
    OTM strikes; real delta median 0.42-0.45). Low deltas lose trades to the $0.20 / 200-contract floor (0.20: 625 vs
    842 on the fair list). 0.35 stays: best on the favorites, within 6% of the best on the fair list.
    **Size by the leg's IV (`leg_iv.py`, the user, 2026-10-26: "if the IV is higher than 70% use regular size, if it's
    lower double it").** The live rule (0DTE + 1DTE by 15:30, 0.35), IV = the picker's at the side. Leg IV median 88%
    fair (0DTE 102%, 1DTE 75%), 81% favorites. Per trade by IV band no order: the lowest band (<40%) is the weakest on
    both lists, 80-100% the best on both, 60-70% and 100-150% middling. 70% rule: fair $433,767 / 6.7% (average size
    1.31%) vs flat 1.31% $436,803 / 6.6%; favorites $167,425 / 6.5% (1.38%) vs flat 1.38% $179,159 / 7.2%. Cuts 50-100%
    and the reverse (2% when IV ≥ 70%) track their average size the same way. Not better: the gain is the bigger size,
    not the IV; at the same average size it is a tie (fair) or less money (favorites). The size slider is the lever.
    **The 5% day-loss limit and the live bot's caps (`leg_daycap.py`, the user, 2026-10-26: "test this bot when it can't
    loose more than 5% in one day").** New trades refused once the day's closed trades lost 5% of the morning's
    account (the live dayLossPct); also the live 5 trades a day and 3 open. At 1-2% the loss limit never fires (fair
    worst day -1.7% / -3.4%; favorites -2.7% / -5.6%, reached by trades already open). At 3%+ on the favorites it
    helps: 4% $494,955 / 21.1% → $529,110 / 15.9%, 6% $968,602 / 30.5% → $1,172,804 / 23.4%; fair only at 6%. It
    refuses new trades, so the worst day still passes 5% at 4%+ (open trades run on: -7.8%, -10.9%). The caps cost
    money: 1% fair $308,991 → $260,156 (57 trades refused, drop 4.9% → 5.5%), favorites $151,341 → $134,128 (62 refused,
    drop 5.2% → 4.1%, worst day -2.7% → -1.8%). 24 fair and 25 favorite days have 6+ trades (up to 15).
    **The liquidity floor at 100 (`leg_vol.py`, the user, 2026-10-26: "how my favorite will look like if the threshold
    for trades was 100 contracts?").** Contracts in the 30 minutes before the side, 50 / 100 / 150 / 200 (live 200), 1%,
    ±2%, no limits / the live caps. Favorites 12 months: 200 $151,341 / 5.2%, 150 $156,365 / 5.6%, **100 $159,986 /
    5.8%** (+74 trades, +$6,949), 50 $154,624 / 6.7%; live caps 200 $134,128 / 4.1% → 100 $140,882 / 4.8%; ±4%
    $125,184 → $128,816; last 2 months $109,760 → $112,117. Fair: 200 $308,991 / 4.9%, 150 $378,995, 100 $388,144 /
    5.4%, 50 $459,183 / 4.6% (±4% $211,991 → $250,307 at 100). Better on both lists at 100 (the favorites by a little,
    with about half a point more drop); the fill model is the same bar middle ± 2% on thinner contracts, so part of the
    gain may go to the spread live. A setting (minVolume), not changed.
    **Entering earlier, and a 15-minute give-up (`leg_entry.py`, the user, 2026-10-26: "I just think we enter too late
    and can improve"; "Also decrease the give up to 15 minutes").** The side at k = 0.05-0.35 of S30 (live 0.25), or
    "now" (the alert's direction, bought the next minute); give-up 60 (live) / 30 / 15 / 10 minutes. 1%, ±2%. Favorites:
    0.05 $135,396, 0.10 $143,973, 0.15 $146,889, 0.20 $150,225, 0.25 $151,341 / 5.2%, 0.35 $151,063 / 4.0%, now $103,089
    / 9.8% (31% winners). Fair: 0.05 $249,137, 0.10 $287,748, 0.20 $327,721, 0.25 $308,991 / 4.9%, 0.35 $317,695, now
    $134,157 / 16.8%. Earlier is worse: even at 0.05 the buy is +0.22 S30 from the alert price (the 1-minute bar jumps
    past the level), so it saves little price and keeps the false starts. The give-up: 0.25 at 15 min favorites
    $153,504 / 5.2% (live caps $136,458 / 4.0% vs $134,128), fair $315,386 / 4.4% (live caps $265,953 / 4.8% vs
    $260,156 / 5.5%); at 10 min $154,729 and $319,856. Only 5 and 4 trades go (sides after 15 minutes lose), so a small
    gain on both lists; the waitMinutes setting (10-120), not changed.
    **More than one trade a stock a day (`leg_twice.py`, the user, 2026-10-26: "what if we can enter to stock twice, even
    if option is open. And even if not").** Every alert event (an alert minute after a minute without one) 09:40-13:00
    runs the live rule (side within 10 min). Favorites (1,072 stock-days, 2+ events on 448): first only 431 trades
    $154,224 / 5.7% (live caps $137,057 / 4.4%); again only when flat 783, $199,721 / 8.2% (caps $149,462 / 5.9%; the
    351 later trades +$33,092, 38% winners); again even while open 1,095, $236,133 / 7.6% (caps $129,171 / 6.7%). Fair
    (1,903, 2+ on 884): first $317,972 / 4.4% (caps $269,762 / 4.4%); flat $717,451 / 7.0% (caps $454,452 / 4.1%; 941
    later trades +$249,625); open $1,190,278 / 8.7% (caps $434,896 / 5.3%). The later alerts trade about as well per
    trade as the first (fair +265 vs +262 at 1%; favorites +94 vs +126). Without caps more trades = more money and more
    drop; with the live caps "again when flat" is better on both lists, "while open" fills the 3-open / 5-a-day caps
    with one stock and loses on the favorites. Candidate: re-entry after the sale, with the caps.
    A cap per stock a day on "again when flat" (live caps in brackets): favorites 1 $152,516 ($139,217 / 4.6%), **2
    $184,087 ($155,077 / 5.8%)**, 3 $182,511 ($150,421), 4 $191,823 ($149,848), none $199,721 ($149,462); fair 1
    $374,849 ($316,250 / 4.4%), 2 $578,392 ($426,097 / 4.9%), 3 $600,769, 4 $680,722 ($453,069), none $717,451
    ($454,452 / 4.1%). Cap 1 here = the day's first trade from any alert (a later alert counts when the first gave no
    trade): fair $374,849 vs $317,972 for the first alert only. Trades a day (the whole bot): today most 13 (favorites)
    / 15 (fair); with re-entry 30 favorite days with 9+, most 28 and 53, so the 5-a-day cap binds hard.
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
  - **The pyramid (the user: "go with both, put it on top of the other rule we liked"):** on 2.5 + cheap + the next
    strike for D2: D2 entries at full size, the add (a fresh 0.15-delta, half size) when the stock reaches the real
    signal with the first leg held and up (131 adds), and both fallbacks' trades at half size: **$1,667,924 / 12%**,
    every year higher than the base (+1,127K / +1,001K / +1,139K vs +920K / +852K / +1,181K at $10K), $459,910 without
    the best 5 (base $1,277,234 / 13%, $415,374). The pyramid alone $1,751,061 / 14% ($506,781). Against the candidate
    2.5 ($1,108,678 / 11%): more money for a point more drop; against the flat size with the same 12% drop (~$1.05M),
    +59%. Live it needs a second position in the same stock that day (the add) and per-trade sizes in the bot.
  - **Half size at 16:40, more if it works (`open_scale.py`, the user: "entering in 16:40 - maybe half there too as it's
    high variance, then increase on the next 0.15 delta if we are right and have more than 50% gain"):** on the pyramid
    ($1,667,924 / 12%); 328 of 1,323 entries are at minute 10 (16:40 Israel), 528 in minutes 10-15. 16:40 entries at
    half, no add $857,569 / 10% (-30% against the flat size with the same drop); + the add (a fresh 0.15-delta, half)
    at +50% $958,349 / 11% (72 adds, -28%); at +100% $832,476 / 10% (52 adds, -35%); minutes 10-15 at half + the add at
    +50% $933,930 / 10% (99 adds, -19%). Not better: the opening entries carry the money (halving them costs more than
    a smaller flat size), and the add after +50% buys late, at a higher price, the move the first half already caught.
- **The D2 bonus before the open (`premarket_d2.py`, sim.py `hold_first`, 2026-10-25; the user: "if we have D2 bonus +
  more than 1.2 in the spy - bet with no stop on the opening"; pre market, t >= 1.2, no stop for 30 minutes):** t and D2
  from the pre-market 1-minute bars (08:00-09:29 NY, new table `prem`), pre-market volume 1.5-4x, no earnings reaction
  day; the option picked at 09:35, the candidate's exits with no stop for 30 minutes. Of 23,239 fair-list stock-days,
  4,563 pass the volume and news test, 76 give a D2 signal and 19 a trade (42 illiquid at 09:35). On 2.5: pm30
  $1,185,009 / 11% vs $1,108,678 / 11%; pm0 (the usual stops) $1,158,945; pm30 with D2 >= 2.0 $1,111,840 (7 trades).
  The 19 pre-market trades: 7 winners, +3,090 a trade, ARM 2025-05-29 +73K is most of it; $96,113 without their best 5.
  Most leave by the t-stat exit right after the 30 minutes (the regular-session t starts at the open, so it is thin
  then). Too few trades to judge: a pre-market D2 against SPY is rare on Indi's stocks. Not better (one trade).
- **More drop cuts (`dd_more.py`, 2026-10-25; the user: "try 2 and 3 with and without pyramid; also 6% stop for day"):**
  on 2.5 + cheap + the next strike for D2 with both fallbacks at half ($1,203,541 / 11% at 1%, $5,942,686 / 22% at 2%)
  and with the pyramid ($1,667,924 / 12%, $10,394,112 / 22%). 1-DTE contracts at half: $931,937 / 11% (-17% against
  the flat size with the same drop) and with the pyramid $1,252,539 / 11% (-14%); half size when SPY's 20-day volatility
  is in its top fifth: $731,495 / 13% and $953,555 / 12% (-40%); half after SPY closed under its 20-day average: $876,858
  / 10% (-10%) and $1,185,490 / 11% (-22%); 2% the same picture. **The 6% day stop never fires**, at 1% or 2%, with or
  without the pyramid: no day's same-day positions ever reached -6%. Why: the worst drop (11.4%, 2024-09-12 to
  2025-01-17) is a four-month bleed, 57 of 65 trading days a small loss, the worst single day -1.2%. A rule that waits
  for a bad day or a bad market never sees it; only less exposure to the weak trades (the fallback half) or a smaller
  size moves it. Not better: all three.
  - **D2 small, the real signal big (`d2_bigadd.py`, the user: "if D2 enters 50% then we hit the signal we can enter
    even bigger - 1.5-2X"):** with both fallbacks at half, the add held and up (131 adds); yardstick = the pyramid (D2
    1x + add 0.5x, $1,667,924 / 12% at 1%, $10,394,112 / 22% at 2%) at another flat size. At 1%: D2 0.5 + add 0.5
    $1,042,315 / 10% (-5%); D2 0.5 + add 1.0 $1,492,305 / 11% (-4%); D2 0.5 + add 1.5 $2,039,853 / 13% (-5%); D2 1.0 + add
    1.0 $2,312,692 / 13% (+0%). At 2%: +7%, +6%, +16% for the last three. The add's size is a risk dial on the same
    trades: at 1% every split ends where the pyramid at that drop would; at 2% a bigger add is a little better (the
    night cap binds less on two legs). Halving the D2 entry gives back its cheap early price, as before.
  - **The candidate stage on the Favorites (`fav_pyramid.py`, the user: "run it against my favorites in the last 12
    months"):** 86 Favorites, 1% from $100,000. 12 months: production 2.4 $176,352 / 9%; candidate 2.5 $192,534 / 12%;
    2.5 + cheap + next strike for D2 $285,889 / 15% ($115,777 without the best 5); + both fallbacks at half $239,024 / 14%;
    the pyramid + fallbacks at half $258,894 / 15% ($115,934); **the pyramid with the fallbacks at full size $306,567 /
    16% ($128,651)**; D2 1x + add 1x + half $277,390 / 16%. 6 months: $118,562 / 9%, $121,303 / 12%, $158,329 / 15%,
    $139,981 / 14%, $154,583 / 15%, **$173,108 / 16%**, $168,882 / 16%. The pyramid's add holds on the Favorites (+$20K
    on 12 months over the same bot without it); the fallback half does not: here the fallback picks are among the best
    trades (IONQ 2026-04-14, IBIT 2026-08-19), so halving them costs money without cutting the drop (14-15% either way).
  - **The pyramid on the fallback trades (`fb_pyramid.py`, the user: "what if I do pyramid on the fallbacks as well?"):**
    the D2 fallback trades already get the real-signal add; for the t >= 1.8 fallback trades (half size), add half a
    size of the usual 0.15-delta contract once it passes the floor within an hour, the first leg still held. It seldom
    happens: 20 adds on the fair list, 15 on the Favorites (of 77 such trades). Fair list: pyramid + half $1,667,924 /
    12% → with the add $1,660,100 / 12% (held and up $1,629,162); Favorites 12 months $258,894 / 15% → $264,781 / 15%;
    6 months $154,583 → $159,006. No change worth having: the usual contract rarely becomes tradable once the bot had to
    fall back. The pyramid with the fallbacks at full size stays the best on the Favorites ($306,567 / 16%) and the
    most money on the fair list ($1,751,061 / 14%).
- **Try a stock again after a stop (`reentry.py`, 2026-10-25; the user: "find a good strategy to try again a stock; we
  might go out but the stock might still be strong"):** on 2.5 (981 trades, $1,108,678 / 11%): 753 close in full by a
  stop on the entry day; 89 of those see the first contract reach 2x its cost later that day (the ceiling). One
  re-entry, 10 minutes after the exit at the earliest, by 14:30 NY, a fresh 0.15-delta, the same size. Rules: R0 the entry
  rule again (control); R1 D2 since the exit >= 1.5 with t >= 1.2; R2 R1 and the stock back past the first entry; R3 D2
  since the exit >= 2.0; R4 R1 after a stop that was SPY's doing (excess move from entry to exit >= -0.5 S30); R5 a new
  high (low) of the day with t >= 1.8. With the usual exits every one loses: R0 168 re-entries -$191K ($914,670 / 15%),
  R1 67 -$111K ($992,548 / 12%), R2 59 -$97K, R3 23 -$52K, R4 22 -$42K ($1,063,445 / 12%), R5 93 -$101K; 10-15% winners.
  Second round, the re-entry's own exits: no stop for 30 minutes (R0 +$20K but -$352K without its best 5, $1,102,276 /
  16%; the rest -$52K to -$169K) and -30% only (all lose, -$62K to -$246K). The re-entries reach 41 of the 89 runners
  (R0) and still lose: the second contract costs more and the runs come back through the stops again. Not better: a
  stopped trade is not worth buying again on any of these signs, D2 since the exit included. The 89 runners are an exit
  question (the stop sells them), not an entry one.
  - **The same on the user's new watchlist (`reentry.py list fav68_25`, 2026-10-26; "can you run the last test again on
    the watchlist? I changed it"):** the 68 Favorites (IGV added, 19 removed), 2025-10-23 to 2026-10-23: 2.5 525 trades,
    $192,845 / 12%; 394 stopped on the entry day, 46 of them later 2x. Usual exits: every rule lower (R0 92 re-entries
    -$88K, $175,965 / 17%; R4 8, -$14K, $190,092 / 12%). No stop 30 min: R0 +$138K ($215,194 / 17%) but -$227K without
    its best 5; the rest lose. -30% only: all lose. Same verdict as the fair list.
- **The contract floor at 100 instead of 200 on the user's watchlist (lists.py with `BT_CONTRACT={"min_vol30":100}`,
  2026-10-26; "check how my favorites look if the threshold for trades was 100 contracts"):** the 68 Favorites, 12
  months, 1% from $100,000. 2.4: 434 → 587 trades, $184,085 / 10% → $216,536 / 15% ($87,204 → $99,574 without the best
  5); 6 months $121,853 / 10% → $128,058 / 15%. 2.5: 525 → 709 trades, $192,845 / 12% → $238,876 / 16% ($82,909 →
  $99,403); 6 months $125,846 / 12% → $166,038 / 16%. The added trades: 2.4 153, 30 winners, +$198K at $10K, -$211K
  without their best 5 (MSTR 2026-08-19, IONQ 2026-04-14, CRWV 2026-08-03); 2.5 185, 34 winners, +$261K, -$225K (COIN
  2026-08-19, SMCI 2026-05-28, GOOGL 2026-07-31). More money for 4-5 points more drop, all of it a handful of trades;
  thinner contracts, so the 2% fill is optimistic for them. Not better by the rule.
  - **Size by the contract's volume (`liq_size.py`, the user: "what about 500 and half size for 100+? or double size on
    500"):** same list and period, the floor at 100. 2.5's 709 trades by volume: 100-199 185 (+$261K at $10K, -$225K
    without the best 5), 200-499 196 (+$87K, -$179K), 500+ 328 (+$677K, -$216K). 2.5, 12 months (base $193,235 / 12%):
    flat 100 $238,876 / 16% (+14% against the base at the same drop); **100-499 at half, 500+ at 1x $208,829 / 12% (+9%,
    the same drop)**; 500+ at 2x $253,743 / 21% (+2%); half / 1x / 2x $281,718 / 21% (+11%). 6 months (base $126,101 /
    12%): $166,038 / 16% (+29%), **$141,245 / 12% (+12%)**, $131,348 / 21% (-3%), $150,519 / 21% (+11%). 2.4 gains nothing:
    12 months half under 500 $182,857 / 10% (= base), double 500 $225,567 / 15% (+4%); 6 months every sizing below the base
    at its drop (-4% to -12%). For 2.5, half size on the thinner contracts adds money at no extra drop on both periods; the
    double size on the liquid ones only adds drop. Thin-contract fills unproven; one list, one year.
    The user's next split, 100-399 at half and 400+ at 1x: 2.5 $209,284 / 13% on 12 months (+8%), $140,544 / 13% on 6
    (+11%), against $208,829 / 12% and $141,245 / 12% for the 500 split; 2.4 $176,373 / 11% (-6%) and $111,157 / 11%
    (-10%). Within a point of the 500 split either way; the 500 split keeps the drop at the base's 12%.

### Overnight from +25%, stops -35% to -50%, and a 1-second stop exit, on the fixed walk (2026-10-31)
The user, after the audit: "lets check 25%+ go overnight", "lets test 35%-50% stop", "try use one second exit ...
Black-Scholes -3% / bid, the lower of the 2". champ-early, fair list, all with `BT_CLOCK=stock BT_CHASE=ask`; tune =
even ISO entry weeks, check = odd; `BT_X` overrides one exit setting, `BT_SEC_EXIT=1` the 1-second stops (sim.sec_stop).

| Version | Trades | Won | 2% (drop) | Without 10-10 | Tune | Check | 1% |
|---|---|---|---|---|---|---|---|
| Fixed champion (carry +50%, stop -30%) | 1087 | 16.7% | $2,845,332 (27.6%) | $2,798,469 | $448,187 | $634,854 | $857,745 |
| Overnight from +25% | 1087 | 15.5% | $3,037,966 (27.0%) | $2,987,931 | $429,734 | $706,941 | $889,360 |
| Stop -35% | 1087 | 17.2% | $2,817,553 (29.1%) | $2,767,076 | $432,933 | $650,805 | $853,467 |
| Stop -40% | 1087 | 17.4% | $2,713,945 (29.8%) | $2,668,264 | $433,117 | $626,608 | $837,888 |
| Stop -45% | 1087 | 17.6% | $2,784,911 (29.7%) | $2,739,043 | $436,192 | $638,460 | $848,651 |
| Stop -50% | 1087 | 18.0% | $2,820,704 (29.9%) | $2,778,335 | $444,723 | $634,260 | $854,223 |
| 1-second price stops (BS -3% / bid) | 1079 | 13.9% | $677,487 (41.8%) | $664,457 | $270,743 | $250,233 | $367,929 |

- Overnight from +25%: +7% on the total, +11% in the check half, but -4% in the tune half: not a clean win (fails the
  both-halves bar); more nights, fewer winners (15.5%). Keep +50%; worth a finer sweep (+35% / +40%).
- Wider stops: none better; each loses a little and adds 1.5-2.3 points of drop. Keep -30%.
- 1-second stops: far worse (-76%): 650 of 1079 trades stopped by second-level noise; the minute close is a filter.
  Do not stop on seconds.

### Stock-based stops for losers, on the fixed walk (2026-10-31)
The user: "re test an exit (as a stop, for looser holding) by the movement on the stock". champ-early, fair list,
`BT_CLOCK=stock BT_CHASE=ask`, entry day, all out; S30 = the stock's usual 30-minute move.

| Version | Sold by it | Won | 2% (drop) | Without 10-10 | Tune | Check | 1% |
|---|---|---|---|---|---|---|---|
| Fixed champion | - | 16.7% | $2,845,332 (27.6%) | $2,798,469 | $448,187 | $634,854 | $857,745 |
| Trail 1.0 S30 from the best, losers only | 751 | 15.2% | $780,488 (28.0%) | $763,702 | $244,097 | $319,745 | $429,184 |
| Trail 1.5, losers only | 468 | 16.4% | $2,429,127 (26.5%) | $2,376,883 | $387,589 | $626,728 | $785,411 |
| Trail 2.0, losers only | 273 | 16.3% | $2,457,432 (28.2%) | $2,401,942 | $369,955 | $664,251 | $793,187 |
| 1.0 S30 against the entry price (T_s30) | 300 | 16.3% | $2,967,242 (26.4%) | $2,908,748 | $468,689 | $633,095 | $888,054 |
| Second level behind, 0.25 S30 (S_level) | 91 | 16.6% | $2,704,589 (26.7%) | $2,660,044 | $470,007 | $575,436 | $849,280 |

- Trails from the best: worse, as on the old walk (a tight one sells most trades in their normal swings).
- 1.0 S30 against the entry: +4% total, +5% tune, check a tie (-$1.8K), drop 1.2 points lower: the best stock stop,
  not a clean win yet; next: 0.75 / 1.25 / 1.5 S30 around it.
- The level stop: tune +5%, check -9%: no.

### The 10 / 20-minute checks off, with and without the 1.0 S30 stock stop (2026-10-31)
The user: "what happens if we remove the 10-20 minutes check if we have this?". `BT_X={"user_stop": {"checks": []}}`
(the -30% stop with the stock against stays; the -20% on the rest after the half has no half to follow), fixed walk.

| Version | Won | 2% (drop) | Without 10-10 | Tune | Check | 1% |
|---|---|---|---|---|---|---|
| Fixed champion (checks on) | 16.7% | $2,845,332 (27.6%) | $2,798,469 | $448,187 | $634,854 | $857,745 |
| + stock stop 1.0 S30 | 16.3% | $2,967,242 (26.4%) | $2,908,748 | $468,689 | $633,095 | $888,054 |
| Checks off | 20.4% | $3,304,181 (32.4%) | $3,249,761 | $488,278 | $676,701 | $930,796 |
| **Checks off + stock stop 1.0 S30** | 18.3% | **$3,239,866 (27.8%)** | $3,175,997 | $477,188 | $678,950 | $929,327 |

- Checks off wins both halves (+9% tune, +7% check) but the drop goes 27.6% -> 32.4%.
- Checks off + the stock stop wins both halves (+6.5% tune, +7% check, +14% total, +8% at 1%) at the same drop
  (27.8%): the stock stop does the checks' job of cutting losers, with fewer good trades cut. The candidate.
  In-sample (the fair list, the period the rules were built on); confirm on Favorites before a live change.

### Staged stock exits and buy-backs, checks off (2026-10-31)
The user: "multiple exits, and multiple exit half than exit full phases. exit half than bring back when it looks good
again". sim.py `stock_stages` {half, share, full, back, repeat}; all with the 10 / 20-minute checks off and the -30%
stop on; moves from the signal price in S30; fixed walk, champ-early, fair list.

| Version | Halves / fulls / buy-backs | Won | 2% (drop) | Without 10-10 | Tune | Check | 1% |
|---|---|---|---|---|---|---|---|
| Today's rules (checks on) | - | 16.7% | $2,845,332 (27.6%) | $2,798,469 | $448,187 | $634,854 | $857,745 |
| All out at 1.0 S30 (= the candidate, same numbers) | 0 / - / 0 | 18.3% | $3,239,866 (27.8%) | $3,175,997 | $477,188 | $678,950 | $929,327 |
| **Half at 0.5, the rest at 1.0** | 620 / 392 / 0 | 16.7% | **$3,431,770 (26.7%)** | $3,359,191 | $506,039 | $678,163 | $956,642 |
| Half 0.5, rest 1.0, buy back at the signal price | 620 / 392 / 212 | 17.0% | $2,572,767 (29.1%) | $2,525,743 | $454,697 | $565,820 | $827,291 |
| Half 0.5, rest 1.0, buy back at +0.25 | 620 / 385 / 170 | 17.0% | $2,655,511 (31.5%) | $2,609,372 | $448,124 | $592,584 | $844,859 |
| Half 0.75, rest 1.25 | 498 / 263 / 0 | 18.8% | $3,018,911 (28.9%) | $2,954,526 | $478,697 | $630,652 | $899,791 |
| Half 0.5, rest 1.0, buy back at the signal, repeat | 619 / 397 / 267 | 16.8% | $2,314,326 (29.2%) | $2,277,037 | $447,770 | $516,856 | $783,929 |

- Half at 0.5 S30, the rest at 1.0: the best so far: +21% over today's rules (+13% tune, +7% check) and +6% over the
  all-out candidate (+6% tune, check a tie), with the lowest drop (26.7%). The new candidate.
- Buying back: worse every way (-20% to -29%, deeper drops): the stock back at the signal price is usually a pause
  before the next leg against, and the half is paid at the ask. Looser stages (0.75 / 1.25) worse.

### Add 50% when the stock moves our way in the first 10 minutes, on top of the staged exit (2026-10-31)
The user: "add 50% if it goes in our direction in the first 10 minutes, then the 2-step exit for all the premium".
`stock_stages.add` {within 10, move, share 0.5}, bought the next minute at the real ask side (the rebuy fill), extra
money on top of the 2% trade; checks off, -30% stop, half out at 0.5 S30 against, the rest at 1.0; fixed walk.

| Version | Trades added | Won | 2% (drop) | Without 10-10 | Tune | Check | 1% |
|---|---|---|---|---|---|---|---|
| Staged exit, no add (candidate) | - | 16.7% | $3,431,770 (26.7%) | $3,359,191 | $506,039 | $678,163 | $956,642 |
| Add at +0.25 S30 | 683 | 16.6% | $6,468,755 (35.1%) | $6,272,477 | $578,421 | $1,118,346 | $2,092,487 |
| Add at +0.5 S30 | 543 | 15.7% | $5,910,629 (33.5%) | $5,727,076 | $565,446 | $1,045,304 | $1,919,530 |
| **Add at +1.0 S30** | 297 | 16.0% | **$7,980,114 (28.6%)** | $7,847,584 | $651,378 | $1,225,112 | $2,251,336 |

- Add at +1.0 S30 wins both halves (+29% tune, +81% check) with 2 points more drop. It is not just more size: the
  candidate at the same average risk (2.27% a trade) makes $4,838,869 with a 29.9% drop.
- But it rests on giants: of the +120 points it adds over 297 trades, 89 come from 10 trades (MSTR and IBIT
  2026-08-19, BA 2024-05-23, FSLR 2024-05-22, SMCI 2025-05-13); the median added trade is 20 points worse and only
  27% of them gain (the add is paid at the ask after the move, then the move often stalls). Promising, not proven:
  needs the Favorites (other stocks) before any live change.

### The -30% option stop widened to -50 / -60 / -70%, on the staged exit and the add (2026-10-31)
The user: "lets move the stop to 50%/60%/70%, as now we have a better stop". `user_stop.out` -0.5 / -0.6 / -0.7,
checks off, staged exit (half 0.5 S30, rest 1.0), with and without the add at +1.0 S30; fixed walk, champ-early, fair
list. The live broker safety stop (`safetyStopPct` 50) would fire first at -60 / -70% unless raised; not modelled.

| Version | Option-stop sales | Won | 2% (drop) | Without 10-10 | Tune | Check | 1% |
|---|---|---|---|---|---|---|---|
| Staged exit, stop -30% | 350 | 16.7% | $3,431,770 (26.7%) | $3,359,191 | $506,039 | $678,163 | $956,642 |
| Stop -50% | 70 | 17.6% | $3,499,639 (26.0%) | $3,425,625 | $504,464 | $693,734 | $967,120 |
| Stop -60% | 12 | 17.8% | $3,767,288 (25.1%) | $3,687,613 | $537,927 | $700,334 | $1,003,424 |
| Stop -70% | 2 | 17.8% | $3,790,679 (25.1%) | $3,710,510 | $544,213 | $696,543 | $1,006,405 |
| Staged + add, stop -30% | - | 16.0% | $7,980,114 (28.6%) | $7,847,584 | $651,378 | $1,225,112 | $2,251,336 |
| + add, stop -50% | - | 16.8% | $8,171,989 (30.0%) | $8,036,272 | $679,091 | $1,203,371 | $2,283,092 |
| + add, stop -60% | - | 17.0% | $8,594,137 (29.7%) | $8,451,410 | $712,276 | $1,206,573 | $2,341,886 |
| + add, stop -70% | - | 17.0% | $8,626,689 (29.9%) | $8,483,421 | $721,340 | $1,195,926 | $2,346,026 |

- At -60% the option stop almost never fires (12 sales); the stock stages do the cutting. On the staged exit it wins
  both halves (+6% tune, +3% check) with a lower drop (25.1%). -70% is the same as -60% (no stop at all, in effect).
- But it rests on giants: of 340 changed trades only 98 gain, the median is 2.9 points worse, and the best 10 bring
  +1,306 points against +474 in all (2026-02-06 +349, 2026-06-26 +183, 2025-02-06 +182): the wider stop lets a few
  losers come back big while most losers lose a little more. With the add, the check half slips (-1.5%).
- Not adopted yet; with the staged exit, -60% is the leaning. Confirm on the Favorites, and the broker stop would need
  raising to match.


- The combination (the user: "add on this the add rule we saw that helps"): stop -60% + staged exit + the add at +1.0
  S30 = $8,594,137 (29.7%), tune $712,276, check $1,206,573, 1% $2,341,886. Against stop -60% without the add: tune
  +32%, check +72%, drop +4.6 points. Against the add on the -30% stop: tune +9%, check -1.5%. The add's part is as
  before: 297 trades changed, 82 gain, median -20 points, the best 10 (FSLR 2024-05-22, BA 2024-05-23, META 2026-09-21,
  ORCL 2025-07-02, IBIT 2026-09-18, AMD 2025-03-26 ...) bring 85% of its points.

### The staged exit, the -60% stop and the add on the Favorites (2026-10-31)
The user: "run it on the favorite". The same runs' Favorites rows (export_early, fav12 / fav6), fixed walk, 2%:

| Version | 12 months (drop) | Without best 5 | Tune | Check | 6 months |
|---|---|---|---|---|---|
| Fixed champion | $244,185 (28.5%) | $64,277 | $223,781 | $109,118 | $160,359 |
| Staged exit | $256,014 (29.0%) | $67,439 | $240,768 | $106,332 | $165,876 |
| Staged exit, stop -60% | $272,126 (30.3%) | $71,627 | $256,442 | $106,116 | $161,978 |
| Staged exit + add | $303,340 (35.5%) | $64,422 | $301,245 | $100,696 | $172,733 |
| Staged exit, stop -60%, + add | $313,855 (35.3%) | $66,597 | $321,006 | $97,772 | $163,225 |

- Every version adds money in the tune half and loses a little in the check half; none passes the both-halves bar on
  the Favorites. The staged exit and the -60% stop are small (+5% / +11% total, check -3%); the add is +29% total with
  the check -10% and 7 points more drop. Without the best 5 trades the add is no better than the champion. Not ready
  for live; the add is a bet on giants.

### Why the stock exits win now and lost before; the Favorites over 3 years (2026-10-31)
The user: "before we already tested an exit by stock movements but never made it a candidate. how is this working now
even better after a fix that dropped 60% of the gain?" and "run this on the last 3 years".

The same exits on the old walk (`BT_CLOCK=trade BT_CHASE=cap BT_KEEP=0`, fair list, champ-early, 2%):

| Version | Old walk | Tune | Check | Fixed walk | Tune | Check |
|---|---|---|---|---|---|---|
| Champion | $7,258,326 (24.1%) | $615,476 | $1,179,302 | $2,845,332 (27.6%) | $448,187 | $634,854 |
| Checks off | $7,697,298 (26.7%) | $679,557 | $1,132,693 | $3,304,181 (32.4%) | $488,278 | $676,701 |
| Checks off + all out at 1.0 S30 | $7,153,274 (25.6%) | $652,866 | $1,095,673 | $3,239,866 (27.8%) | $477,188 | $678,950 |
| Staged (half 0.5, rest 1.0) | $7,265,390 (24.3%) | $670,923 | $1,082,895 | $3,431,770 (26.7%) | $506,039 | $678,163 |

On the old walk the stock exits tie or lose (check half -7% to -8%), as in the 2026-10-24 / 27 tests. The fix cut the
champion 61% but the staged version only 53%: the old walk flattered the option-price exits (checks, -30% stop) more
than the stock ones. On the fixed walk the checks fire on time at the real mid; 465 trades sold by a check would, with
the checks off, do 9 points worse at the median (101 better) but +1,184 points in all, from a few that come back big.
So part of the "win" is the same giant pattern.

The Favorites, 36 months (export_fav_long.py, 69 Favorites, Oct 2023 - Oct 2026, minute entries, real quotes, fixed
walk, 2%; years from Oct 23):

| Version | Account (drop) | Without best 5 | Tune | Check | 1% | Y1 | Y2 | Y3 |
|---|---|---|---|---|---|---|---|---|
| Champion | $3,953,742 (30.4%) | $808,356 | $550,546 | $718,149 | $998,410 | $225,474 | $527,668 | $332,316 |
| Staged | $3,595,914 (31.0%) | $735,650 | $552,666 | $650,649 | $957,694 | $223,843 | $470,177 | $341,668 |
| Staged, stop -60% | $4,173,507 (28.4%) | $850,861 | $659,034 | $633,276 | $1,035,213 | $225,571 | $544,867 | $339,569 |
| Staged, stop -60%, + add | $11,124,421 (30.9%) | $1,921,715 | $1,131,201 | $983,417 | $2,486,192 | $266,187 | $996,121 | $419,545 |

- Staged alone: -9% (check -9%): fails. Stop -60%: +6% but check -12%: fails.
- The add: both halves up (+105% / +37%), every year up, drop +0.5 point, 2.4x without the best 5. Against stop -60%
  alone: 350 trades changed, 102 better, median -15 points; the best 10 +5,396 points, the rest +2,311. The strongest
  result so far, still a few-giants rule; fails the 12-month Favorites check half (-10%). Paper-test candidate.

### The champion's rules rechecked on the fixed walk (2026-10-31)
The user: "the champion now is after bug fixes right?" -> "yes" (recheck the rules, put the fixed numbers on Bot vs
Indi). The benchmark exports re-run with the fixes on (export_bench, fav_bench, export_champ, export_early,
export_fav_long, export_big, fill_models, fair_bench, rets_extra, spread_book); each rule against itself off, the same
fill model on both sides, 2%, account (tune / check):

| Rule | List | With | Without | Old walk (with / without) |
|---|---|---|---|---|
| Early entry (champ-early vs champ-1s) | fair | $2,845,332 (448K / 635K) | $1,955,900 (381K / 513K) | $7.18M / $5.08M |
| | fav12 | $244,185 (224K / 109K) | $189,519 (197K / 96K) | $347K / $273K |
| Pyramid (champ vs d25-ibit, minute fills) | fair | $4,176,456 (487K / 858K) | $3,616,696 (471K / 769K) | $9.49M / $7.81M |
| | fav12 | $332,316 (234K / 142K) | $330,569 (239K / 138K) | $442K / $445K |
| IBIT $0.10 (champ vs pyr-nc) | fair | $4,176,456 (487K / 858K) | $2,756,407 (304K / 907K) | $9.49M / $6.19M |
| | fav12 | $332,316 (234K / 142K) | $204,023 (141K / 144K) | $442K / $267K |
| D2 bonus (2.5 vs 2.4) | fair | $2,371,623 (291K / 814K) | $1,314,160 (386K / 341K) | $5.32M / $2.74M |
| | fav12 | $201,766 (145K / 139K) | $186,626 (172K / 108K) | $268K / $248K |
| Cheap fallback (2.6 vs 2.5) | fair | $2,590,702 (363K / 713K) | $2,371,623 (291K / 814K) | $6.03M / $5.32M |

- No verdict flips: early entry holds (both halves, both lists); the pyramid holds on the fair list and ties on the
  Favorites; IBIT $0.10 is tune-only (check -5% fair, -1% Favorites), as on the old walk; the D2 bonus is mixed halves
  (tune lower, check much higher), as before; the cheap fallback stays off. 2.7 stays the champion.
- Minute fills (champ, $4.18M) stay above the 1-second fills (champ-early, $2.85M) on both walks: compare within a fill
  model only.
- Bot vs Indi (34CHCtYWPgexzP51zze9vV): all 20 data files replaced with the fixed-walk exports; a note at the top says
  the written figures in the Research / How it works text are from before the fix.


### The champion's drops at 3%, fixed walk (2026-10-31, a diagnostic)
The user: "investigate the drops. lets look at 3% and check biggest drop and what happens in there". champ-early, fair
list, 3% (ret_3pct, the 10% night cap at 3%): six drops of 30% or more; the worst 35.9% (2024-11-11 -> 2025-01-17,
recovered 2025-03-10); the current one -32.4% since 2026-09-21. Inside the worst: 61 trades, 10% won (17% elsewhere),
the median loser -31% (-30% elsewhere), 29 of 32 trade days lost (12 in a row); the loss is the -30% stop (-$101K), the
rest's -20% (-$44K) and the 20-minute check (-$27K); overnight holds made money. The current one: 36 trades, 6% won,
14 of 14 days lost. SPY on drop days looks the same as on other days (range 0.86% vs 0.84%, trend share 0.48 vs 0.47),
trades a day 2.1 vs 2.35, win rate flat by trades a day: the drops are droughts of giants, not a market type or a new
kind of loss, and each one ends on one giant day (2026-08-19, 2026-09-18). Size: the fair list peaks near 3% ($5.16M,
drop 35.9%; 4% $4.89M / 44.8%); the 12-month Favorites peak at 2% ($244K; 3% $232K / 39.8%); the 36-month Favorites
still rise to 5% (drop 56%). 3% is at or past the top on two of three lists; 2-2.5% keeps most of the money with
10-ish points less drop.

### Drawdown sizing: cut size 15% under the high, full again within 5% of it (2026-10-31, not better)
The user: "size down after we're 15% down - go back up after you fill to 5% from the last top". Fixed walk; each trade
recomputed at its own size (sim.result, the 10% night cap at that size); account (worst drop, share of days 20%+ under
the high), tune / check:

| List | Flat 2% | 2% -> 2/3 | 2% -> half | Flat 2.5% | Flat 3% | 3% -> 2/3 | 3% -> half |
|---|---|---|---|---|---|---|---|
| Fair | $3,202,806 (26.6%, 6%) 458K / 699K | $1,732,003 (23.5%) 384K / 598K | $1,205,668 (21.4%) 340K / 479K | $4,321,437 (31.2%, 14%) | $5,163,654 (35.9%, 24%) | $2,591,495 (30.6%) 366K / 738K | $1,435,797 (27.4%) 268K / 592K |
| Fav 12m | $243,492 (29.4%) 218K / 112K | $211,504 (24.8%) | $175,851 (22.9%) 160K / 119K | $242,721 (34.7%) | $232,290 (39.8%) | $203,482 (33.5%) | $164,990 (30.6%) |
| Fav 36m (minute) | $4,490,462 (29.9%) 562K / 798K | $3,130,567 (25.3%) | $1,808,930 (22.9%) 353K / 644K | $6,676,916 (35.9%) | $9,147,882 (40.9%) | $5,564,796 (33.8%) | $2,768,127 (29.4%) |

- It cuts the drop (3%: 35.9% -> 27.4% at half size) but costs far more than a smaller flat size with the same drop:
  3% -> half $1.44M / 27.4% vs flat 2% $3.20M / 26.6%; 3% -> 2/3 $2.59M / 30.6% vs flat 2.5% $4.32M / 31.2%. Same on
  both Favorites lists. The bot is under -15% on 26-55% of days, and the giant that ends a drop is caught at the cut
  size. Both halves lower on the fair list. Not better (as on 2026-10-27): to cut the drop, cut the flat size.

**Correction, account sizing of a pyramid add (2026-10-31).** export_champ.rets / export_early / export_fav_long store
an add's returns already as half a trade at half the size (`k * sim.result(cost, steps, size * k)`, k = 0.5); the
dashboard reads them as they are. The research summaries (table.py-style replays, and this log's account figures,
including the "as logged" $7,258,326) multiplied `added` rows by 0.5 again, counting each add at a quarter. Counted
once: fixed champion $3,202,862 / 26.6% (logged $2,845,332), tune $458,193 / check $699,020; old walk $8,338,386 (logged
$7,258,326); staged $3,829,110; stop -60% $4,161,285; + add $9,977,389; Favorites 12m $243,492; 36m champion
$4,490,376, + add $13,199,730. The comparisons above used the same sizing on both sides, so the verdicts stand; the
pyramid's own value was understated. From here on, account replays read add rows as stored.

### What makes an overnight keeper a big winner (2026-10-31, a diagnostic, fair list)
The user: "understand what makes a nightly keeper a big winner ... differentiate it". champ-early, fixed walk, 125
overnight holds (no pyramid adds); per hold, what was known at the 15:50 decision and the night multiple (what the kept
part fetched / its 15:50 value). Script: scratchpad night.py (features: gain at 15:50, stock move from the signal / open /
prior close and in the last hour in S30, close position in the day's range, day volume vs the 20-day usual, SPY day,
relative move, moneyness, days to expiry, weekend, entry minute, IV).
- The night is a giant game: median 0.70x, 56% under 0.8x, 26% at 1.5x or more; carrying earned +14,981 points of cost
  vs selling at 15:50, +7,672 without the best 3 (check half +299). No single measure correlates past 0.21.
- **The last hour run is the clean separator**: when the stock ran more than 1 S30 our way in the last hour (31 holds),
  carrying lost in both halves (tune -687, check -621 points; -2,419 / -2,400 without the best 3), only 23% beat the
  15:50 sale; the other 94 holds carried +16,290 (+10,353 / +5,936). A run into the close looks like exhaustion.
- Day volume 2x usual or more (50 holds): 36% big vs 19%, but the low-volume holds still carry about zero (tune -221,
  check +2,579): dropping them is not a clean win. Gain at 15:50 of +300% or more, calls over puts, an early entry: the
  same shape (better big-rate, not a clean money split). Weekend and days to expiry: no consistent effect.
- The 8 biggest nights (BA 2024-08-01, IBIT 2026-08-19, SMCI 2025-05-13, ORCL 2026-04-13, MSTR 2026-08-19, TSLA
  2024-07-01, AAPL 2025-08-06, IBIT 2026-09-18): 7 of 8 at volume 1.9x+, last hour flat or giving back, 6 entered by
  minute 11.
- Candidate (not yet tested as a rule): sell at 15:50 instead of carrying when the last hour ran > 1 S30 our way.
  Chosen after looking at the fair list: needs a proper sim run and the Favorites.
- Give-back by 15:50 (the user: "if the stock goes up 5% but lost 3 of it?"), in S30 and as a share of the run since
  the signal: the typical hold ran 6.2 S30 and gave back 0.9 (16%). Gave back 35%+ (18 holds): carrying about zero
  (+154; tune -362, check +516); gave back 2+ S30 (28 holds): +6,024, check median night 1.00x. No clean signal; a
  pullback before the close is not a warning, the opposite of the last-hour run (which stays the one clean split: holds
  with no last-hour run and under 35% given back carry +16,043, +8,734 without the best 3). As a same-day exit the
  give-back already failed (2026-10-27: 2.5-3.0 S30 from the best sells the winners in their normal swings).

### The day-end decision at 15:55 / 15:57, and the overnight split measured at 15:57 (2026-10-31, not better)
The user: "what if we look on all of it at 15:57?". `BT_X={"eod_minute": 385 | 387}` (decide the night and sell the
rest then), fixed walk, champ-early, 2% (adds counted once):

| Decision | Fair (drop) | Tune | Check | Fav 12m | Fav 6m |
|---|---|---|---|---|---|
| 15:50 (now) | $3,202,862 (26.6%) | $458,193 | $699,020 | $243,492 | $162,555 |
| 15:55 | $2,800,296 (26.9%) | $416,984 | $671,559 | $220,145 | $143,486 |
| 15:57 | $3,019,500 (27.0%) | $444,426 | $679,415 | $234,010 | $143,806 |

Not better (as on 2026-10-23 on the old walk): 15:57 is -6% on the fair list (both halves -3%), -4% and -12% on the
Favorites. The overnight split redone on the 15:57 run's 123 holds, all measured at 15:57: the last-hour run
(14:57-15:57) > +1 S30 no longer separates (38 holds +2,435, tune +783 / check +1,652, 42% beat the sale) - the
15:50 finding does not survive a 7-minute shift of the window, so it is likely noise. Last 7 minutes falling more
than 0.5 S30 against (19 holds): 21% beat the sale, -2,042 without the best 3, but tune +1,286 with them: no clean
split. Volume 2x+ and gain +300%+ keep the same shape as at 15:50 (more giants, not a clean money split).
The "sell at 15:50 after a last-hour run" candidate is dropped.
- T / V / D2 / D3 at 15:50 (the user: "differentiate the night holding with T V D2 D3"), the same 125 holds: rank
  correlation with the night multiple T -0.08, V +0.13, D2 -0.17, D3 +0.12. No split holds in both halves: the
  strongest T (>= 2.5) carries worst (+833; check -703); low volume (< 1.5x) has 11% big nights but tune -1,360 / check
  +1,472; D2 is inverted (D2 < 0 best, check +8,251, tune -990 without the best 3); D3 >= 1.25 tune +6,655 / check
  +1,676 but -2,930 without the best 3 on check; "2+ of 4 strong" tune +9,359 / check +1,728 (-2,863 without the best
  3). Only V 1.5-2.5x is positive in both halves without the best 3 (+469 / +501), too small to be a rule. The night
  stays unpredictable from the day's strength measures.
- Bot vs Indi: a "Best that day" column (best_day.py in the scratchpad, dataset best_day): the option's highest mid on
  the entry day after the buy, as a raw share over the price paid, and when.

### How high the entries ever got (2026-10-31, a diagnostic)
The user: "cutting winners to make more winners. first: how many entries were ever +10%? 25%? 50%? 100%?". champ-early,
fixed walk, entries only (no pyramid adds); the best = the highest book mid on the entry day after the buy (best_day)
or any 5-minute close while held, over the price paid. Fair list, 1,006 entries, 16% end winners:
ever +10% 76% (79% of them end below zero), +25% 62% (74%), +50% 44% (64%), +100% 28% (53%), +200% 14% (37%), +500% 6%
(12%); never above the price paid 11%. Favorites 12m (509): +10% 74%, +25% 61%, +50% 45% (62% end below zero), +100%
27% (51%), +200% 15%, +500% 6%. A mid is not a bid, and a peak can last one minute.

### Loser exits side by side on all lists; a 30-minute retry; staged 0.75 / 1.25 again (2026-10-31, adds counted once)
Fixed walk, champ-early, 2%. Fair / Favorites 12m / 6m (tune / check on the fair list):
today $3,202,862 (26.6%) 458K / 699K, $243,492, $162,555; + stock stop 1.0 S30 against $3,315,392 (25.4%) 474K / 700K,
$230,949, $170,382; checks off + 1.0 S30 $3,696,709 (27.9%) 481K / 769K, $245,750, $155,140; staged 0.5 / 1.0
$3,829,110 (26.3%) 510K / 750K, $254,741, $167,847; staged + stop -60% $4,161,285 (25.5%) 541K / 770K, $269,142,
$163,088; checks off alone $3,858,372 (31.6%), $238,117, $139,089. Every stock exit wins both fair halves and loses
3-6% of the Favorites 12m check half: a tie off the fair list. Staged 0.75 / 1.25: $3,374,739 (28.0%), $251,619,
$162,135, behind 0.5 / 1.0 everywhere (looser lines hold more nights: 158 vs 145); 1.0 / 1.5 stopped (the user: "not
good").
A second try 30 / 60 minutes after a trade sold on its entry day (retry30.py in the scratchpad; the champion's rule,
pick and exits, real book 93-97%), fair list: same side 30 min 136 retries, 16% won, median -21%, $3,123,542 (29.9%),
tune $533,396 / check $585,596; either side $3,007,331; after a loss $3,139,723; 60 min 108 retries $3,648,500
(29.1%), tune $571,475 / check $638,436. Tune up 16-25%, check down 9-19%, drop +3 points: not better (as on
2026-10-27).

### Stock exits for winners: 25% at the first pullback after +200%, the rest at a full pullback; a failed bounce on winners (2026-10-31, not better)
The user: "for 200%+ sell 25% on the first pullback (test a couple of pullbacks), then exit on the full pullback" and
"if the stock bounces from resistance/support, exit when you confirm it is going down". sim.py `big_stage {arm 2.0,
first, share 0.25, full}` (the stock's best since the option first reached +200%, any day held) and `fb_win {arm,
share}` (failed_break_minute, only when the option is up `arm` then). Fixed walk, champ-early, 2% (fair / tune / check;
Favorites 12m / 6m):
today $3,202,862 (26.6%) 458K / 699K, $243,492, $162,555;
big_stage 0.5 / 1.5 $261,755 (29.9%), $154,448, $99,758 (209 sales; nights 140 -> 75); 0.5 / 2.0 $608,040; 1.0 / 2.0
$672,582; 1.0 / 3.0 $1,040,104 (33.3%), $212,621, $105,830;
fb_win +50% all $2,671,416 (28.5%), +100% all $3,338,706 (26.6%; tune +4%, check the same), +50% half $2,966,568 -
it fired on 3 trades only (the next level ahead touched and failed while already up +50%).
- The pullback exit destroys the giants (-67% to -92%): a +200% trade is mid-move, and the stock's normal swing (and
  the overnight gap, read at the first minute) is a "full pullback"; it halves the nights. Same lesson as 2026-10-27's
  huge-winner stops, much worse at +200%.
- The failed bounce barely fires on winners: the existing detector looks only at the next level ahead of the signal,
  within 30 minutes of touching it; winners mostly break it. A real test needs any level (day high, yesterday's, 5-day)
  reached while in profit, any time of day.

### Indi's gain management from his real fills (2026-10-31, a diagnostic)
The user: "Indi sells by the stock's behaviour, cuts his gains ... how come he's so wrong? research his gain
management". Main account (silexx), option trades only, 2023-01 to 2026-10-08: 1,602 trades, 3,698 sales
(actions.csv); scratchpad indi_gains/ (build.py, analyze.py, extra.py, split.py, rolls.py). P&L and trims from his
fills; "what if held" from 1-minute option bar closes (no bid / ask; 513 of 732 trims priced at 15:50, 360 next morning).
- Money: same-day 1,261 trades +$1.42M (25% won, median loser -21%, -$2.33M without the top 10); held overnight 341
  +$10.95M (37% won, median loser -45%). His top 10 are 103-163% of each year; 16 of his top 20 held overnight. The
  bot's shape, with more small winners (253 at 0 to +50%).
- His contract is the bot's: median delta 0.175, 1 trading day to expiry.
- Winners ended +100%+ overnight (58, +$16.5M): median entry 15:26, carried whole, trimmed on the entry day in 26%.
  Big winners scale out: a third at ~+200%, then ~17% slices at +286 / +324 / +380 / +500%.
- Trims are into strength (stock +3.2 S30 from entry, 0.56 off its best, still beating SPY x beta), not on
  pullbacks; the "stuck" exit is the final sale (1.08 S30 off the best, excess vs SPY gone).
- Counterfactual (estimates): his 732 profit trims took $16.7M; held to his own last exit they would have made $2.19M
  more (+$2.35M for trims at +100%+, -$0.16M below +100%; same-day trades -$0.73M saved, overnight +$2.49M lost).
  The median trimmed contract fell after the trim (0.91x by his exit, 0.66x by next morning): giants decide the sum.
- Verdict: trimming costs him ~8-15% of his biggest trades; it pays only same-day and below +100%. His data agrees
  with the bot's: do not cut the giants. Rules to test from it: no intraday trims on overnight candidates; a same-day
  "stuck" exit only below +100% (1 S30 off the best and 15-min excess vs SPY <= 0); trim into strength at +200%+ (stock
  3+ S30 from entry, within 0.5 S30 of its best); half out when a same-day +25-50% falls back to the entry.

### Indi's gain rules on top of 2.8 (2026-10-31, not better)
The user: "lets build tests for those" (the four rules from his fills). sim.py `guard_win`, `stuck_exit`,
`trim_strength`, `scratch_small`, each over 2.8 (`user_stop {checks [], out -0.6}`, `stock_stages {0.5, 1.0}`), fixed
walk, champ-early, 2% (fair / tune / check; Favorites 12m / 6m):
2.8 $4,161,285 (25.5%) 541K / 770K, $269,142, $163,088;
1 no intraday sale once +100% or entry >= 15:00: $4,107,275 (25.6%) 552K / 744K, $279,221, $167,865 (a tie);
2 stuck exit < +100%, 1.0 S30 off the best and 15-min excess <= 0: $1,629,060 (30.1%), $166,143, $134,523 (276 sales;
  nights 158 -> 93); at 0.75 S30 $930,335 (344 sales, nights 74);
3 trim 25% into strength at +200%: $2,104,851 (24.0%), $232,764, $148,235 (119 trims);
4 a +25% (never +100%) trade back to cost: half $2,865,507 (26.0%) 464K / 617K, $272,688, $177,808; all $1,923,445
  (32.4%), $272,388, $191,706.
- None better. The stuck exit is the worst: the bot's trades stall midday and run later; it sells the future carries
  (nights fall by 40-50%). Indi's overnight giants are late entries (median 15:26) and his same-day trades are a
  different book; the bot enters at 09:40-10:30 and needs the afternoon. Trimming into strength cuts the giants
  (-49%). The scratch helps the Favorites 6m (+9% / +18%) and loses the fair list (-31% / -54%). The guard is a tie.

### 2.8 + hold late winners (2026-10-31, the user's rule; added to 2.8.0)
The user: "do not sell if we bought after 15:00 and positive". sim.py `late_hold {from 330}` over 2.8, fixed walk, 2%:
fair $4,228,594 (25.5%) tune $551,096 / check $767,306 vs 2.8 $4,161,285 (25.5%) $540,512 / $769,879; Favorites 12m
$273,972 vs $269,142 (check the same), 6m $166,015 vs $163,088. 15 of 1,006 fair entries are at 15:00+; 3 trades change
(AAPL 2025-06-30 -16 points, META 2026-05-27 -2, AI 2026-09-02 +9) plus one pyramid add kept: about neutral, +1.6% to
+1.8% on every list, check a tie. In the app's 2.8.0 as `lateHold` (PR #223).

### Two more audit fixes: early entry's SPY look-ahead, and P&L counted on the entry day (2026-10-31)
The user: "the current champion peeks ahead. Its early entry buys partway through a minute using SPY's price at the
end of that minute. It also only tests signals already known to hold at the minute's close" and "lists.py:88-93:
overnight profits are counted too early. A trade's whole multi-day result is added to equity on its entry day, and the
next day's trades are sized on that money". Both confirmed.
- Early entry (sec_timing.early_second): SPY's move to the minute's END was spread over its seconds (no SPY seconds on
  disk), and only confirmed signal minutes were searched. Fix, on by default (`BT_EARLY=old` reproduces): SPY flat
  since its last closed minute. Fired 552 -> 441 of 1,004 fair entries. Searching every minute from 09:40
  (`BT_EARLY_SCAN=1`, off by default) moves 133 buys ~3 minutes earlier for +2,870 points - but only false starts on
  days that later confirmed are visible (no 1-second data for days that never confirm, mostly losers): one-sided, so
  not counted. Remaining, unmeasured: false starts on days with no confirmed signal.
- The account: a trade's P&L now joins on the day of its last sale, and a day's trades are sized on closed trades only
  (lists.py `BT_ACCT=exit` default, `entry` reproduces; score_sum.account when a row has `exit_day`; scratchpad
  acct2.py `honest`). The other 77 scripts using score_sum.account still book on the entry day (their rows have no
  sale date): their figures run ~4-12% high when trades are held overnight.
Fixed early + sale-day account, fixed walk, 2% (adds once):

| Version | Fair (drop) | Tune | Check | Without best 5 | Fav 12m | Fav 6m |
|---|---|---|---|---|---|---|
| 2.7 as logged today | $3,202,862 (26.6%) | $458,193 | $699,020 | | $243,492 | $162,555 |
| 2.7, sale-day account only | $2,862,922 (28.3%) | $474,441 | $644,440 | $566,610 | $233,548 | |
| **2.7, both fixes** | **$2,836,744 (28.7%)** | $478,844 | $632,370 | $561,079 | $234,170 | $159,193 |
| 2.7 without early entry (1-second buy) | $2,074,494 (28.5%) | $413,665 | $533,864 | $447,220 | $184,782 | |
| **2.8, both fixes** | **$3,612,880 (28.0%)** | $559,905 | $687,372 | $716,163 | $256,896 | $159,384 |

The SPY look-ahead was worth 1-3%; the entry-day account 4-12%. Early entry still adds ~37% over the plain 1-second
buy; 2.8 still leads 2.7 (+27% fair, both halves +17% / +9%; Favorites 12m +10%, check -4%; 6m even).
- **Correction, the same evening** (the user: "entry-day booking cost money? the big trade after a big trade is very
  rare"): the closed-only account above understates - the live bot sizes on its account value, open positions marked.
  Marked at each 15:50 carry price (acct3.py; lists.py `BT_ACCT=marked`, now the default): 2.7 fair $3,154,689 (drop
  34.2%; tune $473,389 / check $704,125) vs entry-day $3,176,347; 2.8 $4,080,278 (33.9%; $557,117 / $772,765) vs
  $4,116,321; Favorites 12m 2.7 $233,694 / 2.8 $257,718 (vs $244,097 / $269,546). The entry-day bug is worth 1-4%, not
  4-12%. What changes is the drop: with open positions marked every evening it is ~34% at 2% on the fair list (the old
  replays only saw a trade when it closed). 268 of 1,088 fair trades are entered while an earlier one is held overnight.

### The audit sheet of 2026-10-31 (14 code points) and 2.8 with every fix
An outside audit sheet (14 points); the user's calls: B10 fix (broker stop -60% by default, app PR #225), B5 keep for
now, B9 fix (replay.py: one replay for every headline; `REPLAY_MODE=entry` reproduces the logged $4,161,285 exactly),
B6 fix (store.split_ratio / vol_factor in signals, defence_signals, sec_timing; app signal.ts in PR #225), B3 later
(capacity: at $4M a 2% order, ~1,176 contracts, is more than the contract's 30-minute volume on 57% of trades; under
~$500K it never binds). B1 / B4 fixed earlier the same day; B2 partly (marked at 15:50; not intraday).
- B5 measured: paying the ask on every buy (the live bot's chase) instead of mid + 1/4 spread costs 2.2% a buy on
  average (56% of 2.8's buys already pay the ask) and halves 2.8's fair account at 2% ($4.12M -> $2.06M, entry-day
  replay). Kept as is for now (the user).
- B6: 11 splits in 127 stocks since Oct 2023 (AVGO / NVDA / SMCI 10:1, WMT 3:1, PANW 2:1, IBKR 4:1, NOW 5:1, CRWD 4:1,
  CVNA 5:1, IGV 5:1, SOXX 3:1), no false ones. 2.8's trades inside a split's 20-session window: fair 3 of 1,007, all
  fail the volume rule once fixed (AVGO 2024-07-23 2.97x -> 0.41x, NVDA 2024-06-18 4.63x -> 0.69x, AVGO 2024-07-31
  2.47x -> 1.34x); Favorites 12m 1 (CRWD 2026-07-08). Scored with those removed (the fix can only drop or delay).
2.8 and 2.7 with every fix (fixed walk, early entry without SPY's end-of-minute price, splits, marked booking; replay.py):

| | Fair 2% (drop) | Tune / check | Without best 5 | 1% | Fav 12m 2% | Fav 6m 2% |
|---|---|---|---|---|---|---|
| **2.8** | **$3,996,271 (33.9%)** | $561,752 / $750,610 | $725,082 | $1,050,750 | $260,083 (29.7%) | $159,125 |
| 2.7 | $3,086,767 (34.2%) | $476,859 / $683,952 | $560,882 | $908,061 | $235,030 (28.5%) | $158,479 |

### Size that steps down as the account grows (2026-10-31, the user's idea)
The user: "on 100K keep with 3%, then on 500K go down to 2.5, on 1M 2%, 2M 1.5%, 4M 1% and goes on" (taken on: 8M+
0.5%). The size read from the marked account as each day starts; each trade's return at its own size (sim.result, the
cap). 2.8 with every fix, 2% flat as the yardstick (account, drop, tune / check):

| Ladder | Fair | Fav 12m | Fav 6m |
|---|---|---|---|
| flat 2% | $3,996,228 (33.9%) 562K / 751K | $260,085 (29.7%) | $159,127 (29.7%) |
| flat 3% | $7,162,638 (43.3%) 677K / 1,169K | $259,262 (43.2%) | $140,047 (43.2%) |
| **3% -> 2.5 / 2 / 1.5 / 1 / 0.5% at $0.5M / 1M / 2M / 4M / 8M** | $6,179,802 (40.7%) 695K / 1,209K | = flat 3% | = flat 3% |
| 2.5% -> 0.5% (one step lower) | $3,424,357 (38.6%) 694K / 1,088K | $265,105 (35.6%) | $152,131 (35.6%) |
| 2% -> 0.5% | $3,287,259 (33.9%) | = flat 2% | = flat 2% |

The worst drop comes while the account is small, so a ladder that starts at 3% keeps 3%'s drop there (40-43%); it calms
only the big-account part of the curve (and fits the contracts' volume there, the audit's B3). The Favorites never pass
$500K in 6-12 months, so for them the ladder is plain 3%.
- The ladder + half size in a drawdown (the user: "start it with 3% and add a half size when we are down 20% and back
  when we recover 10%"): fair 3% ladder + half $1,514,111 (33.5%; half size on 28% of trade days) vs flat 2%
  $3,996,228 (33.9%); 2.5% ladder + half $3,145,241 (30.6%). Favorites 12m $206,191 (33.0%) / $188,094 (29.7%) vs
  flat 2% $260,085 (29.7%). It brings the drop to flat 2%'s, for far less money: the account is under -20% on 28-41%
  of trade days and the giant that ends a drop comes at half size (as on 2026-10-27 and 2026-10-31). Not better.
- The same at 75% size (the user: "what about 75% size?"), 3% ladder, cut at -20%: back within 10% of the high / back
  +10% off the low: fair $4,531,878 / $4,852,623 (38.3%) vs the plain 2.5% ladder $3,424,357 (38.6%); Favorites 12m
  $240,567 / $238,904 (36.7%) vs $265,105 (35.6%); 6m $146,055 / $145,530 (36.7%) vs $152,131 (35.6%). At the same drop
  it beats the lower starting size on the fair list (+32-42%) and loses on both Favorites lists (-4% to -10%): mixed.
- Cuts and a boost on the 3% ladder (the user: "0.8 size when down 15%, back to normal at -10%; half size at -30%;
  also on a new high 1.3-1.5x until -5% from the top"): fair cuts $3,045,245 (35.7%), + boost 1.3x $2,942,044
  (35.6%), + boost 1.5x $3,363,925 (35.1%) vs flat 2% $3,996,228 (33.9%); Favorites 12m $188,827 / $183,739 / $186,674
  (34.5-36.3%) vs flat 2% $260,085 (29.7%); 6m $115,331 / $112,485 / $112,908 vs $159,127. Every plan has more drop
  and less money than flat 2% on all three lists; the boost adds nothing (a new high usually comes right after a giant,
  and a dry spell follows). Not better: flat 2% (or the plain 3% ladder for more money at ~41% drop).
- **The owner's pick (2026-10-31): 3% under $300K, 2.5% to $1M, 1.5% to $4M, 1% from $4M** (2.8 with every fix, marked):
  fair $5,020,559 (39.0%), tune $673,622 (41.0%) / check $1,167,393 (24.9%); Favorites 12m $297,769 (40.1%), 6m
  $140,047 (43.2%) - vs flat 3% $7,162,638 (43.3%) / check $1,168,632 (33.1%) / Fav 12m $259,262. App PR #227
  (`sizeSteps`, live and the Backtest account). For comparison, the tune-picked best by growth / drop was 2% -> 1.5% at
  $500K -> 1% from $1M (fair $2.55M / 33.9%, check drop 19.4%, Favorites = flat 2%).

### 2.8 / 2.8.1 without early entry (2026-10-31)
Another session's early_fair.py (Bot vs Indi "Test 2026-10-31: early entry re-tested the way the live bot runs it"):
real SPY and stock trades every 5 s, every stock-day (false starts on days that never confirm included), the forming
minute's volume not counted (as the live bot) -> early entry loses to the minute-close buy on both halves and lists
(check fair $302,557 vs $580,989). It supersedes this session's partial fix above (SPY flat, signal minute only,
forming volume still counted), which still showed early entry ahead. So the honest yardstick is the plain 1-second
buy at the signal minute's close (`champ-1s`). Every fix, marked, split trades removed, 2% / 2.8.1 steps
(account, drop, tune / check):

| | Flat 2% | 2.8.1 steps (3 -> 2.5 -> 1.5 -> 1%) |
|---|---|---|
| 2.7 fair | $2,257,377 (34.6%) 413K / 576K | $3,099,177 (39.9%) 436K / 1,022K |
| **2.8 fair** | **$2,901,992 (34.1%) 484K / 632K** | $3,872,419 (39.3%) 575K / 1,071K |
| 2.7 Fav 12m | $185,663 (29.5%) | $152,030 (40.7%) |
| **2.8 Fav 12m** | **$205,439 (30.1%)** | $179,759 (43.6%) |
| 2.8 Fav 6m | $146,398 (30.1%) | $123,146 (43.6%) |

2.8 still leads 2.7 (fair +29%, both halves; Favorites 12m +11%). Without early entry the 3% start of the steps loses
to flat 2% on both Favorites lists (-12% / -16%, 13 points more drop) while it gains on the fair list (+33%, +5 points).

### 2.8 on the 24 / 36-month Favorites, with the late hold (2026-10-31)
The dashboard's 2.8 on the long Favorites was the step-8 run without the late hold, and the 24 months had none, so
picking 2.8 there fell back to 2.7. New run (export_fav_long.py, minute fills, the 2.8 overlay
`{"user_stop": {"checks": [], "out": -0.6}, "stock_stages": {"half": 0.5, "full": 1.0}, "late_hold": {"from": 330}}`),
now `x-stop60-m` on both lists. Marked account, 2%, ±2% fills (whole / tune / check):

| | 2.7 minute fills | 2.8 minute fills |
|---|---|---|
| Favorites 24m | $1,839,147 (28.6%) / $695,438 / $276,044 | $1,933,758 (29.5%) / $809,401 / $249,477 |
| Favorites 36m | $4,413,964 (29.1%) / $573,066 / $804,252 | $4,667,210 (29.5%) / $686,366 / $710,166 |

2.8 is ahead on the whole period (+5% / +6%) and on tune (+16% / +20%), but behind on check on both (-10% / -12%),
as step 12 found for the stop -60% on the 36 months. The late hold changes 8 of ~2,400 trades.

### 2.8's drops at 2%, a diagnostic (2026-11-01)
The user: "I still see big drops. I still want to dig in to remove them". x-stop60 (2.8, fair list, marked account,
flat 2%, scratchpad drops28.py): six drops of 20%+ (2024-08-22 -> 11-07 -20.7%; 2024-11-11 -> 2025-01-17 -33.9%;
2025-05-14 -> 06-11 -26.6%; 2026-07-02 -> 08-18 -21.3%; 2026-08-31 -> 09-17 -23.9%; 2026-09-21 -> 10-12 -23.5%).
Trades closed inside them: 287, 12% won (20% the rest of the time), +100% trades 4.2% of them (8.0% the rest), the
median loser -33% (-29%). Inside the drops the staged stock exit's losers lose -$599K (at $10K a trade), the thesis
exit -$86K, the 15:50 sale -$62K, the option stop -$16K; overnight holds made +$662K even there. Side, entry time and
pyramid adds have the same shares inside and out. Same verdict as 2.7's at 3%: a drought of giants with the usual
small losers, not a market type a rule can see. What is left to try is the cost of each loser, not the timing:
a smaller starter with the rest added on confirmation.

### Break-even lock on the stock (2026-11-01, a candidate, small)
The user: "when we up 20% calculate the stock down we need to exit that will make us breakeven" (after "I need to
increase the overall win rate"). sim.py `be_lock {arm, update, target}`: on the entry day, once the option bar closes
`arm` over what was paid, the stock price where the option is worth what was paid (x (1 + target)) at its implied
volatility then (Black-Scholes, `be_level`) becomes a stock stop, all out there; `update` works it out again at each
later bar still `arm` up and keeps the tighter one. On 2.8 (f28's overlay + be_lock), champ-1s (the honest 1-second
buy at the signal minute's close), marked account, 2%, tune / check (scratchpad score_be.py, look 1):

| Version | Won | Fair (drop) | Tune / check | Fav 12m | Fav 6m |
|---|---|---|---|---|---|
| 2.8 | 17.2% | $2,956,494 (34.1%) | 479K / 650K | $203,655 | $145,127 |
| arm +30%, set once | 16.8% | $3,141,030 (32.7%) | 493K / 670K | $200,234 | $148,033 |
| arm +50%, set once | 16.3% | $2,985,761 (33.1%) | 474K / 664K | $203,031 | $149,397 |
| **arm +50%, updated** | **18.6%** | **$3,129,481 (32.2%)** | 475K / 692K | $212,181 | $149,658 |
| arm +100%, updated | 18.3% | $3,129,450 (34.2%) | 504K / 654K | $195,824 | $138,189 |
| arm +20% / +30%, updated | 20.5% / 19.9% | $807,303 / $1,574,971 | 488K / 167K; 454K / 350K | $153K / $148K | $136K / $119K |
| arm +50%, updated, +10% / +20% cushion | 20.7% / 24.1% | $1,192,573 / $601,475 | 367K / 342K; 362K / 175K | $216K / $193K | $157K / $143K |
| arm +30%, updated, +10% | 24.5% | $416,699 (39.6%) | 321K / 130K | $175,197 | $136,227 |
| arm +100%, updated, +20% | 19.2% | $3,040,669 (33.7%) | 488K / 655K | $201,658 | $143,553 |

Set once, the lock sells at a median -24% (theta and the spread by the time the stock is back), so wins fall. Updated
at +50%: lock sales median -7% (37% won), every list up (+6% / +4% / +3%), check up on all three, tune a tie (-1%),
drop ~2 points less, without the best 5 $617K vs $582K. Every rule that lifts wins past ~20% (an earlier arm or a
cushion) cuts the giants (+100% trades 78 -> 47-63) and loses half or more on the fair list. Win rate and money pull
against each other here: the giants first dip near the cost. Candidate: arm +50%, updated (a small gain).
- **Confirmed (the user: "yes go"):** be_lock {arm 0.5, update} on the 24 / 36-month Favorites (export_fav_long.py,
  minute fills, fl_be50u vs fl_s60l = 2.8, scratchpad score_be_long.py), 2%, whole / tune / check / without the best 5:
  ±2% walk: 24m $1,933,757 (29.5%) -> $2,139,585 (26.3%), tune 809K -> 825K, check 249K -> 270K, w/o best 5 471K -> 521K;
  36m $4,667,208 (29.5%) -> $5,456,653 (26.3%), tune 686K -> 721K, check 710K -> 789K, w/o best 5 961K -> 1,124K.
  Real bid / ask: 24m $675,124 (35.7%) -> $754,198 (33.0%), check 134K -> 149K; 36m $1,164,321 (39.7%) -> $1,333,559
  (36.1%), tune 395K -> 400K, check 307K -> 348K. Win rate +0.1 to +1 point there. The fair list and 12 / 6 months are
  1-second runs already priced on the real book (the FILLS=real scoring is identical). Every list ahead on the whole
  period and on check; tune ahead on the long Favorites, a tie (-0.3% to -1%) on the fair list and 12 / 6 months; the
  worst drop 2-4 points less everywhere. **The 2.9 candidate: 2.8 + the break-even lock from +50%, updated.**
- **Is the lock's exit price real, and is it just a break-even stop? (the user: "hard to calculate the price we exit
  on, no?", "why it is different from stop at break even?")** The level only times the sale; the price is the market's:
  all 169 fair-list BE_lock sales are at the real Databento bid when the stock hit the level (every one within 1% of
  it, 0 without a quote; the bid a minute later the same, median), e.g. FSLR 2025-01-02 paid 0.68, sold 0.57; MSTR
  2025-02-24 paid 2.78, sold 1.49. The plain option stop at what was paid, armed at +30 / +50 / +100% (`be_lock {on:
  "option"}`, the option bar's close): fair $1,866,174 / $1,908,991 / $3,064,210 (check 417K / 416K / 632K vs 2.8's
  650K), Fav 12m $220,172 / $224,700 / $207,654, Fav 6m $173,111 / $163,983 / $152,392; won 17.1% / 16.9% / 17.5%
  (2.8 17.2%); its sales median -10% to -11%, 20-22% won (the stock lock's -7%, 37%). The option stop fires on the
  spread and theta with the stock still on our side, so it cuts the fair list's giants (-35% at +50%) though it helps
  the 12 / 6-month Favorites more than the stock lock; it does not raise the win rate. The stock lock stays the candidate.
- **Found while drawing the examples (https://claude.ai/artifact/9viXhT7mg5FhGbNQRZLecV):** in the 1-second runs
  (champ-1s / x-*), sim.walk decides every exit on the minute-model buy price (`basis`, the bar's middle + 2%), and the
  real 1-second fill replaces the prices afterwards: NVDA 2026-02-09 basis $0.78 vs the real $0.68, SMCI 2024-02-05
  $5.71 vs $4.88. So the lock level (and every option-percent rule: the -60% stop, the +50% overnight hold) is set off
  a price the live bot would not have paid. The sale prices are real; the timing is a little off. To fix before 2.9:
  walk with the real fill as basis and re-run 2.8 and the lock.

### 2.9 release audit, research half (2026-11-01)
2.9 = 2.8.1 (the size ladder) + be_lock {arm 0.5, update}. bot-release §1-§4 on today's code.

**Fix first (§1): the walk now decides exits on the real fill.** `sim.walk(..., paid=None)` (sim.py:363, 377, 407): with
`paid`, the walk's cost / basis is the real buy, so every option-percent rule (-60% stop, the +50% overnight hold,
be_lock's level) reads gains off what was paid. export_early.py `rewalk()` (:29-55, :76) walks each variant again with its
own 1-second fill; export_fav_long.py (:53-57) walks the real-book column again with its real buy. `BT_BASIS=model` = the
old way (reproduces f28 within 0.03%: $2,955,813 vs $2,956,480). The +-2/5/10% columns were already consistent. Effect on
2.8: fair $2,956,480 -> $3,138,672 (+6%); fav12 $203,655 -> $199,012; fav6 $145,126 -> $142,462; fav36 real
$1,164,321 -> $1,096,100, fav24 real $675,124 -> $638,635. 14 more fair-list trades (pyramid adds: "up" read off the
cheaper real fill).

**Fresh runs (scratchpad indiaudit/r28, r29, r29a40, r29a60, r28m, fl28r, fl29r, fl_be40u, fl_be60u; score_rel.py),
marked account, real quotes, champ-1s (no early entry):**

| List | 2.8 at 2% | 2.9 at 2% | 2.8.1 ladder | 2.9 ladder |
|---|---|---|---|---|
| Fair | $3,138,672 (34.4%) 497K / 666K | $3,455,683 (32.2%) 523K / 695K | $4,148,061 (39.6%) 586K / 1,102K | $4,399,581 (37.2%) 623K / 1,318K |
| Fav 12m | $199,012 (30.8%) 231K / 90K | $201,958 (30.4%) 232K / 91K | $169,411 (42.2%) | $174,234 (41.7%) |
| Fav 6m | $142,462 (30.8%) 156K / 96K | $143,988 (30.4%) 154K / 98K | $118,245 (42.2%) | $120,810 (41.7%) |
| Fav 24m real | $638,635 (35.2%) 518K / 129K | $766,590 (32.4%) 555K / 144K | $844,327 (46.7%) | $1,152,050 (43.3%) |
| Fav 36m real | $1,096,100 (39.3%) 389K / 294K | $1,270,570 (36.1%) 413K / 321K | $1,408,632 (52.6%) | $1,503,186 (48.7%) |

(tune / check after the drop.) Without the best 5 (2%): fair 638K -> 704K, fav12 54.1K -> 54.8K, fav6 44.7K -> 44.9K, fav24
146K -> 176K, fav36 241K -> 280K. Every half up except fav6 tune (-1.4%); worst drop 0.4-3 points lower everywhere.
By year (fair, 2%): 2024 x3.68 -> x3.51, 2025 x2.86 -> x3.38, 2026 x2.98 -> x2.91 (every year positive both).
Neighbours: arm 0.4 worse on every list (fair $2,825,402, fav36 real $989,833); arm 0.6 fair $3,289,630 (below 0.5),
fav36 real $1,411,681 (above), fav12 / 6 about equal: 0.5-0.6 is a plateau, 0.4 a cliff.

**§2 where the gain comes from (trades changed vs 2.8, at $10K, 2%):** fair 165 (111 helped / 54 hurt), median +1,105,
sum +33K, without the best 10 -41K, without the worst 10 +201K; fav12 77, median +820, sum -1K, w/o best 10 -51K; fav6 45,
median +1,015, sum -3K, w/o best 10 -50K; fav24 real 143, median +1,224, sum +76K, w/o best 10 +6K; fav36 real 192, median
+1,208, sum +56K, w/o best 10 -19K. The median changed trade is up on every list and 2 of 3 are helped, but the sum rests
on the ~10 best saves against a few giants cut (on the strict bot-release rule, FAIL). Looks: this idea's 3rd (look 1 the
pick, 2 the long Favorites, 3 this fixed-basis re-run); variants tried on 2026-11-01: be20 / be30 / be50 (set once),
be20u / be30u / be50u, be50t10 / be50t20 / be30t10, be100u / be100t20, beo30 / beo50 / beo100, arm 0.4 / 0.6 = 16.
The 151 unseen stocks: NOT RUN (no export path). Mechanism: a trade whose stock has given back the whole move that made
the option +50% is sold near what was paid instead of riding to the staged exit's -1 S30; the giants that first dip to
break-even are the cost.

**§4 risk (fair, 2% / ladder):** worst drop 34.4% -> 32.2% / 39.6% -> 37.2%; longest under water 78 -> 76 days; worst day
2024-11-12 -11.6% -> -11.1% (ladder -12.3% -> -11.7%); worst 5 days -16.2% -> -15.9% (ladder -18.0% -> -16.6%). Fav36 real
ladder: drop 52.6% -> 48.7%, under water 138 -> 117 days. Fav6: under water 27 -> 45 days (both sizes).
**§1 sanity, 8 traced 2.9 trades (r29, seed 29):** every sale at the real bid (MSFT 08-01 T_half 0.56 = bid, BA 09-04
BE_lock 0.51 = bid 0.51 / 0.57, +2%); buys at the 1-second book (MSFT 0.83 vs the minute-end 0.79 / 0.81 after the
60-second chase; TSLA 2.10 vs 2.12 / 2.14 at the minute's end, the second's book); the best 3 (IBIT 2026-08-19 +2764%,
BA 2024-08-01 +2661%, ORCL 2026-04-13 +2322%) are overnight holds the lock never touches.
**For §6 (live parity):** the research arms on the option bar's close (last print) and takes the IV from it, and fires
on the stock's minute close; live reads the option's quote mid and the stock's last trade - name both in the rule map.

### 2.9 released (2026-11-01): 2.8.1 + the break-even lock at +50%
The owner: "add it now in all the places needed as 2.9, do not forget to use 2.8.1 (ladder)", then, after the audit,
"Keep on with the 50%. I know it can be luck ... for now it is more important to reduce the drop and increase the win
rate." App PR #231 (includes #227). Release gate (bot-release skill):
- §1 backtest: the basis fix (exits decided on the real fill, `BT_BASIS=real` default, commit 1ff86a7); the old result
  reproduces with `BT_BASIS=model`; 8 hand-traced trades sell at the real bid. PASS.
- §2 overfit: every list ahead on the whole and on check, ahead without the best 5, every year positive; the strict
  changed-trades check FAILS (165 fair-list trades changed, median +$1,105, sum +$33K, without the best 10 -$41K; negative
  without the best 10 on 4 of 5 lists); 3 looks, 18 variants. Neighbours (2%, fair / Fav 12m / Fav 36m real):
  +40% $2,825,402 / $180,656 / $989,833 (a cliff: worse than 2.8 on every list); **+50% $3,455,683 (32.2%) /
  $201,958 (30.4%) / $1,270,570 (36.1%)**; +60% $3,289,630 (34.0%) / $200,855 / $1,411,681 (35.7%); +80% $3,462,994
  (33.7%) / $194,248 / $1,234,668 (38.6%); +100% $3,368,447 (34.3%) / $201,853 / $1,165,490 (37.9%). 2.8: $3,138,672
  (34.4%) / $199,012 (30.8%) / $1,096,100 (39.3%). +50% has the smallest drop and the most winners on every list.
- §4 risk: worst drop 2-4 points less, worst day and worst 5 days a little better, the 36 months 117 days under water
  vs 138 (the 6 months 45 vs 27).
- §5 live code: a fresh reviewer; fixed from it: the ladder never raises the owner's size, an unknown account takes the
  smallest step, own labels keep new rules off, the lock decides on the stock's minute close, the research's IV
  solver. `npm run check`: 780 pass.
- §6 parity: scripts/bot-lock-parity.ts on the research walk's own minute inputs (lock_inputs.py): 170 / 170 lock sales
  at the same minute. Not run: the E2E day replay. Drifts named: live arms on the option's mid and the walk on the
  book's mid each stock minute (the same), live checks every minute and the walk every stock minute; live still runs
  early entry, the research yardstick does not.
- §9: the Bot vs Indi page opens on 2.9 with the ladder at 3% ($4,399,581 / 37.2% on the fair list); 2.8 (`x-stop60`)
  and 2.8 (minute fills) re-exported on the same basis; x-staged / x-add60 removed.

### No entry into a big spike, on 2.9 (2026-11-01, not better)
The user: "can you look on enter filter? I know we didn't touch it for a while so check it carefully - I want to not
enter into the big spike. I rather pass the trade or wait for some pull back." Re-run of runup.py (2026-10-29, lost by
far on that day's champion) because the exits changed since (2.8's staged exit sells half 0.5 S30 against the signal
price), the walk was fixed and exits are now decided on the real fill. spike_entry.py: the champion's entries and
picks, 2.9's exits (f28 overlay + be_lock), the pyramid, real quotes (opt_spread bid), walked again on the real price
paid; run = the 10-minute move before the signal, spike = the 3-minute move, both in S30, bet's way. 7 variants set
before running, look 1. At 2% (fair / Favorites 24m):

| Version | Tune | Check |
|---|---|---|
| 2.9 | $376,230 (29%) / $555,017 (18%) | $478,021 (25%) / $143,834 (25%) |
| skip20 (run >= 2.0) | $82,187 / $107,538 | $278,905 / $144,245 |
| skip25 (run >= 2.5) | $252,310 / $491,004 | $465,866 / $147,713 |
| sk3-10 (3-min spike >= 1.0) | $272,296 (36%) / $428,988 | $540,660 (18%) / $143,057 (20%) |
| pb15 / pb20 (wait 15 min for a 0.25 pullback, run >= 1.5 / 2.0) | $118,012 / $113,248; $139,912 / $139,048 | $271,137 / $105,196; $460,320 / $141,309 |
| pb20d (run >= 2.0, 30 min, 0.5 pullback) | $181,667 / $187,067 | $428,810 / $138,980 |
| 🎯 sp3-pb (3-min spike >= 1.0, wait 15 min for 0.25) | $266,748 (32%) / $401,722 (19%) | $544,751 (24%) / $148,438 (27%) |

Verdict: not better. Every variant loses on tune (the pick 0.82 of 2.9 at 1%); the pick and sk3-10 are better on the
fair check (+14% / +13%, sk3-10's drop 18% vs 25%) but tune and check disagree. The trades after a big run are where the
giants are: the run 2.0-2.5 bucket holds 5 / 8 tune giants (+$723K / +$981K), the 2.5+ bucket 6 / 5; by run size the
median trade is -$1.5K to -$3.1K in every bucket on both halves, so the run does not sort the trades. Waiting for a
pullback buys the giants later and higher (pb20 keeps 12 of the 17 tune fair giants), skipping drops them. The 3-minute
spike's trades are the one weak group (check: 118 trades, -$44K, 2 giants) but on tune they hold 3 giants (+$248K).
The live reviews' "bought at the top of the run" losers are real, but they cannot be told from the giants at entry.

### Wait for the dip, buy when it turns back up, on 2.9 (2026-11-01, not better)
The user, after spike_entry.py: "we do not want to buy in the pull back - we need to wait for it to come back up"; the
examples page https://claude.ai/artifact/KDSrCkQKpiDQT7YpHK9xnY (ORCL 2025-10-20 put: 2.9 +31%, the turn +94%; AVGO
2025-11-24 call: 2.9 +343%, the turn -36%, a second dip met the staged exit at the higher reference), then "yes".
resume_entry.py, spike_entry.py's setup (2.9's exits, real quotes, the real price paid): trigger, a 0.25 S30 pullback
within 15 minutes, then the turn (back up 0.25 / 0.5 S30 off the dip's low, or back to the move's extreme) within 30
minutes -> buy then; no pullback: no trade (or "-k": 2.9's own trade). 6 variants set before running, look 1. 2%:

| Version | Tune fair / Favorites | Check fair / Favorites |
|---|---|---|
| 2.9 | $376,230 (29%) / $555,017 (18%) | $478,021 (25%) / $143,834 (25%) |
| rs3 / rs3-k (3-min spike >= 1.0, turn 0.25) | $241,240 (43%) / $353,388 | $538,346 (26%) / $138,555 |
| rs3-50 (turn 0.5) | $243,497 / $360,398 | $582,394 (26%) / $146,605 |
| 🎯 rs3-hi (back to the spike's high) | $261,144 (41%) / $401,490 (26%) | $494,088 (23%) / $141,097 (23%) |
| rr20 / rr20-k (10-min run >= 2.0) | $118,422 / $114,836; $134,994 / $131,801 | $400,315 / $147,966; $399,644 / $147,718 |

Verdict: not better. Every version loses on tune by 28-70% (the pick 0.79 of 2.9); on check the 3-minute versions
are up on the fair list (+3% to +22%) and about flat on the Favorites: tune and check disagree, as in spike_entry.py.
The tune spike trades hold 3 giants (17 -> 14 kept on the fair list); a later, higher entry resets the staged exit's
reference so a second dip sells it (AVGO). Win rate unchanged (16-20%).

### Entry timing rules from the research report, on 2.9 (2026-11-01, not better; corrected run)
The user: "go ahead and do a deep research for technical analysis for how to enter a trending swing and try it out".
Report: app repo reports/Trend entry timing rules.md (pros buy the break, not the pullback; news / relative volume decide
continuation; no measured intraday exhaustion rule). trend_entry.py, spike_entry.py's setup (2.9's exits, real quotes,
the real price paid); 5 versions set before running. **The first run had a bug** (a 24-bar minimum skipped every rule
for the signals in the first ~24 minutes, most of them; it showed rv20 at $525,438 / $750,227 on tune): the corrected
run (look 2 of the same versions) at 2%, end / drop and the average trade at $10K:

| Version | Tune fair / Favorites | Check fair / Favorites |
|---|---|---|
| 2.9 | $376,230 (29%) +1,703 / $555,017 (18%) +2,090 | $478,021 (25%) +1,817 / $143,834 (25%) +556 |
| conf3 (buy-stop over the last 3 bars' high, 3 minutes) | $261,742 (34%) / $431,607 (21%) | $418,469 (36%) / $134,069 (34%) |
| rv20 (volume since the open >= 2.0x; ~30% of the trades) | $308,627 (11%) +4,561 / $273,857 (13%) +3,930 | $278,270 (21%) +4,064 / $152,208 (22%) +1,721 |
| rv30 (>= 3.0x; 25-34 trades) | $92,107 / $89,397 | $283,325 (9%) / $154,360 (7%) |
| 🎯 climax (defer a climax bar to a new high of day; 8-13 trades change) | $373,151 (28%) / $543,363 (18%) | $345,020 (41%) / $102,708 (42%) |
| extveto (control: >= 2.5 S30 past VWAP or RSI14 >= 85) | $199,824 (39%) / $258,376 (18%) | $476,825 (20%) / $121,058 (22%) |

Verdict: not better; every version loses on tune. The finding is rv20's average trade: about double 2.9's on all four
cells (+4,561 vs +1,703, +3,930 vs +2,090, +4,064 vs +1,817, +1,721 vs +556), with the drop far smaller (11-22% vs
18-29%), because it trades a third as often. The trades it drops (volume 1.5-2.0x, ~70%) still add up positive
(+$239K / +$566K tune, +$339K / +$22K check, with 7-10 giants) though they lose $490-545K a half without their giants.
Next: size by the volume ratio (the 1.5-2.0x trades smaller) instead of skipping them.

### Size by the volume at the signal, on 2.9 (2026-11-01, TUNE ONLY; the check is held back at the user's word)
The user: "yes" to half size under 2x, then "use it only on the tune. we will check the check after" (an exception to
the tune-and-check-together rule, for this test). size_volume.py: 2.9's trades (spike_entry.py's setup) with a size
multiplier from c_rvol (the add rides on its main leg's); the account without score_sum's -1 cap (a 1.5x row can lose
1.5 units). 6 versions set before running. Tune at 2% (fair / Favorites 24m):

| Version | Tune fair | Tune Favorites |
|---|---|---|
| 2.9 | $376,230 (29%) | $555,017 (18%) |
| 🎯 h20-up (0.5x under 2.0x, 1.5x at 2.0x+) | $535,264 (22%) | $589,534 (17%) |
| h175 (0.5x under 1.75x) | $390,650 (20%) | $436,539 (14%) |
| h20 (0.5x under 2.0x) | $358,139 (19%) | $414,405 (13%) |
| h25 (0.5x under 2.5x) | $225,985 (16%) | $257,646 (11%) |
| flat75 (all at 0.75x, the yardstick) | $292,814 (22%) | $394,217 (14%) |
| flat60 (all at 0.6x) | $246,355 (18%) | $313,422 (11%) |

On tune h20-up beats 2.9 on both lists with a smaller drop (pick 1.027 at 1%); h20 and h175 beat the flat smaller size
at about the same drop (h20 +45% / +32% over flat60), the first sizing rule to do so. The check weeks are computed
(data/local/x/bt/size_volume_summary.json) and not read yet.
- **The check, read after the pick (the user: "lets go with h20"), look 1, 2%:** h20 fair $379,870 (19%) vs 2.9 $478,021
  (25%) and flat75 $347,122 (20%); Favorites $151,303 (19%) vs $143,834 (25%) and $136,620 (20%). Without the best 5:
  fair $124,944 vs $140,330 / $134,103, Favorites $64,989 vs $54,053 / $64,304. h20 beats the smaller flat size with the
  same drop on both lists and both halves (tune +45% / +32% over flat60, check +9% / +11% over flat75), and cuts the
  worst drop 6 points on check; full-size 2.9 makes more on the fair list. **Chosen by the user as the next version:
  half size when the volume since the open is under 2.0x its usual at the signal.**
- **The boost on the >= 2x trades (the user: "volume = 1.5 premia? or 2X?"), second run of size_volume.py, tune and check
  shown together, 2% (fair / Favorites):** h20-up (0.5 / 1.5) tune $535,264 (22%) / $589,534 (17%), check $548,272 (26%)
  / $172,788 (25%); h20-up2 (0.5 / 2.0) tune $743,119 (26%) / $783,516 (20%), check $739,101 (34%) / $189,916 (32%),
  without the best 5 check $105,627 / $42,272 (2.9 $140,330 / $54,053); up15 (1.0 / 1.5) check $689,515 (30%) / $163,702
  (30%); up2 (1.0 / 2.0) check $928,850 (34%) / $179,357 (34%). 2.9: tune $376,230 (29%) / $555,017 (18%), check
  $478,021 (25%) / $143,834 (25%). At 3% (the live size) check: h20-up $755,416 (38%) / $171,861 (36%) vs 2.9 $652,748
  (36%) / $139,523 (36%); h20-up2 $999,485 (48%) / $177,905 (45%). The 1.5x boost with the half size keeps 2.9's drop
  and adds money on both halves and both lists; the 2x boost adds money with 7-9 points more drop and less without the
  best 5 (it leans on the giants).
- **The user's tiers (third and fourth runs, tune and check together, looks 3-4 on this idea), 2% (fair / Favorites):**
  33 / 85 / 150 / 200% ("33% on small vol 85% on regular vol, 150% on big one 200% on huge"): lines A (1.75 / 2.5 / 4.0x)
  tune $340,389 (17%) / $327,077 (14%), check $595,729 (20%) / $205,623 (20%); lines B (1.6 / 2.0 / 3.0x) tune $461,182
  (22%) / $564,804 (17%), check $722,124 (28%) / $187,573 (31%). 50 / 100 / 150% ("try 0.5, 1, 1.5"): t3A (1.75 / 2.5x)
  tune $400,279 (21%) / $419,539 (15%), check $591,521 (23%) / $194,421 (23%), without the best 5 check $127,386 /
  $64,349; t3B (1.6 / 2.0x) tune $494,564 (26%) / $660,815 (18%), check $552,952 (26%) / $159,184 (29%). Against 2.9
  ($376,230 / $555,017; $478,021 / $143,834, drops 29 / 18 / 25 / 25%) and h20-up ($535,264 / $589,534; $548,272 /
  $172,788). t3A: check +24% / +35% with 2 points less drop, tune fair +6% with 8 points less, tune Favorites -24%.

### 2.10 released (2026-11-01): 2.9 + the size by the volume at the signal (t3A), the add within 5%
The owner: "lets go with t3A, release new version (run the review script first)", then from the review: raise the
service's cap per buy to 5% (the 150% tier at 3% is 4.5%), "Do add, but up to 5%" (the pyramid add after a 150% leg
keeps the position within 5% of the account: 0.5% at 3%), a refused 150% buy buys the whole size, and early entry's
volume ratio is measured through the minute before (it read low against the backtest). App PR #233. Release twin
t3A-c5 in size_volume.py (the cap binds only above 2%; at 2% it is t3A). At 3%, tune / check (fair, Favorites):
2.10 $475,052 (28%) / $537,583 (28%); $654,068 (32%) / $194,770 (31%); 2.9 $404,162 (40%) / $716,915 (27%); $652,748
(36%) / $139,523 (36%). Without the add after 150% (t3A-na): check fair $450,646 at 2% vs t3A $591,521 (the adds on
the biggest-volume D2 trades). Gate: volume parity (bot-parity.ts, H1 2025): 3,519 / 3,534 the same tier, the rest
rounding at a line; looks 4-5 on this idea, ~14 sizing variants: the check is weak evidence; paper trading decides.

### A grace period after the buy, on 2.9 (2026-11-01, not better)
The user: "today we are selling even if 1 minute after the buy we meet the rules. I suggest to give it a 5/10 minutes
of grace (we do have the 60% stop anyway)". Tested 2026-10-24 on 2.4 (early_exits.py, the -30% stop and the failed
break: not better); re-run because today's early exits are the staged stock exit, the t-stat exit and the lock. sim.py
`grace N`: no staged exit / t-stat exit / lock in the first N minutes, the -60% stop stays. 2.9's overlay + grace 5 /
10 / 15 (set before running, look 1); export_early.py (fair, Fav 12m / 6m) and export_fav_long.py (24 / 36m), real
fill basis. 2%, whole / tune / check:
- Fair: 2.9 $3,455,683 (32.2%) 523K / 695K; g5 $3,305,977 (32.9%) 510K / 681K; g10 $3,205,037 (34.8%) 477K / 706K;
  g15 $2,973,835 (34.7%) 458K / 683K. Won 17.9% -> 18.2 / 18.9 / 19.9%.
- Fav 12m: 2.9 $201,958 (30.4%); g5 $198,731; g10 $205,405 (31.6%); g15 $206,486. Fav 6m: $143,988; $139,220; $134,154;
  $133,102. Fav 36m real: $1,270,570 (36.1%); $1,187,040; $1,237,002 (38.2%); $1,060,161 (39.2%). Fav 24m real:
  $766,590 (32.4%); $737,398; $795,377 (35.5%); $725,413.
- The changed trades: median -$180 / -$300 / -$360 at $10K, hurt about 2:1 over helped on every list; without their
  best 10 -$40K to -$250K.
Verdict: not better. The grace lifts the win rate 1-2 points (some early-sold trades recover) but the typical delayed
exit loses more, the drop grows 1-3 points, and tune is lower on every list (check up only on g10 fair +2% and the
24-month Favorites). The early staged exits are right more often than wrong, as on 2026-10-24.
- **2 minutes** (the user: "try 2 minutes", look 2; g2 / flg2, same overlay). 2%, whole / tune / check: Fair $3,340,980
  (32.3%) 568K / 618K vs 2.9 $3,455,683 523K / 695K (check -11%; ladder at 3% check $1.05M vs $1.32M). Fav 12m $207,634
  vs $201,958; Fav 6m $152,338 vs $143,988; Fav 24m real $908,650 vs $766,590 (check 157K vs 144K); Fav 36m minute
  $6.57M vs $5.46M but check 650K vs 789K. Fav 36m real $1,935,193 (32.7%) vs $1,270,570 (36.1%), check 396K vs 321K, but check w/o best 5 217K vs 239K. Won 17.9% -> 15.3% on the fair list (13-16% on the Favorites): the 2 minutes
  turn early small sales into -60% stops. Changed trades: median +$87 fair, -$22 to -$54 on the long Favorites; without
  their best 10 negative on every list (-$7K to -$114K). Not adopted: the Favorites gain but rest on ~10 trades, the fair check is lower and the
  win rate falls 2-3 points.

### The Main bot on the Volume bot's stock list (2026-11-01, analysis)
The user: "can you try the volume list on the main bot?". The Volume bot's 54 stocks (top 50 + SLV TQQQ SOXL SMH) vs
the 60 Favorites, the same script for both (lists.py run, 2.9 exits + the D2 entry, minute fills +-2%, no pyramid
add; most of the 54 have no Databento books), 2024-10-23 - 2026-10-30. 2% / 3%:
- Volume list: 1,125 trades, won 18.8%, +$1,544 a trade at $10K; $1,500,364 (27.0%) / $4,529,340 (36.7%); without the
  best 5 $295,857. Tune $410K, check $377K. 2024 (Nov-Dec) -, 2025 $437K, 2026 $371K (each year from $100K).
- Favorites: 1,011 trades, won 18.9%, +$1,737; $1,766,394 (28.6%) / $6,624,515 (39.6%); without the best 5 $411,044.
  Tune $696K, check $258K. 2025 $751K, 2026 $251K.
- 44 of the 54 are Favorites too. The 10 Volume-only stocks (GOOG NFLX QQQ RGTI SLV SMH SMR SOXL SPCE TQQQ): 165
  trades, +$1,102 a trade (NFLX +$279K, QQQ +$64K, GOOG -$100K, the leveraged ETFs negative). The Favorites-only
  stocks: 71 trades, +$2,319 a trade.
Verdict: about the same bot (most stocks shared); the Volume list is a little behind over the whole period and
without the best 5, ahead on check and in 2026. No reason to switch the Main bot's list.

