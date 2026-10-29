# The Volume bot (volume burst) research

The research log for the Volume bot (code name "strangle", apps/trader/src/strangle.ts): the volume burst alert, the
side, the one leg, the exits. Newest first. The Main bot (Indi) has its own log in `best-algorithms.md`.

Scripts in `scripts/research/indi_bt/` (run from the app repo root with `node --env-file=.env <dir>/run.mjs <script>`):
`leg_*.py`, `strangle_*.py`, `strength_at.py`. Real quotes from Databento: `dbx_fetch.py` (cbbo-1m, `dbx_cache/`),
`leg_seconds.py` (stock ohlcv-1s and option cbbo-1s / cmbp-1, `sec_cache/`), `strangle_real.py` (`strangle_cache/`).

## Log

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
