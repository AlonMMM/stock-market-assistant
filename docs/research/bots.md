# The bots: production, candidate, features

The registry every new test starts from (the `new-test` skill). Update it the moment a role changes, in the same
commit as the log entry in `best-algorithms.md`. Numbers: the fair list, Feb 2024 - Oct 2026, from $100,000, the 10%
overnight cap at each size; Favorites = the app's Favorites watchlist (86 symbols), 2025-10-23 to 2026-10-23.

**Favorites since 2026-10-29: `scripts/research/indi_bt/favorites.txt`, 60 stocks** (the app's 69 minus AMBA, SIRI, SOFI,
XYZ, ONDS, LLY, CVX, MRVL, ARM, GLD; plus USO; the app's own watchlist stays 69). fav_real.signals() cuts every list to
them (FAV_ALL=1 for the old 69). The champion (retry_roll.py base) on the 60, Favorites 24 months, 2%: tune $596,437 / 20%,
check $206,879 / 25% (fav_baseline.py); the fair list is unchanged ($418,875 / $928,510).

## Production

**Since 2026-10-31: 2.8.0** (PR #223, deployed): 2.7 + the staged stock exit (no 10 / 20-minute checks; half out at 0.5
S30 against the signal price, the rest at 1.0), the option stop at -60%, late winners (entry 15:00+, up) held to 15:50.
Research twin: the f28 overlay `{"user_stop": {"checks": [], "out": -0.6}, "stock_stages": {"half": 0.5, "full": 1.0},
"late_hold": {"from": 330}}` on the champion's exits; fresh run with the real-fill basis (2026-11-01, `r28` / `fl28r`,
champ-1s = no early entry): fair list $3,138,672 / 34.4% at 2%, tune / check $496,822 / $665,808. Live it also runs
early entry (on since 2.7), which tested fairly loses (2026-10-31); the research yardstick buys at the minute's close.

**Since 2026-10-27 (live from 15:05 Israel, before the open): 2.7**, the champion (PR #183, merged as ed42c3f and
deployed): 2.5 without the cheap fallback, IBIT down to $0.10, the pyramid, early entry (checked every 5 seconds). The
owner's limits kept: size 3%, 8 buys a day, 5 open, 5% day loss, both brokers; minimum price $0.20 (was $0.15 on 2.6*).
Research slug `champ-early`.


What the live bot runs when its settings are reset to defaults: the default version in
`packages/trading/src/bot/versions.ts` on `origin/main`. It changes only when a version is merged and deployed.

- **2.6** (merged as #158 and deployed 2026-10-26; the live bot shows "2.6*": the owner keeps the minimum price at
  $0.15 and the pre-market volume skip off, so the cheap fallback steps in under $0.15, not $0.20): 2.5 + the cheap
  fallback. 2.5 = 2.4 + the D2 bonus entry (t >= 1.2 and D2 >= 1.5), without the failed-break sale.
- Research twin: trade files `sg_c12_15_*`, exits `d2_failed_break.CHAMP`, fallback `cheap`; benchmark slug `d25-cheap`.
- Fair list $1,297,233 / 11% at 1% ($6,599,909 / 21% at 2%), $422,022 without the best 5. Favorites (68, 2025-10-23
  to 2026-10-23) $246,637 / 14% at 1% ($396,848 / 26% at 2%); the cheap trades' money is mostly IBIT.
- Before it, 2.5 (live 2026-10-26 morning): fair list $1,108,678 / 11%; Favorites $192,845 / 12%; benchmark `d2-bonus`.
- The previous production, 2.4 (t >= 1.8 only, with the failed-break sale): fair list $719,945 / 9%; benchmark `bot24`.

## Candidate

**2.10, released 2026-11-01 (PR #233):** 2.9 with the size set by the signal's volume since the open (x its usual at
that minute): under 1.75x 50%, from 1.75x 100%, from 2.5x 150%; the pyramid add rides on the share, capped so the
position stays within 5% of the account; the service's cap per buy is 5% (was 3%). Research size_volume.py t3A-c5;
dashboard slug x-v210 (built on the page from x-v29's rows and their `rvol`).

**2.9, merged and deployed 2026-11-01 11:00 Israel (PR #231 with #227 = 2.8.1, and #225: splits + broker stop -60% default; website + Railway sma-trader from main 2a8dfc3; live once the owner picks 2.9 on the settings page):** 2.8.1 (the size steps: 3%,
2.5% from $300K, 1.5% from $1M, 1% from $4M; a step never raises the owner's size) + the break-even lock (`be_lock
{arm: 0.5, update: true}`: on the entry day, once the option is +50%, the stock price where Black-Scholes at its implied
volatility values it at its cost is a stop on the stock, worked out again each minute it is still +50%, the tighter
kept). Fresh runs, real-fill basis, 2%: fair $3,455,683 / 32.2% (tune / check $522,556 / $694,763); with the ladder
$4,399,581 / 37.2% vs 2.8.1 $4,148,061 / 39.6%; Favorites 12 / 6 / 24 / 36 months ahead with the drop 0.4-4 points less.
Benchmark slugs `x-v29` / `x-v29-m` (2.8: `x-stop60` / `x-stop60-m`). The owner shipped it knowing the strict changed-trades
check fails (without the best 10 changed trades the sum is negative on 4 of 5 lists): "it is more important to reduce
the drop and increase the win rate". Release audit in best-algorithms.md (2026-11-01).

Earlier candidates:

**Since 2026-10-27 (afternoon) the champion and candidate is the champion below + early entry**: buy at the first second
inside the signal minute the rule already holds (sec_timing.py "early"; benchmark slug `champ-early`, yardstick
`champ-1s`; real 1-second fills only). Fair list tune / check $330,459 / $484,041 vs $306,551 / $428,884; Favorites 12m
$238,078 vs $212,222. To build live: the IBIT floor and no cheap fallback, the pyramid add, the intra-minute signal.

**The champion, the next bot to go live (the user, 2026-10-27: "lets make this our champion"):** 2.5 + IBIT bought
down to $0.10 + the pyramid, no cheap fallback (`floor_exception.py`; benchmark slug `champ`, `export_champ.py`). Real
quotes, 1%: fair list 2024-25 $415,971 / 14%, 2026 $228,296 / 14%; Favorites 24 months $403,255 / 17%, 12 months
$189,705 / 17%. Production 2.6 stays live until it is built (two parts: the IBIT floor without the fallback, a setting;
the pyramid add, new code) and is the line it has to beat. New tests build on the champion.
Tune / check baselines (even / odd entry weeks, `split.py`, real quotes, 1%): fair $257,982 / 16% and $368,105 / 12%;
Favorites 24 months $289,355 / 11% and $139,363 / 15%. Production 2.6: $229,933 / 15%, $272,798 / 18%, $244,689 / 13%,
$122,485 / 17%.

## Features under test

Close to the best; a new test can be run with each of them on or off. Each is a `fallback` mode or an exit key in
`export_bench.py` `VERSIONS`.

| Feature | What it does | Switch | On the candidate, fair list | Favorites |
|---|---|---|---|---|
| Cheap fallback | 0.15-delta option under $0.20: the nearest-the-money strike at $0.20+ | fallback `cheap` | $1,297,233 / 11% | $239,826 / 14% |
| Next strike for D2 | a D2 entry's illiquid strike: the next listed strike on each side with 200+ contracts | fallback `adjd2` | $1,128,279 / 13% | $238,366 / 13% |
| Cheap + next strike for D2 | both | fallback `cheap+adjd2` | $1,277,250 / 13% | $285,889 / 15% |
| D2 under 200 (fill unproven) | a D2 entry buys under the 200-contract floor | fallback `nofloor` | $2,725,610 / 12% | $270,492 / 19% |
| Cheap + D2 under 200 (fill unproven) | both | fallback `cheap+nofloor` | $2,899,179 / 13% | $318,407 / 18% |
| Failed-break sale | production's sale added to the candidate | exit `failed_break: True` (`@fb`) | $734,522 / 14% (worse) | $186,064 / 11% |
| Next strike, every entry | on production: any illiquid strike, the next one on each side | fallback `adj` (on 2.4) | $1,177,597 / 12% | $165,870 / 18% |

## Next to test (saved)

- **Pyramid on confirmed D2 moves + trim the weak picks** (RUN 2026-10-25: $1,667,924 / 12%, see best-algorithms.md; the user: "save it for now; we build on top of
  it"): on 2.5 + cheap + the next strike for D2, D2 entries at full size, the add (a fresh 0.15-delta, half size) when the
  same stock reaches the real signal (t >= 1.8, same side) with the first leg still held and up (`d2_scale.py` add-up),
  and the fallback-added trades at half size (`dd_reduce.py`; the liquid-fallback ones only, or both fallbacks).
- **Re-entry with D2** (proposed 2026-10-25, waiting for the user's three answers): after an entry-day stop that was
  mostly SPY's doing, re-enter when D2 since the exit >= 1.5 with t >= 1.2 and volume >= 1.5x; R0 control without D2.
