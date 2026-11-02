---
name: bot-live-check
description: Stage 5 of every bot change, right after a version is deployed - one month of the app's backtest (the live bot's code) against the research twin, trade by trade, expected 1 to 1, and an end-to-end run of the live bot through the trading service, the broker and the Telegram notifications. The version becomes champion only when this passes. Use after a deploy ("test the deploy", "is live = research?", "run the live check"), or to recheck the champion after any engine change on either side.
user-invocable: true
argument-hint: "<main|volume> <version> [YYYY-MM]"
---

# The live check (stage 5)

User rule, 2026-11-02: "when testing is comparing: running the backtest on a single month with the live bot code,
compare it with the research results. the match should be 1 to 1. we also test E2E flow with trading and
notifications." Part of the `bot-lifecycle` skill. Output: a report with each part PASS / FAIL / NOT RUN (with why);
NOT RUN is never PASS.

Ground rules: no orders, ever (the E2E runs on the in-memory broker, nothing reaches an account). Production reads
only (settings, D1): SELECTs and GETs. Never read `.env`. Never short. Israel time.

## 0. Pin down

- The bot, the version just deployed, the deployed commit (`origin/main`, the deploy checkout `~/Desktop/Personal/sma-deploy`).
- **The live saved settings**, read from the trader (Main: `GET /v1/bot/settings`; Volume: connector `volume_bot_settings`),
  saved to the run folder. The check runs these, not the code defaults (`withDefaults` / `strangleWithDefaults`).
- **The month**: the last full calendar month (or the one named), the bot's live stock list.
- Run folder in the scratchpad. Before a research run, `params.json` `min_vol30` is 200.

## 1. One month, app vs research, 1 to 1

Both sides price on the same real books and go through the same account (the app's), so every gap is a trade gap.

**Main bot**

- App: `scripts/bot-backtest-compare.ts run <settings.json> <bot.json> <from> <to> <app.json>` (from PR #234; on `main`
  once merged), the deployed code in `APP_ROOT`. `ONLY=` reruns failed stocks (Alpaca 429s).
- Research: the version's twin, `scripts/research/indi_bt/app_twin.py` on `research/indi-v2`
  (`node --env-file=.env <indi_bt>/run.mjs app_twin.py <from> <to> <SYMS> <out.json>`). `app_twin.py` is the twin of
  2.7.0: a new version's rules go into it in stage 4 (the rule map in the release report), or the check is NOT RUN.
- Compare: `bot-backtest-compare.ts compare <app.json> <research.json> <label> <out.json>`.

**Volume bot**

- `scripts/research/indi_bt/parity_volume/` (README: settings, the D1 snapshot, `app_run.mts`, the research lists,
  `research_run.sh`, `research_diag.py`, `compare.py`). The research's defaults are Volume 1.0.0 (the 11-01 alignment);
  each version's switches are its "Research twin" in `bots.md` (1.1.0: `PF_MAX_S=20` when the shock list is
  prefiltered, `STR_LIQ_OLD=1` on the run). A new version's twin is written in stage 4, or the check is NOT RUN.
  `STR_LIQ_OLD=1` also turns back the fallback's direction (further out first), which 1.1.0's rescue does not:
  expect those rows to differ until the research has a rescue-only switch.

**Pass**: every trade the same on both sides: the contract, every buy and sale minute (second for the Volume bot),
every fill price to the cent, the same account end, drop and wins; alerts refused for the same reason on both. Any other
row is a FAIL until its cause is found and fixed on the side that is wrong (the live bot is the yardstick unless the
live code is the bug), then rerun. List each gap with its cause, as in the 2026-11-01 alignment
(App vs local backtest, https://claude.ai/artifact/EBYVtGszzqCPdu3rAggaeG). Missing data on both sides (no book, no
strike) is listed, never counted as a match or a skip that hides a trade.

## 2. End to end: trading and notifications

The live bot's code on a past session through the owner's trading service, its engine and the in-memory broker, with
the Telegram posts captured (no order reaches any account, no message is sent):

- Main bot: `node --env-file=.env --import tsx scripts/bot-replay.ts <YYYY-MM-DD> <report.md>`
  (`BOT_REPLAY_SETTINGS=<settings.json>`, the live settings).
- Volume bot: `node --env-file=.env --import tsx scripts/volume-replay.ts <YYYY-MM-DD> <report.md>`
  (`VOLUME_REPLAY_BACKTEST` for the side-by-side).

Pick at least 3 days of the month that hit the new version's change (plus, for the Main bot, an overnight hold and a
pyramid add; for the Volume bot, a plan and a shock trade). **Pass**:

- every signal reaches an order, the service accepts it (repeat check, size cap, spread limit, day loss), it fills,
  and the exits sell close-only, never more than held;
- each buy, sale and refusal has its Telegram post, with the right stock, contract, size and price;
- the replay's trades are the backtest's (stock, side, minute, contract); every difference is listed with its cause
  (the replay's option quotes are synthetic: a price gap alone is not a FAIL, a different trade is).

If live days exist since the deploy, also set the first live trades beside the backtest of that day (`bot-review`).

## 3. Report and promote

```
Live check  <bot> <version>  commit <sha>  month <YYYY-MM>       verdict: PASS / FAIL
1:1 month   app n trades / research n / same n   end $a vs $b   drop a vs b   gaps: <cause per row>
E2E         days <d, d, d>   orders n accepted n refused n   posts n/n   differences: <list>
```

- PASS: `bots.md` makes the version the champion (old champion to the versions list), the bot's benchmark page marks
  it Champion and selects it, the memory's production line is updated, commits pushed as AlonMMM.
- FAIL: say what failed; propose the rollback (the previous champion's settings, from the release report) and wait for
  the user's go before changing live settings.
