---
name: bot-lifecycle
description: The way every bot (the Main bot / Indi bot and the Volume bot) changes, from an idea to a live version - champion, new test, candidate, the upgrade question, the version review, the deploy, the live check - and which skill runs each stage. Use whenever bot work starts or moves a stage ("test X", "upgrade?", "ship it", "is it live?", "which version is the champion", "what's next for the bot"), and to find a bot's champion and versions.
user-invocable: true
argument-hint: "[main|volume] [stage]"
---

# How a bot changes

User rule, 2026-11-02: "lets define the way we're working on any bot". The same five stages for every bot, in order.
No stage is skipped, and each one ends by saying the next one.

| #   | Stage                                                                      | Skill                | Ends with                                                   |
| --- | -------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------- |
| 1   | **Test a thesis** on the champion                                          | `new-test`           | the result on the bot's benchmark page; a candidate or none |
| 2   | **Ask for the upgrade**                                                    | (this skill)         | the user's yes or no                                        |
| 3   | **Review the version**                                                     | `bot-release` §0-6   | GO / NO-GO release report                                   |
| 4   | **Deploy**: build the live bot, merge, deploy                              | `bot-release` §5, §7 | the version live on production                              |
| 5   | **Live check**: one month app vs research 1:1, E2E trading + notifications | `bot-live-check`     | PASS -> the version is the new champion                     |

## The champion

- **Each bot has one champion: the version live in production**, as the live bot runs it (its saved settings, read
  from the trader, not the code default). Every new test builds on it **unless the user names another version**.
- A version becomes champion only when stage 5 passes. Until then it is the **candidate** (passed stage 1, waiting
  for 2-5). A merged version the owner has not switched on is still a candidate.
- The registry is `docs/research/bots.md` on `research/indi-v2` (worktree `~/Desktop/Personal/sma-indi-backtest`):
  per bot, the champion, the candidate, the versions with their PRs and research twins, the features under test.
  Update it in the same commit as the stage that changes it.
- The bot's benchmark page shows the versions by id, the champion marked "Champion" and selected by default, and the
  candidate next to it:
  - Main bot: Bot vs Indi, https://claude.ai/artifact/34CHCtYWPgexzP51zze9vV
  - Volume bot: Volume Bot, https://claude.ai/artifact/1dm8djqm2D4N6NRVJnzHPz

## Versions

- Main bot: `2.x`, in `packages/trading/src/bot/versions.ts` (`BotVersion`), stamped on every entry.
- Volume bot: `Volume 1.x.y`, its own list in `packages/trading/src/strangle/versions.ts` (`volumeVersions`, PR #238),
  never the Main bot's file: the saved setting `version` picks one, every Volume trade is stamped with it, and
  `bots.md` (Volume bot section) names the champion and the candidate.
- A new version = one idea where possible, a new id, the parent named.

## Stage 2: the upgrade question

After a stage-1 result with a candidate (it passed tune and check on both lists, and without the best 5), ask once,
in one short message:

> Candidate <id> (from champion <id>): <one line on the rule>. Check half: <figure> vs <figure>, worst drop <a> vs <b>.
> Upgrade it? Yes runs the version review (bot-release), then the deploy and the live check.

No candidate: say so and stop; nothing is asked. Never start stage 3 without the user's yes in chat. A yes covers
stages 3-5 for that version, but every outward step inside them still needs its own go where the project rules ask for
one: merging and deploying a bot change, and changing the live saved settings.

## Stage 3 -> 4 -> 5

- Stage 3 FAIL on a hard gate: report it and stop. The champion stays.
- Stage 4: the live code is built only after stage 3 says GO; the PR goes through `bot-release` §5 (fresh reviewer),
  merge, deploy from `main` (never a PR branch), the saved settings switched on purpose, read back after.
- Stage 5 straight after the deploy, before calling the version done. FAIL: the previous champion's settings are put
  back (the rollback line in the release report) after the user's go, and the gap is found.
- PASS: `bots.md` moves the version to champion (the old champion to the versions list), the benchmark page marks it
  Champion, the memory's production line is updated.

## Ground rules (every stage)

No orders, ever (E2E runs on the in-memory broker). Never short. Never read `.env` (`node --env-file=.env`). Push as
AlonMMM. No Jira for this repo. Israel time. Before a research run, check `params.json` (`min_vol30` 200).
