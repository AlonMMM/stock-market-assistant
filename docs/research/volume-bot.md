# The Volume bot (volume burst) research

The research log for the Volume bot (code name "strangle", apps/trader/src/strangle.ts): the volume burst alert, the
side, the one leg, the exits. Newest first. The Main bot (Indi) has its own log in `best-algorithms.md`.

Scripts in `scripts/research/indi_bt/` (run from the app repo root with `node --env-file=.env <dir>/run.mjs <script>`):
`leg_*.py`, `strangle_*.py`, `strength_at.py`. Real quotes from Databento: `dbx_fetch.py` (cbbo-1m, `dbx_cache/`),
`leg_seconds.py` (stock ohlcv-1s and option cbbo-1s / cmbp-1, `sec_cache/`), `strangle_real.py` (`strangle_cache/`).

## Log

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
