---
name: new-test
description: Turn the user's thesis about the Indi options bot into a backtest - which bot it builds on, the variants to run, the script, the run, the log and the benchmark on the Bot vs Indi dashboard. Use when the user proposes a new rule, filter, exit, contract pick or sizing idea to test ("let's test...", "what if the bot...", "try X"), or asks to run the candidate stage (the 2026 check on their Favorites). Ideas are tuned on 2024-2025 only; 2026 is the held-out check.
---

# A new test

The user writes the thesis; you turn it into a test, run it, log it and show it on the benchmark. The goal of the bot
is to get **close to Indi**, not to beat him. Mechanics (paths, data, the simulator, ground rules: no orders, never read
`.env`, never short, Israel time) are in the `bot-backtest` skill; the report format in `backtest-report`. This skill is
the process.

## The two groups (against overfitting)

User rule, 2026-10-26: ideas are tuned on one group and checked once on another that they never saw.

| Group | Stocks | Period | Used for |
|---|---|---|---|
| **Tuning** | the fair list (Indi's stocks traded the year before) | Feb 2024 - Dec 2025 | every variant, sweep and level choice |
| **Check** | the user's Favorites + the fair list for 2026 | Jan 2026 - today | the candidate stage only (step 6) |

- **No 2026 numbers for a variant before step 6**: do not run, print, chart or upload a variant's 2026 trades
  before then. Production and the candidate may run on the full period to reproduce their baselines (2026 is
  already known for them), but compare the variants to them only on 2024-2025.
- **At most 3 looks at 2026 per idea**, failures included. Each look is logged in `best-algorithms.md` with its
  number (look 1/3, ...). If a variant is changed after a look, the next look is a new one. After the third, the idea
  is closed unless the user reopens it.
- **Judge 2026 against the candidate, never in dollars alone**: the user built Favorites in 2026 knowing what moved, so
  every version looks good there. On Favorites, use only the difference (variant minus candidate). Use the gap to
  Indi only on the fair list, because Indi did not trade Favorites.
- **Passing the check**: the gain over the candidate goes in the same direction in 2026 and is at least about
  half its 2024-2025 size, on Favorites and on the 2026 fair list, and it still holds without the best 5 trades.
- 2023 is not used: the Indi trade list for Jan-Mar 2024 is missing and the 2023 list needs his 2022 trades.

## The three bots

Read `docs/research/bots.md` on `research/indi-v2` (worktree usually `~/Desktop/Personal/sma-indi-backtest`) first.

1. **Production**: what the live bot runs when its settings are reset to defaults (the default version on `origin/main`).
2. **Candidate**: the next bot. **Every test is built on the candidate** unless the user names another bot.
3. **Features under test**: variations close to the best (the cheap fallback, the next strike for D2 entries, D2 under
   200 contracts, the failed-break sale, ...). A thesis can be tested with a feature on and off when that answers it.

## 1. Plan: say exactly what will run

Before writing code, state in a few lines:

- **The thesis** in one sentence, as you understood it.
- **The bot** it builds on (the candidate unless told otherwise) and which features are on.
- **The variants**: the rule's levels, all **set before running** (no picking the level from the result). Keep it
  small: the base, the thesis at its stated level, and one or two neighbours to show it is not a knife edge. Combine
  with a feature only if the thesis touches it or the user asked.
- **The list and period**: the tuning group, the fair list from Feb 2024 to Dec 2025 (see "The two groups").
- **The comparison**: production and the candidate re-walked by the same script.

Ask the user to confirm only when the thesis can be read two ways that would give different tests (what counts as the
event, the trigger level, which entries it applies to). Otherwise state the plan and go.

## 2. Build

- Check the config first: the candidate row in `bots.md`, `params.json` (`min_vol30` 200, `night_cap` 0.1).
- New script in `scripts/research/indi_bt/`, named for the thesis, with a docstring that quotes the user's thesis and
  the date, the variants and the run command.
- Reuse, do not rewrite:
  - **A contract pick or fallback** (which strike, liquidity, price floor): a new `fallback` mode in
    `export_bench.py` `contract()` (templates: `cheap`, `adjd2`, `nofloor`) and one `VERSIONS` row per variant.
  - **An exit** (stop, take, hold, sale): an option in `sim.py` `X` and a `VERSIONS` row with `{**CHAMP, ...}`.
  - **An entry or signal**: per-minute signal rows like `defence_signals.py` (`s_sig_<rule>_<year>.csv`), then trade
    files through `score_round.py` (`BT_TAG`, the candidate's exits), then the same as above.
  - **Sizing**: `risk_overlay.py` / `sizing_sweep.py` on the trades of the candidate.
  - Lists, the news filter and the account math: `low_delta.HIS40` / `PRIOR`, `news_filter.features`, `score_sum.account`.
- Run from the main checkout's root, from a frozen copy (`rsync` the folder into the scratchpad), in the background:
  `node --env-file=.env <frozen>/run.mjs <script.py>` (the script name, not a path).
- **Reproduce the baselines first**: production and the candidate, on the full period, must match `bots.md` (to the
  dollar or close); if not, stop and find why before reading the variants. Then record their 2024-2025 figures in
  `bots.md` if they are missing; those are the baselines the variants are compared to. Run the variants on 2024-2025
  only.

## 3. Results: the fixed table

For production, the candidate and every variant, at 1% (and 2%) of the account from $100,000, with the overnight cap at
each size:

| Version | Trades | Winners | Per trade at $10K | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 | Without the best 5 | Best 5 |

All on the tuning group (2024-2025).

Then, in words: what the thesis added (the trades it added or removed, their sum and their sum without their best 5),
where the money came from (the best trades by name), and the verdict.

**Better than the candidate** = more money at the same or smaller worst drop (or the same money with a smaller drop),
every year positive, and still better without the best 5. A gain that is one or two trades is not better. A result
that depends on fills the backtest cannot see (thin contracts, no quotes) is marked "fill unproven".

## 4. Log

- `docs/research/best-algorithms.md`: one entry, the thesis in the user's words, the variants, the numbers against the
  candidate, the verdict. A loser goes under "Tested, not better".
- Commit the script and the log on `research/indi-v2` and push as AlonMMM
  (`GH_TOKEN=$(gh auth token --user AlonMMM)` with the per-command credential helper).

## 5. The artifact, always

Every test, winner or loser, goes on the benchmark of the **Bot vs Indi dashboard** (a variant's 2024-2025 run only;
its 2026 trades go up after the check in step 6)
(https://claude.ai/artifact/34CHCtYWPgexzP51zze9vV): add the variants to `export_bench.py` (`fav_bench.py` for the
Favorites), re-export, upload `all_trades.csv` and the paths files as assets, update the datasets, add the versions to
the page's version picker and chart lines (`LOW`), and say what they are in the "versions" card. Keep the picker short:
production, the candidate, the features and the latest test; move older test variants off the picker when they lose.
Then read `data/users/me` doc `check`.

## 6. The candidate stage: the 2026 check

When the user agrees a variant is a candidate, it gets one look at the check group (count it, see "The two groups"):
the same test from Jan 2026 to today on the user's Favorites (`fav_bench.py`: lists.py runs of the Favorites for the
entries involved, then the versions) and on the 2026 fair list. Use the same table with a "vs the candidate" column, and
add the gap to Indi on the fair list. Append to the same log entry and make the same artifact update. Read the
Favorites from the app's D1 watchlist (`bot-backtest` skill) so the list is the one the live bot gets.

If it passes the check and the user says so, update `bots.md`: the variant becomes the candidate, the old candidate moves
to the features. Production changes only when a version is merged to `main` and deployed.
