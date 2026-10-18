# Task: Study of @ultrawavetrader's 2026 option trades

Status: active
Owner: research (unattended role assumption: Integration / Review, read-only study)
Branch: research/oltrawave-x

## Outcome

Understand why the trader enters, adds, trims and exits, and whether any part is a repeatable
pattern worth an alert. Not a claim that his method is profitable going forward.

## Data (outside Git, `data/local/x/ultrawavetrader-2026`)

- His own X posts since 2026-01-01 (X API, `scripts/research/x-fetch.ts`).
- Fills transcribed by hand from the Order Manager screenshots in his daily summaries; each
  main-account contract checked against his Portfolio totals per day (all matched). 396 trades,
  1,383 steps; `actions.csv` / `timeline.md`. Options left after expiry with no sale = 0 (assumed).
- 1-min SIP bars for 59 stocks/ETFs and all 347 option contracts (`indi-bars.ts`, Alpaca).
- His stated reasons: 367 posts read and tagged by hand (`reasons.csv`).

## Method

`indi-features.py`: context at each step (move vs SPY×β, relative volume and bursts, day-range
position, VWAP, prior-day levels, opening range, option OTM/DTE), plus 20 random minutes per entry on
the same stock, day and bet direction as a control. `indi-manage.py`: option-bar path while held and
after exit. `indi-report.py`: comparisons with bootstrap 90% intervals. Scope: main account, option
trades with an entry time (313). Exploratory; no multiple-comparison correction.

## Findings (2026-10-10)

1. **Entries vs random minutes**: modestly selective, consistent with the 2024–26 xlsx study. Beating
   SPY×β over 15 min: 63% vs 48%; top 20% of the day range in his direction 52% vs 36%; 15-min volume
   above 1.5× normal 56% vs 44%; the burst is closer (median 6 vs 8 min before). He enters earlier in
   the day (median 11:33 vs 12:48). These are tendencies, not a sharp filter.
2. **Winners vs losers at entry**: barely separable. Winners beat SPY a little more often (73% vs 59%
   over 15 min) and entered after smaller gaps in their direction (median 0.13% vs 0.41%, interval
   excludes 0). Everything else overlaps.
3. **Management is the edge**: losers are cut fast — first sale median −19% after 14 min, half the
   size; worst point while held −48%. Winners: first sale at +35% after 16 min (40% of size), best point
   +235%. After his last sale the options mostly decay to ~−90% by expiry, so the cuts were right on
   average, though they often bounce first (median best +65% after exit).
4. **His stated exit reason is the stock stalling** (62 posts: stuck, too calm, didn't break out), then
   the stock turning (38), rolling the strike (35), profit (26), the market folding (15). Measured: adds
   come with the stock moving his way and above VWAP; closes after it turned (−0.14% in 5 min) near VWAP.
5. **End-of-day entries carry the year**: 36 entries in the last 15 minutes (overnight bets) won 15 times
   for +$2.33M; +$0.28M without their top 3. All other entries: +$1.39M, and −$0.56M without their top 3.
6. Results are fat-tailed: 76 of 311 entries won; average win ≈ +$126K vs loss ≈ −$25K.

## Entry and exit triggers (2026-10-10, `indi-triggers.py`, `indi-exits.py`)

Events in the 10 minutes before his entries vs random minutes (same stock, day, direction):
first break of yesterday's high/low 8% vs 2% (lift 4.3), of the 15-min opening range 6% vs 2% (3.1),
new day high/low 28% vs 13% (2.2), 5-min move vs SPY×β ≥ +0.5% 35% vs 19% (1.8). He enters a median
~1 minute after the event (chasing, not waiting for a pullback). Volume spikes alone add little
(3×: 1.2, 5×: 1.4). States: first 15 minutes 14% vs 4%, last 15 minutes 12% vs 3%.

Outcome by entry type (event within 5 min): breakout + strength vs SPY 49 entries, +$1.92M
(+$0.27M without the top 2); breakout without strength vs SPY 36 entries, 11% win, −$0.78M;
strength vs SPY only 42, +$0.96M (≈0 without top 2); no chart event 140, +$1.40M (+$0.16M).
Last-15-minute entries: 32 of 36 calls, stock +1.75% vs SPY×β on the day, near the high (0.83).

Exits: chart events barely separate his sell minutes from his holding minutes (losing VWAP 1.6×; he also
sells into new highs 1.5×, i.e. profit-taking). The option's state does: chance of a sale per minute is
6% in the first 15 minutes, up to 8–18% when the option is −25% or worse in that window, 0.3–0.7% while
it is +25% to +100% (he lets it run), and 2–10% again above +100% (scaling out). First sale: median
−4% after 15 minutes; when at a loss, median −18%, half within 15 minutes.

## Risk management (2026-10-11, his posts 2022–2026)

Data: `data/local/x/ultrawavetrader-risk*` — 737 posts matching risk keywords (with replies), 9 full
threads, his risk series (Part A/B, Sep 2023; English chart, Jan 2025). Profile Highlights not read
(no API endpoint). Page: https://claude.ai/artifact/Wg9VNmJWxBcTAqAQA3Dtyp

1. **No stop orders; the premium is the stop.** The stock's behaviour decides the exit. Before buying
   he splits the premium into immediate risk, counter-move risk and an "unlikely" part he can still
   sell. The first two are the most he will lose: 50% of the premium a month out, 70% a week out,
   75/80/85/90% with 5/4/3/2 days left, 100% at 4 hours or less (OTM, delta 10–25; not around
   earnings or macro data).
2. **Sizing:** premium = account × risk % ÷ that share. $20K × 2% = $400; a week out → $570 premium.
   So a "3% risk" trade can be 4–6% of the account in premium.
3. **Account limits cycle:** full limits at highs (5% per trade / 7% daily); a brake at a 25% drawdown
   (12.5% from 2025) or two daily stops in a row → 2% / 3%; ⅔ recovered → 3% / 5%; giving back half the
   recovery → brake again; new high → full. The daily stop counts only that day's trades; rolls paid
   from the remaining premium and rare earnings bets (about yearly, 2–3%) sit outside it.
4. **Management:** never add money to a loser (roll only with what is left); sell a third to cover;
   don't sell cheap OTM winners at 2×; expect to lose half a premium on 5–8 trades and make 4–5× on one.
   Advice to beginners: at most 2% per options trade.

## Limits

One trader, one year; P&L dominated by a few trades. Index options use SPY/QQQ as proxy. Option bars
are trades (thin contracts have gaps). Aggregate days without times (May 6, May 11, Jul 6, Jul 10,
Jul 27, Aug 19 partly, Aug 21, Aug 26) are excluded from timing results — including the year's biggest
trade (IBIT 40.5C, Aug 19–21).

## Next

- Review charts with the user: https://claude.ai/artifact/NeV7hJpG1d2CBZtYhDitak
- Dig into the end-of-day entries: what the stock and SPY did into the close, and the next open.
- Rule test (step 7): stalling exit + fast cut + late-day entry, on 2 years of bars, holdout = last 2 months.

## All years, 2023–2026 (2026-10-18)

Data (outside Git, `data/local/x/ultrawavetrader-<year>`): every daily summary transcribed by hand
from his Order Book / Portfolio screenshots and checked against the Portfolio totals per day.
2023 (from Jan 9), 2024 (Jan 31 → Dec; Jan 2–30 still to do), 2025, 2026 to Oct 9. Rows hidden behind
the taskbar or scrolled away are inferred from the Portfolio totals (`fill_gap.py`, one fill per contract
and side, with a note). Screens are in Israel time (`D <date> <post> ISR`), converted to ET.

Tools (`scripts/research/`):

- `indi-ledger.py` (run inside a year dir): one day's fills (`F`), Portfolio lines (`P`), notes (`N`),
  value (`V`); checks fills against Portfolio. `fill_gap.py`: hidden-row inference helper.
- `indi-actions.py <dir>`: fills → `actions.csv` / `timeline.md`. `indi-days.py`: summary days and images.
- `indi-tradelog/build.py <out> <daybars.sqlite> <year dirs>`: data for the Trade Log page
  (`indi-tradelog/index.html`, published at https://claude.ai/artifact/Xxu7MtakANMEkBY3F6CUKC).
- `indi-yearsum.py <years>` (cwd `data/local/x`): per-year P&L summary.
- Analysis per year as for 2026: `indi-bars.ts <dir>` then `indi-features.py`, `indi-manage.py`,
  `indi-report.py`, `indi-triggers.py`, `indi-exits.py`.

Reconciliation: fills add up to about +$12.6M gross for 2023–Oct 2026, while the account went from
$0.49M to $8.3M. His posted daily P&L equals the fills minus $0.60–0.64 per option contract
(commissions; ~3.6M contracts ≈ $2.2M). He sets money aside for taxes each January (his post of
2026-01-05; about $1.6M left between Dec 31 2025 and Jan 6 2026). About $0.9M is unexplained (account
values partly parsed from his text, a few days without a summary).

Per year (options, main account, from `indi-yearsum.py`; 2024 before Jan–Mar was added):

| Year | Trades | Win % | Net     | Top 10  | Last-15-min entries (w/o top 3) |
| ---- | ------ | ----- | ------- | ------- | ------------------------------- |
| 2023 | 398    | 33%   | +$2.41M | +$2.97M | +$0.67M (−$0.26M)               |
| 2024 | 316    | 29%   | +$1.51M | +$2.52M | +$0.24M (−$0.31M)               |
| 2025 | 470    | 25%   | +$3.30M | +$4.36M | +$1.11M (−$0.32M)               |
| 2026 | 346    | 24%   | +$4.41M | +$6.62M | +$2.33M (+$0.28M)               |

2025 entries vs random minutes (same tests as 2026) repeat the 2026 picture: beats SPY×β over 15 min 70%
vs 48%, top 20% of the day range 61% vs 39%, on the bet side of VWAP 85% vs 67%.
