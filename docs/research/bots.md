# The bots: production, candidate, features

The registry every new test starts from (the `new-test` skill). Update it the moment a role changes, in the same
commit as the log entry in `best-algorithms.md`. Numbers: the fair list, Feb 2024 - Oct 2026, from $100,000, the 10%
overnight cap at each size; Favorites = the app's Favorites watchlist (86 symbols), 2025-10-23 to 2026-10-23.

## Production

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

Not chosen yet (2026-10-26). Proposed: the pyramid with both fallbacks at half size (2.5 + cheap + the next strike for D2,
fallback trades at half, the half-size add on the real signal; fair list $1,667,924 / 12%). Until the user picks one,
tests build on production 2.5.

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
