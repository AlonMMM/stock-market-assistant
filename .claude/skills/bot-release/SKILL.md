---
name: bot-release
description: The version review and the deploy (stages 3-4 of bot-lifecycle) every new version of the Main bot (Indi bot) or the Volume bot passes after the user says yes to the upgrade - the backtest is audited, the result is checked for overfitting, the live code is built, reviewed and replayed against the backtest, the deploy is done from main, then bot-live-check. Use when the user says yes to an upgrade, when a version changes ("new version", "release 2.9", "ship the candidate", "make X production", "review the version"), when a bot PR is opened, when the user asks whether a version is ready to go live, or to audit a version already live.
user-invocable: true
argument-hint: "<version id> [PR number] [research slug] [audit]"
---

# Releasing a bot version

Stages 3 (the version review, §0-6) and 4 (the deploy, §5 and §7) of `bot-lifecycle`. It starts only after the user's
yes to the upgrade question (stage 2), and it builds on the bot's **champion** in `bots.md`. Order: §0-4 and the
research half of §6 on the research version (GO / NO-GO before any live code is written); then the live code (the PR),
§5 and the rest of §6 on it; then §7; then `bot-live-check` (stage 5) straight after the deploy. The version becomes
champion only when the live check passes; until then it is the candidate, live or not.

A version goes live only through this gate. The output is a **release report** with every check marked
PASS / FAIL / NOT RUN (with why) / N-A and its evidence (a command, a number, a file:line). A check that could not be run
is NOT RUN, never PASS. Any FAIL in a **hard gate** (🛑) blocks the release.
Mechanics live elsewhere: paths and tools in `bot-backtest`, the test process in `new-test`, the report format in
`backtest-report`, live vs backtest in `bot-review`. This skill is the checklist.

Ground rules carry over: never read `.env`, no orders, never short, Israel time, push as AlonMMM, no Jira for this repo.

**Audit mode** (a version already live, e.g. `/bot-release 2.8.0 223 x-stop60 audit`): read-only on everything shared
(no dashboard, docs, settings or deploy changes, no commits). Mark each finding "at release" (what was known then) or
"today" (on today's code and data), and add the live days since the release to §6 and §8.

**How to run it**: one auditor per version (§0-4, §6-9) and one fresh code reviewer per PR (§5), in parallel. The
reviewer gets the diff and the §5 list, not the auditor's conclusion. Reports come back as text; save them under the
scratchpad. Budget: §2 neighbours and §6 replays are the slow parts; run them one at a time on the shared bar cache, and
stop at ~2 hours with what is done marked NOT RUN.

## 0. Pin down what is being released

Write these lines first; stop and ask if one is unknown:

1. **Version id** and its parent (e.g. 2.9 from 2.8.0).
2. **What changed**, rule by rule (each `RuleKey` in `packages/trading/src/bot/versions.ts` that moves, every new code
   path, and any changed default outside the version: the broker safety stop, the slider limits). One idea per version
   where possible; a bundle needs §3.
3. **The research twin**: slug, script, the `export_bench.py` `VERSIONS` row, the log entry in `best-algorithms.md`.
4. **The PR** and its branch.
5. **The baseline** it replaces: production as on `origin/main` and as on the live settings (the starred label).
6. **Production reads needed** (the live settings incl. the owner's broker safety stop, live trades, Railway deploy
   state): ask the user for them up front, since the sandbox may refuse them.

## 1. 🛑 The backtest is right (no bad backtest)

Every past inflated result came from one of these. Check each against the run's code and env, not from memory.

- **Config**: the candidate row in `bots.md`, `params.json` (`min_vol30` 200, `night_cap` 0.1). The frozen copy carries every
  env switch the run needs (`BT_REST`, `BT_CLOCK`, `BT_CHASE`, `BT_KEEP`, `BT_ACCT`); print them in the run's header.
- **Reproduce, two ways**: (a) replay the stored exports and match the logged figures; (b) a **fresh re-walk of the parent
  and the new version on today's code**. If the version was chosen on figures made before a later fix, say so and judge
  on (b). No match, no verdict.
- **No look-ahead**: the signal uses only closed bars; Databento quotes go through `real_bench.quote()` (row m+1 = the
  book at the end of minute m); the earnings calendar and pre-market volume are as known that morning; lists are
  point-in-time (fair list = traded by Indi the year before).
- **Rules inside a minute** (early entry, tick exits): tested only on what the live bot sees at that second: SPY so far
  in the minute (not its close), the forming minute's volume, and every second of the minute searched (not only
  minutes known to hold at the close). If the research can't do that, the rule's result is NOT counted.
- **Fills**: real quotes are the yardstick; a buy never fills under the bid / a sale never above the ask; the chase goes
  to the ask like the live bot (`BT_CHASE=ask`); costs $0.62 a contract each way + 2% a fill (floor $0.40) are in. Say
  whether the night-cap sale is priced at the bid or at a mark.
- **What the backtest does not model**, named: the broker safety stop (at the owner's value), the trading service's
  limits (§5), a thin option priced at a stale print.
- **Nothing dropped**: trades whose option did not print are kept (`BT_KEEP` / `STR_WALK_KEEP`); exits run every stock
  minute (`BT_CLOCK=stock`).
- **Account math**: P&L booked on the last sale day, days sized on marked open trades (`BT_ACCT=marked`); the 10% night
  cap at each size; pyramid add rows already half size (never halve again); 2% figures from `ret_2pct`, 3% from
  `ret_3pct` (if the export has no 3% column, say the 3% figures are overstated).
- **Sanity**: trade count and win rate in the usual range (champion 15-20%); hand-trace **5 random trades and the best 3**
  on the chart (entry, contract, every exit step, the price paid vs the quote). Write what you saw for each.

## 2. 🛑 Not overfit

- Tune (even entry weeks) and check (odd) **in the same run**, fair list + Favorites, all years; the pick made on tune only.
- Levels set before the run; one neighbour on each side of every changed level is run, and the chosen level is not just
  the end of a slope.
- Better on check, on both lists, **without the best 5**, by year (every year positive).
- **Where the gain comes from**: the trades the version changes vs the parent: their count, the median changed trade, and
  their sum without the best 10 changed trades. A gain that disappears without ~10 trades is not an edge.
- The **look count** and the **number of variants tried** (the test scripts print it; count the log entries of the same
  idea otherwise). Past 3 looks the check is weak evidence; many variants on one day is a red flag.
- The unseen stocks (not in his 40) do not get worse; if the export path can't run them, NOT RUN.
- A **mechanism** in one sentence: why this should keep working.
- Anything resting on fills the data cannot see is marked **fill unproven** and does not count toward the pass.

## 3. Each part on its own

A bundled version shows each part added alone to the parent and each part left out (leave-one-out). A part that adds
nothing alone or left out (e.g. 2.8's late hold) is pulled. Parts that fail alone but help together pass only if the
combination passes §2 on check and the interaction has a mechanism (e.g. "the stages cap the drop the removed checks
open"); otherwise ship only the parts that pass alone.

## 4. Risk and size

- Worst drop, the longest time under water, the worst day and the worst 5 days, at **2% and 3%** (the live size); say if
  3% is past the best size on any list.
- At the live size, contracts bought vs the option's 30-minute volume: flag trades buying over ~10% of it.
- The owner's limits (size, buys a day, open positions, day loss, drawdown pause, broker stop) are unchanged; say if the
  version makes them bind more often, and whether the owner's saved safety stop now sits inside the bot's stop.

## 5. 🛑 The live code is right (no bad live bot)

A fresh reviewer agent reads the PR diff (the code, not your conclusion). Check:

- **Never short**: every sell is close-only and never more than held, including partial sales, the pyramid add's
  leg, a shared contract between two bot positions, restarts and the broker safety stop firing first.
- **Versions**: a new `BotVersion` entry; earlier versions' rules untouched; a new rule key gets the old behaviour for
  every older version; saved settings migrate (own labels too); the label shows a star when the owner's settings differ.
  Settings that are not rule keys (the safety stop) and still conflict with the new rules are flagged.
- **Every entry and position stamped** with the version in force.
- **Restart and repeat safety**: a restart mid-position resumes its exits (staged state persisted); no double buy or sale;
  a partial or zero fill is handled (a zero-fill sale is retried).
- **The trading service lets every new kind of order through**: the repeat check, the position size cap, the spread
  limit, the day-loss limit. (2.7's pyramid add was refused live by the 60-second repeat check.)
- **Missing and late data**: a missing bar, a stale quote, a bad tick, a stock added after warm-up, a broker error, a half
  session, the DST weeks.
- **Both brokers** under "both" actually trade: the last live day has fills on each (2.7: every IBKR order failed).
  Telegram posts match the action.
- **Tests**: positive, negative and boundary cases for each changed rule and each new live path; tests and typecheck
  green (paste the output).

## 6. 🛑 Live matches the backtest

- A **rule map**: each changed rule → its setting in `versions.ts` → its switch in the research script, with the same
  number on both sides. A rule on one side only is a FAIL.
- Check the two usual drifts: **ticks vs minute closes** (live checks the last trade every few seconds, the backtest a
  minute close; measure on the 10-second bars how many trades cross a line on a tick but never on a close), and the
  **reference price** (live: the price at the fill second; backtest: the signal minute's close).
- **Parity scripts** (`bot-parity.ts`, `bot-exit-parity.ts`, `bot-level-parity.ts`) cover the change. A new rule with no
  parity check is a FAIL until one is written.
- **E2E replay** (`scripts/bot-replay.ts`, the PR's code) on at least 5 days chosen to hit the change, plus an overnight
  hold, a D2 entry, a pyramid add, an earnings day and a half day. Practical setting: 60-second ticks reading the
  10-second bars (5-second ticks take hours a day); its option quotes are synthetic, so where live days exist compare
  exits on the recorded live books instead. Same signals (stock, side, minute) as the research backtest; every
  difference listed, and say if they all lean one way.
- Run the replay with the owner's **live** settings too: the starred version is what runs.

## 7. 🛑 Deploy

- Merge first; deploy a clean `origin/main` from the deploy checkout, never a PR branch.
- Switch the live settings to the new version on purpose, keeping the owner's limits; read them back after.
- After the deploy: the trader is healthy, the settings page shows the new version, the next signal is stamped with it.
- **Rollback**: the one-line way back (the previous version in the settings) is written in the report before deploying.
- Bot, order and risk changes need the user's go before merging and deploying.
- The research twin of the new version is in the parity tools before the deploy (`app_twin.py` for the Main bot,
  `parity_volume/` switches for the Volume bot), so stage 5 can run at once.
- Then run `bot-live-check`: one month app vs research 1:1, and the E2E run with trading and notifications.

## 8. After it is live: set the bar up front

Before the first live day, write in the report:

- What the **first week** should look like (trades a week, win rate, median trade) from the backtest of recent weeks.
- **Stop criteria**, with numbers: a live trade or sale the replay or the rules don't explain, a sale on a tick no minute
  close confirms, the broker stop firing before the bot's stop, a fill more than 10% from its quote, a week worse than
  the backtest's worst 5 days → back to the previous version and investigate.
- **Reconcile** every position closed outside the bot (by the broker or by hand): a sale price, not $0.
- Run `bot-review` after day 1 and after week 1; the replay is the yardstick for "does production act as expected".

## 9. 🛑 Dashboards and docs (the last step)

- **Bot vs Indi dashboard** (https://claude.ai/artifact/34CHCtYWPgexzP51zze9vV): the new version is the **default**,
  the old production stays on the picker as the line it beat; re-export with the current fixes; update the
  "versions" card; then read `data/users/me` doc `check`. Volume bot → its own benchmark page.
- `docs/research/bots.md`: the version stays the candidate ("live, stage 5 pending") until `bot-live-check` passes,
  then becomes the champion; `best-algorithms.md`: the log entry with the
  release date; `versions.ts` `notes` and `since` with today's figures.
- Memory: the production line in the relevant memory updated.

## The release report

```
Version 2.x  (from 2.y)  PR #N  slug <slug>          verdict: GO / NO-GO
Changed:  <rule: old -> new>, ...  (and defaults outside the version)
Result (2%, real quotes, fresh run) | Tune fair | Tune fav | Check fair | Check fav | w/o best 5 (tune / check) | worst drop
  parent                            |           |          |            |           |                           |
  new version                       |           |          |            |           |                           |
Looks: n   Variants tried: n   Changed trades: n, median, sum w/o best 10   Mechanism: <one sentence>
§1 backtest  PASS/FAIL/NOT RUN  ...one line of evidence per item
§2 overfit   ...
§3 parts     ...
§4 risk      ...
§5 live code ...
§6 parity    ...
§7 deploy    ... rollback: <how>
§8 first week bar + stop criteria
§9 dashboard link + docs commits
```

End with the dashboard link.
