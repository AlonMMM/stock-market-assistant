# The Volume bot (volume burst) research

The research log for the Volume bot (code name "strangle", apps/trader/src/strangle.ts): the volume burst alert, the
side, the one leg, the exits. Newest first. The Main bot (Indi) has its own log in `best-algorithms.md`.

Scripts in `scripts/research/indi_bt/` (run from the app repo root with `node --env-file=.env <dir>/run.mjs <script>`):
`leg_*.py`, `strangle_*.py`, `strength_at.py`. Real quotes from Databento: `dbx_fetch.py` (cbbo-1m, `dbx_cache/`),
`leg_seconds.py` (stock ohlcv-1s and option cbbo-1s / cmbp-1, `sec_cache/`), `strangle_real.py` (`strangle_cache/`).

## Log

### Exit when the stock goes flat after the buy (2026-11-03, look 1)

The user, on the task-11 lead (AVGO 2026-10-30 put, bled 53 min to -68%): "go with the stock - if it start to be flat we
can exit." Judge the fade by the stock, not by volume or the option bid.

Built on **Volume 1.2.0** + the broker's -80% stop: the app engine's `v12_*` parts (51 stocks, 2025-11-03 .. 2026-10-30,
real minute books, saved settings, live limits), re-walked by `exitlab.py` (reproduces all 155 engine trades to the cent).
Levels set before the run (`run_flat.py` docstring): flat = at the close of buy minute + W, the stock's move from the
side price the trade's way is < X S30 -> sell at that minute's bid. W 3 / 5 / 10, X 0.25 / 0.5; shock trades only (the
thesis) and all trades (neighbour); with and without "only if the bid is also <= the price paid": 24 versions, one pick
per scope on tune. Reference: B5 (post-hoc, group C run: shock, volume < 3x usual for 5 min, sell at +5 min if bid <= paid).

Tune (even ISO entry weeks), 2% (3%):

| Version | Trades | Won | Median | 2% (drop) | 3% (drop) | W/o best 5 | Non-giant (flat $2K) | Giants | 2025 / 2026 |
|---|---|---|---|---|---|---|---|---|---|
| 1.2.0 + -80% stop | 71 | 23 | -31% | $114.6K (10%) | $122.6K (14%) | -$25.1K | -$18.2K | 4 | -$2.7K / +$17.3K |
| shock W3 X0.25 (= X0.5) | 72 | 20 | -29% | $105.9K (15%) | $106.9K (23%) | -$26.5K | -$17.5K | 3 | -$2.6K / +$8.5K |
| shock W5 X0.25 | 72 | 19 | -30% | $103.3K (17%) | $104.2K (26%) | -$28.5K | -$19.7K | 3 | -$2.7K / +$6.0K |
| shock W5 X0.5 | 72 | 21 | -29% | $105.8K (15%) | $107.4K (23%) | -$26.6K | -$17.6K | 3 | -$2.7K / +$8.5K |
| shock W10 X0.25 | 71 | 21 | -31% | $105.8K (16%) | $106.5K (24%) | -$26.6K | -$17.6K | 3 | -$2.8K / +$8.6K |
| shock W10 X0.5 | 72 | 21 | -29% | $105.1K (16%) | $105.4K (24%) | -$27.3K | -$18.4K | 3 | -$2.8K / +$7.9K |
| shock W3 +bid (X 0.25 = 0.5) | 72 | 18 | -30% | $103.5K (16%) | $104.0K (24%) | -$28.3K | -$19.5K | 3 | -$2.6K / +$6.1K |
| shock W5 X0.25 +bid | 72 | 19 | -30% | $103.3K (17%) | $104.2K (26%) | -$28.5K | -$19.7K | 3 | -$2.7K / +$6.0K |
| shock W5 X0.5 +bid | 72 | 19 | -30% | $103.6K (17%) | $104.5K (25%) | -$28.2K | -$19.4K | 3 | -$2.7K / +$6.3K |
| shock W10 X0.25 +bid 🎯 | 71 | 21 | -31% | $105.9K (16%) | $106.5K (24%) | -$26.5K | -$17.5K | 3 | -$2.8K / +$8.7K |
| shock W10 X0.5 +bid | 72 | 21 | -29% | $105.2K (16%) | $105.5K (24%) | -$27.2K | -$18.3K | 3 | -$2.8K / +$8.0K |
| all W3 X0.25 | 75 | 16 | -23% | $104.7K (14%) | $105.5K (20%) | -$25.8K | -$19.0K | 3 | -$2.4K / +$7.0K |
| all W3 X0.5 | 75 | 17 | -21% | $103.1K (14%) | $104.5K (21%) | -$25.8K | -$19.9K | 3 | -$1.9K / +$5.1K |
| all W5 X0.25 | 74 | 16 | -27% | $101.8K (16%) | $102.3K (23%) | -$28.0K | -$21.5K | 3 | -$2.0K / +$3.8K |
| all W5 X0.5 🎯 | 74 | 18 | -22% | $107.0K (14%) | $109.2K (20%) | -$24.0K | -$16.9K | 3 | -$2.0K / +$9.0K |
| all W10 X0.25 | 73 | 18 | -28% | $100.0K (16%) | $99.0K (24%) | -$29.5K | -$23.3K | 3 | -$2.6K / +$2.6K |
| all W10 X0.5 | 74 | 18 | -27% | $99.9K (16%) | $98.7K (24%) | -$29.5K | -$23.4K | 3 | -$2.6K / +$2.5K |
| all W3 X0.25 +bid | 75 | 14 | -24% | $102.9K (14%) | $104.3K (20%) | -$27.0K | -$20.0K | 3 | -$2.4K / +$5.3K |
| all W3 X0.5 +bid | 75 | 13 | -23% | $100.7K (14%) | $100.1K (20%) | -$28.3K | -$22.6K | 3 | -$2.4K / +$3.0K |
| all W5 X0.25 +bid | 74 | 16 | -27% | $102.7K (15%) | $103.3K (22%) | -$27.1K | -$20.5K | 3 | -$2.0K / +$4.7K |
| all W5 X0.5 +bid | 74 | 16 | -26% | $105.2K (14%) | $106.3K (21%) | -$25.6K | -$18.3K | 3 | -$2.0K / +$7.2K |
| all W10 +bid (X 0.25 = 0.5) | 73-74 | 18 | -28/-27% | $100.8K (16%) | $100.7K (23%) | -$28.6K | -$22.3K | 3 | -$2.6K / +$3.4K |
| B5 (post-hoc reference) | 71 | 22 | -30% | $115.8K (10%) | $124.4K (14%) | -$23.9K | -$17.1K | 4 | -$2.7K / +$18.5K |

Check (odd weeks), the base and the picks:

| Version | Trades | Won | Median | 2% (drop) | 3% (drop) | W/o best 5 | Non-giant | Giants | 2025 / 2026 |
|---|---|---|---|---|---|---|---|---|---|
| 1.2.0 + -80% stop | 62 | 24 | -17% | $127.8K (8%) | $141.7K (13%) | -$20.4K | -$11.7K | 3 | -$3.7K / +$31.5K |
| shock W10 X0.25 +bid 🎯 | 62 | 20 | -17% | $124.2K (8%) | $136.5K (13%) | -$23.5K | -$14.5K | 3 | -$3.0K / +$27.3K |
| all W5 X0.5 🎯 | 62 | 20 | -19% | $129.5K (7%) | $143.6K (10%) | -$14.3K | -$3.7K | 2 | -$3.3K / +$32.8K |
| B5 (post-hoc) | 62 | 24 | -10% | $129.8K (8%) | $145.1K (12%) | -$18.6K | -$10.2K | 3 | -$3.7K / +$33.4K |

Year (one account): base $146.9K (13%) / 3% $174.3K (19%); shock pick $131.8K (20%) / $146.6K (28%); all pick $136.7K
(13%) / $155.7K (19%); B5 $151.3K (13%) / $180.4K (19%).

- **Every one of the 24 versions loses tune** (-$7.6K to -$14.7K at 2%) with a bigger drop. The flat exit wins most of the
  trades it touches (the picks: 13 of 19 and 37 of 54 better on tune) but it sells the giants that start slowly:
  **META 2026-05-27 shock +496% -> -68% / -75%** (tune), SLV 2026-08-28 plan +414% -> -31% (check, the all-trades pick).
  Shock pick, tune: flat -$9.2K of which META -$11.3K; check -$2.7K with no giant touched (it loses on ordinary trades
  too). All-trades pick, check: +$1.7K at 2% and a lower drop, but flat -$0.3K: the account gain is ordering, not edge.
- "+bid <= paid" (the neighbour) does not protect the giants: META 05-27's bid was under the price paid at +10 min.
- Task 11's AVGO 2026-10-30 put is helped by both picks (-69% -> -27% all W5; -> -44% shock W10), but META 05-27 looked
  the same at the check (the stock 0.7 S30 against at +5 min, the option at -70%) and went to +496% later: the rule
  cannot tell them apart.

**3 years (the picks, `flat3y.py`).** No new simulator run: the 3-year research twin of **Volume 1.1.0** ("Live (PR #204)"
on the 10-30 dashboard, top 50, live limits, 2024-02-07 .. 2026-10-16, 431 trades; `volume_trades.csv`), each trade's
exit re-walked on the real minute books already in dbx_cache (no purchase). Differences from 1.2.0: no "against the
day's move" skip (13 more shock trades), the twin's own alerts and list; the export has no contract or side price, so the
contract is the strike whose real minute bid at the exit is the export's sale (431 of 431 resolved, ties by the book at
the buy), the side price is the buy minute's close (on the year this proxy moves the picks by <= $0.7K), S30 = levels.ctx;
base = the twin + the -80% stop on the minute books; the account is re-walked from the export's dollars (freed slots not
refilled). 2% (3%):

| Version | Trades | Won | Median | 2% (drop) | 3% (drop) | Tune / check P&L | W/o best 5 | Non-giant | Giants | 2024 / 2025 / 2026 | 2025-10-10 | W/o 10-10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| twin + -80% stop | 431 | 166 | -24% | $713.5K (23.6%) | $1,371.9K (33.7%) | +$61.5K / +$552.0K | +$175.8K | -$27.7K | 28 | +$15.5K / +$374.8K / +$223.1K | +$295.7K | +$317.7K |
| shock W10 X0.25 +bid | 431 | 148 | -27% | $514.8K (29.4%) | $852.7K (41.1%) | +$1.9K / +$412.9K | +$73.0K | -$48.3K | 26 | +$2.1K / +$303.9K / +$108.8K | +$237.2K | +$177.7K |
| all W5 X0.5 | 431 | 130 | -21% | $399.0K (27.8%) | $606.5K (39.0%) | +$17.9K / +$281.1K | +$42.7K | -$48.4K | 21 | -$7.8K / +$257.5K / +$49.3K | +$191.9K | +$107.1K |

- Shock pick: 89 trades cut (48 tune / 41 check), 47 better, flat -$15.3K / -$21.6K; giants cut META 2026-05-27, IWM
  2025-07-30 (+317% -> -28%). All pick: 240 cut, 153 better, flat -$13.2K / -$65.4K, median +11 / +7 pts; giants cut 7
  (META 05-27, COIN 2025-06-18, IWM 2025-07-30, HOOD and IREN on 2025-10-10, QCOM 2026-05-07 +689% -> -26%, SLV 08-28).
- **2025-10-10**: the base makes +$295.7K that day at 2%; the picks +$237.2K / +$191.9K (HOOD and IREN, both +316-317%,
  were flat at +5 min). Without that day the picks still lose: +$177.7K / +$107.1K vs +$317.7K.
- The median trade improves with the all-trades rule (it saves many small losers), but the giants start flat as often as
  the losers do; the non-giant sum gets worse (-$48K vs -$28K) because the cut giants land in it.

**Verdict: not a candidate.** Worse on tune on the year (all 24 versions), worse on tune and check on 3 years, bigger
drop, giants cut on both halves. B5 (volume) stays a post-hoc lead only. No data bought ($0). Scripts (scratch testC):
`exitlab.py` (the `flat` rule), `run_flat.py`, `flat3y.py`; outputs `out/flat.txt`, `out/flat3y.txt`.

### The analyst trade review (11 single trades): three tests, no candidate (2026-11-03)

The user reviewed 11 single trades from screenshots on the Trade Reviews board (https://claude.ai/artifact/NNUk163ipCjYuzounGtQyT) and asked to test them all: "go over all of them and search for candidate. buy data up to 2$". Three groups ran in parallel on Volume 1.2.0 (the live code's year, real books): A entries near support / resistance, B buying the spike itself, C exits. None is a candidate. One lead to re-check on 3 years: C's B5 (a faded shock: under 3x usual for 5 min, sell at +5 min if the bid is at or under the price paid; 6 trades, level picked after seeing the counts). Data bought: about $0.002 (test B), A and C none.

#### Entries near support / resistance: skip, wait for the break, and no plan against the day's move (2026-11-03, look 1)

The user's single-trade review (group A): NBIS put 2025-11-13 on the day low, bounced at once: "classic - bounce from
the support. maybe we should make it more difficult to trade if we are close to the support (wait more time?)"; MSFT
call under the day's high, SLV 49C 10-28 at the 15-min high: "in volume alert (not shock) when we're closing to the
resistance/support need to prove breakout"; CRM put 2026-10-08 just past yesterday's / the 5-day low, back above in
~15 min: "broke support alert, on the volume alert (not shock) maybe consider waiting for confirmation"; QCOM 180 put
2025-10-27 after a $172 -> $205 run: "just a pullback after huge run, we should not put in this case".

Log first: no level rule was ever tested on the Volume bot. Neighbours: the 3-year double-bet scan (2026-11-02) found the
trades AT the day's high the better group (median -18% / -2% vs -31% / -16%); the Main bot's `levels.py` (2026-10-23):
a signal right at a level is its best group; `strangle_break.py` (10-25): a break fails about as often as it holds;
"Fewer trades" (10-27): the fast cross is the edge, a slow side (60-300 s) loses; "against the move" was tested on the
SHOCK only (looks 1-3, now 1.2.0's rule); the plan alert was never filtered against the day's move.

Built on **Volume 1.2.0** (live since 2026-11-03, stage 5 pending): the live-code year (`v12_` parts of the release,
51 stocks incl. USO, 2025-11-03 .. 2026-10-30, real books, no broker stop, the live limits, `volumeAccount` of the 1.2.0
code); reproduced to the dollar ($149.4K, 133 trades, tune $115.3K / check $128.5K, 3% $177.3K). Levels as the app's
trade chart (`chart-levels.ts` / `bot/levels.ts`): the day's high / low so far, the first 15 minutes', yesterday's, the
5 sessions'; for a call the highs, a put the lows; distance x in S30 at the buy's stock price. Set before the run:
UNDER = a level still ahead within 0.5 S30; JUST BROKE = a prior level (not the day so far) passed by <= 1.1 S30 (the
plan's minimum burst); NEAR = either. Plan alerts only unless named. B = a delayed buy of the same contract on a minute
close, priced as the engine's minute fallback (mid + a quarter spread, the next ask on a chase), the engine's exit walk
(re-walked on all 155 original trades: 155 / 155 identical), sale at the real minute bid; B0 = the same minute pricing
with no wait, the fair control for B. Scripts: scratch `testA/levels_year.py`, `acct.ts`, `report_year.py`,
`levels_3y.py`.

Tune (even weeks), 2% (3%):

| Version | Trades | 2% (drop) | 3% (drop) | Median | Giants | Non-giant sum | W/o best 5 |
|---|---|---|---|---|---|---|---|
| 1.1.0 (reference) | 79 | $111.9K (9.5%) | $117.2K (14.4%) | -31% | 4 | -$22.9K | -$27.4K |
| 1.2.0 (base) | 71 | $115.3K (9.3%) | $123.2K (13.8%) | -31% | 4 | -$19.7K | -$24.4K |
| 🎯 A1 skip under a level | 69 | $116.2K (8.6%) | $124.8K (12.7%) | -31% | 4 | -$19.4K | -$24.2K |
| A2 skip just broke | 65 | $109.0K (9.2%) | $113.1K (13.6%) | -33% | 4 | -$24.3K | -$28.8K |
| A3 skip near (both) | 63 | $111.1K (10.7%) | $114.8K (15.6%) | -32% | 4 | -$23.4K | -$28.0K |
| A4 = A3 + shock | 50 | $104.4K (10.8%) | $106.1K (16.0%) | -32% | 3 | -$17.7K | -$23.7K |
| A5 = A3 half bands | 66 | $108.5K (9.8%) | $112.4K (14.3%) | -33% | 4 | -$24.8K | -$29.3K |
| B0 control (minute price, no wait) | 71 | $112.9K (9.4%) | $118.6K (14.0%) | -31% | 4 | -$22.4K | -$26.9K |
| B1 first close 0.25 past, <= 5 min | 70 | $106.9K (10.7%) | $109.2K (15.9%) | -33% | 4 | -$26.4K | -$30.8K |
| 🎯 B2 wait 5 min, still 0.25 past | 66 | $109.1K (9.3%) | $113.3K (13.6%) | -33% | 4 | -$24.2K | -$28.7K |
| B3 wait 10 min | 67 | $106.8K (10.8%) | $108.4K (15.8%) | -34% | 4 | -$26.5K | -$30.8K |
| B4 = B1 + shock | 66 | $98.3K (13.7%) | $96.0K (20.4%) | -32% | 3 | -$23.4K | -$29.9K |
| 🎯 C1 no plan against the open >= 2 S30 | 65 | $121.0K (9.2%) | $132.0K (13.9%) | -29% | 4 | -$15.7K | -$20.5K |
| C2 same >= 3 | 67 | $118.3K (9.3%) | $127.1K (13.9%) | -31% | 4 | -$18.4K | -$23.1K |
| C3 against the last hour >= 2 | 67 | $119.5K (9.3%) | $128.9K (13.8%) | -31% | 4 | -$17.0K | -$21.9K |

Check (odd weeks), the base and the picks:

| Version | Trades | 2% (drop) | 3% (drop) | Median | Giants | Non-giant sum | W/o best 5 |
|---|---|---|---|---|---|---|---|
| 1.2.0 (base) | 62 | $128.5K (8.6%) | $143.7K (12.9%) | -17% | 3 | -$11.9K | -$19.7K |
| 🎯 A1 | 57 | $129.0K (8.6%) | $143.8K (12.8%) | -17% | 3 | -$11.4K | -$19.2K |
| B0 control | 62 | $124.4K (8.6%) | $136.6K (12.8%) | -20% | 3 | -$15.8K | -$22.9K |
| 🎯 B2 | 57 | $123.9K (9.4%) | $135.9K (14.2%) | -21% | 3 | -$16.5K | -$23.6K |
| 🎯 C1 | 58 | $127.7K (8.7%) | $141.9K (12.9%) | -20% | 3 | -$12.7K | -$20.6K |

Year 2% (3%): base $149.4K (12.5%) ($177.3K); A1 $150.9K (11.4%) ($180.0K); B2 $135.4K ($152.3K); C1 $155.7K (13.0%)
($188.9K). By year (2025 Nov-Dec / 2026): base -$6.0K / +$55.4K; A1 -$4.8K / +$55.7K; C1 -$6.0K / +$61.7K.

- **A1** removes 8 plan trades (flat $2K -$1.5K, median -64%, 3 won, no giant: ORCL 12-12 -68%, USO 01-30 +111%, SLV
  03-23 -68%, MSFT 03-31 +53%, USO 06-09 -63%, USO 09-23 -64%, MSFT 09-25 -81%, USO 09-25 +103%; 4 are USO, off the list
  since today) and frees QQQ 03-31 (-57%). Better on tune and check, by +$0.9K / +$0.5K: a gain of a trade or two.
- **B** (wait for the break) loses on both halves at every wait, also against its own minute-priced control (the control
  itself costs -$2.4K / -$4.1K: the minute book is dearer than the seconds book at the cross). The 11 re-priced trades go
  from +$5.4K flat (median +5%) to -$7.8K (median -42%): waiting pays a dearer option after the move and cuts the winners.
- **C1** wins tune (+$5.7K) and loses the check (-$0.8K, median -20% vs -17%, worse without the best 5).

**3 years, the research twin as a filter** (`levels_3y.py`; the 1.1.0 twin with 1.2.0's shock rule as a filter =
404 trades, $866.9K, reproduced; the twin's price = the alert minute's close + 0.25 S30; re-walked, slots not refilled):

| Version | Trades | 2% (drop) | 3% (drop) | Tune / check P&L | Median tune / check | Giants | Non-giant tune / check | 2024 / 2025 / 2026 | W/o best 5 | 10-10 P&L |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2.0 twin | 404 | $866.9K (18.5%) | $1,846K (27.0%) | +$115.3K / +$651.6K | -31% / -4% | 6 / 22 | -$210.4K / -$25.6K | +$21.0K / +$434.7K / +$311.1K | +$269.6K | +$322.9K |
| A1 | 371 | $695.4K (14.5%) | $1,484K (21.2%) | +$115.9K / +$479.4K | -30% / -4% | 6 / 16 | -$152.8K / -$8.0K | +$25.2K / +$331.2K / +$239.0K | +$201.0K | +$196.1K |
| C1 | 371 | $798.9K (17.1%) | $1,630K (25.0%) | +$100.9K / +$598.0K | -32% / -2% | 6 / 22 | -$194.9K / -$8.0K | +$17.8K / +$370.4K / +$310.8K | +$245.1K | +$285.4K |

- A1 skips 33 plan trades, flat +$64.6K, 6 of them +300%, all on **2025-10-10** (SOXL +1253%, BABA +740%, QQQ +640%,
  SMH +518%, AAPL +336%, IWM +318%): the crash day's winners were bought under the day's low. Without 10-10 the 27 others
  are -$11.5K flat (median -39%), so the skip helps a little on ordinary days and costs the crash day.
- C1 skips 33 (flat +$7.2K, median -13%, no giant; COIN / AVGO 2025-04-04, PLTR 05-30, SMH 07-25 among the winners);
  it does skip the user's QCOM 2025-10-27 put (+12% in the twin). Loses both halves.

Missing data: none dropped. Year: every traded alert had its levels; 53 traded alerts' day open came from the minute
bars (not in opens.json); every delayed buy and sale had a real minute book (no purchase). 3 years: every plan trade had
its levels. Databento: nothing bought ($0).

**Verdict: no candidate.** A1 passes the year by one or two trades (and half its skips are USO) and fails the 3-year
check (the 10-10 giants sit under a level); waiting for the break (B) loses everywhere; no plan against the day's move (C1)
wins tune and loses the check, on the year and on 3 years. Being near a level does not sort the Volume bot's trades: the
median does not move. Look 1 for levels on the Volume bot; look 1 for the plan against the move (the shock version's
check has been seen 3+ times). Process note: the run printed every version's check (the runner's default); the picks
were chosen mechanically on tune (best tune 2% end per idea) before the check was read.

#### Buying the spike itself: wait 1-2 minutes, a huge alert minute, an SPY-driven move (2026-11-03, look 1)

The user's trade review: GOOGL 287.5 C 2025-11-05 bought at the top of a one-bar spike (-47%): "in the volume alert we
might try to wait hold 1 minute to see we are not in the spike"; NVDA C 2025-11-21 (shock 13:48:50 NY, the option
~0.05 -> 0.49 in a minute, -91%): "buying in a HUGE 1 minute move - think about it"; AMZN C, SPY +0.3% in the alert minute
(and SLV 2026-10-28): "tune with the spy movement - spy affecting the stock and it's not the stock real move".
Built on **Volume 1.2.0** (live since 2026-11-03, stage 5 pending; 1.1.0 + no shock against the day's move), the app's
engine over its year (2025-11-03 .. 2026-10-30, the saved 51 stocks and limits, real books only, no broker stop). The
1.2.0 code frozen with a test switch: `TB_DELAY` (buy W s after the side if the move holds, the same contract, on the
real 1-second book then; the give-back starts from the stock at the later buy), `TB_NEWS` (the 1.2.0 parity run's
news verdicts: the Nasdaq calendar answered 403). B and C are filters on the champion's trades at the buy second t
(the side + 2 s; 10-second bars): B the price paid vs the option's mid a minute earlier (Databento minute row
buyMinute - 1) and the stock's 60-s move vs its usual (median |60-s move|, prior 5 sessions); C SPY's 60-s move the
trade's way and beta (60-s returns, prior 10 sessions) x SPY's move as a share of the stock's. Levels set before the
run; the pick per idea = the most money on tune at 2% with a drop at most 2 points over the champion.
Scripts (testB frozen copy): `tb_spike_features.py`, `tb_spike_report.py`, `tb_spike_3y.py`, `tb_gaps.py`; app copy
`scripts/.tb_run.ts` + the `TB_DELAY` / `TB_NEWS` switches in `strangle/backtest.ts` / `volume-backtest.ts`.

Champion reproduced to the dollar ($149.4K, 133 trades, tune $115.3K, check $128.5K, 3% $177.3K). The delayed buys
needed 25 one-second windows and one sale day not in the store: bought from Databento (OPRA cbbo-1s / cbbo-1m, $0.0020
in all); that includes the champion's one unpriced alert (SLV 2026-10-08 shock, -37%), so every row below is on real
books with no alert left unpriced, and the champion is $148.4K / 134 trades.

Tune (even ISO entry weeks), 2%:

| Version | Trades | Median | 2% (drop) | 3% (drop) | W/o best 5 | Non-giant | Giants | 2025 / 2026 |
|---|---|---|---|---|---|---|---|---|
| Volume 1.2.0 | 71 | -31% | $115.3K (9%) | $123.2K (14%) | -$24.4K | -$19.7K | 4 | -$2.4K / +$17.7K |
| A wait 60 s, past the side line | 41 | -29% | $94.2K (13%) | $90.8K (19%) | -$21.5K | -$13.9K | 1 | -$1.1K / -$4.8K |
| A wait 120 s, past the line | 43 | -32% | $103.5K (12%) | $104.2K (18%) | -$22.6K | -$13.9K | 1 | -$0.8K / +$4.3K |
| A wait 60 s, past the alert price | 54 | -30% | $93.7K (14%) | $89.7K (21%) | -$26.7K | -$19.3K | 2 | -$1.2K / -$5.1K |
| 🎯 A wait 60 s past the line, plan alerts only | 53 | -28% | $111.8K (6%) | $116.7K (10%) | -$24.7K | -$22.7K | 4 | -$0.8K / +$12.6K |
| B option >= 3x a minute earlier | 69 | -31% | $116.0K (9%) | $124.3K (13%) | -$24.2K | -$19.4K | 4 | |
| B option >= 2x | 67 | -32% | $103.7K (10%) | $104.1K (15%) | -$27.7K | -$19.4K | 3 | |
| 🎯 B option >= 5x | 70 | -31% | $116.3K (9%) | $124.7K (13%) | -$23.9K | -$19.1K | 4 | |
| B option >= 3x, plan only | 71 | (removes none) | $115.3K | | | | | |
| B stock 60-s move >= 10x usual | 45 | -36% | $92.3K (17%) | $87.9K (25%) | -$27.4K | -$17.5K | 1 | |
| B stock >= 6x / >= 15x | 27 / 57 | | $94.8K / $106.4K | | | | | |
| C SPY 60-s our way >= 0.15% | 62 | -32% | $107.2K (9%) | $109.5K (14%) | -$24.8K | -$16.4K | 3 | |
| C SPY >= 0.10% / >= 0.25% | 57 / 66 | | $109.6K / $118.7K | | | | | |
| 🎯 C SPY >= 0.15%, plan alerts only | 66 | -32% | $119.1K (8%) | $127.2K (11%) | -$22.5K | -$17.6K | 4 | -$1.1K / +$20.1K |
| C beta x SPY >= 50% of the move | 59 | -31% | $108.3K (11%) | $112.3K (16%) | -$23.0K | -$14.7K | 3 | |
| C share >= 33% / >= 67% | 55 / 60 | | $112.0K / $106.8K | | | | | |

(After the run, tune only, not in the pick: C plan-only 0.10% $120.4K, 0.25% $120.1K: no knife edge on the year.)

Check (odd weeks), the champion and the picks:

| Version | Trades | Median | 2% (drop) | 3% (drop) | W/o best 5 | Non-giant | Giants | Year 2% (drop) |
|---|---|---|---|---|---|---|---|---|
| Volume 1.2.0 | 63 | -18% | $127.5K (9%) | $142.1K (13%) | -$20.7K | -$12.9K | 3 | $148.4K (12%) |
| A wait 60 s, plan only | 50 | -22% | $101.4K (9%) | $101.1K (13%) | -$21.6K | -$11.8K | 2 | $113.1K (11%) |
| B option >= 5x | 62 | -20% | $127.4K (9%) | $141.6K (13%) | -$20.9K | -$13.0K | 3 | $149.2K (12%) |
| C SPY >= 0.15%, plan only | 62 | -17% | $129.8K (8%) | $145.3K (11%) | -$18.8K | -$10.8K | 3 | $153.2K (11%) |

3 years, the 1.1.0 twin (top 50, live limits, 2024-02 .. 2026-10; filtered, scaled walk; plan buy second taken as
m*60 + 10; B on the ask a minute earlier, rougher), 2%:

| | Twin | C SPY >= 0.15%, plan only | B option >= 5x (ask) |
|---|---|---|---|
| All days (drop) | $773K (21.1%) | $243K (19.9%) | $515K (20.7%) |
| Tune / check | +$73K / +$600K | +$11K / +$132K | -$25K / +$440K |
| Without 10 Oct 2025 | $288K, +$27K / +$161K | $253K, +$12K / +$141K | $250K (27.2%), -$9K / +$159K |

- **A, waiting, fails.** About 40% of the traded alerts turn back within 60 s (d60: 63, median -36% as bought at once,
  2 of +300%), so waiting does skip the GOOGL / NVDA / SLV spikes of the review; but the ones that hold cost +14% more
  (median, the same contract a minute later) and their flat $2K sum falls from +$72.4K to +$12.0K. Every all-alerts
  version loses tune by $12-22K; the plan-only pick loses tune (-$3.5K) and the check (-$26.1K). The 2026-10-29 shock
  study ("Waiting for the spread to come down") said the same on the old setup.
- **B, the huge minute, no edge.** Paid >= 3x the option's mid a minute earlier is 3 of 157 traded alerts (the 1-min
  rise median is +16%; NVDA 2025-11-21 was only 1.35x a minute before: its jump came earlier). 5x (the pick) removes 2
  trades (QQQ 06-11 -34%, PLTR 04-10 +6%): +$1.0K tune, -$0.1K check, a tie. The stock's 60-s move vs usual removes the
  giants with the losers (median of the removed = the kept) and loses $9-23K on tune.
- **C, SPY-driven, no candidate.** The pick (plan alerts, SPY's 60-s move our way >= 0.15%) removes 9 trades on the
  year (median -61%, none of +300%; IWM x4, QQQ, ORCL, SLV, MSFT +53%, NVDA +27%): +$3.8K tune, +$2.3K check, a
  smaller drop, better without the best 5 and non-giant on both halves; but 8 of the 9 are tune trades (the check gain
  is one trade, IWM 2026-05-20 -75%) and the median does not move (tune -32% vs -31%). On 3 years it skips 18 trades of
  2025-10-10 (SOXL +1253%, AMZN +849%, NVDA +799%, BABA, QQQ, META ...): $243K vs $773K; without 10-10 it still loses
  both halves ($253K vs $288K). A market-wide move is where the giants are (the same lesson as the volume score).
- What is new here: SPY's own price move at the buy as a skip (the volume score / SPY volume work was volume, the
  2026-10-27 "strength at the entry" was the t-stat), the wait on the live code with plan alerts and real 1-second
  books, and the 1-minute option rise as a skip (the 5-minute rise was closed 2026-11-02).
- Data gaps: none at the buy or sale after the purchase. Listed: 53 alerts "fewer than 5 sessions of history"
  (SPCX, SPCE) and 1 call with no prices, in every version; the delayed versions 1-2 USO alerts with no stock trade at
  the delayed second; the filters' features missing on 17 trades (USO 16 and GOOG at 09:44 have no 10-second bars) and 1
  with no option book a minute earlier: kept, never dropped. 2025-10-10 is outside the live code's year (3-year view
  above). Looks: 1 (19 versions on tune, 3 picks on check).

#### Exits from the trade review: the grace end and the -80% stop, a fading shock, a 0DTE trail, a roll on a new alert (2026-11-03, look 1; roll look 2)

The user's analyst review of single trades: Task 3 (a call sold at 0.11 on the -80% stop just as the 30-minute grace
ended, the stock back near the entry, no option points during the hold): "its about 30 minutes grace, maybe we can
found better way"; Task 11 (AVGO 2026-10-30 put, one big bar, then normal volume, bled 53 min to -68%): "if the shock
enter and it's a single bar and than volume fade - consider decrease the window time frame"; Task 6 (GOOGL 367.5 put
0DTE 2026-08-05, 1.10 -> ~10.5 -> sold 4.85): "try (once again) smart exit in 0dte"; Task 2: "for alerts of ticker with
the same direction of already open position - if we have a big gain we can use it as a trigger to rolling".

Built on **Volume 1.2.0** (live since 2026-11-03, stage 5 pending): the app engine's own parts (`v12_*`, origin/main
backtest.ts, 51 stocks, 2025-11-03 .. 2026-10-30, saved settings, live limits, real minute books for every sale) with
the broker's -80% safety stop as the engine models it. Every exit is re-walked on the same D1 snapshot (stock minute
bars, option minute books and bars); the plain re-walk reproduces all 155 engine trades (exit minute and sale, to the
cent), the stop reproduces all 83 trades of the engine's 60%-stop parts, and the account port reproduces 1.2.0 to the
dollar ($149,393, 133 trades, tune $115,271, check $128,472 with no stop). Levels set before the run except B4/B5.
Scripts: `exitlab.py`, `run_exits.py`, `acct.py` (scratch testC). No data bought.

Variants: **A** (grace end / stop) A1 the stop only on a two-sided book (spread <= 50% of the mid); A2 A1 + only while the
stock is against the entry; A3 the give-back waits up to 15 more minutes after the grace while the stock is not 0.25 S30
against the entry; A4 the same up to 30. **B** (shock trades whose 5 minutes after the alert minute average < 2x the
usual volume: the median of 20 sessions, same minute +-2) B1 grace 10 (the give-back sells in 10-30 only while the bid
<= the price paid); B2 grace 15; B3 sell at +5 min if the bid <= the price paid; B4/B5 = B1/B3 at < 3x (added after
seeing < 2x catch 2 of 61 shock trades: not pre-set). **C** (0DTE, on the minute bid of two-sided books) C1 once the bid
>= 3x the buy, sell 40% off its high; C2 3x / 25%; C3 5x / 40%; C4 half at 3x; C5 C1 on <= 1 DTE. **D** a same-side
alert's trade while the stock's open trade has a bid >= Kx its buy: sell the open leg at that minute's bid and take the
new alert's own trade; D1 K = 3, D2 K = 2.

Tune (even ISO entry weeks), 2% (3%):

| Version | Trades | Won | Median | 2% (drop) | 3% (drop) | W/o best 5 | Non-giant (flat $2K) | Giants | 2025 / 2026 |
|---|---|---|---|---|---|---|---|---|---|
| 1.2.0 + -80% stop | 71 | 23 | -31% | $114.6K (10%) | $122.6K (14%) | -$25.1K | -$18.2K | 4 | -$2.7K / +$17.3K |
| A1 stop on a two-sided book | 71 | 23 | -31% | $114.6K (10%) | $122.6K (14%) | -$25.1K | -$18.2K | 4 | = |
| A2 A1 + stock against | 71 | 23 | -31% | $114.6K (10%) | $122.6K (14%) | -$25.1K | -$18.2K | 4 | = |
| A3 grace +15 while not 0.25 S30 against 🎯 | 71 | 23 | -28% | $115.5K (9%) | $123.4K (14%) | -$23.6K | -$17.2K | 4 | -$2.9K / +$18.3K |
| A4 grace +30 | 71 | 20 | -32% | $106.2K (11%) | $108.0K (17%) | -$29.8K | -$16.8K | 2 | -$3.1K / +$9.3K |
| B1 faded shock: grace 10 | 71 | 23 | -31% | $115.0K (10%) | $123.2K (14%) | -$24.7K | -$17.8K | 4 | -$2.7K / +$17.6K |
| B2 faded shock: grace 15 | 71 | 23 | -31% | $114.9K (10%) | $123.1K (14%) | -$24.8K | -$17.9K | 4 | -$2.7K / +$17.6K |
| B3 faded shock: cut at +5 min 🎯 | 71 | 23 | -31% | $115.7K (10%) | $124.2K (14%) | -$24.0K | -$17.1K | 4 | -$2.7K / +$18.4K |
| B4 (post-hoc) B1 at < 3x | 71 | 23 | -31% | $115.2K (10%) | $123.4K (14%) | -$24.5K | -$17.7K | 4 | -$2.7K / +$17.8K |
| B5 (post-hoc) B3 at < 3x | 71 | 22 | -30% | $115.8K (10%) | $124.4K (14%) | -$23.9K | -$17.1K | 4 | -$2.7K / +$18.5K |
| C1 0DTE trail 40% once 3x | 71 | 23 | -31% | $114.1K (10%) | $121.7K (15%) | -$26.2K | -$19.4K | 4 | -$2.7K / +$16.7K |
| C2 0DTE trail 25% once 3x | 72 | 23 | -31% | $111.5K (12%) | $116.9K (17%) | -$25.5K | -$14.9K | 3 | -$2.7K / +$14.2K |
| C3 0DTE trail 40% once 5x 🎯 | 71 | 23 | -31% | $115.2K (10%) | $123.4K (14%) | -$25.1K | -$18.2K | 4 | -$2.7K / +$17.9K |
| C4 0DTE half at 3x | 71 | 23 | -31% | $113.0K (8%) | $118.7K (13%) | -$22.1K | -$15.3K | 4 | -$2.7K / +$15.6K |
| C5 <= 1 DTE trail 40% once 3x | 71 | 23 | -31% | $114.1K (10%) | $121.7K (15%) | -$26.2K | -$19.4K | 4 | -$2.7K / +$16.7K |
| D1 roll at >= 3x | 73 | 23 | -32% | $117.1K (10%) | $127.1K (14%) | -$27.6K | -$20.5K | 4 | -$2.7K / +$19.8K |
| D2 roll at >= 2x 🎯 | 74 | 23 | -32% | $118.1K (10%) | $127.6K (14%) | -$27.2K | -$19.9K | 4 | -$2.7K / +$20.8K |

Check (odd weeks), the base and the picks (B5 for the record):

| Version | Trades | Won | Median | 2% (drop) | 3% (drop) | W/o best 5 | Non-giant | Giants | 2025 / 2026 |
|---|---|---|---|---|---|---|---|---|---|
| 1.2.0 + -80% stop | 62 | 24 | -17% | $127.8K (8%) | $141.7K (13%) | -$20.4K | -$11.7K | 3 | -$3.7K / +$31.5K |
| A3 🎯 | 62 | 24 | -18% | $130.7K (10%) | $147.2K (15%) | -$17.8K | -$2.4K | 2 | -$3.7K / +$34.4K |
| B3 🎯 | 62 | 24 | -11% | $127.9K (8%) | $142.0K (13%) | -$20.2K | -$11.6K | 3 | -$3.7K / +$31.6K |
| C3 🎯 | 62 | 24 | -17% | $127.8K (8%) | $141.7K (13%) | -$20.4K | -$11.7K | 3 | = |
| D2 🎯 | 67 | 26 | -17% | $126.9K (8%) | $139.9K (13%) | -$14.8K | -$1.9K | 3 | -$3.7K / +$30.6K |
| B5 (post-hoc) | 62 | 24 | -10% | $129.8K (8%) | $145.1K (12%) | -$18.6K | -$10.2K | 3 | -$3.7K / +$33.4K |

Year (one account): base $146.9K (13%) / 3% $174.3K (19%); A3 $151.2K (**17%**) / $181.6K (**25%**); B3 $149.4K (13%);
C3 $148.2K (13%); D2 $150.4K (12%); B5 $151.3K (13%). (1.2.0 with no stop: $149.4K; the -80% stop sold 13 taken trades,
costing flat $1.4K vs the engine's own later exits.)

- **A, the grace end / the stop: no candidate.** The year's 15 -80% stops (13 taken) all fired 11-30 min into the grace
  with the stock 0.9-4.7 S30 against the entry; 14 on a clean two-sided book (spread a few cents), **1 on a stale/wide
  book: USO 2026-01-29 0.04/0.26, exactly at +30 min** (A1 sells it at 0.18 later: +$0.8K flat). No stop followed a gap
  of more than 3 minutes in the books. So the backtest has no Task-3 case beyond USO; Task 3 looks like a live quote
  problem (check the live stop's book), not a rule. A2 = A1 (every stop had the stock against). A3 (wait up to 15 more
  minutes while the stock is not 0.25 S30 against) gains +$0.9K tune / +$2.9K check but the flat change of its ~28
  changed trades (27 / 29) is +$0.4K / +$2.1K with a -2..-3 pt median, it cuts a giant on each half (META 05-27 +496% -> +349%,
  QCOM 05-07 +369% -> +99%) and the worst drop rises (year 13% -> 17%, 3% 19% -> 25%): not better. A4 loses (-$8.4K tune).
- **B, the fading shock: no candidate, too rare.** After a shock the volume stays 3-10x usual for the next 5 minutes in
  59 of 61 shock trades (< 2x: 2 trades, AMZN 2026-09-28 and SOFI 2026-01-28; < 3x: 6). B3 helps both (-63% -> -11%,
  -18% -> -10%): +$1.1K tune, +$0.1K check. Task 11's AVGO 2026-10-30 is not caught (the spike is minute 196 at 13x; the
  next five are 2-4x usual; it fades only from +6 min). The post-hoc 3x level (B5) is better on both halves (+$1.2K /
  +$2.0K, 5 of 6 trades better, no giant touched, same drop) but it is 6 trades and a level chosen after the look: a
  lead to log and re-test when more shock trades exist, not a version.
- **C, 0DTE smart exit (look 2 of a take/trail on this bot; the shock scale-outs 2026-10-30 and the Main bot's trails
  failed): no candidate.** On minute books the GOOGL 08-05 put's best bid was ~8.7 (the ~10.5 was inside a minute);
  C1/C3 sell it at 5.20 (+370%) vs 4.85 (+338%). C3 touches only that trade (check unchanged); C1 also cuts USO 02-04 and
  IWM 06-11 (tune -$0.6K flat) and helps IWM 06-17 and NVDA 07-17 (check +$2.8K flat); C2 and C4 cut the META 04-08 giants
  (+1251% -> +757%, +627% -> +273%): worse. One trade is not a rule.
- **D, roll on a same-side alert (look 2 of rolling; the +400% roll into 0.30 delta failed 2026-11-02): no candidate.**
  6 events at 3x, 8 at 2x in the year. D2 +$3.5K tune, -$0.9K check: it rolls META 04-08's +1251% plan leg at 3.05
  into the shock leg (+627%). Without the best 5 / non-giant improve on check only because that giant is cut. The new
  legs lost on 6 of 8 (GOOGL 08-05 1.44 -> 0.25, INTC x2, ORCL, SLV, UBER).
- Missing data: 2 alerts with no book at the buy (SLV 2026-08-28 shock, SLV 2026-10-08 shock; the 08-28 book was bought
  2026-11-03 for the shock-bar test but these parts predate it), 53 alerts with fewer than 5 sessions of history
  (SPCX), 1 no-prices; none bought (same for every version). No exit in any version lacked a book. The 2025-10-10 crash
  day is outside this year (no effect). 3-year twin not run (its export holds dollars, not paths).
- Looks: A, B, C (as these rules) look 1 on 1.2.0; rolling look 2; the 0DTE take/trail family look 3+ counting the shock
  scale-outs and the Main bot's trails.

### The shock's bar: lower (10x / 12x), the day's-pace gate, a smoothed usual; every buy and sale on real books (2026-11-03)

The user (2026-11-02/03): "after we tune this, we can try to add more signal that before was wrong. we can try 10X volume
as first signal"; "its on avg of the same minute in the last 20 days right? but same minute is noisy. we need to use some
window of couple of minutes". The shocks recomputed from the 10-second bars (scratch `.shock-recompute.ts` sets 1/2/4):
the live rule with a lower bar (10x / 12x usual or pace), with the day's-pace gate (>= 3x / 5x the pace on the same
60 s), and a smoothed usual (each prior day's average 60-second volume over +-2.5 / +-5 min, then the 20-day median; the
spike stays 60 s). Every changed stock-day re-run in the app's engine (Volume 1.1.0, saved settings, 51 stocks,
2025-11-03 .. 2026-10-30, -80% stop). New alerts that reached a buy had no stored books: bought from Databento (approved by
the user), OPRA cbbo-1s at the buy (55 for 10x, then the others) and cbbo-1m for the sale day, ~$0.009 in all
(`.dbx_windows.py`, `.dbx_minutes.py`, scratch `fillround.py`); after it every version's buys and sales are on real
books (1 unpriced alert in 15x+10x and in today-only). The 15x+K rows supersede look 2 (its 4 unpriced alerts now priced).

| Version | Trades (year) | Tune 2% (drop) | Tune w/o best 5 | Check 2% (drop) | Check w/o best 5 | Year 2% (drop) |
|---|---|---|---|---|---|---|
| Live (15x, 1.1.0) | 145 | $111.4K (10%) | -$27.9K | $125.2K (9%) | -$22.7K | $140.5K (13%) |
| 15x + 2x pace | 143 | $112.9K (10%) | -$26.4K | $127.2K (9%) | -$21.0K | $144.2K (13%) |
| 15x + 3x pace | 140 | $114.8K (11%) | -$25.8K | $126.6K (9%) | -$21.6K | $145.0K (13%) |
| 15x + 5x pace | 132 | $116.8K (10%) | -$23.8K | $126.4K (8%) | -$21.6K | $149.2K (12%) |
| 15x + 10x pace | 107 | $108.8K (10%) | -$23.1K | $133.1K (6%) | -$17.4K | $144.9K (12%) |
| 15x the day's pace only | 93 | $104.2K (14%) | -$23.2K | $136.5K (5%) | -$14.9K | $142.3K (10%) |
| 10x, no gate | 195 | $107.3K (23%) | -$32.7K | $149.4K (13%) | -$16.2K | $160.6K (28%) |
| 10x + 3x pace | 171 | $117.0K (20%) | -$24.8K | $130.1K (11%) | -$19.6K | $151.4K (24%) |
| 10x + 5x pace | 153 | $112.5K (20%) | -$19.7K | $140.4K (10%) | -$21.4K | $157.0K (22%) |
| 12x + 3x pace | 164 | $103.3K (17%) | -$29.2K | $136.3K (12%) | -$23.4K | $141.8K (24%) |
| 12x + 5x pace | 150 | $108.7K (14%) | -$25.3K | $134.6K (12%) | -$24.7K | $146.6K (21%) |
| smoothed +-2.5 min + 3x | 122 | $103.4K (12%) | -$26.8K | $138.3K (7%) | -$22.1K | $145.1K (14%) |
| smoothed +-5 min + 3x | 121 | $108.2K (14%) | -$24.4K | $142.2K (7%) | -$20.2K | $153.8K (15%) |
| smoothed +-2.5 min, no gate | 128 | $99.8K (12%) | -$30.2K | $136.4K (8%) | -$23.7K | $134.5K (15%) |

- **15x + 2x / 3x / 5x the day's pace pass**: better on tune AND check at the same drop, and without the best 5 on both.
  3x: +$3.4K / +$1.4K. The check of this idea has now been seen several times (weaker evidence).
- **10x + 3x / 5x**: more trades (+26 / +8 a year) and more money on both halves, but the drop doubles (tune 20% vs 10%,
  year 22-24% vs 13%): not "better" by the rule (more money at the same or smaller drop). 10x without the gate loses tune
  (the gate is what makes 10x work). 12x loses tune.
- **The smoothed usual loses tune** at every width (fewer, later shocks; the check gains). Not better.
- Candidate stays 15x + 3x the day's pace (3 years: passes, filtered). 10x + 3x/5x needs its own 3-year run (new alerts:
  the research twin re-run with these shock lists and their books) before it can be judged on its drop.

**3 years, exact (2026-11-03, look 4 of the gate, look 2 of 10x and the smoothed usual).** The user: "check on 3 year";
on the smoothed usual: "regardless the results - don't you think that this is the right way to look at this? ... we
can't look on a specific minute". The shocks recomputed for 3 years (`f60_variants.py`: the live rule reproduces all
2,635 alerts of `eventse_shock15.json`, +22 from newer bars), the 20-s prefilter (`f60_prefilter.py PF_WEEK=1 PF_MAX_S=20
PF_TOP50=1 PF_AM_MIN=-999`, exactly the old list), every list through `leg_seconds.py list/stock/pick/option` and run in
the live twin (top 50, live limits, 2024-02 .. 2026-10) with the list as the shock tag. Added: two **count-matched**
smoothed versions (narrowed near 09:40 / 15:30, the bar set before the run so they fire as many 3-year shocks as 15x + 3x:
11.5x +-2.5 min 9,971, 11x +-5 min 9,882 vs 10,131), since at 15x the smoothed usual is a higher bar (29% fewer shocks:
the within-day average sits above the skewed slot's median). Data bought (approved, <= $1): stock seconds $0.13, buy
books $0.11, sale-day minute books $0.04. The picks were redone for every list (153 of the stored 2,635 shock picks had a
lower-delta contract from older settings), so the baseline is the live rule recomputed through the same steps.

| Version (2%, from $100K) | Trades (shock) | 2% (drop) | 3% (drop) | Tune P&L | Check P&L | W/o best 5 |
|---|---|---|---|---|---|---|
| Live rule (15x), same pipeline | 427 (178) | $779.4K (21.1%) | $1,577K (30.4%) | +$71.1K | +$608.3K | +$201.2K |
| **15x + 3x pace (candidate)** | 403 (151) | **$874.0K (20.1%)** | $1,864K (28.9%) | **+$112.9K** | **+$661.0K** | +$256.6K |
| 10x + 3x pace | 513 (261) | $661.4K (27.9%) | $1,201K (39.2%) | +$45.8K | +$515.6K | +$105.7K |
| 10x + 5x pace | 447 (193) | $648.5K (27.8%) | $1,181K (39.0%) | +$25.8K | +$522.7K | +$105.9K |
| smoothed +-2.5 min 15x + 3x | 373 (122) | $935.4K (21.7%) | $2,075K (31.1%) | +$77.8K | +$757.6K | +$296.7K |
| smoothed +-5 min 15x + 3x | 369 (117) | $925.0K (21.6%) | $2,044K (30.9%) | +$95.5K | +$729.5K | +$257.2K |
| count-matched +-2.5 min 11.5x + 3x | 447 (193) | $909.2K (22.6%) | $1,971K (32.2%) | +$32.3K | +$776.9K | +$165.2K |
| count-matched +-5 min 11x + 3x | 452 (196) | $870.5K (24.1%) | $1,831K (34.2%) | +$89.4K | +$681.1K | +$190.3K |

Non-giant sums (trades under +300%, tune / check): live -$245.9K / -$51.2K; 15x + 3x -$224.2K / -$38.3K (better on both:
an edge, not giants); smoothed +-2.5 -$240.6K / -$10.0K, +-5 -$233.3K / +$1.8K (worse than 15x + 3x on tune, better on
check). The count-matched versions on the live-code year (app engine, real books, $0.0006 bought): tune $93.7K / $98.4K
(drop 23%) vs $111.4K, check $135.9K / $120.0K; on that year they fire 26-30% more shocks than 15x + 3x (the 3-year match
does not hold there).

- **15x + 3x the day's pace passes exactly on 3 years**: better on tune and check, a smaller drop, better without the
  best 5, the non-giant sum better on both halves. The candidate.
- **10x + 3x / 5x fail**: less money on both halves, the drop 21% -> 28%. A lower bar adds losing shocks.
- **The smoothed usual (15x)** beats 15x + 3x on the check and on 3 years in all (+$51-61K) but loses its tune half on
  3 years and on the year (both looks), at a 1.5-point deeper drop. Not better by the rule; the same split twice.
  Count-matched it is worse (a deeper drop, the tune lost). Kept as a feature: the measure is sounder (one 60-s slot of
  20 days is noisy), the money does not show it.
- Built on Volume 1.1.0; 1.2.0 (PR #249, no shock against the day's move) went live since: 15x + 3x needs a re-check on
  top of 1.2.0 before its release.
- **10x, the 3-minute average, 3x the pace** (the user: "what about 10X, 3 minutes avg, 3X?"; usual smoothed +-1.5 min,
  narrowed at the ends; 12,248 3-year shocks vs 10,131): 3 years 500 trades (247 shock), $752.3K (drop 25.2%), tune
  +$68.4K, check +$583.9K, w/o best 5 +$180.1K, all under 15x + 3x and under the live rule. The year: tune $104.3K (22%)
  vs $111.4K, check $132.0K (11%) vs $126.6K for 15x + 3x. Fails: the lower bar again adds losing shocks and doubles the
  drop. Data $0.04 (all of this test: $0.31).

**Re-check on Volume 1.2.0 (2026-11-03, the user: "do recheck").** 1.2.0 (PR #249) skips a shock against the day's move
(>= 2 S30 since the open); both rules bite on heavy days. The year: the app engine of origin/main (82e4ee8, the 1.2.0 code,
`shockAgainstUnits` 2, the saved settings, the -80% stop, real books; 1 SLV buy window has no two-sided book in both),
1.2.0 alone and with the 15x + 3x shock list (`.shock-recompute.ts` set 1 p3). 3 years: the twin with the rule added
(`leg_seconds.py STR_SHOCK_AGAINST=2`: the 60-s move's direction from the 10-second bars, the 09:30 open, S30).

| Version, 2% (3%) | Year (drop) | Tune (drop) | Tune w/o best 5 | Check (drop) | Check w/o best 5 |
|---|---|---|---|---|---|
| 1.2.0 | $153.1K ($184.2K) 12% | $114.6K ($122.6K) 10% | -$25.1K | $133.2K ($150.5K) 8% | -$17.1K |
| 1.2.0 + 15x + 3x pace | $154.4K ($189.0K) 13% | $115.3K ($121.9K) 10% | -$25.3K | $134.4K ($153.2K) 8% | -$16.0K |

| 3 years, 2% (3%) | Trades (shock) | $100K -> (drop) | Tune P&L | Check P&L | W/o best 5 | Non-giant tune / check |
|---|---|---|---|---|---|---|
| 1.2.0 | 396 (146) | $896.0K ($1,940K) 18.7% | +$128.8K | +$667.2K | +$282.5K | -$206.5K / -$27.5K |
| 1.2.0 + 15x + 3x pace | 379 (127) | $937.4K ($2,054K) 18.0% | +$139.9K | +$697.5K | +$305.0K | -$205.5K / -$15.6K |
| 1.2.0 + smoothed +-2.5 15x + 3x | 353 (102) | $917.7K ($2,038K) 19.8% | +$107.6K | +$710.1K | +$279.7K | -$211.8K / +$6.5K |

- On top of 1.2.0 most of the gate's gain is gone: 1.2.0 already removes the heavy-day shocks (the year: 256 shocks
  skipped against the move, 212 with the gate). **The year is a tie** (+$0.7K tune / +$1.2K check at 2%; at 3% tune
  -$0.7K; tune without the best 5 -$0.2K; the drop 12% -> 13%). **3 years pass** (+$11.1K tune / +$30.3K check, a smaller
  drop, better without the best 5; the non-giant check +$11.9K, tune flat). Small; not a clear pass on the year.
- The smoothed usual on 1.2.0: loses tune again (third time), wins check.

**Released as Volume 1.3.0 (2026-11-04, the user: "release it").** PR #256 (`shockPaceMin` 3, `fast.ts shockRuleFor`),
deployed 3ae02a9 07:3x Israel, live settings switched (the owner's limits kept; rollback: version 1.2.0 in the
settings, which puts `shockPaceMin` back to 0). The trader checks both shock lists from the open (`shock` kept for the
1.2.0 backtest, `shock_p3` trades); D1 `volume_alerts` holds 30,580 `shock_p3` alerts, 2024-02-01 .. 2026-10-30, 235
stocks (`volume-data-upload.ts shock --pace 3`; = the research list on the year, 1,293 / 1,293). Gap: 2026-11-02 / 11-03
have no `shock_p3` rows (no 10-second bars on the Mac for them; the trader keeps them from 11-04). The release re-walk
on the 1.3.0 code (`.volimp.ts` w12 / w13, the same saved settings): year $151.4K (12%) vs $152.4K (13%), tune $113.4K
vs $113.2K, check $133.2K vs $134.4K at 2%: a tie, as logged; both moved by the same 14 signals vs the 11-03 run (the
earnings fetch flagged 5 fewer earnings days today; SLV 10-08 now fills), not by the change. The code review (fresh
agent): no new order path, one entry per slot; fixed before the merge: the gate switched on mid-session started its
list cold (now both lists step from the open), the parity script ignored the list (`volume-backtest-check.ts --pace`).
First week bar: the year's backtest has ~2.6 trades a week, 35% winners, median -28%; 1.3.0 removes ~1 shock in 10
vs 1.2.0. Stop criteria: a shock trade with the window under 3x the day's pace, a shock before ~10:16, or a trade the
replay does not explain -> back to 1.2.0.

### A shock must also stand out against the day's pace (2026-11-02, look 1)

The user, 2026-11-02, on the MSTR 111 Call of 2026-08-19 (a shock trade at 11:14:00): "there is no shock - look on the
image the volume bar is not special at all". Its 60-second window was 351,696 shares, 15.2x the 20-session median
(23,086) but 2.2x the day's own pace (162,237 a minute; MSTR traded ~7x usual all day). The shock passes on 15x usual OR
15x the pace, so on a heavy day a minute only ~2x the day clears it. Thesis: a shock must also be K x today's pace
(fast.ts fastState's pace, the same window), K = 2 / 3 / 5 set before the run; shocks before the pace exists (~10:16)
kept. Built on Volume 1.1.0 with the saved settings, the app's backtest year of 2026-11-02 (51 stocks, 2025-11-03 ..
2026-10-30, real books, -80% stop): each stored shock's pace from data/local/bars-10s.sqlite (27,440 shocks; 2,308 before
the pace), the failing shocks' trades removed, the account replayed (scratch `.shock-pace.ts`, `.volreport.ts`).

| Version | Trades | Tune 2% (drop) | Tune without best 5 | Check 2% (drop) | Check without best 5 |
|---|---|---|---|---|---|
| Champion (Volume 1.1.0) | 79 / 66 | $111.4K (10%) | -$27.9K | $125.2K (9%) | -$22.7K |
| Shock >= 2x the pace | 79 | $111.4K (10%) | -$27.9K | | |
| Shock >= 3x the pace | 76 | $112.0K (11%) | -$27.4K | | |
| 🎯 Shock >= 5x the pace | 72 / 60 | $116.0K (9%) | -$24.7K | $124.2K (9%) | -$23.4K |

At 3% the pick: tune $123.2K vs $116.3K, check $134.2K vs $135.8K. Year at 2%: 132 trades, $143.7K (11%) vs $140.5K
(13%). **Not better: wins tune, loses the check** (-$1.0K, and without the best 5). No traded shock was under 2x the pace
(2x removes nothing). The shock trades by pace (before the account, tune / check): before the pace 2 / 2 (median -73% /
-59%), 2-3x 4 / 2 (-32% / -50%), 3-5x 5 / 6 (-33% / +7%, one +100%), >= 5x 32 / 22 (-21% / -31%, 4 / 2 of +100%). The
under-5x shocks are 21 trades, too few to call; the check's one 3-5x giant decides it.

**Look 2, exact (supersedes the filter above).** The user: "it's not about candidate - it's about that shock means. this is
a real bug. shock is a sadden increase in the volume. to not compare it to today volume is weird. try also 10X from today.
run it on all". Removing stored alerts was not exact: a removed alert no longer starts the 30-minute cooldown, so the day's
real shock can fire minutes later. The shocks recomputed for the 51 stocks from the 10-second bars with the live rule
(fastAlerts: fresh crossing, cooldown) plus the gate (scratch `.shock-recompute.ts`); the live rule recomputed matches the
stored list 1,707 / 1,716 (the rest SPCE and USO, newer data) and is the base. Every stock-day whose shocks change re-run
in the app's engine (`.volimp.ts` SHOCKS / SHOCK_VARIANT, one-day runs; the engine used exactly the recomputed shocks on
all of them), the other days as the champion. Every version on both halves:

| Version | Shocks | Trades | Tune 2% (drop) | Tune w/o best 5 | Check 2% (drop) | Check w/o best 5 | Year 2% |
|---|---|---|---|---|---|---|---|
| Live rule (recomputed = champion) | 1,707 | 79 / 66 | $111.4K (10%) | -$27.9K | $125.2K (9%) | -$22.7K | $140.5K |
| + >= 2x the day's pace | 1,474 | 78 / 65 | $112.9K (10%) | -$26.4K | $127.2K (9%) | -$21.0K | $144.2K |
| + >= 3x | 1,293 | 75 / 63 | $114.8K (11%) | -$25.8K | $128.2K (8%) | -$20.0K | $148.9K |
| 🎯 + >= 5x | 982 | 72 / 59 | $116.7K (10%) | -$23.9K | $126.4K (8%) | -$21.6K | $149.1K |
| + >= 10x | 472 | 56 / 51 | $108.8K (10%) | -$23.1K | $133.1K (6%) | -$17.4K | $144.9K |
| 15x the day's pace only | 258 | 51 / 42 | $104.2K (14%) | -$23.2K | $136.5K (5%) | -$14.9K | $142.3K |

At 3%: 5x tune $124.7K vs $116.3K, check $139.2K vs $135.8K. **2x, 3x and 5x beat the champion on tune AND check, and
without the best 5 on both** (not a knife edge); 10x and the day's pace alone lose tune. The shock trades themselves
(before the account, tune / check): live 43 / 32, median -28% / -31%, +100% 4 / 3; 3x 38 / 28, median -26% / -18%, 4 / 3;
5x 34 / 24, median -25% / -24%, 4 / 2. The medians move up on both halves; the giants stay (5x loses one check giant).
Small money (+$1-5K a half at 2%) on ~15 fewer shock trades. Pick on tune: 5x; 3x is the steadier pass (+$3.4K / +$3.0K).
**Candidate.** Look 2 of this idea.

**3 years (look 3), the research twin** (`shock_pace_3y.py`: the 10-30 dashboard's "Live (PR #204)" = 1.1.0's twin, top
50, live limits, 2024-02 .. 2026-10, 431 trades, 165 shock; each shock trade's alert from eventse_shock15.json, its pace
from the 10-second bars; under K x skipped, the account re-walked, a skipped slot not refilled; filtered, not re-run):

| Version | Trades | 2% (drop) | 3% (drop) | Tune P&L | Check P&L | W/o best 5 |
|---|---|---|---|---|---|---|
| 1.1.0 twin | 431 | $773.1K (21.1%) | $1,548K (30.5%) | +$73.4K | +$599.7K | +$200.7K |
| 🎯 shock + >= 3x the day's pace | 405 | $822.2K (20.8%) | $1,697K (30.1%) | +$96.3K | +$625.9K | +$228.1K |
| shock + >= 5x | 378 | $811.0K (22.8%) | $1,659K (32.7%) | +$122.6K | +$588.4K | +$255.2K |

3x skips 26 shock trades: median -17%, 7 won, none of +100% (best SMCI 2024-04-19 +94%, IONQ +72%, MSTR 2026-08-19 +50%),
flat $2K -$5.7K, negative in 5 of the 6 year-halves; better on tune AND check, a smaller drop, better without the best 5.
5x skips 53 including three +100% (AVGO 2024-04-19 +621% at 4.4x, QBTS +140%, SPCX +140%): loses the check and a deeper
drop. **3x passes on the live-code year (exact) and on 3 years (filtered); 5x fails the 3-year check. The candidate is
3x.**

### More gain, more trades: floor, limits, burst sizing, runners, plan delta, news days (2026-11-02, look 1)

The user, 2026-11-02: "analyse the volume bot and find improvments - 1. improve the gain. 2. number of trades
(increasing)". On Volume 1.1.0 with the owner's saved settings (51 stocks, 3%, 15 a day, 5 open, 7.5% day loss, floor
200, delta 0.20, the -80% broker stop), the app's backtest (the live code, main 9c7767f), 2025-11-03 .. 2026-10-30, real
books only (the D1 snapshot of 2026-11-01). Temporary scripts in the app worktree: `scripts/.volimp.ts` (one run per
version, settings overrides) and `.volreport.ts` (the accounts: volumeAccount's steps with the limits as a knob and a
burst size multiple capped at the service's 5% a position; tune = even ISO entry weeks, check = odd). The runner rule is a
research-only switch in walkExit (`VOL_RUNNER`: no give-back while the option's minute bid is >= that multiple of the
buy; still out at 15:30; no overnight: 0/1 DTE cannot carry). Levels set before the run. Champion reproduced: 145
trades, $140.5K at 2% with the -80% stop (the 1.1.0 row's $142.1K is with no stop).

Tune (even weeks), from $100K:

| Version | Trades | Won | 2% (drop) | 3% (drop) | 2% without best 5 | Flat $2K sum |
|---|---|---|---|---|---|---|
| 1.1.0 (champion here) | 79 | 25 | $111.4K (10%) | $116.3K (15%) | -$27.9K | +$13.0K |
| 🎯 A no liquidity floor | 86 | 31 | $122.2K (9%) | $132.8K (13%) | -$22.5K | +$22.9K |
| B limits 30 / 10 / 15% | 80 | 25 | $110.0K (10%) | $113.3K (15%) | -$28.7K | +$11.9K |
| B no limits | 80 | 25 | $110.0K (10%) | $113.3K (15%) | -$28.7K | +$11.9K |
| C x1.5 at burst >= 2 | 79 | 25 | $116.6K (10%) | $124.3K (15%) | -$29.6K | +$13.0K |
| 🎯 C tiers x0.75 / x1 / x1.5 (burst < 1.5 / 1.5-2.5 / >= 2.5) | 79 | 25 | $121.5K (8%) | $132.2K (12%) | -$22.4K | +$13.0K |
| C x2 at burst >= 2 | 79 | 25 | $122.3K (11%) | $127.3K (16%) | -$31.8K | +$13.0K |
| D runner, no give-back at >= 1.5x | 79 | 25 | $90.1K (16%) | $84.4K (24%) | -$34.6K | -$8.7K |
| D runner at >= 2x | 79 | 25 | $97.5K (11%) | $94.8K (17%) | -$30.3K | -$0.8K |
| D runner at >= 3x | 79 | 25 | $101.5K (12%) | $101.1K (18%) | -$27.2K | +$3.4K |
| E plan delta 0.25 | 85 | 26 | $105.6K (9%) | $107.6K (14%) | -$27.8K | +$7.7K |
| 🎯 A+C | 86 | 31 | $128.8K (7%) | $142.9K (11%) | -$18.3K | +$22.9K |
| F pre-market news skip off | 103 | 28 | $94.1K (17%) | $89.8K (26%) | -$40.6K | -$3.2K |
| F both news skips off | 130 | 37 | $91.4K (18%) | $88.1K (24%) | -$45.3K | -$5.7K |

Check (odd weeks), the picks only:

| Version | Trades | Won | 2% (drop) | 3% (drop) | 2% without best 5 | Flat $2K sum |
|---|---|---|---|---|---|---|
| 1.1.0 | 66 | 25 | $125.2K (9%) | $135.8K (13%) | -$22.7K | +$26.4K |
| A no liquidity floor | 67 | 25 | $117.8K (9%) | $124.6K (13%) | -$26.5K | +$20.5K |
| C tiers | 66 | 25 | $113.7K (8%) | $120.4K (12%) | -$20.7K | +$26.4K |
| A+C | 67 | 25 | $108.8K (9%) | $112.2K (13%) | -$23.3K | +$20.5K |

Year: 1.1.0 $140.5K (13%), A $143.9K (10%, 153 trades), C $138.9K (11%), A+C $140.8K (9%); median trade -28% in all.

- **No candidate.** Every pick wins tune and loses check (A -$7.4K, C -$11.5K, A+C -$16.4K at 2%). No floor won the
  3-year research of 2026-10-30; on the live code's year it is a tie (all its gain in the tune half), and 9 more of its
  alerts have no book at the sale (11 vs 2): fill unproven.
- **The limits do not bind this year**: looser or none adds one trade. More trades must come from alerts, not caps.
- **The funnel** (9,501 alerts): plan slow cross 3,568, pre-market news 3,221, burst 730, earnings 100; shock slow
  cross 588, pre-market 397, no 0-2 DTE expiry 345, burst 149; too cheap 115, thin 42, no history 54; traded 169 (145
  after the account).
- **News days with today's filters** (first time: the 2026-10-27 study ran before the cross and burst filters): the
  pre-market skip alone removes 49 trades (before the account), average -40%, median -45% (tune -45% / check -45%),
  none of +100%; every slice by plan / shock, burst, time of day and option price is negative on both halves. Both
  skips off adds 136 trades, average -15%, median -35%, 6 of +100% (on earnings days). Keep both skips; a news-day
  strategy needs its own alert (volume against the same day's earlier minutes, 2026-10-27), not a cut of this one.
- Burst tiers cut the drop and the "without the best 5" loss on both halves, but the check's money sits in low-burst
  trades they size down. Runners give the move back at every level. Plan delta 0.25 loses on tune.
- Benchmark: the card "Test of 2 Nov 2026" on the Volume Bot page (dataset `tests1102`).

### No shock against the move (2026-11-02, look 1)

The user, on ORCL 2026-10-28 14:49 (a "down" shock 30 min after a +12% shock run): "we do not want to take against
the huge swing.. it is not a shock". Skip a shock alert whose direction is against the stock's move, since the open or
since its last shock that day, once that move is >= X S30 (2, 3, 5, set before the run). Volume 1.1.0 parts, 51 stocks,
2025-11-03 .. 2026-10-30, live limits (scratchpad `againstmove.ts`; opens from D1 minute bars).

| Version | Trades | $100K at 2% (3%) | Drop | Tune | Check | Without best 5 |
|---|---|---|---|---|---|---|
| 1.1.0 | 145 | $142.1K ($162.1K) | 13% | $111.9K | $125.6K | -$23.6K |
| since the open >= 2 | 133 | $149.4K ($177.3K) | 12% | $115.3K | $128.5K | -$18.1K |
| since the open >= 3 | 135 | $148.2K ($174.6K) | 12% | $114.7K | $127.9K | -$19.2K |
| since the open >= 5 | 140 | $143.1K ($163.9K) | 13% | $111.7K | $127.1K | -$22.8K |
| since the last shock >= 2/3/5 | 145 | $142.1K | 13% | same | same | same |

- Since the open >= 2 skips 351 shock alerts and 13 of 1.1.0's trades: flat $2K -$5.9K, median -31%, no +300% trade
  (best of them MSFT 01-21 +84%). >= 3: 11 trades, -$4.8K. Better on both halves and without the best 5, but the gain is
  ~a dozen ordinary losers in one year; no 3-year check (the app engine has the year's data only).
- Since the last shock: no trade of 1.1.0 is skipped (ORCL 14:49 was already refused: the first trade still open).


### Start at 10:00, not 09:40 (2026-11-02, look 1)

The user: "starting from half hour after opening?" Every alert (or plan alert) before 10:00 (09:50) dropped; the live
code's year (`pr_` parts, 51 stocks, limits on) and the 3-year research twin (re-walked from its dollars). Filtered,
not re-run (a burst running into 10:00 would make a fresh first alert there: not counted). Scratchpad `from10.ts`.

| Version, 2% (3%) | Year: $100K -> / drop | Year tune / check | 3 years: $100K -> / drop | 3y tune / check P&L | 3y w/o best 5 |
|---|---|---|---|---|---|
| 1.1.0 (09:40) | $142.1K ($162.1K) / 13% | $111.9K / $125.6K | $773K ($1,548K) / 21.1% | +$73.4K / +$599.7K | +$200.7K |
| from 09:50 | $132.9K ($146.7K) / 14% | $103.7K / $126.9K | $739K ($1,454K) / 19.0% | +$46.6K / +$592.4K | +$184.4K |
| from 10:00 (plan + shock) | $134.8K ($153.6K) / 13% | $107.0K / $126.8K | $679K ($1,285K) / 17.3% | +$28.8K / +$550.0K | +$163.2K |
| from 10:00 (plan only) | $133.1K ($147.0K) / 14% | $104.9K / $125.6K | | | |

Verdict: not better. 09:40-09:59 is a median loser (3y: 52 trades, median about -35%), but it holds a few +200-290%
trades (HIMS 2025-02-13, INTC 2026-01-07, GOOG 2026-09-18) that pay for it; a later start gives up more than it saves
(a smaller drop only).

### Buy from the open; on the open only "good vs SPY in the pre-market" (2026-11-02, look 1)

The user: "Regarding the first 20 minutes: that is because we are allow only on 1540. I would like to buy from the
opening if possible. Lets try." then "On the open - go only with those with was good vs spy in the pre market". The
live code (origin/main cf1c57f), live saved settings (1.1.0), 51 stocks, 2026-05-01 .. 10-30, limits on. The plan
alert's 3-minute window vs the same minutes of 20 days makes 09:33 the earliest (firstMinute 3; the stored shock list
starts at 09:40, so only the plan moves). Pre-market vs SPY: the last pre-market price vs the prior close, less SPY's
(SPY minute bars from Alpaca). Scratchpad `open_driver.ts`, `openacct.ts`, `openp.ts`, `premkt.py`.

- **From 09:33: no new trade** (80 trades, $117.4K, = 09:40). Of the 269 plan alerts 09:33-09:39: 178 on pre-market
  skip days (pre-market volume >= 4x), 14 earnings, 33 no 15-s cross, 29 burst, 15 no book / too cheap / thin.
- **The pre-market skip off for the early alerts** (the user's filter needs those days): still no alert before 09:40
  trades (of 311 early alerts on those days: 129 earnings, 64 no cross, 68 burst, 17 no book); the early buys are
  09:41-09:50.

| Version (6 months, 2%) | Trades | $100K -> (3%) | Drop | Tune / check | News-day trades |
|---|---|---|---|---|---|
| 1.1.0 | 80 | $117.4K ($127.2K) | 13% | $105.5K / $112.1K | - |
| + news-day alerts before 09:50 that agree with pre-market vs SPY | 86 | $115.5K ($123.5K) | 15% | $104.9K / $110.9K | 6, 2 won, median -28%, -$1.7K |
| + those against it | 85 | $113.1K ($118.8K) | 14% | $104.7K / $108.6K | 5, 1 won, median -25%, -$3.9K |
| pre-market skip off all day | 103 | $100.4K ($98.9K) | 19% | $99.5K / $101.0K | 23, 3 won, median -39%, -$15.0K |

Verdict: not better. The pre-market skip earns its keep; on news days the SPY-agreeing side loses less than the other
side but still loses (worse on tune and check).

### Roll at +400% into a 0.30 delta (2026-11-02, look 1)

The user: "Can you test a rolling strategy? Say we are on 400%, sell all and buy 0.3 delta at 50% from the money. Check
this on last 6 month first." Read: the first minute book with the bid >= 5x the buy sells all; 50% of the proceeds buys
the 0.30-delta strike (same side and expiry; delta by Black-Scholes from each strike's mid on its real book), the rest
stays cash; the new leg sells at the trade's own exit minute (the give-back is on the stock) at that minute's bid.
Volume 1.1.0 live-code year (`pr_` parts, 51 stocks, limits on), `volume_roll400.py` + scratchpad `rollacct.ts`.

| Version | 6 months (05-01 on) 2% (3%) / drop | Year 2% (3%) / drop | Year tune / check |
|---|---|---|---|
| hold (1.1.0) | $117.5K ($127.1K) / 13% | $142.1K ($162.1K) / 13% | $111.9K / $125.6K |
| take all at +400% | $120.6K ($130.8K) / 14% | $124.4K ($136.0K) / 15% | $110.5K / $112.3K |
| roll 50% into 0.30 | $113.8K ($120.9K) / 14% | $135.1K ($153.2K) / 14% | $105.9K / $127.9K |
| roll 100% into 0.30 | $107.7K ($110.9K) / 14% | $144.4K ($166.5K) / 14% | $101.1K / $142.9K |

7 trades in the year touched +400% (5 in the 6 months). The new 0.30 leg lost on 6 of 7 (-63% GOOGL 08-05, -21% SLV,
-16% QCOM, -14% ORCL, -14% QQQ, +3% META 05-27 [the books held only 0.47 delta there]) and won once: META 2026-04-08
(+299%, the trade went on to +1258%). The roll gives back part of each winner's last leg; the year's gain for the
100% roll is that one trade. Verdict: not better (worse on 6 months and on tune at every share).

### No shock against the last hour's move, 3 years (2026-11-02, look 3) + the first 20 minutes

The user: "can you run it on the whole test?" and "how many bought we had in our 3 y test that are in the first 20
minutes? give me full report". `volume_against_hour_3y.py` on the 10-30 dashboard's trades ("Live (PR #204)" =
1.1.0's twin, top 50, live limits, 2024-02 .. 2026-10, 431 trades, 165 shock). The alert's direction is not in the
export: the alert price vs the close 2 minutes before (99.2% right on the 1,714 year alerts with the true direction).
The account is re-walked from the export's dollars; a skipped trade's slot is not refilled.

| Version | Trades | 2% (3%) | Drop 2% (3%) | Tune / check (2% P&L) | W/o best 5 | Skipped (flat $2K) |
|---|---|---|---|---|---|---|
| 1.1.0 twin | 431 | $773.1K ($1,548K) | 21.1% (30.5%) | +$73.4K / +$599.7K | +$200.7K | - |
| last hour >= 2 S30 🎯 | 418 | $835.0K ($1,739K) | 19.5% (28.3%) | +$94.2K / +$640.7K | +$239.0K | 13, -$7.6K, median -33%, 3 won, no giants |
| last hour >= 3 S30 | 421 | $809.3K ($1,659K) | 19.5% (28.3%) | +$83.5K / +$625.8K | +$222.1K | 10, -$4.5K |
| since the open >= 2 S30 | 404 | $866.9K ($1,846K) | 18.5% (27.0%) | +$115.3K / +$651.6K | +$267.2K | 27, -$11.0K, 6 won (MSFT +84%, AVGO +75%) |

Better on tune and check, every version, every year of the skipped trades negative (2024 1, 2025 8, 2026 4 for the
last hour). The pick on tune would be "since the open" (look 1's rule), which also wins on check. Look 3 of the idea.

First 20 minutes (bought 09:30-09:49; nothing before 09:40, the plan's first alert minute): 37 of 431 trades (34 plan,
3 shock), 30% won, avg +6%, median -31%, no +300%; +$11.9K of the +$673.1K at 2% (-$63.3K without their best 5);
tune +$24.3K, check -$12.4K; 2024 +$2.7K, 2025 -$16.1K, 2026 +$25.3K (INTC 2026-01-07 +240%, GOOG 2026-09-18 +227%).
Without them: $739.0K (drop 19.0%) vs $773.1K. By buy time: 09:40 23 trades median -34%; 09:45 14, -20%; 09:50 15,
-37%; 10:00-10:29 64, -19%; 10:30-11:29 109, median +6%, 17 of the 28 giants; after 11:30 206, -27%.

### No shock against the last hour's move (2026-11-02, look 2)

The user: "check - against the last 1 hour, and only big move comparing to the movement this day". Same as look 1, but
the move is the last 60 minutes (H, the last closed minute an hour before the alert), at least x S30, and at least a
share of the day's high-low range so far (R). Volume 1.1.0 parts (`pr_`), 51 stocks, 2025-11..2026-10, limits on,
2% (3%). Scripts: scratchpad `hourctx.py` + `againsthour.ts`.

| Version | Year 2% (3%) / drop | Tune 2% | Check 2% / drop | Check w/o best 5 | Trades skipped (flat $2K) |
|---|---|---|---|---|---|
| 1.1.0 | $142.1K ($162.1K) / 13% | $111.9K | $125.6K / 9% | -$22.3K | - |
| look 1: since the open >= 2 S30 | $149.4K ($177.3K) / 12% | $115.3K | $128.5K / 9% | -$19.7K | 13, -$5.9K, median -31% |
| last hour >= 2 S30 🎯 | $149.0K ($175.7K) / 12% | $116.4K | $127.5K / 8% | -$20.7K | 6, -$5.4K, median -36% |
| last hour >= 3 S30 | $143.9K ($168.2K) / 12% | $113.2K | $126.3K / 9% | -$21.8K | 3, -$2.1K |
| last hour >= 50% of R | $144.6K / 13% | $113.9K | $125.6K / 9% | -$22.3K | 2, -$2.3K |
| last hour >= 2 S30 and >= 50% of R | $144.6K / 13% | $113.9K | $125.6K / 9% | -$22.3K | 2 |
| last hour >= 3 S30 and >= 50% of R | $143.6K / 13% | $113.2K | $125.6K / 9% | -$22.3K | 1 |
| ... >= 75% of R (any x) | = 1.1.0 | | | | 0 (12 alerts) |

Pick on tune: last hour >= 2 S30 (no range share). Check: +$1.9K vs 1.1.0, drop 8% vs 9%, better without the best 5.
The "big against the day's range" condition removes almost every skipped trade: the losing counter-moves came after
an hour that was a modest part of a wide day; only ORCL 14:49 (+19 S30, 83% of R) and BABA 11-14 13:30 are both. The
six skipped trades: USO 10-20 +8%, HIMS 07-29 -33%, IREN 10-28 -36%, GOOGL 05-19 -47%, NBIS 11-13 -81%, BABA 11-14 -82%;
no giants. One year, 6 trades: weak evidence; same verdict as look 1 (helps a little, needs the 3-year check).

### Live gets the research's shock touch rule (20 s) and the too-cheap rescue; TQQQ SOXL SMH out (2026-11-02, PR #236)

The user, 2026-11-01/02: "the volume bot was very profitable" (the 10-30 dashboard, +34% on the last 12 months) vs
the live code's year run (+7.6% at 2%). Year 2025-11-03 .. 2026-10-30, the app engine (live code), live settings and
limits, real books (strictQuotes; the year's books bought for $11.51 the same day), parts in the scratchpad
(`.volyear.ts`, `.oldrules.ts`, `ladder.ts`). The difference, one step at a time (54 stocks, 2%, flat $2K a trade):

| Step | Trades | $100K at 2% (3%) | Drop | Flat $2K |
|---|---|---|---|---|
| 1 live (with the -60% broker stop) | 242 | $107.6K ($103.9K) | 38% | +$18.3K |
| 2 no stop | 241 | $116.9K ($118.3K) | 33% | +$27.3K |
| 3 no ETF shock alerts | 220 | $94.7K ($89.5K) | 30% | +$2.9K |
| 4 + shock touch within 20 s (f60_prefilter PF_MAX_S=20) | 140 | $123.6K ($134.1K) | 15% | +$28.1K |
| 5 + too-cheap-and-thin rescue (STR_LIQ_OLD) = the research rules | 148 | $137.8K ($155.0K) | 15% | +$37.7K |

Step 5 reproduces the dashboard on the same months (+$37.7K vs +$35.4K flat; 129 trades shared, +$32.2K vs +$32.8K).
- The -60% stop cost ~$9K; the ETF shocks +$24.4K, nearly all SMH 2026-10-08 (+$27.9K).
- The 20-s touch cut 81 slow shocks (-$17.8K) and halved the drop; side found after 60-300 s: 67 trades -$21.5K.
- The rescue: 8 plan trades +$9.6K, mostly SLV 2026-08-28 (+$8.3K).
- The "alignment" of 2026-11-01 had moved the research to the app's 300 s; the user: "the 300 seconds is in there by
  mistake". The 3-year 20 vs 300 s test was waived (NOT RUN in the release gate; ~2,000 slow shocks of 2024-25 have no
  data).
- Shock filters tested the same night on the year (live, pause 30, 3%): news days, any burst, 3-4 DTE, 3 checks, all:
  every one lost to live (all four together: $100K -> $17.4K). Plan only beat live on the 54 (+$4K at 2%, half the drop).
- Stop sweep, Aug-Oct, stop 60 everywhere, shock pause 0/5/10/15/20/30: 30 (live) best ($127.2K at 2%), mostly SMH 10-08.

Released (PR #236, deployed 2026-11-02 07:07 Israel, trader + website): `shockRules.touchWithin` 20 (live stores
`touched`, also from the tape's 10-s bars at creation), the rescue in `legAt` (with liquidFallback), the saved list 51
names (TQQQ, SOXL, SMH out; SLV, USO stay), the -60% stop kept. Parity: the PR's code on the year = the switch run,
9,501 alerts identical (13 fallback labels reworded). PR code year, 51 stocks, no stop: 145 trades, $142.1K at 2%
(13% drop), $162.1K at 3%; tune $111.9K, check $125.6K; -$23.6K without the best 5.


### The research aligned with the app's backtest: the live rules, on by default (2026-11-01)

The user, 2026-11-01: the app's Backtest page and the research must make identical trades; the app (it mirrors the live
bot) is the yardstick. A trade-by-trade comparison (live saved settings, 54 stocks, 2026-07-31 .. 2026-10-30, 3% a trade,
live limits) found the trades the two shared priced the same to the cent (31 of 31), but 43 app-only and 8 research-only
trades and 2 on another strike. The research's causes, fixed here, each on by default (an env switch reproduces the old):

- **The shock list's 20-second prefilter** (`f60_prefilter.py`): an alert was kept only when the stock touched a side
  line within 20 s, though the shock rule waits 300 s for its 5 checks in a row: 21 of the app-only trades. Now
  `PF_MAX_S` 300 by default (a superset for the 15-s cross, which leg_seconds still applies). Old: `PF_MAX_S=20`.
- **No ETF shocks**: the prefilter kept only strangle_rank's top 50, so SLV TQQQ SOXL SMH had no shock alerts (10
  trades). Now every stock of the alert file. Old: `PF_TOP50=1`.
- **The lists ended early**: the 0/1 DTE plan days stopped at zero5.SPAN (2026-10-12), the shock list at 2026-10-22.
  `leg_seconds.py list` takes `SEC_TO` (every 0/1 DTE day, or same-week day, from SEC_FROM to SEC_TO; fast lists too).
- **The liquidity fallback's direction and the too-cheap rescue** (`leg_fallback.choose`, the "liquid" mode that
  `plain20` / `lqN` / `step35` use): as the app's `strangle/pick.ts` legAt + `bot/picker.ts` liquidOrder: a pick under
  $0.20 is no trade (before, a pick both too cheap and thin was rescued: SLV 2026-08-28 +$13.6K); a thin pick tries
  further out only down to delta 0.25 (for a 0.20 pick: none), then toward the money up to 0.50 (before: further out
  first, down to 0.10). Old: `STR_LIQ_OLD=1`. Every Volume-bot script on that mode changes (leg_export, leg_fb2,
  leg_spread, leg_friday*).
- **Alerts in time order**: a shock and a plan alert of a stock in the same minute now go by their second (the shock
  inside the minute first), as the live bot. Old: `STR_ORDER_MINUTE=1`.
- **The day's first plan alert**: the first alert minute from 09:40 counts even when 09:39 had one (strangle.ts, the app's
  dayAlerts); before, it needed a quiet minute before it. Old: `SEC_OLD_FIRST=1`.

New lists, 54 stocks (the live list), 2026-07-31 .. 2026-10-30: `v54` (0/1 DTE, 426 alerts), `v54w` (same week, 202),
`e_shock15v54` (shock: `shock15_v54.json` 590 alerts = D1's 581 + 9 of 10-29/30 not uploaded yet, prefiltered to 537),
all with `SEC_AM_PRE=1.1` (a burst either way, a superset of the live burst filters).

Data with no purchase (the user, 2026-11-01: "free"; $0.06 of stock seconds and about $1 of books would have been the
Databento cost): `SEC_STOCK_DB` (a copy of the app's D1 after its run: the research's windows and the ones the app built
from Alpaca's trades, looked up as the app does: the window starting nearest at or before the alert, covering 15 s /
300 s) and `SEC_BOOKS_DB=data/local/alert-books.sqlite` (the 1-second books merged over every stored window around the
buy, as the app's D1 option_seconds; the minute books for contracts dbx_cache lacks, `leg_realspread.quotes`). Off unless
set; a sec_cache file still wins for the stock.

Result, live settings, 3% a trade, live limits, $100K, 2026-07-31 .. 2026-10-30 (`STR_SHOCK_TAG=e_shock15v54`, tags
above; the app from fix/backtest-align with the stock-window `ORDER BY start DESC`):

| Engine | Trades | Won | $100K becomes | Worst drop |
|---|---|---|---|---|
| App backtest (the page's handler on a D1 snapshot) | 75 | 26 | $142,671 | 14.2% |
| Research (leg_seconds.py run, live3, "shock <= 30%, burst >= 0") | 75 | 26 | $142,671 | 14.2% |

All 75 trades identical (contract, entry second, exit minute, buy, sale, P&L); 16 more alerts refused the same way by
both accounts. Before the alignment the same period gave the research 41 trades, $127,818 (7.9%). Gaps both share:
5 shock alerts with no 1-second book at the buy (SLV x2, RGTI, TQQQ, COIN), and 9 shocks of 2026-10-29/30 (RGTI, SPCE,
USO) not yet in the app's D1 (`volume-data-upload.ts shock`), 5 of them past the prefilter with no stock seconds to run
on; the app also has 7 shocks with no priced strike (SPCE x5, AVGO 2026-09-02, F).

### Random side: the side carries the result, not luck on wild days (2026-10-31)

The user, 2026-10-31: "do #2" (the outside audit's control test). `random_side.py` (`fetch`, `run`): the 430 trades of
the audited live run ($782,861, `live_ask` "[flat2] shock <= 30%, burst >= 0"; the dump reproduces it exactly) again
on the OTHER side: same trigger second, same version (plain20 / the shock's step35), same expiry, the opposite right,
bought on its real 1-second book, the give-back walked the other way, sold at the real minute bid (Databento, new books
in `data/random_side/`). 80 trades have no opposite contract (under the $0.20 / 200-contract floor after the move),
3 no quote: 347 pairs. Then 200 seeds flip a coin for each trade's side. 2% a trade, $100K.

| View (347 pairs) | Bot's side | Other side | Random: median (10-90th) | Random >= bot |
|---|---|---|---|---|
| flat2, 3 years | $445,879 | $17,769 | $100,497 ($64K-$152K) | 0/200 |
| flat2, without 2025-10-10 | $217,334 | $22,661 | $73,177 ($51K-$106K) | 0/200 |
| flat2, tune (to 2025-07) | $172,479 | $47,622 | $94,718 ($74K-$116K) | 0/200 |
| flat2, check (2025-07 on) | $253,793 | $36,052 | $106,609 ($73K-$152K) | 0/200 |
| flat2, check without 2025-10-10 | $124,489 | $46,681 | $78,276 ($54K-$106K) | 4/200 |
| live limits, 3 years | $266,767 | $22,021 | $82,179 ($54K-$117K) | 0/200 |

Per trade, net: bot's side 38% won, +28.9% average, median -25.2%, +8.0% without its best 10; other side 23% won,
-24.9%, median -34.9%; both sides half each (a strangle) +2.0%, median -14.7%. Bot's side minus other side +53.7
points a trade (t 5.3), median +12.9, +37.8 without 2025-10-10.

- The options were priced fairly (the strangle is about flat): everything is the side. Following the move after a
  fast cross with the burst the same way beat fading it by a wide margin, in both halves and without 10-10.
- Caveat: the cross-15 s and burst filters were chosen on these years by the bot's side's results, which by
  construction also picks alerts where the other side lost; the check half was seen while choosing. The unfiltered
  rule's side was right 49.7% of the time. Next: the same test on the unfiltered alerts, and the frozen version on paper.
- The 83 unpaired trades are left out of every column (the bot's side on the 347 is $445,879, not $782,861).

### The live rules replayed: $608,664 at the live floor, not $782,861 (2026-10-31)

The user, 2026-10-31: "good so lets open the volume for backtesting on the app". The app's backtest
(`packages/trading/src/strangle/backtest.ts`, app PR #224) replays the live bot's own code: the plan's minute alert,
the shock alert, the news filter, the expiry, the side on 1-second prices (the 15-second cross, the shock's 5 checks
within 300 s), the burst, the leg (`strangle/pick.ts`, shared with the trader), the buy 2 s after the side at the mid +
a quarter of the spread with the chase to the ask, the give-back on minute closes, the sale at the bid, the account as
leg_twice "flat" + leg_daycap. It was checked against leg_seconds.py's audited run (`audit/nofloor_ask` and
`audit/live_ask`, `STR_WALK_KEEP=1 STR_CHASE_NOFILL=ask`, flat2 2%) on the research's own caches, the same alerts,
news verdicts and 1-second books (`scripts/volume-backtest-check.ts` in the app repo), trade by trade:

| Run (2024-02-01 to 2026-10-22, 54 stocks) | Trades | Avg a trade | $100K becomes (drop) | Live limits | Same as the research |
|---|---|---|---|---|---|
| Research, no floor (the $1,011,767 row) | 467 | +35.7% | $1,011,767 (22.2%) | $426,679 | |
| Engine, research alerts, no floor | 426 | +35.5% | $827,157 (18.8%) | $393,657 | 406 identical (contract, buy, sale, exit) |
| Engine, its own alerts, no floor | 428 | +35.4% | $830,895 (18.8%) | $395,274 | 406 identical |
| Research, floor 200 (the $782,861 row) | 430 | | $782,861 (21.1%) | $392,938 | |
| **Engine, floor 200 = the live rule (delta 0.20, plan + shock)** | 403 | +33.1% | **$608,664 (19.1%)** | $309,564 | 367 identical |
| Engine, no floor, minute books only (no 1-second book) | 457 | +23.1% | $361,219 (23.8%) | $187,392 | 27 identical prices |

The gap is the research's, three causes:

- **A silent fallback strike.** `STR_PLAN_V=lq0>plain20` (and the shock's `lq0>step35`) keep "the first version that
  has a trade": when the 0.20 contract was under $0.20, or had no book at the buy or the sale, the research traded
  plain20's liquid strike instead. The live bot skips those (too cheap, or no fill). No floor: 41 plan trades,
  +$156,008, one of them SLV 2026-08-28 +$78,444; and 6 shock trades.
- **A same-minute tie.** A plan alert and a shock alert of a stock in the same minute: the research took the plan's
  trade (its list order); the shock fires inside the minute, so the live bot watches it first and the stock is busy
  for the plan. The engine keeps the time order (13 such pairs).
- **The strike direction at the floor.** When the 0.20 leg trades under 200 contracts in 30 minutes, the live
  `liquidOrder` tries only toward the money (0.25-0.50); plain20 (leg_fallback LOW 0.10) went further out first (0.10
  to 0.20). 20 of the 430 floor-200 trades get another strike, and some thin legs plain20 rescued further out are no
  trade live.

So **the live rule (delta 0.20, floor 200, plan + shock, flat2 2%) is $608,664 with a 19.1% worst drop, not
$782,861**, and $309,564 (19.2%) with the live limits; the no-floor candidate is $827,157 (18.8%), not $1,011,767. No
floor still beats the floor by about the same ($218K vs $229K). The alerts agree: the engine's plan alerts include all
16,026 of the research's (its extras were never listed, burst pre-filter, and trade twice), and the live shock rule
(`fast.ts` `fastAlerts` + `shockRule`) reproduces all 320 research shock alerts of Feb-Apr 2024. Minute books alone are
not enough for the buy ($361,219): the app backtest needs the 1-second books in D1 (`option_seconds`: sec_cache, the
alert books backfill, and the live trader's alert books after each close).

### Status at the end of 2026-10-27 (read this first)

- Top 50, 3 years, today's rules: -8.9% a trade (fresh run; the -9.1% of the morning moved with quotes added later in
  the day). 1,610 trades, 2.4 a day, side right 49.7% of the time (`dir_label.py`).
- The backtest's exit is the walk on minute closes; the live bot checks every 10 s and does worse (-11.9% a trade):
  move the live give-back to minute closes (not done, needs the user's go).
- Best candidate so far: only alerts whose stock crosses the side line within 15 s and whose burst points the same way,
  no give-back for the first 30 minutes: 301 trades, +15.9% a trade, $100K -> $151,387, worst drop 11.2%, positive in
  every year and both halves, but -$2,275 without the best 5 trades. The 30-minute grace looks like a peak (20 and 45
  minutes are weaker), so part of it may be luck. Not live.
- Done: the benchmark and both filters at 1-5% a trade, and with no limits at 1-3% ("Size a trade", below). Still
  to run: the rest of the sweep (burst 0.8 / 1.5, never stop), one batch at a time.
- Without 2025-10-10 the burst >= 0 filter's check half is flat ("One day carries the check half"); burst >= 1.1
  holds up better: +13.4% a trade without that day, positive every year.
- Dashboard: https://claude.ai/artifact/99VCgkWj9ZegAW3pMBitdg (both strategies, every trade, "how a trade works").
- Direction plan: `volume-direction-plan.md` (order flow from Databento tbbo is the next big test).

### F60x2 over 3 years (2026-10-29)

The 10-second bars for the top 50 back to 2024-01-02 (scripts/build-10s-bars.ts, 22,694 stock-days, 5.4 billion trades,
15 hours). `f60_alerts.py` (the study's R60 / K=2 rule, a 30-minute cooldown, 09:40-13:00; 597 of the study's 603 alerts
on NVDA / TSLA / AAPL reproduced): 67,434 alerts; `f60_prefilter.py` kept 649 (38,638 no 0/1 DTE, 22,695 no line within
20 s, 4,905 burst < 1.1). Stock seconds, picks; options at the minute bar's middle +- 3% (`STR_FILL=bars`, calibrated to
within 4% of real). Winner rules, 2%:

| Alert | Limits | Trades | Avg | $100K becomes, drop | Without best 5 | Tune / check |
| --- | --- | --- | --- | --- | --- | --- |
| live alert | live | 196 | +25.6% | $235,591, 16.0% | +$19,115 | +31.2 / +20.8 |
| live alert | none | 232 | +41.0% | $379,238, 18.0% | +$110,695 | +25.6 / +52.6 |
| F60x2 | live | 184 | +29.7% | $221,653, 15.8% | +$26,944 | +1.1 / +52.1 |
| F60x2 | none | 199 | +27.8% | $212,117, 16.3% | +$18,600 | +0.5 / +46.9 |
| live + F60x2 | live | 348 | +21.5% | $314,314, 18.6% | +$59,790 | +12.6 / +29.1 |
| live + F60x2 | none | 421 | +36.3% | $583,878, 22.9% | +$239,570 | +15.2 / +51.4 |

F60x2 alone matches the live alert on money but makes it all in the check half (tune +1%). Added to the live alert
(one account, 2 a stock): +$205K at no limits, nearly twice the trades, a 5-point deeper drop, a weaker tune half.
A candidate; next: real quotes for its trades, then with the same-week and ETF additions.

### More tickers: 25 candidates, then 4 ETFs on real quotes (2026-10-29)

25 names outside the top 50 (no large caps): the ranking's 51-60 (SQQQ SNDK RDDT PATH IBM ADBE ARM NOW SHOP VRT), ETFs
(TQQQ SOXL SMH TLT SLV) and momentum names (APP CVNA AFRM UPST MARA RIOT RIVN SNAP PYPL DKNG). Free screen (minute bars,
3 years): 2,138 alerts with a burst >= 1.1 on 0/1 DTE days, 96 same-week at 2.5 (TQQQ SLV MARA RIOT SNAP had no bars in
the store: fetched). Stock seconds (Databento) and picks for those; options priced first from Alpaca minute bars
(`STR_FILL=bars STR_SH=0.03`: the bar's middle +- 3%). Calibration on the winner (top 50, 194 trades): +-3% $235,591 vs real
$226,355 (within 4%); `STR_FILL=bs` (the stock's second, Black-Scholes at the bar's implied volatility) is closer trade by
trade (buy 5.7%, sale 4.4% typical error vs 6.5% / 7.1%) but overprices the big winners' sales ($328,438): +-3% bars stay
the screen. All 25 with the top 50 (no limits, 2 a stock, same-week 2.5): +-3% $628,844 / 17.3% vs $533,002 / 19.6%; the
gain is 4 ETFs (SLV +$39K, TQQQ +$27K, SOXL +$18K, SMH +$14K at +-3%); single stocks mostly lose (PYPL -$20K, RDDT, CVNA,
SQQQ, APP, DKNG, ARM) or rarely trade. The 4 ETFs on the real book (47 option windows, 59 minute-quote contract-days):

| Stocks | Pricing | Trades | Avg | 2%: $100K becomes, drop | 3% | Without best 5 | Tune / check | Check without 2025-10-10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| top 50 | real | 258 | +44.7% | $513,337, 21.9% | $932,345 | +$119,559 | +23.5 / +62.0 | +15.8 |
| top 50 + SLV TQQQ SOXL SMH | real | 305 | +46.4% | $625,755, 23.6% | $1,182,664 | +$167,758 | +19.2 / +69.8 | +14.7 |
| same | +-3% | 307 | +45.9% | $699,366, 20.8% | $1,396,200 | +$233,833 | +22.5 / +66.3 | +15.2 |
| same | +-5% | 307 | +40.1% | $522,397, 21.9% | $919,426 | +$145,489 | +17.7 / +59.7 | +10.7 |

On real quotes every ETF wins: SLV 11 trades +$30.9K, TQQQ 15 +$19.1K, SOXL 10 +$20.7K, SMH 13 +$7.7K (49 trades, +53% a
trade, +$78K at 2%). Adopted for the bot's list (chosen after seeing them: 10-15 trades a name).

### Production (2026-10-29): same-week expiries, no-limit caps

PR #199 (38a3479), deployed 2026-10-29 06:04 UTC (before the open): `weekExpiry` (on) with `burstMinWeek` 2.5; the caps
can go to 100 trades a day, 50 open, a 100% day loss; connector tools `volume_bot_account_risk` /
`volume_bot_update_account_risk` for the trading service's risk rules on the bot's account (buys a day 10, open risk
10%, the 12.5% drawdown brake by default: tighter than the backtest). 715 tests; `volume-replay.ts` 2025-10-27: QCOM's 4 DTE
call bought 10:01:01, sold 10:33, as the backtest. To match the backtest live, save: the top 50, Favorites off, 2%,
delta 0.20, 100 trades a day, 50 open, a 100% day loss, 2 a stock; and on the account: buys a day 100, open risk 0 (no
limit), max open positions 0, day loss 25%, drawdown brake 50%.

### No limits on the candidates (2026-10-29)

The user: run the candidates without limits (no day-loss stop, no trade or open cap, any number of trades a stock,
overlapping too: `STR_ACCOUNTS=free2,free3 STR_PER_STOCK=99`). Top 50, Feb 2024 - Oct 2026:

| Version | Trades | Avg | 2%: $100K becomes, drop | 3% | Without best 5 (2%) | Tune / check | Check without 2025-10-10 | 2% without 2025-10-10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| winner, live limits | 194 | +25.4% | $226,355, 18.1% | $320,189 | +$1,699 | +28.9 / +22.5 | +1.2 | $155,460 |
| winner, no limits (2 a stock, yesterday) | 230 | +41.6% | $365,206, 20.3% | $555,819 | +$85,125 | +23.6 / +54.9 | +3.0 | $152,148 |
| winner, no limits (any per stock) | 245 | +38.1% | $349,925, 21.6% | $531,571 | +$81,232 | +20.1 / +52.1 | +4.1 | $148,027 |
| + 2-4 DTE burst >= 2.0, no limits | 311 | +37.2% | $510,683, 26.1% | $920,647 | +$126,178 | +20.7 / +51.2 | +13.2 | $217,238 |
| + 2-4 DTE burst >= 2.5, no limits | 275 | +41.4% | $502,621, 23.3% | $907,189 | +$121,818 | +21.4 / +58.4 | +16.0 | $213,002 |
| + 2-4 DTE burst >= 2.5, no limits, 2 a stock | 258 | +44.7% | $513,337, 21.9% | $932,345 | +$119,559 | - / +62.0 | +15.8 | $213,099 |

Best: the 2-4 DTE add-on (burst >= 2.5) with no limits and 2 trades a stock (overlapping trades on one stock add
nothing). Live it needs: the same-week expiry with its own burst (code), the bot's caps at their tops, and the account's
risk rules loosened (buys a day 10, open risk 10%, the 12.5% drawdown brake are in the trading service). Much of the
no-limits gain is 2025-10-10; without it the 2% account is about $213K either way.

### 2-4 DTE with a stronger burst: a new candidate (2026-10-28, night)

The user: more trades; adjust 2-4 DTE. Exit grid on the same-week trades alone (3y50w; grace 30 / 60 / 120 / none x give-back
0.75 / 1.0 / 1.5, `STR_GIVE`): every version -7% .. +4% a trade, 2024 -18% .. -23% under every exit: not the exit. A
stronger burst is: same-week alone, 2%, burst >= 1.1 / 1.5 / 2.0 / 2.5: 220 / 130 / 55 / 27 trades, +4.2 / +10.4 / +37.2 /
+75.0% a trade, $114K / $124K / $142K / $142K, drop 25 / 14 / 6.7 / 3.5%; at 2.0 tune +19.7 / check +56.8, without the best 5
-$10,503 (QCOM 2025-10-27 +$26.6K). Then in one account with the winner (`STR_AM_MIN_W`: the burst only for the 2-4 DTE
alerts; 0/1 DTE keep 1.1). Top 50, 3 years, live limits:

| Version | Trades | Won | Avg | 2%: $100K becomes, drop | 3% | Without best 5 (2%) | Tune / check | Check without 2025-10-10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| the winner (0/1 DTE) | 194 | 74 | +25.4% | $226,355, 18.1% | $320,189, 26.1% | +$1,699 | +28.9 / +22.5 | +1.2 |
| + 2-4 DTE, burst >= 2.0 | 248 | 91 | +28.1% | $320,699, 22.8% | $542,388, 32.3% | +$25,579 | +26.6 / +29.5 | +13.0 |
| + 2-4 DTE, burst >= 2.5 | 221 | 86 | +31.5% | $321,936, 19.8% | $547,684, 28.4% | +$25,783 | +28.7 / +33.9 | +15.5 |

Better than the winner on the end account, the average, without the best 5 and the check half without 2025-10-10 (+13
to +15 against +1.2); the drop is 2-5 points deeper. The burst level was chosen after seeing it (both halves agree, 55 /
27 trades). Candidate for production (needs the same-week expiry in the live bot).

The cross window, 3 years (winner otherwise): 15 / 20 / 30 / 45 / 60 s: 194 / 217 / 254 / 296 / 322 trades, +25.4 / +23.4 /
+18.9 / +13.9 / +12.6% a trade, $226K / $233K / $221K / $192K / $190K, without the best 5 +$1.7K / -$0.9K / -$11.2K / -$17.5K
/ -$24.5K. More trades but no more money past 20 s: keep 15 (20 is neutral).

### F60x2 (rolling 60 s, volume >= 2x) with the winner (2026-10-28)

20,310 alerts (2025-11-21 .. 2026-10-22, the 43 names, 09:40-13:00); `f60_prefilter.py` (10-second bars, a touch of a side
line within 20 s and a burst >= 1.1, no download) kept 234 (it kept all 34 of A's exact trades). Tag e_f60: stock seconds,
picks, 82 per-second books (the option step's burst now from the alert's own second), 136 minute-quote contract-days.
Winner rules, live limits, 2%, the early alerts' window:

| Alert | Trades | Won | Avg | $100K becomes | Drop | Without best 5 | Tune / check |
| --- | --- | --- | --- | --- | --- | --- | --- |
| old alert (live) | 46 | 15 | +19.1% | $114,409 | 12.3% | -$27,384 | +41.9 / -13.3 |
| F60x2 | 60 | 22 | +2.0% | $101,836 | 9.3% | -$19,739 | +0.7 / +3.7 |
| both, one account | 101 | 34 | +9.9% | $117,064 | 16.1% | -$32,084 | +20.9 / -5.0 |

F60x2 is the best of the early alerts (A / 3 steady / 6 range lost 6-18% a trade) but about flat; 54 of its 60 trades are
on stock-days the old alert did not trade. Added to the old alert: +$2.7K for a 4-point deeper drop, a negative check half.
Not adopted.

### Late alerts on 2 DTE, held overnight (2026-10-28)

The user: alerts with under 3 hours to the close buy 2 DTE (even when 0 / 1 DTE exist), take the last half hour too,
and hold overnight. `leg_seconds.py list` with `SEC_LATE=1 SEC_FIRST=210 SEC_LAST=388` (tag 3y50late: the nearest
expiry 2-7 days out, 2,000 alerts with a burst >= 1.1), the winner's entry, 306 per-second books, 313 minute-quote
contract-days, then `late_carry.py`: the give-back on minute closes after the 30-minute grace, at 15:50 the night
(A: carry whatever is open; B: the main bot's rule, +50% and the top 10% of the range), the 10% night cap, 09:40 the gap
rule, the rest under the give-back, expiry day out at 15:30. One account with the winner's 0 / 1 DTE trades.

| Set | Night | Trades | Won | Avg | $100K becomes (2%) | Drop | Without best 5 | Tune / check | Check without 2025-10-10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0-1 DTE (the winner) | - | 194 | 74 | +25.4% | $226,355 | 18.1% | +$1,699 | +28.9 / +22.5 | +1.2 |
| late 2 DTE only | A | 200 | 51 | -7.0% | $73,133 | 38.8% | -$52,741 | -14.8 / -1.4 | -1.3 |
| late 2 DTE only | B | 204 | 52 | -5.5% | $78,891 | 24.9% | -$43,575 | -5.5 / -5.6 | -5.4 |
| both | A | 391 | 125 | +9.4% | $167,900 | 31.1% | -$30,707 | +7.7 / +10.6 | +0.4 |
| both | B | 395 | 126 | +9.8% | $181,605 | 26.5% | -$26,748 | +12.0 / +8.1 | -2.2 |

By entry (avg a trade, A / B): 13:00-14:30 -4.1 / -3.3% (125 trades), 14:30-15:30 -1.8 / -3.0% (89), the last half
hour -14.4 / -11.9% (53; A carried all 53). The late alerts lose in every slice and both night rules; the last half
hour worst. Not adopted.

Without the last hour (`LC_BUY_MAX=329`, late buys 13:00-14:59 only, 172 pass the entry): late only 128 trades, -1.0% a
trade, $95,268 (A); with the winner $217,069 / 24.2% (A) and $220,417 / 24.2% (B) against the winner's $226,355 / 18.1%:
about flat, a deeper drop. Not adopted.

### 2 DTE only (2026-10-28)

The user: test 2 DTE trades. The same-week alerts with exactly 2 days to expiry (`SEC_DTE_DAYS=2`, 1,320 of the 3,495),
the winner's rules and exit (give-back, 30-minute grace), live limits, 2%:

| Set | Trades | Won | Avg | $100K becomes | Drop | Without best 5 | Tune / check | Check without 2025-10-10 | 2024 / 2025 / 2026 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0-1 DTE (the winner) | 194 | 74 | +25.4% | $226,355 | 18.1% | +$1,699 | +28.9 / +22.5 | +1.2 | +16.8 / +39.1 / +15.0 |
| 2 DTE only | 77 | 27 | +4.0% | $104,482 | 11.5% | -$22,641 | +9.8 / -1.9 | -1.9 | -20.6 / +9.6 / +10.6 |
| Both, one account | 269 | 100 | +19.1% | $231,699 | 20.1% | +$4,437 | +23.0 / +15.6 | -0.3 | +7.8 / +29.3 / +13.2 |

2 DTE alone is about flat (+$4.5K in 3 years, the check half negative). Added to the winner it gives +$5K at 2% for a 2-point
deeper drop and a lower average and check half. Not adopted.

### The winner on top 50 + the app's Favorites, and a spread cap at the buy (2026-10-28)

The user: the Favorites of the app (data/local/early_alerts_favorites.txt, 66 names, 23 outside the top 50; the 7 not in
any earlier data, ARM CBRS CRDO IGV LITE LMND TSEM, fetched as tag 3yappx with `SEC_SYMS`, burst-prefiltered; the 3yfav
gap filled), and no buy when the spread at the buy is over 10% of the mid (`STR_MAX_SPREAD=0.1`; 0.2 = the ask at most
10% over the mid). Winner rules, live limits:

| Stocks | Spread cap | Trades | Won | Avg | 2%: $100K becomes, drop | 3% | Without best 5 (2%) | Tune / check | Check without 2025-10-10 | App-Favorite trades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| top 50 | none | 194 | 74 | +25.4% | $226,355, 18.1% | $320,189, 26.1% | +$1,699 | +28.9 / +22.5 | +1.2 | - |
| + app Favorites | none | 212 | 78 | +20.9% | $203,337, 19.3% | $278,363, 27.8% | -$10,762 | +22.9 / +19.2 | -0.9 | 18, -27.5%, -$12,621 |
| top 50 | 10% | 92 | 37 | +21.4% | $141,210, 9.4% | $164,038, 13.8% | -$20,542 | +15.4 / +26.0 | +13.3 | - |
| + app Favorites | 10% | 96 | 37 | +18.9% | $136,163, 9.3% | $154,816, 13.8% | -$22,839 | +12.4 / +24.1 | +11.6 | 4, -39.7%, -$3,225 |
| top 50 | 20% | 141 | 52 | +23.3% | $175,223, 13.8% | $219,401, 20.0% | -$18,665 | +22.1 / +24.2 | +3.9 | - |
| + app Favorites | 20% | 149 | 53 | +20.3% | $164,513, 15.0% | $202,373, 21.6% | -$24,266 | +18.0 / +22.0 | +2.2 | 9, -32.2%, -$6,701 |

The app's Favorites lose in every version (the extra names' trades -27% to -40% a trade). The 10% spread cap halves the
trades (wide-spread names drop out), halves the drop (9%) and is the only version whose check half holds without
2025-10-10 (+13.3); but it ends lower ($141K) and without the best 5 trades it is -$20.5K. Not adopted yet; a candidate
for a sturdier, smaller version.

### The winner on top 50 + Favorites (2026-10-28)

The user: test adding the Favorites. The winner (live limits, 2%) on the top 50 plus the 21 Favorites outside it (AAOI,
ADBE, CVX, GLD, IBKR, IBM, LLY, MRNA, NET, NOW, NU, NVO, PANW, SHOP, SIRI, SKHY, SNDK, SOXX, UAL, WIX, XYZ; events3yfav,
`SEC_ADD_TAG=3yfav SEC_ADD_NEW_ONLY=1`): 216 trades, +19.5% a trade, $193,103, drop 20.7% (top 50 alone $226,355 / 18.1%);
check half without 2025-10-10 -4.7 (top 50 +1.2). The top-50 trades are the same 194; the 22 extra-name trades won 5, -32.8%
a trade, -$25,505 (GLD 9, MRNA 5, LLY 3, NVO 2). 368 of their 453 fast-cross alerts have the option book (81%). Not
adopted: production stays on the top 50.

### Production (2026-10-28)

PR #193 (18fba4e): the live Volume bot runs the winner: cross <= 15 s, burst >= 1.1 the side's way, no give-back for 30
minutes, the give-back on minute closes; new settings on by default. `scripts/volume-winner-parity.ts`: the TypeScript burst
and exit match the backtest on all 554 trades (19 sales 1-3 minutes earlier live, where the backtest's walk started at
the option's first bar after the buy). Settings to save on the page: the top 50, Favorites off, 2%, delta 0.20, 5 open.

### Mid-price limits rechecked, and the sale at the mid (2026-10-28, later)

The 1-second mid buy above was not a real cost: its fallback price came from the second book (opt2, cmbp-1 in 2024) and
both books carry flickering quotes in fast moves (SMCI 2024-09-26 P420: bid $3.00, ask $13.20 for two seconds, then
$3.10), so a 1-second shift could land on one (SMCI bought at $10.65, not $4.13). `mid_buy.py` uses the baseline's own
book and drops any book wider than 50% of its mid (`MB_CLEAN=0.5`, for the baseline buy too: the winner becomes
$226,876). `sell_limit.py` fetched each exit's per-second book and trade prints (245 trades, `sec_cache/sell`) and offers
the option at the mid for W s, then sells at the bid; "prints" also counts a trade printed at our price or above. 2%:

| Rule | Mid fills | $100K becomes | Avg | Tune / check | Check without 2025-10-10 |
| --- | --- | --- | --- | --- | --- |
| buy as today (clean book) | - | $226,876 | +25.5% | +28.9 / +22.7 | +1.4 |
| buy: mid 1 / 2 / 5 / 10 s | 14 / 27 / 53 / 71 | $226,764 / $228,603 / $224,978 / $203,439 | +25.4 / +25.5 / +25.5 / +22.2% | | |
| sell as today (minute-close bid) | - | $226,355 | +25.4% | +28.9 / +22.5 | +1.2 |
| sell: mid 1 / 2 / 5 / 10 / 30 s, quotes | 8 / 23 / 45 / 57 / 88 | $227,015 / $223,404 / $220,300 / $207,668 / $213,951 | +25.5 / +25.4 / +24.8 / +23.1 / +23.7% | | |
| sell: mid 1 / 2 / 5 / 10 / 30 s, prints | 20 / 42 / 68 / 90 / 124 | $228,004 / $225,287 / $228,786 / $216,935 / $222,364 | +25.6 / +25.7 / +25.3 / +23.8 / +24.7% | | |

A mid limit for 1-5 s on either side is neutral (within $3K of today); 10 s or more costs, because the option keeps
moving the wrong way for us (up after the breakout on the buy, down after the give-back on the sale). Keep in mind for
every per-second test: drop flickering books. Not adopted.

### A mid-price limit buy on the winner (2026-10-28)

The user: buy at the mid, and when it does not fill at once pay the usual price. `STR_BUY=mid STR_BUY_WAIT=1|2|5` on the
winner (cross <= 15 s, burst >= 1.1, no give-back 30 min), live limits, 2%. A limit fills only when the ask comes down to
it (quotes only: a seller hitting our bid is not seen, so fills are undercounted).

| Wait | Limit fills | $100K becomes | Avg | Drop | Tune / check | Check without 2025-10-10 |
| --- | --- | --- | --- | --- | --- | --- |
| none (the winner) | - | $226,355 | +25.4% | 18.1% | +28.9 / +22.5 | +1.2 |
| 1 s | 13 of 245 | $204,515 | +22.8% | 18.1% | +25.4 / +20.6 | -0.5 |
| 2 s | 25 | $200,462 | +21.9% | 17.9% | +25.6 / +18.9 | -1.4 |
| 5 s | 52 | $200,066 | +22.1% | 18.2% | +25.2 / +19.5 | -1.2 |

Worse at every wait: a filled limit saves about 2% of the mid, but the fills come when the option falls (the losers),
and the unfilled ones pay the usual price later, after the breakout has run. The sale side (a limit at the mid before
the bid) is not tested: it needs the per-second book and the trade prints around each exit. Not adopted.

### Same-week trades held the main bot's way overnight (2026-10-28)

The user: for the 2-4 DTE trades, skip the give-back and use the main bot's night rule (`week_carry.py`): hold to 15:50,
carry if the option is up >= 50%, the stock in the top 10% of the day's range the bet's way, >= 2 days to expiry, not
Friday, the 10% night cap; 09:40 next day sell half on a 0.5% gap the bet's way, else all; expiry day out at 15:30. The
0/1 DTE trades keep the winner's exit. Its account reproduces the winner exactly (194 / $226,355 at 2%). Quotes: 259
contract-days 15:29-15:52 and 26 carried contract-days (Databento cbbo-1m, `dbx_cache/extra_late`). 2%:

| Set | Trades | Won | Avg | $100K becomes | Drop | Without best 5 | Tune / check | Check without 2025-10-10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0-1 DTE (the winner) | 194 | 74 | +25.4% | $226,355 | 18.1% | +$1,699 | +28.9 / +22.5 | +1.2 |
| 2-4 DTE, give-back (above) | 220 | 68 | +4.2% | $114,115 | 25.2% | -$33,251 | -5.9 / +13.7 | +13.7 |
| 2-4 DTE, held + night rule | 207 | 62 | +9.4% | $131,464 | 29.3% | -$41,713 | +5.4 / +13.1 | +13.1 |
| Both, give-back (above) | 412 | 141 | +14.0% | $252,742 | 24.3% | -$10,321 | +9.9 / +17.7 | +7.6 |
| Both, 2-4 DTE held | 399 | 134 | +15.2% | $257,945 | 24.4% | -$20,257 | +16.5 / +14.2 | +3.7 |

Holding helps the same-week trades a little (+9.4% against +4.2% a trade, tune half now positive) but deepens the drop.
Inside it: the 22 carried trades made +$138K (19 won; IONQ 2026-04-14 +882%, USO 2025-06-23 +875%, ASTS 2025-10-01
+520%), while the trades held to 15:50 and sold there lost about -$110K: without the give-back the ordinary trades bleed
all afternoon. Not adopted. Next idea from it: keep the give-back, but stop it while the option is up >= 50% and carry
those at 15:50 the main bot's way (only the runners skip the give-back).

### Same-week expiries (2-4 DTE) for the winner (2026-10-28)

The user: trade the alerts on days with no 0/1 DTE too, on the nearest expiry later that week (never past its last
trading day). `week_count.py`: 13,284 more alerts on the top 50 over 3 years (0 DTE 6,202, 1 DTE 6,096), 3,495 with a
burst >= 1.1 either way. `leg_seconds.py list` with `SEC_WEEK=1 SEC_AM_PRE=1.1` (tag 3y50w, kind "w", `nxt` = the week's
expiry), stock seconds for all 3,495, the per-second option book only for the 569 that cross within 15 s with the burst
the side's way (`SEC_OPT_CROSS_MAX`, `SEC_OPT_AM_MIN`), their minute quotes (`extra_quotes.py EXQ_HAVE_OPT=1`, 523
contract-days); `SEC_ADD_TAG=3y50w` runs both in one account. Winner rules, live limits, 2%:

| Expiries | Trades | Win | Avg | $100K becomes | Drop | Without best 5 | Tune / check | Check without 2025-10-10 | 2024 / 2025 / 2026 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0-1 DTE (the winner) | 194 | 74 | +25.4% | $226,355 | 18.1% | +$1,699 | +28.9 / +22.5 | +1.2 | +16.8 / +39.1 / +15.0 |
| 2-4 DTE only | 220 | 68 | +4.2% | $114,115 | 25.2% | -$33,251 | -5.9 / +13.7 | +13.7 | -21.5 / +18.1 / -2.3 |
| Both, one account | 412 | 141 | +14.0% | $252,742 | 24.3% | -$10,321 | +9.9 / +17.7 | +7.6 | -2.1 / +26.8 / +6.2 |

At 3%: 0-1 DTE $320,189 / 26%, both $368,794 / 35%. The same-week trades alone are about break-even: they lose in the
tune half and in 2024, and one trade (QCOM 2025-10-27, +$24.5K) carries them. Added to the winner they raise the end
account but cut the average a trade from +25% to +14%, deepen the drop by 6 points and turn "without the best 5"
negative; their only plus is a better check half without 2025-10-10 (+7.6 against +1.2). Not adopted.

### The early-sign alerts with the winning strategy (2026-10-27, night)

The early alerts were only tested with today's plain rules. Now with the whole winning strategy (cross <= 15 s,
burst >= 1.1, no give-back for 30 minutes, live limits, 2%). Their window only: 2025-11-21 .. 2026-10-22, 09:40-13:00,
the 43 names `early_alerts.csv` covers; the old alert on the same days, names and hours (`STR_TO`, `STR_ALERT_SECS`,
`STR_EXCL`). Tune to May 2026, check June on (`STR_SPLIT=2026-06`).

Fixed first (`leg_seconds.trade`): for an alert inside a minute (`sec0`: fast / early) the seconds to the cross were
counted from the end of the minute and the burst read the close of the minute still running (up to 60 s of the
future). Both now start at the alert's own second (its price against the close that ended 3 minutes before). The old
alert fires on a minute close and is unchanged; no earlier result used these two numbers for the early alerts.

| Alert | Trades | Win | Avg per trade | $100K becomes (2%) | Drop | Without best 5 | Tune / check |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Old alert (rvol, minute close) | 46 | 15 | +19.1% | $114,409 | 12.3% | -$27,384 | +41.9 (27) / -13.3 (19) |
| A (early, 120-min cooldown) | 34 | 10 | -15.1% | $90,038 | 17.0% | -$20,121 | -34.6 (19) / +9.6 (15) |
| 3 steady + 6 range | 33 | 12 | -6.4% | $95,570 | 10.5% | -$14,479 | +1.1 (19) / -16.5 (14) |
| 6 range + 4 no block | 39 | 12 | -18.2% | $86,607 | 16.7% | -$22,470 | -17.8 (23) / -18.9 (16) |

No early source helps: all three lose with the filter, and none catches the big winners of the old alert (META
2026-04-08 +$22.6K at 2%, QCOM 2026-05-07). Too few trades for a fine call (33-46 each), and in this window the old
alert itself rests on META (without the best 5: -$27K; check half -13.3%). Not adopted.

### Size a trade: 1-5% of the account, and no limits (2026-10-27, night)

`STR_ACCOUNTS=live1,...,live5,free1,free2,free3` runs several accounts in one process (one simulation, so no memory
trouble); `STR_WITHOUT_DAYS=2025-10-10` adds each row again without that day; the tune (to 2025-06) and check (2025-07
on) halves now print in the run; `STR_DUMP_DIR` dumps every account's kept trades. Top 50, 3 years. Live limits = 7.5%
day loss, 15 trades, 5 open. The 1% rows reproduce the log (301 / +15.9% / $151,387 and 193 / +24.6% / $151,693); the
benchmark now gives 1,579 trades, -8.9%, $26,091 (was 1,610 / $25,255: quotes added since).

| Strategy | Size | Trades | Avg | $100K becomes | Drop | Without best 5 (P&L) | Tune / check avg | Check without 2025-10-10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Every alert (today's rules) | 1% | 1,579 | -8.9% | $26,091 | 79.0% | -$102,249 | -8.1 / -9.8 | -11.0 |
| Every alert | 2% | 1,534 | -8.7% | $7,415 | 95.1% | -$144,888 | -7.9 / -9.5 | -10.8 |
| Every alert | 3% | 1,407 | -8.4% | $2,772 | 98.5% | - | -7.5 / -9.3 | -10.5 |
| Every alert | 4% / 5% | 1,262 / 1,121 | -8.3 / -7.6% | $1,273 / $908 | 99%+ | - | - | - |
| Cross 15 s, burst >= 0 | 2% | 302 | +16.5% | $220,785 | 21.4% | -$18,476 | +19.8 / +13.6 | -2.0 |
| Cross 15 s, burst >= 0 | 3% | 302 | +16.5% | $297,228 | 30.3% | -$59,388 | | |
| Cross 15 s, burst >= 0 | 4% / 5% | 302 | +16.5% | $374,942 / $447,790 | 38.1 / 45.1% | -$133K / -$240K | | |
| Cross 15 s, burst >= 0, no limits | 1 / 2 / 3% | 364-366 | +27% | $208K / $342K / $496K | 15 / 27 / 37% | +$46K / +$72K / +$64K | +15.0 / +37.5 (3%) | -1.4 |
| Cross 15 s, burst >= 1.1 | 2% | 194 | +25.4% | $226,355 | 18.1% | +$1,699 | +28.9 / +22.5 | +1.2 |
| Cross 15 s, burst >= 1.1 | 3% | 194 | +25.4% | $320,189 | 26.1% | -$18,012 | | |
| Cross 15 s, burst >= 1.1 | 4% / 5% | 194 | +25.4% | $427,357 / $552,654 | 33.3 / 39.8% | -$63K / -$140K | | |
| Cross 15 s, burst >= 1.1, no limits | 1 / 2 / 3% | 229-230 | +41% | $208K / $365K / $556K | 11 / 20 / 29% | +$47K / +$85K / +$90K | +23.6 / +54.9 (3%) | +3.0 |

Today's rules lose at every size; bigger sizes only lose faster (the day-loss limit refuses more trades, the account is
gone at 4-5%). The filters scale with size, but so does the drop (about 9% more per 1%), and above 2% the result
without the best 5 trades turns clearly negative: the money is a handful of +400% to +1,250% trades (2026-04-08 META,
2025-10-10 BABA / AMD / AAPL, 2025-05-29 BA). No limits adds 60 / 36 trades and is better "without the best 5", but
its check half again rests on 2025-10-10 (+37.5 -> -1.4 for burst >= 0, +54.9 -> +3.0 for burst >= 1.1). The check
half without that day is flat at every size. Sturdiest: burst >= 1.1 at 1-2% with live limits. Not live.
Dashboard: "Size a trade" section on https://claude.ai/artifact/99VCgkWj9ZegAW3pMBitdg (every trade at each size).
The page's header said 2% a trade; its trades were at 1% (fixed).

### One day carries the check half: 2025-10-10 (2026-10-27, late)

Re-reading the filtered runs without 2025-10-10 (the market-wide drop; every name alerted at 10:59, puts ran +150% to
+850%). No stop for 30 minutes, live limits unless named:

| Filter | Max open | Trades | Avg per trade | $100K becomes | Drop | Check half | Without 2025-10-10: avg, check half, $100K becomes, drop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cross <= 15 s, burst >= 0 | 5 | 301 | +15.9% | $151,387 | 11.2% | +13.6 | +7.8%, -2.0, $121,242, 19.0% |
| cross <= 15 s, burst >= 0 | 10 | 309 | +23.7% | $180,962 | 11.1% | +28.6 | +7.5%, -2.0, $120,790, 21.4% |
| cross <= 15 s, burst >= 0 | 20 | 309 | +31.1% | $207,924 | 10.7% | +42.3 | +7.5%, -2.0, $120,402, 23.5% |
| cross <= 15 s, burst >= 1.1 | 5 | 193 | +24.6% | $151,693 | 9.3% | +22.5 | +13.4%, +1.2, $125,371, 12.0% |

Without that day the check half (Jul 2025 on) is flat or slightly negative for the burst >= 0 filter; raising the open
limit only adds more of that day. The burst >= 1.1 version stays positive every year without it (+13.3 / +12.0 /
+15.0) and is the sturdier candidate. The no-limit runs at 1/2/3% and the rest of the sweep were stopped by the
system for low memory (too many runs at once) and are not done.

### Missed big winners: what blocks them, and news days (2026-10-27)

`STR_DUMP_ALL` dumps every simulated trade before the filters and the account (6,406 alerts with a side and quotes,
no stop for 30 minutes); `blockers.py` replays the account per trade. Of 377 trades of +100% or more: news-day filter
162 (of 3,161 trades, -14.4% a trade), slow cross with the burst agreeing 69 (of 1,241, -13.6%), slow cross against
the burst 60 (-12.7%), fast cross against the burst 25 (-12.3%), passed the filter but blocked by the account 19 (of
113, +42.4%), traded 42 (of 301, +15.9%).

Of the 414 that pass the filter: traded 301 (+15.9%); "5 positions open" 19 (+274%, 11 big winners), almost all
2025-10-10 10:59, the market-wide drop (AMZN, NVDA, QQQ, AVGO, META, DELL, AAPL, IREN, HOOD, HIMS, RKLB puts, +164% to
+849%); "same stock still open" 87 (-5.8%, 7 big winners: second alerts on a runner, e.g. META 2026-04-08 12:17 and
12:22); "2 trades on the stock" 6 (-16.2%); too pricey for 1% 1.

News days (`news_filter`: earnings reaction day, or pre-market volume >= 4x): no cut rescues them. With the filter:
earnings day 237 trades -15.7%, pre-market 4x 239 trades -19.8%; by time of day, pre-market gap, day move, option
price: every slice negative. The alert (4x a normal minute's volume) is an ordinary minute on a day when all volume is
high, and the options are dear. A news-day strategy needs its own alert (volume against the same day's earlier
minutes). Keep the filter.

Grid before the account, normal days (cross seconds x burst in S30): cross <= 15 s with burst 1.1-2: 180 trades
+31.8% (tune +24.7, check +37.2); burst >= 2: 65 trades +55.5%; burst 0.5-1.1: +0.5%; every slow-cross cell with a
weak burst loses. Cross <= 15 s & burst >= 1.1: 245 trades +38.1%; cross <= 30 s & burst >= 1.1: 342, +26.5% (tune
+14.4, check +35.8); cross <= 60 s & burst >= 1.1: 435, +22.3% (tune only +3.6).

### Fewer trades: the fast cross and the burst (2026-10-27)

The user: "1600 trades are too many, maybe we are not filtering enough for the direction". `trade_features.py`
computes what each trade looked like at the buy; a quintile scan over 15 features, tune (to 2025-06) and check
(2025-07 on). Two held in both halves: seconds from the alert to the cross (under 8 s: +2.0 / +1.7, every other
quintile negative) and the burst (`am`: the 3 minutes to the alert, the side's way, in S30; above 1.1: +0.1 / +3.7,
below -1.2: -11 / -16). Both are the same idea: buy when the stock breaks out the way the burst was already going.
Filters applied before the account (`STR_CROSS_MAX`, `STR_AM_MIN`), live limits, top 50, 3 years:

| Filter | Exit | Trades | Win | Avg per trade | $100K becomes | Worst drop | Tune / check | 2024 / 2025 / 2026 | Without best 5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | live | 1,610 | 23% | -8.9% | $25,255 | 79.6% | -7.7 / -9.8 | -6.2 / -10.6 / -8.8 | -$103K |
| burst >= 1.1 | live | 429 | 30% | +1.8% | $106,546 | 12.9% | -5.1 / +6.7 | +0.0 / -3.2 / +8.0 | -$22K |
| burst >= 1.1 | no stop 30 min | 393 | 32% | +10.6% | $144,800 | 14.5% | +5.1 / +14.5 | -0.9 / +19.2 / +9.9 | -$4.7K |
| cross <= 15 s, burst >= 0 | live | 330 | 29% | +2.5% | $106,355 | 12.1% | -1.0 / +5.5 | +3.9 / -2.4 / +9.0 | -$20K |
| cross <= 15 s, burst >= 0 | no stop 30 min | 301 | 36% | +15.9% | $151,387 | 11.2% | +18.6 / +13.6 | +3.6 / +26.1 / +10.4 | -$2.3K |
| cross <= 8 s | live | 373 | 31% | +2.1% | $105,527 | 11.9% | -0.1 / +4.3 | +5.9 / -2.1 / +5.4 | -$16K |
| cross <= 8 s | no stop 30 min | 326 | 35% | +13.9% | $147,822 | 8.4% | +13.4 / +14.3 | +2.8 / +23.7 / +8.5 | -$1.8K |

Sweep around it (no stop 30 min unless named; cross alone): cross <= 5 s +14.3% (216), 10 s +8.7% (388), 15 s +3.6%
(504), 20 s +0.6%, 30 s -0.6%. Cross <= 15 s & burst >= 0 with no stop for 10 / 20 / 30 / 45 minutes: +5.3 / +8.2 /
+15.9 / +9.8% (30 is a peak: some of it may be luck). Burst >= 0.5 instead of 0: +16.1% (291).

### Other notes from 2026-10-27

- The $0.69 bid on the TSLA example (2025-09-12) is real: raw cbbo-1s (`peek_quote.py`) shows 1.31/1.36 at 9:58:00
  and 0.69/0.73 at 9:59:00 as TSLA fell from 385.70 to 383.69; the $1.62 buy was the fill model's chase (bid 1.56 at
  +10 s above the 1.51 usual price, pay the ask). The page said "9:58" for the minute that closes at 9:59:00: fixed.
- Around the cross the option's mid rises about 5% on every kind of trade (spike not a loser's mark); 60 s after the
  buy the quick losers are -7% and the winners +4.5%.
- The day's move before the alert (`mv_close`) shows no clean fade/follow rule on its own.
- `explain_paths.py` (second-by-second trade pictures) feeds the dashboard's "how a trade works".

### No give-back stop for the first N minutes (2026-10-27)

`STR_NOSTOP_MIN=N` (leg_fallback.walk): the give-back can't sell in the first N minutes after the buy; the best is still
tracked; 15:30 still sells. Top 50, 3 years, cross, minute-close exit:

| No stop for | Trades | Avg per trade | $100K becomes | Worst drop | Win | Lost 80%+ | 100%+ | 2024 / 2025 / 2026 | P&L without the best 5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 (live) | 1,610 | -8.9% | $25,255 | 79.6% | 23.4% | 16 | 76 | -6.2 / -10.6 / -8.8 | - |
| 3 min | 1,601 | -9.1% | $25,416 | 79.7% | 23.9% | 20 | 77 | -6.6 / -11.3 / -8.2 | - |
| 5 min | 1,588 | -8.7% | $27,240 | 78.2% | 24.4% | 22 | 79 | -5.2 / -10.5 / -8.7 | - |
| 10 min | 1,559 | -7.4% | $33,341 | 73.7% | 25.3% | 28 | 85 | -3.9 / -8.1 / -8.9 | - |
| 15 min | 1,530 | -7.0% | $34,460 | 72.2% | 25.8% | 46 | 81 | -6.0 / -7.7 / -6.9 | - |
| 20 min | 1,503 | -6.8% | $36,959 | 69.5% | 27.3% | 52 | 89 | -6.7 / -5.9 / -7.8 | - |
| 30 min | 1,464 | -5.6% | $43,439 | 63.0% | 27.1% | 84 | 109 | -5.9 / -2.7 / -8.5 | -$93,713 |
| 45 min | 1,375 | -5.2% | $48,039 | 59.3% | 28.9% | 120 | 111 | -4.9 / -1.1 / -9.5 | -$95,589 |
| 60 min | 1,316 | -5.9% | $44,348 | 62.7% | 29.0% | 165 | 112 | -4.8 / -1.5 / -10.9 | -$99,754 |
| never (15:30 only) | 964 | +3.3% | $107,637 | 54.4% | 26.9% | 341 | 126 | +9.2 / +20.1 / -17.4 | -$104,715 |

The early give-back costs more than it saves: it sells trades that come back, some of them into big winners. The gain
is in names 16-50 (fewer sales into the wide bid); the top 15 stay near 0. "Never" is positive only through a handful
of trades (without the best 5: -$104,715), loses 17% a trade in 2026, holds positions all day (964 trades: the 5-open
limit blocks the rest), and loses 80%+ on 341 trades. Holding to 15:30, the stock alone goes the side's way (+0.44% a
trade, t 3.9, win 55%) where the 30-minute direction is a coin flip: a lead for the direction plan, not yet a rule.
Best usable: 30-45 minutes of grace, about 3.5 points a trade better than live; still losing.

### The exit's clock: minute closes vs the live bot's 10-second check (2026-10-27)

The user saw the TSLA example (2025-09-12): the stock crossed the give-back line at about 9:58:22 (call bid ~$1.15), the
backtest sold at the 9:59:00 minute close at $0.69. The backtest's walk (leg_fallback.walk) tracks the best and checks
the line on minute closes; the live bot (strangle.ts, tick every 10 s) does both on the last trade every 10 s.
`exit10.py` rebuilds the exit on EQUS.MINI 1-second stock prices with the sale at the cbbo-1s bid 2 s after the
crossing tick (`STR_EXIT=sec10`, `EXIT10_MODE`). Top 50, 3 years, cross, same day's data:

| Exit | Trades | Avg per trade | $100K becomes | Top 15 | Names 16-50 |
| --- | --- | --- | --- | --- | --- |
| minute closes (the backtest so far) | 1,610 | -8.9% | $25,255 | +0.2% | -10.5% |
| best on minute closes, check every 10 s | 1,617 | -9.9% | $21,470 | -0.9% | -11.8% |
| live check for the first 5 minutes, then minute closes | 1,615 | -10.5% | $19,501 | -2.6% | -12.5% |
| the live bot: best and check every 10 s | 1,608 | -11.9% | $16,054 | -3.9% | -13.7% |

The same trades, by how they ended with the minute-close exit:

| Group | Minute closes | 10 s, best on closes | First 5 min live | Live 10 s |
| --- | --- | --- | --- | --- |
| quick losers (out within 10 min) | -36% | -33% | -33% | -31% |
| later losers | -33% | -29% | -32% | -27% |
| winners | +75% | +59% | +59% | +44% |
| 100%+ winners | +253% | +195% | +202% | +133% |

A faster check saves 3-5 points on the losers and costs 16-31 points on the winners: inside a minute the stock wiggles
past the line and the stop shakes out the runners. The minute close is the better clock, and the live bot's 10-second
check is likely about 3 points a trade worse than every backtest so far. Why the losers lose 30-36%: the side line
(0.25 x S30) plus the give-back (0.75 x S30) let the stock go about 1 x S30 against the buy, and a 0.20-delta 0DTE
option loses 25-30% on that; then the spread on the sale (-9% on the top 50, -3% on the top 15) and commission. Around
the cross the option's mid rises about 5% on every kind of trade (not a loser's mark); 60 s after the buy the quick
losers are already -7% and the winners +4.5%: the direction again.

### The early-sign alerts as the Volume bot's alert (2026-10-27)

Sources from `early_alerts.csv` (docs/research/early-alerts.md on research/early-rules): `A` (today's rule, 120-minute
cooldown), `3 steady + 6 range` and `6 range + 4 no block` (30-minute cooldown); `F60x2` not run. `early_prep.py`: the
top 50 the file covers (43 names; no QQQ, GOOG, NFLX, RGTI, SPCE, USO, SMR), 09:40-13:00, the slot's 10-second close
as the alert price, the alert second = the slot's end; then `leg_seconds.py` with `SEC_ALERT=fast SEC_ALERT_FILE=...`
(real per-second option quotes, so the buy is 2 s after the cross, always after the alert). 2025-11-21 .. 2026-10-22,
168 days. Every other rule live. Grid: side line 0.25 / 0.5, side wait 10 / 30 min, entry cross / hold 10 s / hold 30 s.

| Source (wait 10, cross) | Trades | /day | Win | Avg per trade | P&L | Without the best 5 | Tune (to May) | Check (Jun on) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| built-in A (no cooldown) | 563 | 3.4 | 21.8% | -9.8% | -$41,561 | -$64,231 | -11.5% | -7.5% |
| A, line 0.25 | 442 | 2.6 | 23.8% | -10.0% | -$35,649 | -$53,016 | -11.0% | -9.0% |
| A, line 0.5 | 363 | 2.2 | 23.7% | -6.8% | -$23,302 | -$48,716 | -1.4% | -12.4% |
| 3 steady + 6 range, 0.25 | 718 | 4.3 | 20.9% | -9.9% | -$49,138 | -$65,384 | -15.5% | -2.6% |
| 3 steady + 6 range, 0.5 | 618 | 3.7 | 19.7% | -8.9% | -$41,119 | -$64,971 | -9.9% | -7.8% |
| 6 range + 4 no block, 0.25 | 556 | 3.3 | 21.0% | -9.5% | -$38,942 | -$56,028 | -13.1% | -5.3% |
| 6 range + 4 no block, 0.5 | 473 | 2.8 | 20.3% | -7.9% | -$30,841 | -$57,473 | -6.1% | -10.2% |

A 30-minute side wait was no better anywhere; holding 10 or 30 s past the line was worse on every source (it buys
after the move has gone further). The new sources give 1.3-1.6x the trades at the same loss a trade, so they lose
more money; per trade they are within noise of A (the tune and check halves swap order). Earlier alerts do not buy
cheaper options in a way that pays: the win rate is 20-21% against A's 24%. The direction is still the problem
(volume-direction-plan.md).

### The mid for 1 second (2026-10-27)

`STR_BUY=mid STR_BUY_WAIT=1`: a limit at the mid for 1 s, then the usual price: fills 3% of buys (top 15 13%) at 5.2%
under the usual price; all buys +0.07%; -9.4% a trade (top 15 +1.5%, names 16-50 -11.3%). `micro_mid` (the microprice
for 1 s, then the mid for 1 s, then the usual): fills 6% (top 15 21%), all buys +0.18%, -9.4% (top 15 +1.4%). The
same as the 2-second microprice limits: a limit inside the spread rarely fills in 1-2 s, and the rest pay a little more
a second or two later. The top 15's +1.2..1.7 points appear with every short-delay version, fills or not.

### Microprice + x%, 2 seconds at most (2026-10-27)

The user's version: limit at the microprice + x% (never above the usual price), 2 s, then the usual price
(`STR_BUY=pct STR_BUY_PCT=x STR_BUY_WAIT=2`). Top 50, 3 years, cross:

| x | Filled at the limit | Top 15 filled | Filled price vs usual | All buys vs usual | Avg per trade | Top 15 | Names 16-50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | - | - | - | - | -9.1% | +0.2% | -10.9% |
| 0% | 5% | 17% | -4.0% | +0.18% | -9.4% | +1.3% | -11.4% |
| 1% | 7% | 22% | -3.5% | +0.18% | -9.4% | +1.3% | -11.4% |
| 2% | 8% | 25% | -3.4% | +0.16% | -9.4% | +1.6% | -11.4% |
| 3% | 9% | 28% | -3.2% | +0.17% | -9.4% | +1.6% | -11.4% |
| 5% | 10% | 31% | -3.0% | +0.17% | -9.4% | +1.6% | -11.4% |

The limit is capped at the usual price, which sits inside the spread, so in 2 s it fills only when the ask ticks down to
it (5-10% of buys, quotes only; sellers hitting our bid are not seen). The fills save 3-4%, but the other 90% pay the
usual price 2 s later, after the option has moved up a little: overall the buy costs the same (+0.2%). Top 15 +1.3..1.6%
(vs +0.2%), names 16-50 a little worse. x barely matters.

### The Main bot's fair-price limit buy on the Volume bot (2026-10-27)

The rule (the Main bot's, from another session): limit at the microprice (bid and ask weighted by their sizes) + 3
ticks, never above the usual price (mid + half to the ask); unfilled after the wait, pay the usual price then, with the
run-away cost. `step5` (the user's idea): one tick higher every 5 s up to the usual start. `leg_seconds.py option2`
re-downloads each cross buy's book with sizes, 2 s before to 82 s after (6,592 windows, `sec_cache/opt2/`);
`STR_BUY=micro60|step5`, `STR_BUY_WAIT`. A limit fills only when the ask comes down to it (quotes, no trades: a seller
hitting our bid is not seen), so fills are a lower bound. Top 50, 3 years, cross:

| Buy | Trades | Avg per trade | $100K becomes | Top 15 | Names 16-50 |
| --- | --- | --- | --- | --- | --- |
| usual (baseline) | 1,591 | -9.1% | $25,196 | +0.2% | -10.9% |
| micro + 3 ticks, wait 60 s | 1,570 | -11.0% | $19,539 | +1.3% | -13.6% |
| step5, wait 60 s | 1,569 | -11.1% | $19,553 | +1.2% | -13.7% |
| step5, wait 20 s | 1,582 | -9.8% | $22,351 | +1.6% | -12.2% |
| step5, wait 10 s | 1,581 | -9.8% | $22,352 | +1.6% | -12.2% |
| step5, wait 5 s | 1,585 | -9.5% | $23,522 | +1.9% | -11.8% |

60-second waits: the limit fills on 56-60% of buys (top 15: 83%, after 9 s; names 16-50: about half, after 20 s) and
saves 3-4% of the price. The unfilled ones are the runners: 60 s later they cost 9-12% more than the usual price, and
they are the better trades (late trades at the usual price +3.8% on the top 15, they turn to -6.3%). Adverse selection:
the limit fills when the option comes down, so it buys the losers cheaper and the winners dearer. A short wait cuts the
damage; only the top 15 gain (+1.9% vs +0.2% a trade at 5 s). Names 16-50 lose more with any wait.

### A wider early give-back and a bigger side line (2026-10-27)

Why the 1-minute stops: the give-back (0.75 x S30 from the best) sits about 0.5 x S30 under the alert price, and a burst
minute's high-low range is about 0.97 x S30 (median, the 177 trades out within 2 minutes). 47% of trades are out within
10 minutes at -30% on average; 30 minutes after the buy those stocks were still 0.9 x S30 against us (median), but 29%
later went 1 x S30 our way. `STR_EARLY_GIVE` / `STR_EARLY_MIN` (leg_fallback.walk) and `SEC_K` (the side line) test it.
Top 50, 3 years, cross:

| Version | Trades | Win rate | Avg per trade | $100K becomes | Worst drop | Top 15 avg |
| --- | --- | --- | --- | --- | --- | --- |
| baseline (0.25 line, 0.75 give-back) | 1,591 | 23.4% | -9.1% | $25,196 | 79.7% | +0.2% |
| 1.25x for the first 3 min | 1,589 | - | -8.7% | $27,036 | 78.6% | +0.9% |
| 1.25x for the first 5 min | 1,586 | - | -8.5% | $27,745 | 77.9% | +0.3% |
| 1.5x for the first 3 min | 1,587 | - | -8.7% | $27,092 | 78.5% | +1.1% |
| 1.5x for the first 5 min | 1,580 | 24.6% | -8.5% | $28,010 | 77.6% | +0.5% |
| side line 0.5 | 1,407 | 24.3% | -8.2% | $31,659 | 73.7% | +3.3% |
| side line 0.5 + 1.25x for 5 min | 1,393 | 25.0% | -8.0% | $32,205 | 73.5% | +5.0% |

Each helps a little (about 1 point a trade together), none comes near break-even on the top 50: names 16-50 stay at
-10..-11% a trade. The early exits only move later (out within 10 minutes 47% -> 44%), they don't turn into winners.

### A 40% option stop-loss (2026-10-27)

The NVDA call of 2024-06-28 rode from $0.27 to $0.02: the stock crept up and drifted sideways for 3 hours, never giving
back 0.75 x S30 (its biggest pullback was 0.52% against a 0.69% line), and the out-of-the-money 0DTE call bled out. The
exit watches only the stock. But it is rare: 8 trades rode to 15:30 (+69% on average) and only 16 of 1,591 lost 80%+
($8.5K). The leak is the 932 trades stopped by the give-back within 15 minutes: 11% win, -27% a trade, -$136K.

`STR_STOP=0.4` (sell at the bid at the end of the first minute the option is 40% under the buy; `STR_STOP_ON=bid|mid`
says which price trips it). Top 50, 3 years, cross:

| Stop | Trades | Win rate | Avg per trade | $100K becomes | Worst drop | Stop fired | Those trades: with / without |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none (baseline) | 1,591 | 23.4% | -9.1% | $25,196 | 79.7% | - | - |
| 40% on the bid | 1,565 | 21.4% | -11.6% | $17,220 | 85.8% | 297 | -50.3% / -35.0% |
| 40% on the mid | 1,590 | 23.0% | -9.7% | $23,071 | 81.1% | 127 | -55.8% / -43.0% |

Worse both ways. The stop sells near the low (about -50% after the minute's slide and the bid) of trades that mostly
recover part of the way, and cuts some of the big winners: the META call (+1,172%) and the MSTR call (+517%) both
dipped 45% first. On the bid it fires on the wide names' spread alone (210 of 297 within 5 minutes). Top 15 alone:
-0.6% (bid) and -0.5% (mid) against +0.2% with no stop. Not adopted.

### The top-50 baseline: every test from here on (2026-10-27)

From now on every Volume test runs on the top 50 of `strangle_rank.json` (`STR_TOP=50`): the watchlist names with 5+
alerts, ranked by the median real spread of the 0.35-delta call + put at the alerts (QQQ 1.3% ... CRWD 17.7%).
`leg_seconds.py` with `SEC_FROM=2024-02-01 SEC_TAG=3y50`: 12,155 alerts, 28,865 option windows, 441 missing
contract-days filled by `extra_quotes.py`. Live 0.20 rule, per-second entry (cross), sale at the bid.

| 3 years, cross | Trades | Avg per trade | $100K becomes | Worst drop | Stock alone | Option at mid | Paid over mid | Sold under mid | Commission |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| top 50, all | 1,591 | -9.1% | $25,196 | 79.7% | +0.009% (t 0.3) | +7.6% | -5.3% | -9.1% | -2.4% |
| top 50, t >= 0 | 1,056 | -6.9% | $48,204 | 60.6% | +0.014% | +9.7% | -5.1% | -9.2% | -2.4% |
| top 15 | 367 | +0.2% | - | - | +0.028% | +8.8% | -3.4% | -3.1% | -2.0% |
| names 16-50 | 1,285 | -10.9% | - | - | +0.009% | +8.2% | -5.8% | -10.7% | -2.5% |

By year (top 50, all, cross): 2024 -6.4%, 2025 -10.8%, 2026 -9.1%. No t / D2 filter turns it positive over 3 years
(best D2 >= 1.5: -9.2%, 250 trades). The top 15 matches the earlier corrected run exactly (+0.2%), a check that the
pipeline is the same. Names 16-50 have the same signal at the mid (+8.2%) but lose it to the spread, mostly on the
sale (-10.7% under the mid vs -3.1% on the top 15). The baseline every next test is compared against: -9.1% a trade.

### A 30-minute give-up for the side (2026-10-27)

`SEC_WAIT=30` (live 10), 14 top names, 12 months, quotes filled, cross: the fast alert 419 trades, -7.2% a trade,
$73,015 / 35% (10 minutes: 414, -6.8%, $75,030); the old alert unchanged (158, +2.9%, $103,865): nearly every alert
crosses the line within 10 minutes (old 561 of 561, fast 625 of 634), so the longer wait adds a few late, losing
trades. Not better.

### Where the money goes: the stock alone and each trade's costs (2026-10-27)

`leg_seconds.py run` with `STR_DIAG=1` (top 15, per-second entry, live 0.20 rule, the account's kept trades, quotes
filled). The stock alone = the same entry second and exit minute on the shares, the side's way.

| 3 years | Trades | Stock alone | Option move at the mid | Paid over mid | Sold under mid | Commission | Net |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all | 367 | +0.028% (t 0.7, win 39%) | +8.8% | -3.4% | -3.1% | -2.0% | +0.2% |
| t >= 0 | 219 | +0.037% (t 0.7) | +13.1% | -3.6% | -3.2% | -2.1% | +4.3% |
| t < 0 | 225 | +0.003% | +0.3% | -3.3% | -2.9% | -2.0% | -8.0% |

The signal has no direction edge on the shares (t 0.7); the option's +8.8% at the mid is the cheap 0DTE option's
convexity (small losses, a few big wins) on the moves after the line. Costs are ~8.5 points a trade (median option
$0.72, so $0.62 a contract each way is 2%). Levers: fills nearer the mid (up to ~6.5 points), pricier contracts (the
commission), and moves big enough for the convexity.

### CORRECTION: the per-second results were inflated by missing sale quotes; the fast alert (2026-10-27)

`leg_seconds.py` sold at the real minute bid from `dbx_cache`, which holds only the contracts picked at the old
minute-close side. When the per-second entry picked another strike there was no quote and the trade silently dropped,
and the dropped trades were mostly losers. Fixed: `extra_quotes.py` downloads the missing contracts to
`dbx_cache/extra/`, `leg_realspread.quotes()` reads both. Corrected (live 0.20 rule, cross = 2 s after the side line):

| Top 15 | Before | Corrected |
| --- | --- | --- |
| 3 years, all | 321, +5.8%, $117,177 / 12.5% | 367, +0.2%, $99,106 / 17.5% (2024 -3.9%, 2025 -2.1%, 2026 +4.7%) |
| 3 years, t >= 0 | 189, +11.8%, $121,840 / 7.0% | 219, +4.2%, $107,460 / 11.1% (2024 +10.3%, 2025 +5.4%, 2026 -0.7%) |
| 12 months, 14 names (no GOOG), all | 134, +10.4%, $113,092 | 158, +2.9%, $103,865 / 7.2%; 6 months -6.8% |

The entries below that use the per-second entry (the top 10/15/20/40 table, the 3-year and strength numbers) are the
inflated ones; the minute-close rows and the strangle are not affected. The all-names per-second rows are not re-run.

**The fast alert** (stock-market-assistant #182, `fast_volume.py` rule R60 at 4x: a rolling 60-s window every 10 s,
120-min cooldown; `fast_alerts.py`; everything after the alert the same), 14 names, 12 months (the 10-s bars start
2025-10-23): 833 alerts in 09:40-13:00 (old rule A with the same cooldown 270; the Volume bot's own onsets 561),
634 on expiry days, 625 reach a side, 414 trades. Cross -6.8% a trade, $75,030 / 33%; t >= 0 -4.0%, $91,312 / 20%;
close -10.1%. Worse than the old alert (+2.9%). Not better.

### Real quotes: the bar test's look-ahead, the strangle, the entry on the second (2026-10-27)

All on real bid/ask (Databento OPRA), 1% a trade, the live limits (15 a day, 5 open, 7.5% day loss), the news skip,
up to 2 trades a stock a day. Buy = mid + half to the ask (the chase when the next bid is above it); sale at the bid.

- **The bar backtest had a look-ahead.** `LF.walk` bought at the middle of the confirming minute's own bar and sold
  at the middle of the exit bar; against the real book at the end of those minutes that is ~5% too cheap a buy and
  ~6.5% too high a sale (~11 points a trade). Real mid-to-mid move a trade: step8c8 +0.7% (bars said +15.5%).
  Every Volume bot version loses on the 167 watchlist names (`leg_realspread.py`): live 0.20 rule $100K -> $23K,
  step8c25 $43K, step8c8 $66K over 12 months. The Main bot's sim acts on the next bar and holds up (+0.9% on buys).
- **The strangle is dead** (`strangle_real.py`, `strangle_diag.py`, `strangle_liquid.py`): 1,296 versions (delta
  0.25/0.35/0.50, side 0.15/0.25/0.40 S30, wait 5/10/30/60, recycle or not, option 30% trail or stock give-back
  0.75/0.5, first alert or 2 a day, spread cap none/25%/15%), 12 months, none profitable. At the mid the pair earns
  +0.5..+4% a trade on all names and about 0 on the liquid ones; real fills cost 15-30 points (3-4 spread crossings,
  median pair spread 25%). Entering a whole minute earlier adds 1.5-3 points. Top 40 by spread: best -2.6% a trade.
- **The single leg, entered on the second** (`leg_seconds.py`; stock EQUS.MINI ohlcv-1s, option cbbo-1s from
  2025-02-20, cmbp-1 before): entries close (the minute close) / cross (2 s after the stock crosses the side line) /
  hold5 / hold10. The 40 tightest names by real 0.35-pair spread (`strangle_top40.json`):

  | Names (12 months, live 0.20 rule) | close | cross | hold5 | hold10 |
  | --- | --- | --- | --- | --- |
  | Top 10 | -4.1%, $95K | +3.8%, $103K | +4.6%, $105K | +1.9%, $102K |
  | Top 15 | -4.8%, $92K | +10.9%, $115K / 4.5% | +7.1%, $110K | +1.8%, $102K |
  | Top 20 | -5.2%, $88K | +4.1%, $108K | +3.3%, $106K | -1.5%, $96K |
  | Top 40 | -10.3%, $58K | -6.1%, $74K | -6.7%, $71K | -8.8%, $65K |
  | All 156 with alerts | -14.6%, $24K | -11.1%, $36K | -11.3%, $35K | -14.5%, $28K |

  Top 15 = QQQ TSLA NVDA AMZN SPCX PLTR AAPL GOOG AMD GOOGL IWM NFLX META MSFT IBIT (picked on this year's spreads).
  3 years (Feb 2024 - Oct 2026), top 15, cross: 321 trades, +5.8% a trade, $117,177 / 12.5% (2024 -3.3%, 2025 +4.1%,
  2026 +13.1%); close -3.6%, $86K. The step-up rule (8% / 25%) is a little worse than 0.20 here.
- **Strength at the entry** (`strength_at.py`: the Main bot's t and D2 at the last closed minute before the buy, the
  side's way), top 15, 3 years, cross: t >= 0 (agrees) 189 trades, +11.8%, $121,840 / 7.0%, every year about +12%
  (the disagreeing trades lose in 2024 and 2025); t >= 1.2 -2.4%; t >= 1.8 -11.3%; D2 >= 1.5 +5.9% (26 trades);
  t >= 1.2 and D2 >= 1.5 -9.7%; the Main bot's 2.6 rule -6.5%. A strong t means the move is already made.
- **The fill model** (the user: buying at the ask and selling at the bid "is never true"; then "ok to use bid for
  selling, but for buy use the price you think it going to make"): the buy is the bot's ladder (`ladder.ts`: starts at
  the mid, 5 steps 3 s apart up to mid + 85% to the ask, then chases to the ask for 3 minutes) modelled as mid + half
  to the ask; when the next minute's bid is already above it, min(next ask, price x 1.1) (about 30% of buys chase).
  The sale is at the bid; the sell ladder (mid - half to the bid, else the next bid) is shown beside it.
- **Contract rules on real quotes, all 167 names, 12 months, 1% a trade, sold at the bid / with the sell ladder**
  (`leg_realspread.py`; stepT = step to the next strike while the spread is over T%, cC = block over C%). None wins:

  | Version | Trades | $100K becomes (bid / ladder) | Avg spread |
  | --- | --- | --- | --- |
  | plain20 (live, 0.20 delta) | 1,033 | $23,396 / $33,337 | 23% |
  | step10 | - | $34,209 | - |
  | step8c25 (the user's pick) | 878 | $42,703 / $48,849 | 11% |
  | step8c20 | - | $41,499 | - |
  | step8c15 | - | $44,962 | - |
  | step8c10 | 552 | $60,306 | 6% |
  | step8c8 (block over 8%) | 456 | $66,249 | 5.1% |
  | now35 (0.35 delta) | - | $32,015 | - |

  Why a 6% spread still loses (step8c10, a trade): the move +1.5%, paid over the mid -4.2%, sold under the mid -4.8%,
  commission -1.7%: net -9%. The sell ladder adds ~6-14% to the end amount, not enough. The bar test's "±4" was ±4%
  of the option price a fill, not the spread; the real cost was the look-ahead above.
- **A worked example of the look-ahead** (page https://claude.ai/artifact/2Mdj3RBYLs4M6RREs69fjV, 10-second candles
  from Databento seconds): META 615C on 2026-04-08, the confirming bar 12:12: high 1.24, low 0.49, its middle 0.865 was
  the bar test's buy; the book at 12:13:00 was 1.25 / 1.33, the real buy 1.44 (the asks a second later 1.44, 1.49).
- **Live 2026-10-27:** the bot follows the Favorites list only (the user: "only on our favorites list for now"):
  settings `added` (167 watchlist tickers) emptied, `followFavorites` on (69 names then). Delta 0.20, size 2%,
  strengthFilter off, unchanged.
- **Live:** the bot already checked the side on the stock's last trade every 10 s (not the minute close); PR #180
  (merged and deployed 2026-10-27) adds a 1-second side watch. Not changed yet (the user to decide): the strength
  filter (setting `strengthFilter`, the t >= 0 rule) and limiting the bot to the top 15.
- Running: favorites (59 + QQQ, GOOG, NFLX) 3 years, cross, with a skip when the stock already moved 2/3/4/6 S30
  the side's way since the open or yesterday's close.

## Shock rule: 0.10 delta, and wider confirmation (2026-10-29)

The user: "test the shock with 0.1 delta" and "we must still have confirmation - can we test the shock with wider time to
approve?". Shock = the F60 rule at 15x volume (f60_alerts.py F60_K=15), 09:40-15:30, no burst, same-week expiry allowed;
top 50, 2024-02 to 2026-10, alone (no minute alerts), no limits (free2), 2 a stock, 2% a trade, the +-3% minute-bar
model (not real quotes). New: `SEC_VERSIONS=plain20,plain10` (leg_realspread.pick: plainNN = that delta, the liquid
fallback). Confirmation = `STR_CROSS_MAX` (the side within N s of the alert) x the entry: cross (first second past the
line) or holdN (N seconds in a row past it). Files: scratchpad vol/shockconf.

| Window | Delta | Entry | Trades | 3 years | Tune | Check | Check without 2025-10-10 |
|---|---|---|---|---|---|---|---|
| 15 s | 0.20 | cross (today's rule) | 447 | $197,185 | $169,296 | $116,072 | $99,061 |
| 15 s | 0.10 | cross | 381 | $197,540 | $177,011 | $111,997 | $93,672 |
| 60 s | 0.20 | hold5 | 481 | $299,888 | $172,564 | $172,879 | $148,294 |
| 60 s | 0.20 | hold10 | 371 | $339,844 | $152,254 | $223,521 | $168,704 |
| 5 min | 0.20 | hold5 | 598 | $344,150 | $181,099 | $190,327 | $163,516 |
| 5 min | 0.10 | hold30 | 458 | $385,639 | $115,833 | $334,633 | $246,838 |
| 5 min | 0.20 | cross | 600 | $232,393 | $151,554 | $151,854 | $130,919 |

- 0.10 delta: no better. Even at the cross; worse than 0.20 on most hold entries; the +-3% model flatters cheap options.
- Confirmation: a hold (the stock stays past the line) beats the plain cross at every window from 30 s on; 5 min and
  10 min are the same (nearly every cross comes within 5 minutes). Best balanced: 0.20, hold5 within 5 minutes (both
  halves +80-90%, check without 2025-10-10 +64%, drop 23%); its neighbours (hold5 at 60 s-10 min) all hold up.
  0.10 hold30 is bigger but rests on the check half (tune +16%).
- 48 versions looked at: selection bias. Next: real quotes (2025-02 on) for 0.20 hold5 <= 5 min, and with the winner.

## Volume size at the 60-second alert vs the move after (2026-10-29)

The user: "find connection between the size of the volume at the alert to the move itself". Every F60 alert at 2x and up
(fresh crossing, 30-min cooldown), 09:40-15:30, top 50, 2024-02 to 2026-10: 108,243 alerts, from the local 10-second bars.
Volume = the 60-second window vs its 20-session median or today's pace (the larger); moves in S30, signed the alert's way.
Script and data: scratchpad volmove/study.py, alerts.json.

- The typical alert: no link. Medians after 5/15/30 min are ~0 at every volume size; "kept going" 46-49% (42-44% at 20x+).
  Spearman log(volume) vs the 30-min move: -0.01. The alert's own move predicts the size of what follows (+0.25), not volume.
- The tail: a strong link, in both halves. Share of alerts the stock runs >= 4 S30 the alert's way within 30 min:
  0.6% at 2-5x, 0.9% at 5-10x, 1.5% at 10-15x, 2.6% at 15-20x, 1.9% at 20-50x, 0.5% at 50x+. Against the alert (>= 4 S30)
  stays 0.4-0.8%: the big runs at 15-50x go the alert's way 3-5 to 1. Clean run (>= 3 for, < 1 against): 1.6% at 2-5x,
  3.7% at 15-20x (check half 5.5-5.9% at 15-50x, the same without 2025-10-10).
- 50x and up is worse again (thin windows: a near-zero median, opening/halt prints): a cap at ~50x is worth testing.
- So the shock rule's edge is the tail, which suits options: most alerts go nowhere, and the large ones lean its way.

## The user's delta thesis on the shock alert (2026-10-29)

The user: "when the volume is big and the order fills faster - buy far delta (0.05-0.1), and go back to 0.25 delta when
the signal is less huge; if there is no interest in the contract, try one above". Shock 15x alone, top 50, 2024-02 on,
free2 at 2%, +-3% model plus a cent each way (`STR_TICK=0.01`). New: `upNN` (leg_realspread.pick: the strike nearest NN
delta from $0.05; under 200 contracts in 30 min, one strike toward the money, else none), `STR_MIX` + `STR_VOL_FILE`
(far version when the alert's volume >= V and the cross <= C s, else the near one). 12 mixes (far 0.05/0.10, V 20/30/50,
C 10 s/any) x windows 15 s / 5 min x entries; chosen on the tune half. Files: scratchpad vol/thesis.

| Version (5-min window, hold 5 s) | Trades | 3 years (drop) | Tune (drop) | Check (drop) | Check without 2025-10-10 |
|---|---|---|---|---|---|
| plain20 (today's picker: 0.20, from $0.20) | 598 | $323,094 (24%) | $173,343 (21%) | $185,242 (17%) | $158,414 |
| up25 | 666 | $343,072 (36%) | $165,824 (23%) | $204,881 (26%) | $179,612 |
| up10 | 581 | $298,798 (46%) | $201,944 (34%) | $147,724 (43%) | $149,591 |
| up05 | 502 | $153,660 (52%) | $128,692 (51%) | $118,784 (46%) | $119,828 |
| best mix on the tune half: 0.10 if >= 20x and cross <= 10 s, else 0.25 | 665 | $303,191 (39%) | $163,232 (24%) | $181,449 (30%) | $158,547 |
| mix: 0.10 if >= 50x and cross <= 10 s, else 0.25 | 667 | $325,655 (37%) | $162,389 (23%) | $200,000 (27%) | $175,288 |

- Not better. No mix beats plain 0.25 on the tune half, and every far-delta version deepens the drop (to 34-52%).
  A fixed 0.05 is the worst version at every window and entry ($46K-$154K, drops to 75%).
- The cheap contracts are the drop: the same 0.20-0.25 delta with a $0.20 floor (plain20) has drops of 17-24%; from
  $0.05 (up25) 23-36%. Keep the $0.20 floor and 0.20 delta.
- With hold entries the mix is mostly the near version (a hold rarely confirms within 10 s).

## All together: production plan + F60x2 + shock (2026-10-29)

The user: "lets run all together - the shock, with live bot strategy, with no limits - show me benchmark". All on the
+-3% minute-bar model (one pricing for all four), top 50 + 4 ETFs (production plan), 2024-02 to 2026-10, no limits, 2 a
stock, one at a time a stock. Each alert keeps its own entry: the minute alert and F60x2 the cross <= 15 s and the burst
(1.1, same-week 2.5); the shock (15x) the hold5 within 5 minutes, no burst (`STR_SRC_ENTRY=e_shock15=hold5:300`).
Files: scratchpad vol/together (dumps prod/prodf60/prodshock/all.json).

| Version | Trades | 2%: 3 years (drop) | 3% | Tune 2% (drop) | Check 2% (drop) | 3 years without 2025-10-10 | 2024 / 2025 / 2026 (2%) |
|---|---|---|---|---|---|---|---|
| Production plan | 301 | $698,050 (20.8%) | $1,405,096 (29.7%) | $178,399 (8.8%) | $387,859 (16.8%) | $250,510 | +20% / +327% / +33% |
| + F60x2 (live today) | 492 | $1,018,542 (25.5%) | $2,095,913 (35.9%) | $180,281 (11.5%) | $563,056 (20.7%) | $263,291 | +11% / +494% / +54% |
| + shock | 862 | $2,029,255 (25.8%) | $5,948,082 (36.3%) | $321,139 (12.1%) | $623,916 (15.9%) | $686,573 | +53% / +495% / +116% |
| + F60x2 + shock | 1,047 | $2,981,158 (29.3%) | $9,205,377 (40.9%) | $334,401 (21.2%) | $883,209 (18.1%) | $761,156 | +43% / +717% / +153% |

- The shock is the big add: in both halves, every year, and without 2025-10-10 ($687K vs $251K).
- F60x2 on top of the shock adds return but its drop (tune 12% -> 21%, 2024 12% -> 21%) for little: best risk/return is
  production + shock. Model prices, not real quotes; the shock's hold entry is the least reliable part of the model.

## Real quotes for F60x2 and the shock: both fail (2026-10-29)

The user: "these look very optimistic. Recheck the backtest to confirm it, and download the right price for the option."
Databento 1-second books at every buy (1,115 shock + 236 F60x2 windows) and minute quotes for every sale, then the four
versions again on real prices (no model), with four accounts: no limits (free2), one trade at a time a stock (flat2), the
live limits (live2: 15 a day, 5 open, 7.5% day loss), and 3%. Files: scratchpad vol/realq, vol/realrun.

| Version, real prices, 2% | 3 years (drop) | Without 2025-10-10 | Tune | Check without 10-10 | Live limits | 2024 / 2025 / 2026 |
|---|---|---|---|---|---|---|
| Production plan | $648,265 (23.6%) | $222,030 | $161,683 | $136,019 | $373,799 | +15% / +318% / +35% |
| + F60x2 | $603,239 (31.6%) | $142,829 | $138,064 | $102,351 | $283,663 | -7% / +451% / +18% |
| + shock (hold 5 s) | $573,802 (38.0%) | $187,867 | $161,610 | $118,888 | $231,238 | +2% / +253% / +60% |
| + F60x2 + shock | $533,178 (43.8%) | $124,393 | $140,450 | $90,535 | $223,184 | -18% / +358% / +42% |

The model was far off where it matters, trade by trade (real vs the +-3% bar model):
- minute alert, 0/1 DTE (554 trades): buy +0.5%, sale -6.3%; average return +13.9% -> +8.8%.
- F60x2 (232): buy +8.3% (median), sale -4.8%; +22.7% -> +14.5%.
- shock (1,083): buy +2.9% (mean +5.7%), sale -2.8%; +5.2% -> **-5.2%** a trade.
The faster the entry, the more the minute bar's middle under-states the real ask: the option is jumping in that minute.

Verdict: neither F60x2 nor the shock adds on real prices; every combination is worse than the production plan alone,
in the tune half, without 2025-10-10, and on the drop. F60x2 went live on 2026-10-29: recommended off (the `fastAlert`
setting). Also found: with no limits, a stock's second trade may overlap its first, so two alerts can buy the same move
(COIN on 2025-10-10, twice); "one at a time a stock" (flat2) is the honest no-limits account. On 2025-10-10 the plan put
53% of the account (66% all together) in open trades at once.

## The shock on real prices: fewer trades, cheaper fills (2026-10-29)

The user: "I still believe in the shock model. Maybe we have too many trades in there, and maybe we can optimize the buy
and sell spread." The 571 kept shock trades of plan + shock on real prices (vol/realrun/prodshock.json), by feature:
- burst against the side (< 0): 283 trades, -7.1% a trade (tune -7.5%, check -6.7%); burst >= 2.5: 26 trades, +83%.
- top 15 names +10.4% (both halves positive); rank 30+ -7.2%. Option $1-2: +13.6% (both halves); under $1 loses.
- 9:40-10:30 and 14:00-15:30 lose in both halves.
Filters with the plan, one trade at a time a stock, 2%, real prices (about 10 versions looked at, chosen after seeing the
groups):

| Version | 3 years (drop) | Tune | Check | 3 years without 10-10 | Check without 10-10 |
|---|---|---|---|---|---|
| Plan alone | $657,424 (22%) | $170,179 | $384,275 | $231,721 | $136,702 |
| + shock, no filter | $479,544 (35%) | $154,945 | $308,888 | $179,155 | $115,657 |
| + shock, burst >= 0, top 15 (99 shock trades, +7.1%) | $729,638 (26%) | $182,134 | $397,798 | $260,998 | $140,979 |
| + shock, burst >= 0, option >= $1 | $857,450 (26%) | $232,136 | $366,630 | $300,881 | $129,858 |
| + shock, burst >= 2.5 | $676,537 (22%) | $161,861 | $412,830 | $236,523 | $148,719 |

Only "burst >= 0, top 15" beats the plan in all four views, by 5-12%, with 4 points more drop: a lead for paper, not proof.
Fills: the spread at a shock buy is 12% of the mid (median; 75th pct 23%). The backtest already pays mid + a quarter of the
spread (+3.8%), and a buy limit at the mid fills within 10 s only 26% of the time, so no cheaper buy is available. The
sale is at the bid; a sell-side limit needs 1-second books at the exits (not downloaded).

### Waiting for the spread to come down (2026-10-29)

The user: "I would like to wait - a lot of stocks will continue the moves after the shock and the spread will come down."
615 shock buys with 1-second books (to 12 s after the buy) and minute quotes to 15:31.
- First 12 s: the spread's median is unchanged at every second; 47% narrower at 12 s, 23% narrower by a quarter or more,
  7% by half. The ask's median is unchanged too (36% cheaper at 12 s, 10% of buys >= 7% cheaper, 10% >= 10% dearer).
  A buy limit at the mid fills by 12 s 23% of the time.
- Waiting W minutes (buy at that minute's real book, mid + a quarter of the spread, only if the stock is still on the
  side's way; exit rules from the later buy; sale at the real bid):

| Wait | All shock: bought / turned back | avg trade (tune / check) | Burst >= 0, top 15: bought | avg trade (tune / check) | Spread at the buy (all / filtered) |
|---|---|---|---|---|---|
| 0 | 614 / 0 | +0.3% (+1.0% / -0.4%) | 112 | +14.6% (+13.7% / +15.7%) | 11.0% / 6.7% |
| 1 min | 309 / 306 | +0.0% (+3.0% / -3.1%) | 60 | +16.2% (+23.9% / +6.7%) | 9.6% / 5.1% |
| 2 min | 311 / 304 | -3.5% (+4.7% / -12.5%) | 56 | +7.7% (+26.2% / -15.2%) | 9.3% / 5.9% |
| 5 min | 317 / 298 | -3.5% (-1.0% / -6.2%) | 59 | +9.8% (+9.5% / +10.4%) | 8.2% / 4.4% |
| 10 min | 297 / 318 | -1.2% (+1.6% / -4.1%) | 51 | -3.4% (+1.7% / -12.6%) | 6.9% / 4.2% |

The spread does narrow with time (11% -> 7-9%), but about half the shocks turn back within a minute, and the ones that
keep going are not cheaper to enter: the option has priced the move. Buying at once is the most consistent.

### Benchmark on real prices with a 30% spread limit (2026-10-29)

The user: "remove all trades with a spread of more than 30%", then "show me all on benchmark". Real prices, 2%, one trade
at a time a stock (flat2), 2024-02 to 2026-10. Shock-only limits applied to the realrun dumps; the limit on every trade
via `STR_MAX_SPREAD=0.30` (vol/cap30). Page: https://claude.ai/artifact/2BqemC1fHxoaYzeCbxtqWv (Shock Trades).

| Version | Trades (shock) | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits |
|---|---|---|---|---|---|---|---|
| Plan alone | 270 (0) | $657,424 (22%) | $231,721 | $170,179 | $384,275 | $136,702 | $373,799 |
| Plan, every trade <= 30% | 218 (0) | $494,804 (18%) | $293,313 | $196,556 | $250,554 | $148,439 | $454,794 |
| Plan + shock | 798 (536) | $479,544 (35%) | $179,155 | $154,945 | $308,888 | $115,657 | $231,238 |
| Plan + shock <= 30% | 716 (453) | $721,780 (33%) | $268,235 | $191,845 | $376,244 | $141,325 | $337,802 |
| Plan + shock <= 30%, burst >= 0 | 492 (226) | $829,141 (27%) | $290,384 | $208,351 | $395,291 | $137,278 | $434,443 |
| Plan + shock <= 30%, burst >= 0, top 15 | 361 (92) | $743,888 (25%) | $263,229 | $183,431 | $404,387 | $143,735 | $425,559 |
| Plan + shock, every trade <= 30% | 669 (457) | $512,851 (30%) | $326,641 | $213,908 | $235,240 | $153,218 | $424,679 |
| Plan + shock, every trade <= 30%, burst >= 0 | 443 (229) | $612,148 (24%) | $353,921 | $234,172 | $258,318 | $149,782 | $512,759 |

- The 30% limit helps the plan's own minute alerts too: without 10-10 $232K -> $293K, drop 22% -> 18%, live limits
  $374K -> $455K; it gives up most of 10-10 (its crash-minute spreads were wide), hence the lower 3-year total.
- Best without 10-10 and in the tune half: every trade <= 30% with the shock at burst >= 0 ($354K, $234K, live $513K).
- The 30% line and the burst filter were set after seeing the data: paper first.

## Market-wide shocks: what 10-10 teaches (2026-10-29)

The user: "what can we learn from 10-10? we want to find such trades." A cluster = 5+ of the top 50 firing the shock
alert (15x) the same way within 3 minutes, known when the 5th joins; one per 30 minutes. 15 in 2024-02 to 2026-10
(scratchpad clusters/clusters.json). QQQ the cluster's way after 30 min, and the bot's real-price trades in the 5 minutes
after it (at a flat $2,000 a trade):

| Date | Known | Way | Stocks | QQQ 30 min | Bot trades (avg) | $ at $2,000 |
|---|---|---|---|---|---|---|
| 2025-10-10 | 10:59 | down | 5 | +1.47% | 21 (+471%) | +$197,973 |
| 2025-04-09 | 13:19 | up | 29 | +3.94% | 8 (+190%) | +$27,739 |
| 2026-01-21 | 14:28 | up | 9 | +0.88% | 3 (+212%) | +$12,779 |
| 2025-01-31 | 13:21 | down | 5 | +0.41% | 0 | 0 |
| 2024-09-18 | 14:00 | up | 26 | -0.15% | 11 (-45%) | -$9,779 |
| 2025-09-17 | 14:04 | up | 6 | -0.59% | 2 (+11%) | +$422 |
| 2024-12-18 | 14:09 | down | 6 | +0.16% | 0 | 0 |
| 2025-04-07 | 11:15 | down | 13 | -1.19% | 3 (-22%) | -$1,185 |
| others (7) | | | 5-7 | -0.23% to +1.32% | 0-4 each | -$2,528 to +$745 |

- The big wins are unscheduled headline shocks (tariff news on 2025-04-09 and 2025-10-10): the whole market moves
  together and keeps going for 30-60 minutes. The 14:00 clusters on Fed decision days (2024-09-18, 2025-09-17,
  2024-12-18) mostly reverse or stall: the largest cluster of all (26 stocks, 2024-09-18) lost.
- 15 events, 3 that matter: too few to fit a rule. Next: more events (a lower bar: 10x, or a breadth count of the
  minute alert; and 10-second bars further back than 2024 from Alpaca trades), and an index trade (QQQ/SPY 0DTE, one
  tight-spread contract) in the cluster's way, skipping scheduled 14:00 releases.

## Shock buys capped at the Black-Scholes price + 5% (2026-10-29)

The user: shock with a wide spread limit, "but apply only when you are trying to buy if the price is 5% more than the
Black-Scholes should be". Fair = Black-Scholes at the stock's price at the buy second, the volatility of the option's
last 1-minute bar before the alert minute (`fair` in the trade; `STR_FILTERS=shockbs`). Skip the shock buy when the price
paid (after the chase) is over fair x 1.05. Real prices, flat2 2%, plan + shock (hold5:300), 2024-02 to 2026-10.
All 615 shock buys had a fair price. Paid over fair: median +6.3% (10th pct -4.8%, 90th +28%).

| Shock version | Trades | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits |
|---|---|---|---|---|---|---|---|
| No shock (plan) | 270 | $657,424 (21.5%) | $231,721 | $170,179 | $384,275 | $136,702 | $373,799 |
| Shock | 798 | $479,544 (35.1%) | $179,155 | $154,945 | $308,888 | $115,657 | $231,238 |
| Shock, <= BS + 5% | 521 | $911,528 (24.9%) | $317,158 | $258,864 | $348,331 | $120,474 | $520,969 |
| Shock <= 50% | 762 | $605,012 (33.7%) | $226,048 | $174,567 | $345,445 | $128,861 | $288,527 |
| Shock <= 50%, <= BS + 5% | 511 | $929,489 (24.9%) | $323,273 | $265,760 | $346,888 | $121,142 | $521,850 |
| Shock <= 30% | 716 | $721,780 (33.5%) | $268,235 | $191,845 | $376,244 | $141,325 | $337,802 |
| Shock <= 30%, <= BS + 5% | 496 | $1,005,065 (24.9%) | $349,492 | $282,033 | $353,890 | $125,210 | $566,538 |
| Shock, burst >= 0 | 534 | $658,576 (24.6%) | $229,947 | $185,839 | $355,307 | $123,776 | $355,483 |
| Shock, <= BS + 5%, burst >= 0 | 383 | $869,056 (22.6%) | $303,692 | $233,270 | $369,542 | $130,684 | $494,061 |
| Shock <= 30%, burst >= 0 | 492 | $829,141 (26.6%) | $290,384 | $208,351 | $395,291 | $137,278 | $434,443 |
| Shock <= 30%, <= BS + 5%, burst >= 0 | 368 | $913,083 (22.0%) | $319,295 | $238,426 | $379,394 | $132,831 | $511,297 |

Shock trades kept and removed by the rule (all shock buys, per trade, net):

| | Tune: n, mean, median | Check: n, mean, median |
|---|---|---|
| Kept (<= fair + 5%) | 142, +22.1%, -10.8% | 138, -3.4%, -15.6% |
| Removed (> fair + 5%) | 167, -17.0%, -28.4% | 168, +3.1%, -26.0% |

- The rule gives the best 3-year totals and cuts the drop from 33-35% to 22-25%, but the gain is all in the tune half.
  In the check half the means flip (the removed buys did better) and every BS version ends below the plan alone
  ($346-379K vs $384K; without 10-10 $120-133K vs $137K).
- On medians it is consistent: the kept buys lose 11-16% at the median, the removed 26-28%, in both halves. It cuts the
  typical loser; the check half's few big winners were among the dear buys (volatility rising into the move).
- Not better than the plan on the check half: not for live. A lead: the price over fair as a size or exit input.

### Retry for 60 s instead of skipping; 3% as well as 5% (2026-10-29)

The user: "keep trying if we did not get a fair price, up to 1 minute, if the stock keeps big volume; test it with 3% as
well". A shock buy over Black-Scholes + cap tries again each second for up to 60 s (`shock_retry` in leg_seconds.py): the
first second the price (mid + a quarter of the spread) is at or under fair + cap buys, fair again at that second's stock
price with the pre-shock volatility; a second whose bid runs past the price within 10 s is no fill (keep trying). The volume
gate stops the tries once the stock's 60-second volume multiple (shock_volmult.py: 60-s window / its 20-session median or
today's pace; ~18x at the shock, ~11x a minute later, medians) drops under 10x or 5x. Books: cbbo-1s / cmbp-1 to 80 s
after the buy (opt2). Real prices, flat2 2%, plan + shock.

| Shock version | Trades | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits |
|---|---|---|---|---|---|---|---|
| No shock (plan) | 270 | $657,424 (21.5%) | $231,721 | $170,179 | $384,275 | $136,702 | $373,799 |
| Shock | 798 | $479,544 (35.1%) | $179,155 | $154,945 | $308,888 | $115,657 | $231,238 |
| <= BS + 3%, skip | 479 | $993,336 (23.5%) | $346,075 | $278,536 | $354,907 | $125,040 | $566,729 |
| <= BS + 3%, retry 60 s | 607 | $752,805 (27.3%) | $262,729 | $197,870 | $380,219 | $133,439 | $448,454 |
| <= BS + 3%, retry while volume >= 5x | 591 | $816,044 (27.6%) | $283,274 | $207,094 | $386,882 | $135,664 | $478,772 |
| <= BS + 3%, retry while volume >= 10x | 564 | $873,124 (28.4%) | $303,154 | $226,792 | $381,743 | $132,092 | $510,532 |
| <= BS + 5%, skip | 521 | $911,528 (24.9%) | $317,158 | $258,864 | $348,331 | $120,474 | $520,969 |
| <= BS + 5%, retry 60 s | 640 | $718,199 (29.4%) | $252,247 | $193,138 | $369,735 | $127,663 | $423,720 |
| <= BS + 5%, retry while volume >= 5x | 629 | $787,227 (28.7%) | $275,585 | $203,345 | $383,106 | $133,867 | $451,768 |
| <= BS + 5%, retry while volume >= 10x | 605 | $878,228 (28.5%) | $306,781 | $227,797 | $385,337 | $133,741 | $518,900 |

The retried buys (shock buys only, per trade, net): about 30-45% of the over-fair buys reach fair within 60 s, after 6-12 s
(median). Tune: -19% to -29% a trade (median -27% to -32%); check: +11% to +16% (median -19% to -22%). The same flip as
the skip rule: once paid at fair, the over-fair buys are still the weak ones at the median, and their average is decided
by a few runners in the check half. The volume gate helps (10x > 5x > none in every view).
- Best 3-year total so far: <= BS + 3%, skip ($993K, drop 23.5%, live limits $567K, without 10-10 $346K), but its check
  half is below the plan alone ($355K vs $384K). No version beats the plan in the check half without 10-10 ($132-136K vs
  $137K). Not for live.

## The shock's delta: 0.10 to 0.30 (2026-10-30)

The user: "can you test it on delta 0.1, 0.15, 0.25, 0.3?" (plan + shock <= 30%, burst >= 0). Only the shock's buys change
contract (`STR_SRC_V=e_shock15=plainNN`, leg_realspread plainNN); the minute alerts stay at 0.20. New picks for e_shock15
(SEC_VERSIONS=plain20,up05,up10,up25,plain10,plain15,plain25,plain30; the old file kept as pickse_shock15.bak.json), books
at the buy and minute quotes for the sale from Databento. Real prices, flat2 2%, 2024-02 to 2026-10. Plan alone: $657,424
(21.5%), without 10-10 $231,721, tune $170,179, check $384,275, check without 10-10 $136,702, live limits $373,799.

| Shock delta | Trades | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits |
|---|---|---|---|---|---|---|---|
| 0.10 | 455 | $787,448 (28.9%) | $275,399 | $206,543 | $376,140 | $132,729 | $441,494 |
| 0.15 | 472 | $791,327 (28.7%) | $277,598 | $216,496 | $364,255 | $128,216 | $417,353 |
| 0.20 | 492 | $829,141 (26.6%) | $290,384 | $208,351 | $395,291 | $137,278 | $434,443 |
| 0.25 | 505 | $812,654 (22.0%) | $283,169 | $200,721 | $404,035 | $141,249 | $432,349 |
| 0.30 | 513 | $745,046 (21.6%) | $260,024 | $208,284 | $355,808 | $125,225 | $380,250 |

- 0.20 and 0.25 lead; 0.10/0.15 lose the check half and have the biggest drops; 0.30 gives back the move.
- 0.25 is the best balanced: the best check half (with and without 10-10), the drop 22% (vs 26.6%), within 2% of 0.20 on
  the totals. Both beat the plan in all six views. The same order holds with no spread limit or no burst filter
  (0.25 has the smallest drops there too).

### The narrowest spread between delta 0.10 and 0.35 (2026-10-30)

The user: "when we want to buy, search between delta 0.35 to 0.1 the delta with the best spread and buy only when <= 30%.
It should add more trades." `STR_SRC_BEST=e_shock15=plain10:...:plain35`: of the six contracts (0.10, 0.15, ..., 0.35;
plain35 newly picked and fetched) the one with the narrowest spread of the mid at the buy second, ties to the one nearest
0.20. Real prices, flat2 2%, plan + shock.

| Shock contract | Filter | Trades | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits |
|---|---|---|---|---|---|---|---|---|
| 0.20 | <= 30%, burst >= 0 | 492 | $829,141 (26.6%) | $290,384 | $208,351 | $395,291 | $137,278 | $434,443 |
| 0.25 | <= 30%, burst >= 0 | 505 | $812,654 (22.0%) | $283,169 | $200,721 | $404,035 | $141,249 | $432,349 |
| 0.35 | <= 30%, burst >= 0 | 522 | $755,158 (21.6%) | $263,556 | $214,348 | $350,205 | $122,655 | $366,433 |
| Narrowest | <= 30%, burst >= 0 | 527 | $782,092 (22.6%) | $273,462 | $219,171 | $352,170 | $124,359 | $387,758 |
| Narrowest | <= 30% | 789 | $621,132 (28.6%) | $231,036 | $201,091 | $308,128 | $114,042 | $273,943 |
| Narrowest | all | 855 | $486,041 (31.1%) | $178,801 | $169,454 | $285,889 | $104,924 | $221,681 |

- It adds shock buys (594 under 30% vs 512 at 0.20), but the added ones (0.20 over 30%, another strike under) lose:
  tune 34, +4.3% (median -18.7%); check 48, -15.9% (median -31.3%). A wide spread at 0.20 marks a bad shock, whatever strike.
- The narrowest spread is mostly the dearest contract (0.35 or 0.30 in 229 of 594), and the dear contracts give back the
  move (0.35 alone: check $350K). Not better than a fixed 0.20 / 0.25.

## The shock's contract floors and its expiry (2026-10-30)

The user: no liquidity floor (the 30-minute count looks back, the shock is when trading starts; the 30% spread limit
protects), "try 0, 50, 100"; under $0.20 try $0.15; or step to 0.25, 0.30, 0.35 and check the price again. And, after
the expiry split (shock 3-4 DTE lost in both halves; overnight holds of the runners only won on 2025-04-09), the shock
on 0-1 and 0-2 DTE only. leg_realspread.pick `lqN`, `mpN`, `step35`; leg_seconds `STR_SRC_DTE`. Real prices, flat2 2%,
plan + shock <= 30%, burst >= 0; only the shock's buys change.

| Shock version | Shock buys | Trades | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits |
|---|---|---|---|---|---|---|---|---|
| Plan alone | 0 | 270 | $657,424 (21.5%) | $231,721 | $170,179 | $384,275 | $136,702 | $373,799 |
| 0.20, >= $0.20, >= 200 (now) | 259 | 492 | $829,141 (26.6%) | $290,384 | $208,351 | $395,291 | $137,278 | $434,443 |
| Liquidity >= 0 | 267 | 498 | $947,979 (29.7%) | $331,073 | $243,808 | $388,354 | $135,955 | $432,499 |
| Liquidity >= 50 | 289 | 517 | $880,255 (28.9%) | $307,701 | $244,908 | $357,662 | $126,534 | $407,536 |
| Liquidity >= 100 | 292 | 524 | $820,709 (29.7%) | $284,743 | $227,129 | $360,297 | $125,821 | $382,878 |
| Price >= $0.15 | 273 | 504 | $844,749 (26.6%) | $293,976 | $224,179 | $369,609 | $130,227 | $428,138 |
| Step to 0.25/0.30/0.35 when under $0.20 | 279 | 509 | $881,785 (22.0%) | $306,383 | $218,260 | $401,594 | $140,763 | $435,906 |
| Shock 0-1 DTE only | 100 | 346 | $876,420 (21.9%) | $304,249 | $189,342 | $461,561 | $162,331 | $492,437 |
| Shock 0-2 DTE only | 173 | 413 | $1,008,467 (25.1%) | $352,893 | $233,173 | $429,819 | $148,165 | $526,212 |

- Shock 0-2 DTE beats the current shock in every view (3 years +22%, check without 10-10 +8%, live +21%) with fewer
  trades and a smaller drop; 0-1 DTE has the best check and drop but a weaker tune half.
- Step to 0.35 when under $0.20: better than the current pick in every view, by a little (+6%), drop 26.6% -> 22.0%.
- Lower liquidity floors and the $0.15 floor lift the tune half but lose the check half.
- Next: 0-2 DTE with the step to 0.35 together.

Together (`STR_SRC_DTE=e_shock15=2 STR_SRC_V=e_shock15=step35`): 428 trades, $1,069,492 (drop 20.5%), without 10-10
$374,326, tune $245,281, check $432,129, check without 10-10 $151,600, live limits $532,238; by year 2024 $134,397,
2025 $502,719, 2026 $154,601 (each from $100K). Better than both alone in every view, and the drop is under the plan
alone's (21.5%). The candidate for live: shock (15x, hold5 within 5 min, 09:40-15:30), 0-2 DTE, burst >= 0, spread <= 30%
at the buy, 0.20 delta stepping to 0.25/0.30/0.35 when under $0.20.

### Shock scale-out: 25% at +100%, 25% at +300%, 10% at +400% (2026-10-30)

The user: "take 25% when 100%+, then another 25% when 300%, then 10% at 400%" on the shock trades of the live version
(0-2 DTE, <= 30%, burst >= 0, step35). `STR_SRC_SCALE=e_shock15=1:0.25,3:0.25,4:0.10`: a part sells when the option's
bid at a minute close reaches the level, at that bid (real cbbo-1m); the rest on the usual exit.

| | Live version | Scale-out |
|---|---|---|
| Account (drop) | $1,069,492 (20.5%) | $941,052 (20.5%) |
| Without 10-10 | $374,326 | $327,518 |
| Tune / check | $245,281 / $432,129 | $233,507 / $399,794 |
| Check without 10-10 | $151,600 | $140,064 |
| No limits / live limits | $1,253,857 / $532,238 | $1,051,583 / $466,745 |
| Shock P&L in the account | $208,774 | $119,660 |

39 shock trades reached +100% on the bid; the scale-out made 20 better and 19 worse, but the worse ones are the runners
(the shock's money is a few big trades). Worse in every view, every year. Not adopted.

### Shock scale-out, Indi style (2026-10-30)

Same setup as the scale-out above (live version, flat2, real bids at minute closes), two more ladders on the shock trades:

| | Live | 25/+100, 25/+300, 10/+400 | 25/+200 only | 25/+200, 25/+700, 10/+1000 |
|---|---|---|---|---|
| Account (drop) | $1,069,492 (20.5%) | $941,052 (20.5%) | $1,020,459 (20.7%) | $1,058,642 (20.7%) |
| Without 10-10 | $374,326 | $327,518 | $355,316 | $368,406 |
| Tune / check | $245,281 / $432,129 | $233,507 / $399,794 | $241,420 / $420,288 | $241,840 / $433,773 |
| Check without 10-10 | $151,600 | $140,064 | $147,414 | $151,571 |
| No limits / live limits | $1,253,857 / $532,238 | $1,051,583 / $466,745 | $1,165,435 / $504,874 | $1,208,513 / $525,473 |
| Shock P&L | $208,774 | $119,660 | $173,412 | $205,408 |

20 shock trades reached +200% (10 better, 10 worse), 5 reached +700%, none +1000%. The later ladder is a tie
with the live version (−1% overall, check +$1.6K); not adopted: no gain, one more moving part.

## The plan's spread, and the shock's spread step and liquidity floor (2026-10-30)

The user: "if the spread is more than 30%, try to buy another delta like we do on the shock" (the plan), and the two
shock contract rules never tested on the live version: step to another delta on a spread over 30% (instead of the
skip), and no liquidity floor. New: the plan alerts picked again at 0.25 / 0.30 / 0.35 (tags `3y50p` ... `3ycand5wp`,
copies of the plan event lists) and their option windows fetched (about 1,700); leg_seconds `STR_PLAN_STEP`
(cap / keep / skip), `STR_SHOCK_STEP`, and a version chain in `STR_SRC_V` (`lq0>step35`: the 0.20 contract with no
liquidity floor, else the step-up as live). Real prices, flat2 2%, live version otherwise (plan + shock 0-2 DTE,
spread <= 30%, burst >= 0, step35). The reference on the re-picked plan lists gives $1,080,384 (427 trades) against
the logged $1,069,492 (428): one plan trade differs; the check half is identical.

| Version | Trades | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits |
|---|---|---|---|---|---|---|---|
| Live now (reference) | 427 | $1,080,384 (20.5%) | $376,086 | $247,864 | $432,129 | $151,600 | $537,705 |
| Plan: skip a spread > 30% (no step) | 379 | $778,586 (19.0%) | $448,320 | $275,058 | $279,126 | $163,290 | $617,390 |
| Plan: step 0.25-0.35, else buy the 0.20 | 427 | $994,933 (20.4%) | $389,704 | $252,560 | $391,198 | $152,509 | $503,634 |
| Plan: step 0.25-0.35, else skip | 394 | $874,008 (20.1%) | $421,376 | $267,554 | $324,834 | $157,144 | $555,721 |
| Shock: step on a spread > 30% | 441 | $989,318 (20.6%) | $344,209 | $243,387 | $405,351 | $140,827 | $487,587 |
| **Shock: no liquidity floor** | 447 | **$1,314,633** (21.5%) | **$457,745** | **$287,356** | **$450,368** | **$158,898** | **$566,943** |
| Shock: both | 468 | $1,160,157 (21.7%) | $401,792 | $276,826 | $416,202 | $145,791 | $497,517 |

- Shock with no liquidity floor beats live in every view and every year (2024 $141K, 2025 $550K, 2026 $165K); the drop
  is one point higher. The candidate for live.
- The shock's spread step loses everywhere: the wide-spread shock buys are better skipped.
- The plan's spread: skipping or stepping wins without 10-10, in the tune half and with live limits, but loses the
  check half with 10-10: that day's plan winners had wide spreads. Not a clean win.
- Next: the shock with no floor together with each plan rule.

### The plan with no liquidity floor, and a 40% spread cap, on top of the shock with no floor (2026-10-30)
The user: "did you try no liquidity for the plan as well? Mix it with max spread 40%". The shock now buys with no
liquidity floor (`lq0>step35`) in every row. New: the plan alerts picked with no floor (`lq0`, tags `3y50q` ...
`3ycand5wq`, about 900 option windows fetched); leg_seconds `STR_PLAN_V` (the plan's version chain, e.g.
`lq0>plain20`) and `STR_PLAN_CAP` (the spread cap, default 0.30). flat2 2%. The reference ($1,326,357) is a little
above the row above ($1,314,633): the shock picks were refreshed with the plan's new tags.

| Plan version | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|
| As live (floor 200, no cap) | $1,326,357 (21.5%) | $459,376 | $289,320 | $450,368 | $158,898 | $574,790 | $141,148 | $558,145 | $164,760 |
| **No liquidity floor** | **$1,426,390** (21.3%) | $482,827 | $288,946 | **$487,505** | $166,688 | $607,398 | $141,182 | $615,877 | $161,493 |
| Skip a spread > 40% | $1,109,737 (21.5%) | $509,637 | $317,563 | $347,113 | $161,550 | $631,362 | $152,443 | $425,142 | $168,168 |
| No floor + skip > 40% | $1,091,484 (20.0%) | $494,950 | $306,646 | $352,690 | $162,216 | $616,696 | $152,989 | $418,745 | $165,915 |
| Skip a spread > 30% | $964,140 (19.9%) | **$554,372** | **$323,432** | $294,953 | **$169,606** | **$664,430** | $154,168 | $349,088 | $175,824 |
| Step 0.25-0.35, else skip | $1,071,446 (21.0%) | $513,138 | $312,209 | $337,756 | $165,297 | $601,243 | $148,376 | $412,233 | $173,854 |
| Step 0.25-0.35, else keep | $1,215,041 (21.4%) | $472,645 | $293,947 | $409,172 | $161,447 | $530,224 | $143,682 | $500,092 | $165,643 |

- The plan with no floor: better on the headline, without 10-10, the check half (both ways) and live limits; the tune
  half ties (-$374) and 2026 is $3K lower. A small, clean gain; the candidate to go with the shock's no floor.
- Every spread cap is the same trade: it wins without 10-10, in the tune half and with live limits (the 30% skip by
  the most: +$95K without 10-10, +$90K live limits), and gives back $100K-$360K on 10-10 alone, whose plan winners had
  wide spreads. Whether that is a gain depends on whether such days come again; one day decides it (see giants).
- The 40% cap sits between none and 30% on every column; adding no floor to it changes little.

## Audit of the simulator (2026-10-30)
The user doubted a 35-43% win rate on 0-2 DTE options. A code review of leg_seconds / leg_fallback / leg_realspread
and checks on the trades found two bugs (both now behind switches, off by default so old runs reproduce):

- **Dropped losers** (`STR_WALK_KEEP=1` fixes): `leg_fallback.walk` returned None when the option had no trade print in
  the 3 minutes after the buy, and the trade vanished. Those trades average about -25% (17% won).
- **Chase below the bid** (`STR_CHASE_NOFILL=ask` fixes): when the bid 10 s after the buy was above the price, the buy
  was capped at +10%, under the bid. The live bot chases the ask for 3 minutes with no cap (ladder.ts), so the fix pays
  the ask 10 s later (`=1` skips the trade instead: too harsh).

Fine: no look-ahead in entry or exit (the exit sells at the book as the decision minute closed), zero bids = -100%, no
duplicate or overlapping trades, nothing overnight, the giant winners match the stock's move and intrinsic value.
Optimistic, not fixed: the buy at mid + 1/4 spread (the ask never came that low within 10 s in 63% of buys); size
(at 2% most sales exceed the option's volume in the 5 minutes around them; at 3-5% far worse); the top-50 list is
today's, applied to 2024.

Note (2026-10-31): these rows include trades on a silent fallback strike the live bot skips; the live rules make
$827,157 (no floor) and $608,664 (floor 200, the live setting). See "The live rules replayed" at the top of the Log.

flat2 2%, q tags:

| Version | Trades | Account (drop) | Without 10-10 | Tune | Check | Check without 10-10 | Live limits |
|---|---|---|---|---|---|---|---|
| Live, old model | 427 | $1,080,384 (20.5%) | $376,086 | $247,864 | $432,129 | $151,600 | $537,705 |
| Live, fixed (chase to ask) | 430 | $782,861 (21.1%) | $289,360 | $213,791 | $360,826 | $135,485 | $392,938 |
| No floor, old model | 460 | $1,426,390 (21.3%) | $482,827 | $288,946 | $487,505 | $166,688 | $607,398 |
| No floor, walk fix only | 467 | $1,387,994 (21.4%) | $469,066 | $279,934 | $488,386 | $167,034 | $575,533 |
| **No floor, fixed (chase to ask)** | 467 | **$1,011,767** (22.2%) | $362,862 | $242,569 | $411,139 | $150,531 | $426,679 |

- The fixed model takes about 28-30% off both. No floor still beats live in every column and year; the candidate stands.
- Per trade, fixed no floor: plan 42% won, average +45%, median -24%, +16% without its best 10; shock 36% won, +22%,
  median -19%, -1% without its best 10. The win rate is real; the average is a few 10x days.
- Every later volume-bot test runs with `STR_WALK_KEEP=1 STR_CHASE_NOFILL=ask`, the defaults since 2026-10-31 (`STR_WALK_KEEP=0 STR_CHASE_NOFILL=cap` = before the audit).

## Option books around every plan and shock alert, bought for 3 months (2026-10-31)

The user, 2026-10-31: "I want to start to save the needed data for alerts from this bot" ... "i want to save every 2
second around the alert + delta 0.1 to 0.35" ... "F60x2 is currently not in use. only plan and shock is relevant" ...
"go for both". The live trader saves the same from now on (apps/trader/src/alert-books.ts); this fills the past.

- Script `scripts/research/indi_bt/alert_books_hist.py` (steps alerts, list, cost, fetch, store, upload). Alerts on the
  69 Favorites, 2026-08-03 to 2026-10-30: the plan alert as the live bot fires it (checked minute by minute against the
  TypeScript `alerts()` on NVDA 2026-10-28 and COIN 2026-09-03) and the shock (F60, 15x, 09:40-15:30).
- Contracts: |delta| 0.10-0.35, calls and puts, the bot's expiry (nearest within 4 days); delta from Black-Scholes at
  the alert price with the 20-day volatility x 1.15. Adjusted series (BABA2 ...) left out.
- Bought from Databento OPRA: cbbo-1s from the alert second - 2 s to + 300 s per alert, and cbbo-1m from the day's first
  alert minute to 15:30 for the union of the day's contracts. $3.00 (metadata.get_cost over the exact request list:
  plan 1-second $2.08, shock 1-second $0.47, minutes $0.45).

| | Alerts | Stock-days | Stored |
|---|---|---|---|
| Plan | 2,559 | 862 | 2,529 alert windows (30 had no contract in the band) |
| Shock | 1,156 | 663 | 1,112 alert windows (43 none in the band, 1 not resolved) |
| Minutes | | 1,111 | 11,493 contract-days |

- Stored in `data/local/alert-books.sqlite`: `alert_books_hist` (one row per alert, shaped like the live
  `AlertBookWatch`: contracts with their delta, samples every 2 s for 300 s of [bid, ask] per contract) and
  `minute_books` ([[m, bid, ask], ...], m = the minute whose close the book is). The minute books also went to the
  app's D1 `option_quotes` as "databento" (10,354 contract-days new or changed; the rest were already there).
- Gaps: AVGO 2026-09-02 (Databento resolved none of that day's contracts); 10 alert windows with no quote at all and 136
  under half filled, all thin names (AMBA, LMND, SIRI, TSEM, ...).

### Which trades get a double bet (2026-11-02, look 1 for the account test; the scan saw both halves)

The user, 2026-11-02: "I would like to find trade to double up the bet." 3-year twin of 1.1.0 (top 50, live,
Feb 2024 - Oct 2026; `volume_double_scan.py`, `volume_double_acct.py`). The scan: 16 features known at the buy minute
(plan/shock, side, weekday, nth trade, minute, option price, spread, delta, the stock's move since the open and in the last
30 min our way, position in the day's range, the last 10 minutes' volume vs the day's minute average, day range, SPY,
RS), tertiles cut on tune, without 10 Oct 2025. All trades: tune avg +7% / median -31%, check +27% / -16%. Groups better
on avg, median and the avg under +300% on both halves: last-10-minute volume >= 1.2x (tune +20% / -28%, check +50% /
-3%), at the day's high (range pos >= 0.955: +2% / -18%, +34% / -2%), last 30 min >= +1.34% our way. Calls beat puts on
both halves (+18% / +34% vs -8% / +19%). The second trade of a stock-day is worse on both (27 trades).

The account (x2 on the group at 2%; 3% capped at 5% a position), against a flat size with the same worst drop:

| Version | x2 trades | 2% end (drop) | Tune | Check | w/o best 5 | Flat at the same drop: end, tune, check, w/o 5 |
|---|---|---|---|---|---|---|
| 1.1.0 twin | 0 | $773K (21.1%) | +$73K | +$600K | +$201K | - |
| x2 volume burst >= 1.2x | 152 | $1,741K (26.1%) | +$182K | +$1,459K | +$177K | 2.53%: $1,131K, +$106K, +$925K, +$201K |
| same, without 10-10 | 144 | $611K (26.1%) | +$72K | +$439K | -$5K | $362K, +$31K, +$231K, -$4K |
| x2 at the day high | 141 | $1,207K (26.3%) | +$123K | +$984K | +$247K | 2.56%: $1,152K, +$108K, +$945K, +$199K |
| same, without 10-10 | 135 | $406K (26.3%) | +$35K | +$271K | +$19K | $366K, +$31K, +$235K, -$5K |
| x2 last 30 min strong | 144 | $1,336K (24.0%) | +$54K | +$1,182K | +$162K | 2.30%: $966K, +$92K, +$774K, +$207K |

Neighbours of the burst cut (1.0x / 1.5x) are worse than 1.2x but above 1.1.0. Caveats: the feature was picked after the
scan showed both halves (the check is not clean); the walk scales each trade's P&L (no limits, no contract rounding);
today's alert-burst tiers on the live code's year failed the check. Next: the burst x2 on the live code's year (pr_ parts,
volumeAccount, the live limits).

**On the live code's year (look 1 there; `volume_double_feat_year.py` + `volume_double_acct_year.ts`)**: Volume 1.1.0 pr_
parts, 2025-11-03 .. 2026-10-30, the live limits (15 a day, 5 open, 7.5% day loss, 2 a stock), x2 capped at 5% a
position; cuts fixed from the 3-year tune. Against the flat size with the same worst drop, at 2%:

| Version | x2 trades | Year (drop) | Tune | Check | Year w/o best 5 | Flat at the same drop: year, tune, check, w/o 5 |
|---|---|---|---|---|---|---|
| 1.1.0 | 0 | $142.1K (13%) | $111.9K | $125.6K | -$23.6K | - |
| 🎯 x2 volume burst >= 1.2x | 86 | $165.6K (23%) | $103.7K | $159.6K | -$56.6K | 3.56%: $173.0K, $119.0K, $144.1K, -$50.5K |
| neighbour >= 1.0x | 104 | $160.9K (23%) | $105.4K | $152.0K | -$62.7K | 3.55%: $173.1K, $119.0K, $144.0K, -$50.4K |
| neighbour >= 1.5x | 50 | $194.2K (18%) | $119.7K | $162.0K | -$39.4K | 2.82%: $158.5K, $116.1K, $137.0K, -$36.5K |
| x2 at the day high | 58 | $145.6K (21%) | $114.7K | $126.8K | -$42.7K | 3.33%: $168.1K, $117.8K, $142.5K, -$45.7K |

- **No candidate.** The pick (1.2x) loses tune to the flat line (and to 1.1.0 itself: $103.7K vs $111.9K) and the year
  to the flat line; its gain is all in the check half. The day high loses to the flat line on every half.
- 1.5x beats the flat line on the year and both halves, but only by a little on tune, worse without the best 5 on the
  year and check, and it was the worse neighbour on the 3 years: choosing it now would be picking from the result.
- Same as the alert-burst tiers this morning: on the live code's year, a bigger bet on a volume burst does not beat a
  plain bigger bet. Doubling just adds risk.

**Shock alerts only (the user: "Can you test it only on shock alert?", look 1)**: x2 on shock trades (all, or with the
burst / day-high cuts), same scripts. Live code's year, 2%, against the flat size at the same worst drop:

| Version | x2 | Year (drop) | Tune | Check | w/o 5 | Flat: year, tune, check, w/o 5 |
|---|---|---|---|---|---|---|
| x2 every shock | 69 | $143.8K (18%) | $129.4K | $111.2K | -$51.5K | 2.82%: $158.5K, $116.1K, $137.0K, -$36.5K |
| x2 shock at burst >= 1.2x | 43 | $136.2K (17%) | $112.6K | $119.5K | -$43.1K | 2.69%: $155.1K, $115.3K, $134.9K, -$34.7K |
| shock >= 1.0x / >= 1.5x | 51 / 26 | $139.3K / $140.1K | $119.7K / $119.7K | $118.1K / $116.9K | | 2.69% / 2.52%: $155.2K / $153.0K |
| x2 shock at the day high | 27 | $150.1K (16%) | $119.9K | $125.1K | -$30.6K | 2.39%: $149.9K, $114.3K, $131.4K, -$29.9K |

3 years (scaled walk): shock at burst >= 1.2x $1,063K at a 19.3% drop vs 1.1.0 $773K (21.1%), better on both halves
(without 10-10 $390K vs $288K) but worse without the best 5 (-$4K vs +$11K without 10-10). **No candidate**: on the live
code's year every shock variant loses the check to the flat line; the day high ties it on the year (+$0.2K), wins tune,
loses check. On this year the doubled shocks' check weeks are the weak half (x2 every shock: tune +$17K over 1.1.0, check
-$14K).

### The option's price before the buy (2026-11-02, analysis)

The user: "give me data on the option price - the size of it before the alert/bought 1-5-10-15 minutes by destribution".
Volume 1.1.0 live-code year, the 145 trades the live account takes (`volume_taken_ids.ts`, `volume_option_before_buy.py`);
the bought contract's Databento mid k minutes before the buy minute vs the price paid. The stored books start near the
alert, so 5 / 10 / 15 minutes back exist for 102 / 99 / 90 trades only.

| Before | n | p10 | p25 | median | p75 | p90 | median mid then -> paid |
|---|---|---|---|---|---|---|---|
| 1 min | 144 | +4% | +9% | +18% | +39% | +88% | $0.62 -> $0.83 |
| 5 min | 102 | +33% | +67% | +97% | +203% | +404% | $0.33 -> $0.85 |
| 10 min | 99 | +31% | +78% | +144% | +218% | +630% | $0.30 -> $0.85 |
| 15 min | 90 | +25% | +78% | +156% | +278% | +874% | $0.26 -> $0.84 |

Plan median rise 1 / 5 / 10 / 15 min: +14% / +111% / +152% / +174%; shock +28% / +91% / +123% / +123%. By bucket
(the trade's result): no bucket is better on both halves. Doubled or more in the 5 minutes before (49 trades): won 27%,
median -45% (tune -48%, check -25%), 3 of +300%; +25-50% in 5 min (10 trades): median -4%; up 100%+ in the last minute
(9): median +6% but tune +55% / check -10%. The bot buys after the option has already doubled in most trades; the
small groups that look better are too few and flip between halves. No rule proposed.

**Size by the option's rise before the buy (look 1; the user: "double only if the option did not raise more than 100%?
and half if it did more than 300%")**: `volume_option_rise.py` + `volume_option_rise_acct.ts`, live code's year, live
limits, rise = paid vs the mid k minutes before (5 min the main window, 1 / 10 / 15 as neighbours, set before the run);
no book then (43 of 145 at 5 min) -> size unchanged. 2%, against the flat size at the same worst drop:

| Version | Changed | Year (drop) | Tune | Check | w/o 5 | Flat: year, tune, check |
|---|---|---|---|---|---|---|
| 1.1.0 | 0 | $142.1K (13%) | $111.9K | $125.6K | -$23.6K | |
| 5m: x2 <= +100%, half > +300% | 67 | $143.6K (17%) | $104.5K | $137.3K | -$27.6K | 2.58%: $152.6K, $114.8K, $133.2K |
| 5m: x2 <= +100% only | 53 | $137.6K (19%) | $106.0K | $130.5K | -$32.8K | 2.91%: $158.8K, $116.2K, $136.5K |
| 5m: half > +300% only | 14 | $147.1K (12%) | $109.9K | $132.1K | -$18.4K | 1.77%: $136.2K, $110.8K, $123.8K |
| 10m both | 55 | $134.5K (14%) | $107.2K | $124.4K | -$26.8K | 2.14%: $144.4K, $112.5K, $127.5K |
| 15m both | 53 | $130.0K (15%) | $102.4K | $125.5K | -$30.0K | 2.30%: $147.3K, $113.4K, $129.8K |
| 1m both | 138 | $167.4K (26%) | $109.7K | $151.3K | -$63.4K | 4.00%: $181.3K, $120.8K, $149.8K |

- **The double part fails** on every window: tune below 1.1.0 and below the flat line.
- **Half size over +300% in 5 min** (14 trades) is the only part that helps: a smaller drop (12% vs 13%) and more money
  on the year (+$5.0K) and check (+$6.5K), better without the best 5, but tune is $2.0K below 1.1.0 (and $0.9K below the
  flat line). Fails the tune gate by a little; 14 trades, look 1. Not a candidate; a watch item.

**The same on the ask, x2 at <= +50% (look 2 of the idea; the user: "what about the first rule (double) for 50%? 50% on 1
minute? and look always on the ask")**: rise = paid vs the ask k minutes before; 1 min (144 trades with a book, median
+11%, 121 at <= +50%) and 5 min (102, median +89%, 22 at <= +50%); +25% / +100% neighbours. 2%:

| Version | x2 | Year (drop) | Tune | Check | w/o 5 | Flat at the same drop: year, tune, check |
|---|---|---|---|---|---|---|
| 1.1.0 | 0 | $142.1K (13%) | $111.9K | $125.6K | -$23.6K | |
| ask 1m <= +50% | 121 | $170.4K (31%) | $105.6K | $162.3K | -$52.6K | 4% (26%, the sweep's top): $181.3K, $120.8K, $149.8K |
| ask 1m <= +25% / +100% | 104 / 136 | $147.6K (28%) / $171.1K (25%) | $96.4K / $111.7K | $152.3K / $151.4K | | 4% / 3.86%: $181.3K / $179.6K |
| ask 5m <= +50% | 22 | $127.1K (17%) | $105.4K | $120.7K | -$33.6K | 2.62%: $153.0K, $115.6K, $132.7K |
| ask 5m <= +25% / +100% | 11 / 56 | $133.4K / $137.4K | $107.5K / $105.9K | $124.0K / $130.3K | | 2.05% / 2.91%: $142.0K / $159.0K |
| ask 5m half > +300% only | 12 | $143.9K (12%) | $108.7K | $132.1K | -$19.1K | 1.86%: $137.8K, $111.5K, $124.1K |

**No candidate.** Every double variant is below 1.1.0 on tune (the doubled trades lose there) and below the flat line on
the year; the 1-minute one is nearly every trade (121 of 145), so it is a bigger size with a worse tune. The half over
+300% on the ask repeats the mid result (smaller drop, better check, tune -$3.2K).

**Half / skip by a big rise, on the ask, 5 min (look 3 of the idea; the user: "check the 300% with others. 200, 400.
also - check do not enter at all if more than 500-600%")**: `volume_option_rise_cut.ts`. 2%, against the flat line:

| Version | Changed | Year (drop) | Tune | Check | w/o 5 | Flat at the same drop: year, tune, check |
|---|---|---|---|---|---|---|
| 1.1.0 | 0 | $142.1K (13%) | $111.9K | $125.6K | -$23.6K | |
| half > +200% | 21 | $132.2K (10%) | $111.7K | $118.9K | -$16.1K | 1.58%: $132.4K, $109.1K, $120.0K |
| half > +300% | 12 | $143.9K (12%) | $108.7K | $132.1K | -$19.1K | 1.86%: $137.8K, $111.5K, $124.1K |
| half > +400% | 10 | $143.1K (12%) | $108.7K | $131.0K | -$19.8K | 1.86%: $137.7K, $111.5K, $124.1K |
| skip > +500% | 7 | $138.1K (12%) | $102.2K | $133.6K | -$23.6K | 1.77%: $136.3K, $110.8K, $123.8K |
| skip > +600% | 6 | $136.9K (11%) | $102.2K | $131.9K | -$24.7K | 1.75%: $136.3K, $110.6K, $122.1K |
| half > +300% + skip > +600% | 12 | $142.6K (11%) | $105.2K | $135.0K | -$19.8K | 1.75%: $136.3K, $110.6K, $122.1K |

The trades over +500%: AVGO 04-24 -68%, META 07-17 -21%, QQQ 01-21 **+505%** (tune), ORCL 2025-12-12 -68%, GOOGL 04-24
-73% (exactly +600%), NVDA 2025-11-21 -91%, AMZN 06-05 -73%: 6 of 7 lose, but the one QQQ shock decides tune (-$9.7K).
Over +200% (21 trades): 3 won (META 04-08 +1251%, ORCL 10-08 +148%, QQQ). **No candidate**: every level is below 1.1.0
on tune; on the check and the drop every level helps. Too few trades (6-21) to tell a pattern from QQQ's one winner.

**The 3 years (look 4 of the idea; the user: "can you ran Half if > 200% for all 3 years?")**: `volume_option_rise_3y.py`
finds each twin trade's contract in the research's Databento minute books (same stock and side, the book at the buy
minute closest to the price paid: 431 of 431, 7 more than 15% off) and its ask 5 minutes before (326 trades);
`volume_option_rise_3y_acct.py` re-walks the account (scaled P&L). 2%:

| Version | Changed | End (drop) | Tune | Check | w/o 5 | Flat at the same drop: end, tune, check |
|---|---|---|---|---|---|---|
| 1.1.0 twin | 0 | $773K (21.1%) | +$73K | +$600K | +$201K | |
| half > +200% | 48 | $565K (18.5%) | -$17K | +$482K | +$153K | 1.73%: $624K, +$58K, +$466K |
| half > +300% | 31 | $603K (18.8%) | -$17K | +$520K | +$167K | 1.76%: $638K, +$60K, +$479K |
| half > +400% | 24 | $579K (20.5%) | -$23K | +$503K | +$152K | 1.93%: $734K |
| skip > +500% | 18 | $514K (21.1%) | -$56K | +$471K | +$117K | 2%: $773K |
| skip > +600% | 11 | $658K (21.1%) | +$26K | +$531K | +$135K | 2%: $773K |
| without 10-10: half > +200% | 38 | $243K (20.2%) | -$5K | +$148K | +$7K | 1.90%: $275K, +$26K, +$149K |

**Fails, clearly.** Over 3 years the trades whose option rose more than +200% in the 5 minutes before are the good ones:
48 trades, won 26 (54%), median +13%, 11 of +300% (QCOM 2025-10-27 +1104%, NVDA / QQQ / META 2025-10-10, META 2026-05-27
+496%, GOOGL 2026-08-05 +338%); by year 2024 6 of 10 won, 2025 14 of 22, 2026 6 of 16. The live code's year (6 of 21 won)
was the odd one out. Every level is below the flat line; the skip levels lose the most. Close the idea.

### Volume against SPY's volume, filter only (2026-11-02, look 1)

The user: "do we normelized the volume in both signals to the spy volume? ... if in the single minutes the spy volume is
huge we should not consider out signal, also the oposit - if the spy is cum we need to multiply" -> "start with A".
Neither alert looks at SPY's volume today (alert.ts: the stock's 3-min volume >= 4x its same-window median of 20
sessions; fast.ts: 60-s volume >= 15x). Filter only (no new alerts): the stock's and SPY's 3-minute window vs the median
of the same window over the prior 20 sessions (`volume_spy_norm.py`, SPY minute bars from Alpaca `volume_spy_bars.mjs`);
plan: drop when stock/SPY < 4 (3 / 5); any alert: drop when SPY's own ratio >= 2x (1.5 / 3), and per kind. At the
alerts SPY's ratio is median 1.55, p90 6.5: the alerts come on busy market minutes.

Live code's year (`volume_spy_norm_acct.ts`, volumeAccount, live limits), 2%:

| Version | Trades | Year (drop) | Tune | Check | w/o 5 tune / check | Trades gone |
|---|---|---|---|---|---|---|
| 1.1.0 | 145 | $142.1K (13%) | $111.9K | $125.6K | -$27.4K / -$22.3K | |
| 🎯 plan: stock/SPY >= 4 | 106 | $156.9K (9%) | $128.1K | $121.7K | -$14.8K / -$19.6K | 41, median -37%, 1 of +300% |
| plan >= 3 / >= 5 | 116 / 100 | $145.5K / $155.7K | $123.0K / $126.0K | $119.0K / $123.2K | | 30 / 48 |
| any alert, SPY >= 2x | 95 | $137.0K (8%) | $109.8K | $124.4K | | 52, median -29% |
| any, SPY >= 1.5x / 3x | 70 / 113 | $139.6K / $134.1K | $115.1K / $109.8K | $120.9K / $123.0K | | |
| shock, SPY >= 2x | 126 | $121.8K (14%) | $99.2K | $121.5K | | 22, 2 of +300% |
| plan, SPY >= 2x | 116 | $156.2K (9%) | $120.3K | $128.7K | -$20.5K / -$19.5K | 30, median -31%, none +300% |

3 years (`volume_spy_norm_3y.py`, the twin's plan trades, the window ending the minute before the buy; scaled walk), 2%:

| Version | End (drop) | Tune | Check | w/o 5 | Without 10-10: end (drop), tune, check, w/o 5 |
|---|---|---|---|---|---|
| 1.1.0 twin | $773K (21.1%) | +$73K | +$600K | +$201K | $288K (21.1%), +$27K, +$161K, +$11K |
| plan: stock/SPY >= 4 | $241K (10.7%) | +$25K | +$116K | +$23K | $231K (13.1%), +$23K, +$108K, +$18K |
| plan, SPY >= 2x | $304K (18.4%) | +$44K | +$160K | +$33K | $292K (18.4%), +$42K, +$150K, +$29K |
| plan, SPY >= 3x | $536K (16.4%) | +$75K | +$361K | +$109K | $314K (16.4%), +$43K, +$171K, +$28K |

- **No candidate.** The tune pick (plan stock/SPY >= 4) wins tune (+$16.2K) and loses check (-$3.9K) on the live
  code's year, and on 3 years it drops 207 of 266 plan trades (19 of +300%): the 3-year stock ratio at the minute before
  the buy is lower than the live alert's (the window is not the alert's), so that row is a rough read.
- "Plan, SPY >= 2x" wins both halves on the live code's year (+$8.4K / +$3.1K, drop 9% vs 13%, better without the best
  5) but was not the tune pick, and on 3 years it loses $469K: the busy-market days hold the giants (10 Oct 2025: 14 of
  +300%, all on a market-wide volume day). Without 10-10 SPY >= 3x is better on both halves ($314K vs $288K, drop 16.4%
  vs 21.1%), so the whole verdict turns on how many 10-10-like days come.
- The shock should not be filtered by SPY's volume (worse on both halves).

**Without 10 Oct 2025 (the user: "I need you to filter out 10-10-2025")**, "skip a plan alert when SPY's 3-min volume is
>= X its usual" (look 2; plan-only 1.5x / 3x added on the live code's year). 2%:

| SPY >= | Live year (drop) | Tune | Check | 3y w/o 10-10 (drop) | Tune | Check | w/o 5 |
|---|---|---|---|---|---|---|---|
| 1.1.0 | $142.1K (13%) | $111.9K | $125.6K | $288K (21.1%) | +$27K | +$161K | +$11K |
| 1.5x | $149.4K (9%) | $123.5K | $120.8K | $301K (17.0%) | +$48K | +$153K | +$33K |
| 2x | $156.2K (9%) | $120.3K | $128.7K | $292K (18.4%) | +$42K | +$150K | +$29K |
| 3x | $148.5K (9%) | $116.8K | $126.3K | $314K (16.4%) | +$43K | +$171K | +$28K |

3x is better on both halves on both data sets once 10-10 is out (live check only +$0.7K), with a smaller drop; 2x loses
the 3-year check. With 10-10 kept, 3x ends $536K vs $773K: a 10-10-like day (market-wide volume, every stock moving) is
exactly what it skips. By-year splits of the scaled walk are not valid (the P&L is in the whole run's account dollars),
so none are logged. Several variants and 2 looks: weak evidence; not a candidate until the user weighs the 10-10 risk.

### Size by the volume score against SPY (2026-11-02, look 1)

The user: "we can use it as a score ... if intl got 10X and spy 3X intel might be good bet ... double the premia".
Score = the stock's 3-min volume ratio / SPY's (each vs its same-window median of 20 sessions). Sizes set before the run:
x0.5 under 2, x1 2-6, x2 at >= 6 (capped at 5% a position); neighbours x2 at >= 4 / >= 10, and each part alone. The entry
(alert on the score) and the exit (sell when the score fades) need the alert engine and are not run. Score at the buy:
live year median 3.2 (43 / 69 / 33 trades in the tiers), 3-year twin median 2.2 (204 / 157 / 70; the window ending the
minute before the buy, not the alert's own).

| At 2% | Live year (drop) | Tune | Check | w/o 5 | 3y (drop) | Tune | Check | w/o 5 | 3y w/o 10-10 | Tune | Check | w/o 5 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.1.0 | $142.1K (13%) | $111.9K | $125.6K | -$23.6K | $773K (21.1%) | +$73K | +$600K | +$201K | $288K (21.1%) | +$27K | +$161K | +$11K |
| 🎯 x0.5 < 2, x2 >= 6 | $208.9K (13%) | $123.0K | $170.8K | -$21.8K | $734K (20.0%) | +$145K | +$489K | +$72K | $397K (20.0%) | +$77K | +$220K | -$5K |
| flat at the same drop | $142.0K (2.01%) | $111.7K | $126.0K | -$23.9K | $703K (1.88%) | +$66K | +$537K | +$195K | $272K | +$26K | +$146K | +$13K |
| x2 >= 4 | $201.7K (14%) | $123.7K | $160.7K | -$28.2K | $812K (23.0%) | +$184K | +$528K | +$87K | $440K | +$93K | +$247K | +$4K |
| x2 >= 10 | $195.9K (11%) | $114.4K | $171.7K | -$27.2K | $581K (18.2%) | +$124K | +$357K | +$74K | $315K | +$68K | +$147K | -$4K |
| x2 >= 6 only | $210.4K (15%) | $127.8K | $163.4K | -$22.5K | $1,067K (24.8%) | +$143K | +$824K | +$113K | $397K | +$49K | +$247K | -$18K |
| x0.5 < 2 only | $139.3K (10%) | $107.4K | $129.9K | -$21.1K | $532K (16.0%) | +$87K | +$345K | +$122K | $289K | +$49K | +$140K | +$22K |

Trades by score, 3 years (tune / check median, +300%): < 2 -30% / -1%, 1 / 15 (14 of them 10-10); 2-4 -34% / -28%, 4 / 4;
4-6 -27% / -4%; 6-10 -32% / +1%; >= 10 -12% / -24%.

- **Not a candidate yet.** The pick beats the flat line on both halves on the live code's year (+$11.1K tune, +$45.2K
  check at the same 13% drop) and on 3 years without 10-10 (+$51K / +$74K), but: (1) with 10-10 it loses the check
  (+$489K vs +$600K): 10-10's giants scored under 2 (the whole market was busy), so the half size cut them; (2) without
  the best 5 it is below the flat line on 3 years (+$72K vs +$195K; -$5K vs +$13K without 10-10) and on the live check
  (-$30.7K vs -$22.2K): the gain is a few big winners doubled. The medians by score do not rise with the score.
- Next if pursued: the score at the alert's own window on 3 years (the alert minute, not the buy minute), and the entry
  side (B).

**The trades by score (analysis; the user: "show destribution of the trades")**, `volume_spy_score_dist.py`. Median trade
(won %, +300% count) by stock/SPY volume score:

| Score | Live year | 3 years | 3 years w/o 10-10 |
|---|---|---|---|
| < 1 | 25: -1% (48%, 1) | 115: -2% (48%, 15) | 94: -10% (39%, 2) |
| 1-2 | 18: -46% (6%, 1) | 89: -37% (31%, 1) | 85: -37% (32%, 0) |
| 2-3 | 29: -28% (34%, 1) | 54: -31% (37%, 4) | same |
| 3-4 | 17: -36% (18%, 1) | 54: -31% (37%, 4) | same |
| 4-6 | 23: -29% (43%, 0) | 49: -7% (43%, 1) | same |
| 6-10 | 17: -21% (35%, 0) | 35: -18% (37%, 1) | same |
| >= 10 | 16: +2% (50%, 3) | 35: -14% (31%, 2) | same |

A U shape, not a line: the best group is score < 1 (the stock's volume rose less than SPY's: a market-wide move; all 25
10-10 trades but 3 sit at 0.2-1.1), the worst 1-2 on every set, and >= 10 is good on the live year only. The score's x0.5
under 2 cut the best bucket with the worst one; a rule worth testing is "x0.5 on 1-2 only".

**Skip a score of 1-3 (look 2 of the score; the user: "skip 1-3", after the distribution)**: `volume_spy_score_skip_year.ts`
(live code's year, volumeAccount) and `volume_spy_score_skip_3y.py` (3-year twin, scaled walk). Neighbours 1-2, 1-4,
0.8-3 set before the run. 2%:

| Skip | Live year (drop) | Tune | Check | w/o 5 | 3y (drop) | Tune | Check | w/o 5 | 3y w/o 10-10 (drop) | Tune | Check | w/o 5 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none (1.1.0) | $142.1K (13%) | $111.9K | $125.6K | -$23.6K | $773K (21.1%) | +$73K | +$600K | +$201K | $288K (21.1%) | +$27K | +$161K | +$11K |
| 1-3 | $153.4K (7%) | $123.2K | $125.6K | -$14.6K | $718K (16.9%) | +$89K | +$529K | +$257K | $273K (19.5%) | +$26K | +$147K | +$36K |
| 1-2 | $154.2K (9%) | $112.8K | $136.7K | -$15.1K | $1,013K (16.5%) | +$219K | +$693K | +$344K | $384K (16.5%) | +$88K | +$196K | +$70K |
| 1-4 | $159.8K (10%) | $123.4K | $129.6K | -$8.5K | $602K (14.5%) | +$85K | +$417K | +$201K | $228K (17.4%) | +$26K | +$103K | +$18K |
| 0.8-3 | $152.8K (7%) | $123.2K | $125.1K | -$15.3K | $804K (15.8%) | +$138K | +$566K | +$310K | $313K (18.4%) | +$49K | +$163K | +$60K |

- **1-3 fails**: a tie on the live check, and on 3 years it loses the check (+$529K vs +$600K; without 10-10 both halves).
- **1-2 passes every gate on both sets** (live: tune +$0.9K, check +$11.1K, drop 9% vs 13%; 3 years: +$240K, drop 16.5%
  vs 21.1%; without 10-10 +$96K, both halves; better without the best 5 everywhere): the 18 / 89 trades it skips have a
  median of -45% / -37%, 1 / 1 of +300%. But the 1-2 band was read off the distribution of these same trades (look 2,
  in-sample), the live tune gain is small, and the 3-year score is a minute off the alert. Needs an unseen period before
  it is a candidate.

**The volume score (look 3 of the score, 2026-11-03; the user: "each stock affected by the spy in different way ... call it
volume score. and go")**: `volume_score.py` (the score), `volume_score_dist.py`, `volume_score_3y.py` (3-year twin, scaled
walk), `volume_score_year.ts` (live code's year, volumeAccount and the live limits).

- **The score, rebuilt**: the stock's volume in the alert's own window (plan: the 3 minutes ending at the alert minute;
  shock: the 60 seconds ending at the alert second, 10-s bars) over the median of the same window in the prior 20
  sessions, divided by what SPY's ratio predicts for this stock: e^a * r_spy^b, with a, b fitted on the stock's prior 60
  sessions (3-minute blocks, log ratios). SPY 10-s bars built for 2024-01 to 2026-10. The median volume beta is 0.28
  (p10 0.11, p90 0.55): a stock's volume follows SPY's only weakly. Median score 5.9 (3 years), 8.0 (live year).
- **The earlier score was in the wrong window** (the minute before the buy; for shocks the minute before the alert
  second), and missed the burst: BA 2026-05-07 reads 9.7, not 0.7. The U shape and the "skip 1-2" pass above came from
  that window and **do not hold**: on the new score, skip 1-2 is $502K vs $773K on 3 years.
- **Distribution, median trade by score** (3 years tune / check without 10-10): < 2: -37% / -31% (14 / 3 trades); 2-4:
  -31% / -30%; 4-6: -3% / -10%; 6-10: -41% / -4%; 10-20: -29% / -20%; 20-40: -14% / -21%. No line and no U. The 13 check
  trades under 2 with 10-10 have a median of +458%: 10-10 was a market-wide day, where SPY's volume explains the stock's.
  On the live year 4-6 is the best band on tune (+17%), 6-10 on check (+63%).
- **Rules, all set before the run** (cuts from the 3-year tune weeks without 10-10: quintiles 3.1 / 4.8 / 8.1 / 16.5,
  tertiles 4.2 / 11.3): skip each quintile, x0.5 / x2 by tertile both ways, and the earlier rules on the new score. 2%:

| Rule | 3y (drop) | Tune | Check | Check w/o 5 | 3y w/o 10-10 (drop) | Tune | Check | Live year (drop) | Tune | Check |
|---|---|---|---|---|---|---|---|---|---|---|
| none (1.1.0) | $773K (21.1%) | +$73K | +$600K | +$226K | $288K (21.1%) | +$27K | +$161K | $142.1K (13%) | $111.9K | $125.6K |
| 🎯 skip >= 16.5 (top fifth) | $850K (18.9%) | +$164K | +$586K | +$240K | $316K (18.7%) | +$70K | +$146K | $150.3K (13%) | $117.2K | $128.0K |
| skip 3.1-4.8 | $796K (15.2%) | +$108K | +$589K | +$234K | $296K (15.1%) | +$42K | +$154K | $141.2K (10%) | $112.9K | $126.2K |
| skip < 3.1 | $276K (17.8%) | +$20K | +$156K | +$35K | $267K (17.8%) | +$19K | +$149K | | | |
| x0.5 < 4.2, x2 >= 11.3 | $597K (23.7%) | +$109K | +$388K | +$89K | $321K (23.7%) | +$47K | +$174K | | | |
| x2 < 4.2, x0.5 >= 11.3 | $1,188K (27.0%) | -$44K | +$1,131K | +$425K | $275K (27.3%) | +$10K | +$165K | | | |
| skip 1-2 | $502K (19.7%) | +$71K | +$331K | +$99K | $316K (19.7%) | +$45K | +$171K | $145.2K (11%) | $114.6K | $125.6K |
| skip 1-3 | $319K (17.8%) | +$23K | +$197K | +$46K | $257K (17.8%) | +$15K | +$142K | $134.1K (12%) | $108.3K | $124.4K |
| x0.5 < 2, x2 >= 6 | $1,097K (31.5%) | +$138K | +$860K | +$132K | $503K (31.5%) | +$54K | +$350K | | | |

- **Verdict: no candidate.** The tune pick, skip a score of 16.5 or more (mostly shocks), loses the 3-year check to 1.1.0
  (+$586K vs +$600K; without 10-10 +$146K vs +$161K). It wins on the live year (check $128.0K vs $125.6K) and against a
  flat size at the same drop (check +$586K vs +$479K), but the gate is the champion. Every rule that sends money to low
  scores lives on 10-10 alone.
- **What the data does say**: scores of 20 or more lose on both halves (median -14% / -21%, 23 / 15 trades, no +300%).
  Read off this distribution, so it is a new test, not a result.

**The volume score on a log scale (look 4 of the score, 2026-11-03; the user: "if the volume is go to double, 2x is
scoring the same as zero for the other side ... We need to think about calculation equation")**: `volume_score_log.py`
(3-year twin, distributions, the 2-D table) and `volume_score_log_year.ts` (live code's year, volumeAccount, the live
limits); `volume_score.py` now also keeps each fit's residual spread (sd). Base 1.1.0 (the champion). Bands set before
the run (after seeing only how the measures spread, not the trades):

- **A** = log2(stock ratio) - log2(SPY ratio), the stock vs SPY one for one: < 1, 1-2, 2-3, 3-4, >= 4.
- **B** = log2(look 3's score): the same order as look 3, so read only (a cut on it = a cut on the score).
- **C** = (ln stock ratio - a - b ln SPY ratio) / sd, the score in the stock's own noise: < 2, 2-3, 3-4, 4-5, >= 5.
- **D** = stock ratio (< 8x / 8-16x / >= 16x) x SPY ratio (< 1x / 1-2x / 2-4x / >= 4x), analysis.

A skip rule can only remove trades (fewer, never more); an entry on the score would need the alert engine.

| At 2% | 3y (drop) | Tune | Check | Check w/o 5 | 3y w/o 10-10 | Tune | Check | Live year (drop) | Tune | Check | Live trades |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.1.0 | $773K (21.1%) | +$73K | +$600K | +$226K | $288K | +$27K | +$161K | $142.1K (13%) | $111.9K | $125.6K | 145 |
| 🎯 A: skip 1-2 (stock 2-4x over SPY) | $867K (17.7%) | +$163K | +$603K | +$237K | $323K | +$62K | +$161K | $156.7K (10%) | $127.1K | $122.1K | 118 |
| A: skip < 1 | $203K (20.4%) | +$24K | +$79K | -$13K | $203K | +$24K | +$79K | $131.2K (12%) | $106.1K | $124.2K | 122 |
| A: skip 2-3 / 3-4 / >= 4 | $532K / $609K / $631K | | +$453K / +$441K / +$514K | | | | | $114.6K / $124.7K / $146.7K | | $128.3K / $114.9K / $124.3K | |
| 🎯 C: skip 3-4 | $438K (27.8%) | +$79K | +$259K | +$95K | $166K | +$35K | +$31K | $118.8K (13%) | $112.9K | $104.5K | 118 |
| C: skip 2-3 | $737K (13.2%) | +$72K | +$564K | +$234K | $278K | +$17K | +$161K | $151.2K (11%) | $112.4K | $132.7K | 123 |
| C: skip < 2 / 4-5 / >= 5 | $286K / $595K / $713K | | +$155K / +$461K / +$624K | | | | | $126.6K / $125.3K / $145.8K | | $117.0K / $127.8K / $132.6K | |

- **Verdict: no candidate.** A's tune pick (skip a stock that rose 2-4x more than SPY) wins tune everywhere but only
  ties the 3-year check (+$603K vs +$600K; without 10-10 +$161K both) and loses the live check ($122.1K vs $125.6K). C's
  pick fails the check outright. The 28 live trades A skips have a median of -37% (6 won, 1 of +300%), a real but small
  cut of ordinary losers, like look 2's "skip 1-2" on the old window.
- **Distributions (median trade by band)**: no band is good on both halves in any measure. A on 3 years tune / check:
  < 1 -31% / +122% (10-10; +34% without), 1-2 -34% / -31%, 2-3 -8% / -39%, 3-4 -39% / -6%, >= 4 -22% / -17%. C: the
  same picture. Fixing the scale did not reveal a line.
- **D, the 2-D table**: every cell's median loses except stock < 8x with SPY >= 4x on 3 years (+26%, 12 of +300%), and
  that cell is 10-10 alone (without it -31%). Without 10-10, "the stock is busy and SPY is not" (stock >= 16x, SPY < 1x:
  -18%) is no better than "both are busy" (-22%). On the live year the best cell is stock < 8x with SPY < 1x (+30%,
  n 10), too small to act on.
- So the equation was not what hid an edge: on any scale, the stock's volume against SPY's at the alert does not
  separate the winners. The one market-wide day (10-10) is the whole SPY effect.

**More trades: a plan alert on the stock's volume against SPY's (look 1 of the entry, 2026-11-03; the user: "if we will
add more trade we can catch more gaint that can cover these looses")**: `volume_rel_spy_run.ts` (the live code's
backtest through its alerts hook), `volume_rel_spy_acct.ts`, `volume_rel_spy_added.ts`, `volume_rel_spy_books.py`. The
site's plan alert (strangle/alert.ts) with one more way to pass the volume test: the stock's 3-minute volume ratio >= 2
and stock ratio / SPY ratio >= K (each over its 20-session median at that minute); the move, 10,000 shares and the
candle's side unchanged. Every regular alert and shock kept (the rule only adds). K 3 / 4 / 6 set before the run. Base
1.1.0, live code's year, 51 stocks, real books, the live limits; 1.1.0 reproduced to the dollar. The first pass found
56 new alerts with no book at the buy (they had passed every gate): bought from Databento ($0.005: 56 one-second
windows, 12 minute days) into the local db, rerun. 2% (3% in brackets):

| Version | Trades (+300%) | Year (drop) | Tune | Check | Tune w/o 5 | Check w/o 5 | Added: n, median, won, +300% | Year w/o April 2026 |
|---|---|---|---|---|---|---|---|---|
| 1.1.0 | 145 (7) | $142.1K, 13.1% ($162.1K, 19.5%) | $111.9K | $125.6K | -$27.4K | -$22.3K | - | $116.9K |
| K 3 | 195 (10) | $179.4K, 14.5% ($229.1K, 21.2%) | $110.8K | $160.1K | -$36.1K | -$13.6K | 52, -27%, 19, 3 | $121.8K |
| K 4 | 166 (10) | $194.2K, 14.8% ($257.9K, 21.7%) | $121.8K | $159.4K | -$27.1K | -$14.6K | 22, +8%, 11, 3 | $127.3K |
| 🎯 K 6 | 148 (8) | $160.5K, 13.1% ($195.1K, 19.5%) | $122.9K | $130.1K | -$26.1K | -$18.5K | 4, +122%, 3, 1 | $115.6K |

- The rule fires often (K 3: 5,945 new plan alerts; K 4: 3,048; K 6: 783), but the bot's own gates stop almost all:
  no side line in time 63%, pre-market news 24%, the burst 8%. K 3 trades 58 of them, K 4 24, K 6 5.
- **The tune pick K 6 passes the gates on the live year** (tune, check, both without the best 5, same drop) **but its
  gain is 3 April 2026 trades** (MSTR 04-17 +564%, IREN 04-23 +122%, NVDA 04-24 +104%): without April it is below
  1.1.0. Not an edge.
- **K 4 is the robust level**: better on tune and check, about even on tune without the best 5 (+$0.3K), better on
  check without them (+$7.7K), and still +$10.4K without April; its 22 added trades have a median of +8% (11 won, 3 of
  +300%: TSLA 08-14 +693%, MSTR, NVDA 04-24 +484%). Cost: the drop 14.8% vs 13.1% (3%: 21.7% vs 19.5%). It was not
  the tune pick (by $1.1K), so choosing it reads the check.
- **K 3 fails tune** ($110.8K vs $111.9K): the extra alerts are ordinary losers (median -27%).
- **Not a candidate yet**: one year, look 1, the gain is ~3 giants, and the 3-year twin has not run (it needs the
  relative alert in `rvol_alert.py` / `leg_seconds.py` and the new alerts' books). Next: the 3-year twin at K 4 and
  K 6, with 10-10 and April 2026 shown apart.

**The 3-year twin (look 2, 2026-11-03; the user: "START")**: `rvol_alert.py` takes the rule as a switch (`RV_REL_K`,
`RV_REL_FLOOR` 2; off by default); `volume_rel_spy_3y.py` rebuilds the six 1.1.0 plan lists (3y50, 3y50w, 3ycand,
3ycandw, 3ycand5, 3ycand5w) with it and writes only the new alerts as tags `<tag>r4` / `<tag>r6` (with the switch off
every list comes back exactly, 12,155 alerts on 3y50; `SEC_OLD_FIRST=1` as the lists were built). New alerts: 4,334 at
K 4, 1,025 at K 6; 1,013 of them can trade (a burst of >= 1.1 S30, 2.5 same-week, and the next minute reaching a side
line; `<tag>f`); 99 cross within 15 s. Bought: stock 1-second bars $0.13, option books and minute books about $0.02.
`leg_seconds.py run` as the 10-30 "Live" run with `STR_LIQ_OLD=1 STR_ORDER_MINUTE=1`, the new tags added
(`SEC_ADD_TAG`), flat account; scored by `volume_rel_spy_3y_acct.py`. 1.1.0 re-walked on today's code: 421 trades,
$790.3K (the 10-30 log: 431, $773.1K, before the 11-01 fixes); the versions are judged against today's run.

| At 2% | Trades | 3y (drop) | Tune | Check | W/o best 5 | 2024 / 2025 / 2026 | Without 10-10: end, tune, check | 3% (drop) |
|---|---|---|---|---|---|---|---|---|
| 1.1.0 (today's code) | 421 | $790.3K (21.2%) | +$86.2K | +$604.1K | +$211.5K | +$17K / +$418K / +$256K | $294.8K, +$31.1K, +$163.8K | $1,612K (30.5%) |
| + stock/SPY >= 4 | 451 | $1,058.2K (22.2%) | +$108.4K | +$849.8K | +$390.6K | +$16K / +$394K / +$549K | $395.4K, +$39.7K, +$255.7K | $2,473K (31.8%) |
| 🎯 + stock/SPY >= 6 | 430 | $852.4K (21.2%) | +$142.4K | +$610.0K | +$247.7K | +$15K / +$397K / +$341K | $318.2K, +$50.7K, +$167.5K | $1,803K (30.4%) |

Added trades (not in 1.1.0's account), returns at a flat $2K:

| | 2024 | 2025 | 2026 without April | April 2026 |
|---|---|---|---|---|
| K 4 (33 added) | 8, median -53%, 3 won, -$2.1K | 10, median -25%, 3 won, -$3.8K | 9, median -46%, 1 of +300% (TSLA 08-14), +$10.4K | 6, median +213%, 2 of +300%, +$26.8K |
| K 6 (11 added) | 2, median -53%, 0 won, -$2.5K | 4, median -37%, 0 won, -$2.9K | 1, -49%, -$1.0K | 4, median +122%, 1 of +300% (MSTR 04-17), +$14.8K |

- **Verdict: no candidate.** The tune pick (K 6) only ties the check (+$610.0K vs +$604.1K, +1%; without 10-10
  +$167.5K vs +$163.8K) on 11 added trades, median -41%, and every dollar of it is April 2026. K 4's large total is the
  same April (MSTR, NVDA 04-24, AMZN 04-09, IREN) plus TSLA 2026-08-14, all inside the live year the levels came from;
  the dollars compound, so a 2026 giant moves the end most. In 2024-25, the years the levels did not see, the added
  trades lose at both levels (K 4: 18 trades, 6 won, none +300%; K 6: 6 trades, none won).
- **Why**: the bot's own gates (the 15-s cross, the burst) keep about 1 in 40 of the new alerts, and what is left looks
  like the ordinary plan trade. April 2026 was one cluster of single-stock runs, not a pattern the rule finds again.
- Close the idea for the Volume bot.

### Volume 1.2.0 release review (2026-11-03): GO

The user: "lets go with since open, and release the candidate." 1.2.0 = 1.1.0 + no shock against the day's move since
the open at >= 2 S30 (`shockAgainstUnits`), PR #249.
- Parity: the PR's own backtest over the year (51 stocks, real books, no broker stop), alert by alert vs 1.1.0's parts:
  9,247 identical, 254 skipped against the move (all the research's rule), nothing else changed; $149.4K, 133 trades,
  tune $115.3K / check $128.5K, 2% (3%: $177.3K, drop 18.6%), as the research to the dollar. A first run with the broker
  stop at the old file's 60% moved 44 exits; not the rule.
- Neighbours on the year (2%): 1 $142.5K (skips ORCL 10-28 +390%, loses tune), 1.5 $149.6K, 2 $149.4K, 2.5 / 3 $148.2K:
  a plateau, 2 inside it.
- Risk at 3%: worst day -$12.7K, worst 5 days -$16.0K, drop 18.6% (1.1.0: 19.5%). 2.6 trades a week, 35% won, median -28%.
- Code review (fresh agent): no must-fix; its should-fix items (unknown saved version keeps the rule off, nothing saved
  = the defaults, boundary tests) in the PR. Live settings read 2026-11-03: version 1.1.0, no `shockAgainstUnits` field
  (loads as off).
