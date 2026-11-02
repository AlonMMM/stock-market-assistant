---
name: new-test
description: Stage 1 of every bot change (bot-lifecycle) - turn the user's thesis about the Main bot (Indi bot) or the Volume bot into a backtest on the bot's champion - the variants, the script, the run, the log and the bot's benchmark page - and end by asking whether to upgrade when there is a candidate. Use when the user proposes a new rule, filter, exit, contract pick or sizing idea to test ("let's test...", "what if the bot...", "try X"), or asks to run the candidate stage. Starts by reading the research log (was it tested, when, could today's bot differ); every run prints BOTH halves, tune (even entry weeks) and check (odd weeks), all years; ends by adding the result to the tested bot's benchmark artifact.
---

# A new test

The user writes the thesis; you turn it into a test, run it, log it and show it on the benchmark. This is stage 1 of
`bot-lifecycle` (test -> upgrade question -> version review -> deploy -> live check). The goal of the Main bot is to get
**close to Indi**, not to beat him. Mechanics (paths, data, the simulator, ground rules: no orders, never read
`.env`, never short, Israel time) are in the `bot-backtest` skill; the report format in `backtest-report`. This skill is
the process.

**Every test builds on the bot's champion** (the version live in production, `bots.md`), unless the user names another
version. The Volume bot uses the same process: its log is `docs/research/volume-bot.md`, its simulator
`leg_seconds.py`, its lists the live 54 stocks (top 50 + SLV TQQQ SOXL SMH) and its benchmark the Volume Bot page.

## The two groups (against overfitting)

User rule, 2026-10-27 (replaces the 2024-25 / 2026 split of 2026-10-26): "lets split the test into 2 from now on. one
for tuning and one for vaulting" ... "i want 2026 to be in both list". **The split is by entry week**
(`scripts/research/indi_bt/split.py`, `half(date)`): a trade entered in an even ISO week is in the **tune** set, an odd
week in the **check** set. Both sets cover Feb 2024 - today, so 2024, 2025 and 2026 are in each.

| Set       | Stocks                                                                                            | Weeks          | Used for                                  |
| --------- | ------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------- |
| **Tune**  | the fair list (Indi's stocks traded the year before) + today's Favorites (24 months, real quotes) | even ISO weeks | every variant, sweep and level choice     |
| **Check** | the same lists                                                                                    | odd ISO weeks  | the verdict on the version picked on tune |

- **ALWAYS TUNE AND CHECK, IN THE SAME RUN.** User rule, 2026-10-27, said three times ("why didn't you ran it with the
  tune and check lists?", "why you not following the tune-check rule", "always do tune and check"). Every test run
  prints the tune table for the champion and every version, the pick of each idea (marked 🎯), and the check table for
  the champion and **only the picks**, at 2% and 3%. User rule 2026-10-29: "run only on the tune. only candidate from
  each combination go with the check": the other versions' check numbers are not computed or shown.
  Never run tune only, never hold the check back to ask first, never add a `NOCHECK`-style flag, and never say "the
  idea has used its looks" as a reason to skip the check. This holds for follow-ups and re-runs too.
- **Pick on tune, judge on check**: the pick is chosen from the tune table only (by min(fair, Favorites) vs the
  champion), one per idea (combination); only the picks are run on the check weeks, in the same run, and the verdict
  reads their check numbers.
- **All settings of an idea in one run**: levels, neighbours and follow-up variants (a different delta, a different
  funding) go into one run as versions, not one run after another.
- **Count the looks** in the log and in the chat (look 1, 2, 3, ...): a run that prints the check is a look. Past
  three, still run and show the check, but say the check is weaker evidence because it has been seen several times.
- **Passing**: better than the champion on tune AND on check, on the fair list and on the Favorites, and still better
  without the best 5 trades. On the Favorites judge the difference to the champion, not dollars (the user built the
  list knowing what moved).
- **Real quotes are the yardstick** (opt_spread.price "bid"; real_bench.quote is fixed); +-2% may be shown next to it.
- 2023 is not used: the Indi trade list for Jan-Mar 2024 is missing and the 2023 list needs his 2022 trades.

## Champion, candidate, features

Read `docs/research/bots.md` on `research/indi-v2` (worktree usually `~/Desktop/Personal/sma-indi-backtest`) first: it
has a section per bot.

1. **Champion**: the version live in production, as its saved settings run it. **Every test is built on the
   champion** unless the user names another version (rule 2026-11-02, replaces "built on the candidate").
2. **Candidate**: a version that passed a test and waits for the upgrade (stages 2-5 of `bot-lifecycle`).
3. **Features under test**: variations close to the best (the cheap fallback, the next strike for D2 entries, D2 under
   200 contracts, the failed-break sale, ...). A thesis can be tested with a feature on and off when that answers it.

## 0. First: read the log. Was it tested, and could it differ now?

User rule, 2026-10-29: "first thing you do is reading the log to see if and when we made the test and if you think the
changes we did can now make different". Before any plan or code:

- Search `docs/research/best-algorithms.md` (the Log, "Tested, not better", the Candidates) and `docs/research/bots.md`
  for the idea under its own words and its neighbours (e.g. "profit taking" = takes, locks, floors, trails, guards).
- Tell the user, first: **tested or not**; if tested, **when** (date), **on which bot** (version / champion of that day),
  **how it was judged** (fair list + unseen, a 2024-25 / 2026 split, or tune + check), the **result** with its key
  numbers, and the script.
- Then your view: **can the changes since then make it different?** Name what changed that touches this idea (the bot's
  rules: the D2 entry, the strength exit, the overnight hold, the pyramid, early entry; real quotes instead of the
  minute model; the tune / check split; new data). If nothing relevant changed, say a re-run would likely repeat the
  result and propose something else; if something did, say what and why it could change the answer, and let the user
  choose.
- Never present a tested idea as new. (2026-10-28: a profit floor and the illiquid-signal fallbacks were suggested as
  new and the user had to ask "didn't we test profit taking?" / "dont we already test the lequide permotation?".)

## 1. Plan: say exactly what will run

Before writing code, state in a few lines:

- **The thesis** in one sentence, as you understood it.
- **The bot** it builds on (the champion unless told otherwise, by version id) and which features are on.
- **The variants**: the rule's levels, all **set before running** (no picking the level from the result). Keep it
  small: the base, the thesis at its stated level, and one or two neighbours to show it is not a knife edge. Combine
  with a feature only if the thesis touches it or the user asked.
- **The list and period**: the tune set, the fair list and the Favorites on even entry weeks, Feb 2024 - today (see "The two groups").
- **The comparison**: the champion (and the open candidate, if any) re-walked by the same script.

Ask the user to confirm only when the thesis can be read two ways that would give different tests (what counts as the
event, the trigger level, which entries it applies to). Otherwise state the plan and go.

## 2. Build

- Check the config first: the champion row in `bots.md`, `params.json` (`min_vol30` 200, `night_cap` 0.1).
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
- **Reproduce the baselines first**: the champion (and the open candidate), on the full period, must match `bots.md` (to the
  dollar or close); if not, stop and find why before reading the variants. Then record their tune-week figures in
  `bots.md` if they are missing; those are the baselines the variants are compared to. The script prints tune, the
  pick, then check (`split.half`), in the same run.

## 3. Results: the fixed table

For the champion, the open candidate and every variant, at 1% (and 2%) of the account from $100,000, with the overnight cap at
each size:

| Version | Trades | Winners | Per trade at $10K | At 1% / worst drop | At 2% / worst drop | 2024 / 2025 | Without the best 5 | Best 5 |

On the tune set (even entry weeks), then the same table on the check set (odd weeks), from the same run.

Then, in words: what the thesis added (the trades it added or removed, their sum and their sum without their best 5),
where the money came from (the best trades by name), and the verdict.

**The giants decide splits** (2026-10-28/29, pre_agree.py / pre_size.py): the champion's typical trade loses about
$2.5K at $10K in every bucket; all the money is ~20 trades of +300% or more per half, and a bucket or filter "wins"
when more of them happen to land in it. For any rule that splits, filters or re-sizes trades, also show per group: the
**median trade**, the **sum of the non-giant trades**, the **giant count**, and the result **by year**; say how many
buckets or measures were scanned. Call it an edge only if the median or the non-giant sum moves, on both halves.
"Without the best 5" is not enough when a group holds 10 giants.

**Better than the champion** = more money at the same or smaller worst drop (or the same money with a smaller drop),
every year positive, and still better without the best 5. A gain that is one or two trades is not better. A result
that depends on fills the backtest cannot see (thin contracts, no quotes) is marked "fill unproven".

## 4. Log

- `docs/research/best-algorithms.md` (Volume bot: `volume-bot.md`): one entry, the thesis in the user's words, the
  version it built on, the variants, the numbers against the champion, the verdict. A loser goes under "Tested, not better".
- Commit the script and the log on `research/indi-v2` and push as AlonMMM
  (`GH_TOKEN=$(gh auth token --user AlonMMM)` with the per-command credential helper).

## 5. The artifact, always: the last step of every test

User rule, 2026-10-29: "always end with adding to the benchmark artifact for the relevant bot". A test is not finished
until its result is on the benchmark artifact of the bot it tested, and the chat's last message gives the link. The
relevant bot decides which artifact: the Main bot (Indi bot) -> the Bot vs Indi dashboard below; the Volume bot / the
Alert leg -> its own benchmark page (find it in the artifact list; `docs/research/bots.md` or `volume-bot.md` name it).
Losers too, and analysis-only runs (a diagnostic) as a note on the same page.

Every test, winner or loser, goes on the benchmark of the **Bot vs Indi dashboard** (tune and check weeks)
(https://claude.ai/artifact/34CHCtYWPgexzP51zze9vV): add the variants to `export_bench.py` (`fav_bench.py` for the
Favorites), re-export, upload `all_trades.csv` and the paths files as assets, update the datasets, add the versions to
the page's version picker and chart lines (`LOW`), and say what they are in the "versions" card. Keep the picker short:
production, the candidate, the features and the latest test; move older test variants off the picker when they lose.
Then read `data/users/me` doc `check`.

## 6. The check: the odd weeks (same run as tune)

The check is not a separate stage: the run in step 2 already printed it. Report the pick's check numbers on the odd
entry weeks, fair list and Favorites, with a "vs the champion" column, the without-the-best-5 test and the gap to Indi
on the fair list; count the look (see "The two groups"). Append to the same log entry and make the same artifact update. Read the Favorites from the app's D1
watchlist (`bot-backtest` skill) so the list is the one the live bot gets.

## 7. The upgrade question (stage 2)

If the pick passes the check (tune and check, both lists, without the best 5): give it the next version id, put it in
`bots.md` as the bot's **candidate**, mark it Candidate on the benchmark page, and ask once (the wording is in
`bot-lifecycle`, stage 2): "Upgrade it?". A yes runs `bot-release` (the version review), then the deploy and
`bot-live-check`. No candidate: say so; nothing is asked. The champion changes only when `bot-live-check` passes after
the deploy.
