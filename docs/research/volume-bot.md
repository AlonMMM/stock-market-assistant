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
- Every later volume-bot test runs with `STR_WALK_KEEP=1 STR_CHASE_NOFILL=ask`.
