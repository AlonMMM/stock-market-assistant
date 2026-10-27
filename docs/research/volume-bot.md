# The Volume bot (volume burst) research

The research log for the Volume bot (code name "strangle", apps/trader/src/strangle.ts): the volume burst alert, the
side, the one leg, the exits. Newest first. The Main bot (Indi) has its own log in `best-algorithms.md`.

Scripts in `scripts/research/indi_bt/` (run from the app repo root with `node --env-file=.env <dir>/run.mjs <script>`):
`leg_*.py`, `strangle_*.py`, `strength_at.py`. Real quotes from Databento: `dbx_fetch.py` (cbbo-1m, `dbx_cache/`),
`leg_seconds.py` (stock ohlcv-1s and option cbbo-1s / cmbp-1, `sec_cache/`), `strangle_real.py` (`strangle_cache/`).

## Log

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
