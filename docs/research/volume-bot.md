# The Volume bot (volume burst) research

The research log for the Volume bot (code name "strangle", apps/trader/src/strangle.ts): the volume burst alert, the
side, the one leg, the exits. Newest first. The Main bot (Indi) has its own log in `best-algorithms.md`.

Scripts in `scripts/research/indi_bt/` (run from the app repo root with `node --env-file=.env <dir>/run.mjs <script>`):
`leg_*.py`, `strangle_*.py`, `strength_at.py`. Real quotes from Databento: `dbx_fetch.py` (cbbo-1m, `dbx_cache/`),
`leg_seconds.py` (stock ohlcv-1s and option cbbo-1s / cmbp-1, `sec_cache/`), `strangle_real.py` (`strangle_cache/`).

## Log

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
- **Live:** the bot already checked the side on the stock's last trade every 10 s (not the minute close); PR #180
  (merged and deployed 2026-10-27) adds a 1-second side watch. Not changed yet (the user to decide): the strength
  filter (setting `strengthFilter`, the t >= 0 rule) and limiting the bot to the top 15.
- Running: favorites (59 + QQQ, GOOG, NFLX) 3 years, cross, with a skip when the stock already moved 2/3/4/6 S30
  the side's way since the open or yesterday's close.
