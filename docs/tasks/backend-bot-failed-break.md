# Task: the failed-break sale

Status: in review
Owner: backend
Branch: feat/bot-failed-break
Spec/contract revision: 5c98556 (main, #126)

## Outcome

The owner's chosen algorithm (2026-10-23): on the entry day, when the stock reaches the next level ahead of the entry
and falls back from it without breaking it, the bot sells everything it holds of that trade. It is on by default and can
be switched off on the Bot settings page; the trade size stays the owner's (2%).

## Research

Branch research/indi-v2, `docs/research/best-algorithms.md` (2026-10-23 entries), scripts `levels.py`, `fail_rebuy.py`,
`fail_rebuy2.py`. Champion trades (t >= 1.8, news filter, delta 0.15), fair list / 151 unseen stocks, 1% and 2% of the
start-of-day account from $100,000:

|                            | Fair at 1%     | Fair at 2%       | Unseen at 1%   |
| -------------------------- | -------------- | ---------------- | -------------- |
| Champion                   | $585,593 / 11% | $2,444,640 / 21% | $123,028 / 11% |
| With the failed-break sale | $538,923 / 9%  | $2,107,921 / 18% | $127,476 / 10% |

Less money at the same size on the fair list, a smaller worst drop on both lists, more on the unseen; every year
positive. A buy-back on the second try was tested and is worse (not built).

## The rule (packages/trading/src/bot/levels.ts)

- Levels, known at the minute they are used: yesterday's high / low, the 5 sessions before's high / low, the first
  15 minutes' high / low (from 09:45), the day's high / low so far (before this minute's bar).
- The unit: the stdev of the stock's 1-minute log returns over the 5 sessions before × √30 (a typical 30-minute
  move), × the price at the signal.
- At the signal: the nearest level ahead in the bet's direction (above for a call, below for a put). None ahead: no watch.
- From the minute after the signal, on each 1-minute close: 0.25 units beyond the level is a break (the watch ends);
  within 0.25 units is a touch; after a touch, 0.5 units back within 30 minutes is a failed break; 30 minutes after the
  touch with neither, the watch ends. Minutes without a bar are skipped.
- A failed break before 15:50 on the entry day sells everything the bot still holds of the trade ("failed-break"),
  through the service's close-only sell like every other bot sale. Carried days are not watched.

## Changes

- `packages/trading/src/bot/levels.ts` (new): `priorLevels`, `levelsAt`, `watchFor`, `advanceWatch`.
- `apps/trader/src/bot.ts`: the 5 sessions' levels at warm-up; the watch is set at the entry and kept on the position
  (`breakWatch` in `bot_positions`' JSON, restart-safe); each minute it advances (also while the buy fills), writes
  "reached / broke / failed break" to the feed, and sells all on a failed break when `sellFailedBreak` is on.
- `packages/trading/src/bot/settings.ts`: `sellFailedBreak` (default true). Saved settings without it get the default.
- `packages/trading/src/bot/exits.ts`: the `failed-break` reason. `bot-api.ts`: `breakWatch` on positions.
- Web: the Bot settings switch "Failed-break sale"; the Bot tab shows the watched level in an open position's plan
  and names the sale.
- `scripts/bot-level-parity.ts` (new): the watch against the backtest on real bars.

## Verification evidence

- `node --import tsx scripts/bot-level-parity.ts data/local/x/bt/market.sqlite data/local/x/bt/level_parity.csv`
  (from `level_parity_export.py`): 1134 of 1134 champion trades the same (level, state, minute).
- Tests (synthetic bars): levels and the watch's break / failed break / end; the runner sells all 33 on a failed break
  at the day's high with the level in the note, and with the setting off only notes it.
