# Task: end-to-end replay of the Indi bot on a past session

Status: completed
Owner: backend
Branch: test/bot-replay
Spec/contract revision: 5c98556 (main, #126)

## Outcome

A developer can run a past session through the live bot code end to end and see every signal, skip, order and
Telegram post it would have made, then compare that with the Python backtest for the same day.

## Scope and exclusions

- `scripts/bot-replay.ts`: the real `IndiBot`, `TraderService` and `TradeEngine` (owner-v1 validator) on the
  in-memory `SimBroker`, on a clock that moves one minute at a time from 09:25 to 16:15 New York.
- `.claude/skills/bot-backtest/SKILL.md`: how to run the three kinds of bot backtests (Python replay, research test
  against the champion, this replay).
- Not included: replaying the next session of a trade held overnight (one date per run); posting the broker's
  safety-stop fills (the live service's stop watch does that, the replay does not run it).

## Relevant context

- docs/tasks/backend-indi-bot.md (the bot), `scripts/research/indi_bt/` on `research/indi-v2` (the backtest).

## Acceptance criteria

- Same signals (stock, side, minute), skip reasons and contracts as the Python backtest (`week.py`) for the day.
- No order reaches any account; option quotes are labeled synthetic in the report.

## Plan and assumptions

- Stock bars (SIP), pre-market volume and the Nasdaq earnings calendar are read by the live readers
  (`AlpacaBotMarket`, `nasdaqEarnings`) for the past date.
- Alpaca has no historical option quotes. The chain comes from `/v2/options/contracts`; each quote is built from the
  last complete 1-minute option bar: bid/ask = close -/+ 2% (the backtest's fill cost), delta by Black-Scholes from
  that price (as `store.py` `iv_delta`). A buy fills at the ladder's ceiling (85% of mid -> ask), a sale at the bid.
- The bot runs with its default settings; the favorites list is passed in `BOT_REPLAY_FAVORITES`.

## Verification evidence

- `npx tsc --noEmit -p tsconfig.json`: no errors in the script.
- 2026-10-22, core list + the app's Favorites list (51 stocks): 8 signals, the same as `week.py 2026-10-22 2026-10-22`:
  META put and TSLA call skipped (earnings reaction day), OWL too cheap, UAL, LLY and MRNA illiquid, SPCX skipped
  (pre-market 6.3x), AMZN Put 247.5 bought. Replay: bought 31 at 0.64, 16 sold at the 10-min check, 15 at -30%,
  -33% in all; backtest: -32%. Account $100,000 -> $99,509.
- First runs found two harness faults, both fixed: the sim broker filled buys only at the ask, which the ladder never
  reaches (its ceiling is 85% of the way); quotes used the bar of the minute still running (40 s look-ahead).

## Handoff

Possible next steps: replay several days in a row (carry positions to the next session), and post the safety
stop's fill in the replay.
