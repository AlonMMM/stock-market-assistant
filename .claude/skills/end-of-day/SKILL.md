---
name: end-of-day
description: The end-of-day review of both live bots (the Main bot and the Volume bot), run every trading day at 23:25 Israel time by a scheduled cloud routine - the app's backtest of the day on the live settings and stocks, set beside the live trades trade by trade (entry time, entry and exit prices, money at paper and at real prices), a verdict on whether the backtest was too optimistic or too pessimistic, and a written analysis saved on each bot's Analyse page in the app. Use when the routine fires, or when the user asks for the end-of-day review, "live vs backtest today", or to redo a day's review.
user-invocable: true
argument-hint: "[YYYY-MM-DD] [main|volume]"
---

# End-of-day review

User request, 2026-11-05: "run backtest (app) and compare the trade in enter time, enter and exit, enter and exit
money, etc. it will in the end summarize if the bot was too optimistic or too pessimistic, and save it all with
analysis under analyse tab in the bot window in the app."

Everything runs on the website through the **trader assistant connector** (its `day_review_*` tools), so the cloud
routine needs no secret, no `.env` and no Mac. The website does the numbers
(`packages/market-data/src/day-review.ts`); this skill reads them, writes the analysis and saves it. The result shows
in the app: Trading → 🤖 Main bot → **Analyse**, and 🎯 Volume bot → **Analyse**.

Ground rules: read-only towards the bots. Never call `buy`, `sell`, `set_stop`, `cancel_order` or any
`*_update_*` tool. Israel time in everything written. Never invent a number: every figure comes from the review.

## 1. The day

- No argument: the New York session that has just closed (`TZ=America/New_York date +%F`; at 23:25 Israel time the
  US close has passed). A day the market was closed (weekend, holiday) is answered by `day_review_start` with
  "date must be a session that has closed": stop there and say so in one line.
- `YYYY-MM-DD`: that session (a redo); add `force: true` to the start.
- `main` / `volume`: that bot only. Default: both.

## 2. Start, and redo the day before when it held trades overnight

1. `day_review_start {bot, date}` for each bot. The website stores the day's recorded option books, then queues the
   app's backtest of the day ("Same as paper": the live settings and stock list) on its job queue.
2. For each bot, `day_review_get` of the **previous session**. If its `comparison.summary.open > 0` (a trade was held
   overnight on either side), `day_review_start {force: true}` for that day too: its exits are known now. Its old
   analysis stays until you save the new one.

## 3. Wait for the comparison

Poll `day_review_get {bot, date}` about once a minute until `status` is `compared` (or `failed`). A day takes a few
minutes; give up after 40 minutes and report what is still running. `failed`: report its `error` and stop for that
bot (do not save an analysis).

## 4. Read the comparison

`comparison.rows`: one row a trade, `match` = `both`, `live-only` or `backtest-only` (with `why`).

- `live`: `entryAt` (ms), `qty`, `paidPaper` (the paper fill), `paidReal` (the book's mid at the fill: the real
  price), `exits[]` (paper and real each), `retReal` / `pnlReal` and `retPaper` / `pnlPaper` (after $0.62 a contract
  each way), `open` (held overnight), `dry`, `broker`, `version`.
- `backtest`: `entryAt`, `entryPrice`, `exits[]`, `ret` (after fees), `priced` (`quotes` = real books; `trades` = the
  option's trade bars, **an estimate**; Volume: `buyPriced/sellPriced`), `account`.
- Gaps on a matched closed pair (backtest − live): `entryMinutes`, `entryPct` (backtest buy vs live real buy),
  `exitPct`, `retGapPts`, `dollarsGap` (the backtest's return at the live cost − the live real $).
- `summary`: `verdict` (from `gapPts` against ±5 points: above = optimistic, below = pessimistic), `gapDollars`,
  `gapPts`, `livePaper`, `liveReal`, `backtestAtLiveSize`, counts, `open`, `estimates`. `notes`: dry runs, stocks
  that failed in the backtest, a stopped run.

## 5. Find the cause of every difference

The review's job is not only to say the bot and the backtest differ, but **why**. Go through:

- every one-sided row (`bot only` / `backtest only`);
- every matched row with a different contract, an entry more than 2 minutes apart, a different exit reason or
  minute, or `retGapPts` beyond ±5;
- every refusal in the bot's records that the backtest did not have (or the reverse).

For each, find the cause in this order, and stop at the first that explains it with evidence:

1. **The records.** `comparison.evidence.live` (Main: each signal with each account's pick, `legs[]`: contract,
   `delta` and `volume30` as the broker gave them, outcome and detail; Volume: each alert and what came of it) and
   `comparison.evidence.backtest` (Main: the backtest's skips with reason and contract; Volume: the alerts it did not
   trade, with why). `backtest.delta` / `backtest.volume30` on each row: the backtest's own pick.
2. **The settings**: `comparison.evidence.settings`, the bot's saved settings both sides ran (a cap, a floor, a
   filter the backtest applies differently).
3. **The code**, in this repository: the live rule in `apps/trader/src/bot.ts` / `strangle.ts` and its backtest
   twin in `packages/trading/src/bot/backtest.ts` / `strangle/backtest.ts`. Name the two places with `file:line`
   and say how they differ.

Put each difference in exactly one class:

| Class        | Meaning                                        | Example                                                                                                                                  |
| ------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| expected     | both followed the same rule on different facts | an account limit hit live only                                                                                                           |
| pick         | each side chose a different contract           | live uses the broker's delta, the backtest its own from the price: one strike apart, so the volume floor passed on one and not the other |
| data         | different market data or fills                 | a paper fill far from the book, a missing book, a backtest priced on trade bars                                                          |
| live bug     | the bot broke its own rule                     | it bought under its volume floor by its own records                                                                                      |
| backtest bug | the backtest broke the bot's rule              | it bought what the live rule refuses                                                                                                     |
| unknown      | not found in records, settings or code         | say what was checked                                                                                                                     |

**Never call something a bug without proof**: a bug needs the record that shows the rule broken, or the two code
places that disagree. A guess is `unknown` with what to check next. (2026-11-04: COIN looked like the bot ignoring
its 200-contract floor; the records showed the bot bought Call 160 with 293 / 375 contracts and the backtest
skipped Call 162.5 with 98: a **pick** difference, not a bug.)

A difference that repeats across days (look at the previous reviews with `day_review_get`) is worth more than one
day's: say how many days it has appeared.

## 6. Write the analysis, one per bot

The **verdict** is the comparison's unless the figures it rests on are weak (say a single matched trade priced on
trade bars, or most of the day one-sided): then still pick one of the four values, and say in the first paragraph
why it differs from the computed one. "Too optimistic" = the backtest made more than live at real prices; "too
pessimistic" = less.

`headline`: one sentence with the verdict and the dollar gap, e.g. "The backtest was too optimistic by $412 (+8.1
pts) on 3 matched trades; live paid more at the entry."

`markdown`, in this order and no longer than needed:

1. `## Verdict`: two or three sentences: the figures (live real, live paper, backtest at live size, gap) and the
   main reason.
2. `## Trade by trade`: a table, one row a trade: stock and side, entry live / backtest (Israel time, minutes
   apart), buy paper / real / backtest, average sale real / backtest, return real / backtest, $ gap. Mark an
   estimate (trade bars) and a trade held overnight.
3. `## Differences and causes`: a table from step 5: what differed, the class, the evidence (the record or
   `file:line`), what to do. Bugs first, then pick and data, then expected.
4. `## Where the money gap came from`: entries (late or early, paid above the backtest's price), exits (a
   different exit reason or minute, a sale at a worse book), paper vs market (what the paper fills cost).
5. `## Notes`: open trades to be judged on a later day, estimates, dry runs, failed stocks, a version change.
6. `## To do`: at most three items. A **live bug** or **backtest bug**: the fix to make (ask the user before any
   change to the bots). A pattern: **a test to run** with the `new-test` skill, never a rule; say so.

`differences`: every item of step 5 as `{class, title, why, evidence, action, symbols, accounts}`; the Analyse page shows them
as the "Why the bot and the backtest differ" cards (bugs first) and tags each trade with its cause. `title` is a few
words ("COIN: a different strike"), `why` one or two plain sentences, `evidence` the record or `file:line`, `action`
what to do ("None." is fine), `symbols` the stocks, `accounts` the Main bot's accounts it concerns (`alpaca`,
`ibkr`; empty for all).

Words on the page: say **the bot** (what it did on its paper account), **the backtest** (the app's simulation of
the same day) and **at market** (the book's mid at the fill), never "live" or "real".

A day with no trade on either side: verdict `no trades`, a one-line headline, and a short markdown that says the
signals of the day and why none was taken (from the rows' `why`, or "no signal").

## 7. Save and report

`day_review_save {bot, date, verdict, headline, markdown, differences}` for each bot (and for the redone previous day). In the
final message, 3–5 lines: for each bot the verdict and headline, every **live bug** or **backtest bug** found (with
its evidence), any redone day, anything that failed or is still running, and where to read it (Trading → the bot's
tab → Analyse).

## When it breaks

- A connector tool answers "not configured for the day reviews": the connector's `SITE` binding or
  `DAY_REVIEW_TOKEN` secret is missing (setup, see `wrangler.connector.jsonc`); report it, nothing else to do.
- "The trading service answered 404 for /v1/bot/day": the trader on Railway is older than the day-review routes.
- Many `estimates`: the day's books were not recorded for the backtest's contracts (it picked other contracts than
  live); say so. Never download option data for the review: everything it reads is already in our database.
- Volume: "the Volume bot's data of the day is saved at 16:20 New York": the scheduled step that saves the day's
  alerts and 1-second books has not run yet; wait 10 minutes and start again.
