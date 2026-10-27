# Task: the Main bot's version 2.7 (the 2026-10-27 champion)

Status: in review (merging and deploying 2026-10-27 at the user's go)
Owner: backend
Branch: feat/bot-champion-2-7

## Outcome

The live Main bot can run the research champion of 2026-10-27 (research/indi-v2, docs/research/best-algorithms.md):
2.5's entries and exits without the cheap fallback, IBIT bought down to $0.10, the pyramid, and early entry. The user
chose it ("lets make this our champion") and asked for it live ("go and implement the logic in our live bot - test it
well"; "when you done with the new version merge and deploy - make it live today").

## What changed

- `packages/trading/src/bot/versions.ts`: version 2.7 = 2.5 + five new rules. Older versions get the rules off, so a
  running 2.6 stays 2.6 until 2.7 is chosen. A rule may be a list of tickers (compared in order).
- `packages/trading/src/bot/settings.ts`: the rules as settings with limits, defaults = 2.7.
  - `lowFloorSymbols` (["IBIT"]) / `lowFloorPrice` (0.10): those stocks' floor; every other keeps `minPrice`.
    `pickRules(s, symbol)` and `minPriceFor`.
  - `pyramid` / `pyramidSharePct` (50): the half-size add.
  - `earlyEntry`: the signal on the minute so far.
  - A record saved before versions takes its missing rules from 2.6 (never the new ones).
- `apps/trader/src/bot.ts`:
  - **IBIT's floor**: every pick uses the stock's own floor; the too-cheap skip says so.
  - **Pyramid** (`pyramids`, `addTo`): a D2 bonus entry is marked `bonus` on its position. Each closed minute, for an
    open bonus position of today, the day's first full signal (t >= minT, the bonus off): the other side, a missed
    minute, the first position not held or its option not above its cost ends it (`pyramidChecked`, an activity
    line); else one add of `pyramidSharePct` of the size, a fresh pick at the first position's broker, `addOf` = the
    first's id. The owner's limits apply (open positions; it is not a new signal, so not a "buy of the day").
  - **The shared contract**: 41% of the backtest's adds buy the same contract as the first position. An add may buy a
    contract the bot holds when the account holds exactly the bot's positions in it (never the user's). `settle`
    counts each position as the account's quantity less the bot's other open positions in that contract, so the bot
    never counts (or sells) more than the account holds; an add's cost is its own fill price (`avgPrice`).
  - **Early entry** (`earlyEntries`): on each tick inside a minute whose previous minute is loaded, the stocks' and
    SPY's latest trades (`lastPrices`, one request) become the forming minute's close (its volume not yet counted)
    and the signal is evaluated; the first tick it holds is the signal (minute m, "inside the minute" with the
    second). The closed minute then finds the signal taken.
- `apps/trader/src/main.ts`: the bot ticks every 5 seconds (was 10). The research: checking every 5 s keeps almost
  all of early entry's gain, every 10 s about half (sec_timing.py early5 / early10).
- `packages/trading/src/bot/algorithm.ts`: the rules in words (Signal, Contract, a Pyramid step).
- `scripts/bot-replay.ts`: the replay fed the live reader's latest trades (today's prices) to a past day. It now
  gives the price at the replay's moment (a completed 10-second bar, else the last closed minute) and can tick every
  few seconds (`BOT_REPLAY_TICK_S`).

## Limits

- Early entry's forming minute has no volume yet: a stock whose volume crosses 1.5x inside the minute waits for the
  close. SPY's latest trade is real live (the research spread SPY's move evenly inside the minute).
- The pyramid decides on the option's quote mid at the minute the full signal closes (the research: the real mid at
  that minute).
- The owner's limits (buys a day, open positions, the daily loss) are not in the research; the add counts as an open
  position.

## Verification evidence

- `npm run check`: format, types, the web and worker builds, 687 tests pass (1 skipped), 0 fail.
- New tests (tests/indi-bot.test.ts, bot-settings*.test.ts): IBIT's floor and no fallback; the add at half size,
  once, in the same contract, each position counting its own; no add when the first is not up, the other side, not a
  D2 entry, or the pyramid off; never into a contract the user holds; the shared contract never counted above the
  account; early entry buys inside the minute and the closed minute buys nothing more; off, it waits for the close;
  2.6 stays 2.6; the version card and the rules in words.
- Replays (`scripts/bot-replay.ts`, the live IndiBot + TraderService + TradeEngine on SimBroker, 2.7, ticks every 5 s,
  prices from the 10-second bars, no trade caps), against the research champion on the same days:
  - 2026-10-09: TSLA call D2 09:44 and its add (Call 400, half size) at 09:50, UBER 09:52, SPCX 10:22: as the
    backtest; SNOW at 10:08:50 inside the minute (the backtest's minute-level champion: 10:22).
  - 2026-10-16: PLTR put D2 09:40 and its add (Put 180) at 09:42, UBER 09:50:30 (backtest 09:51), MRNA 10:04: as the
    backtest; WMT at 09:40:10 inside the minute.
  - 2026-09-30: RKLB 09:59, GOOGL D2 10:05: as the backtest; the GOOGL add skipped ("not up at 10:08, 0.84 vs 0.86
    paid": the replay's quotes are the bar close +-2%, not the real book).
  - Every sale at most the position's own quantity; both legs of a pyramid exit on their own rules.
- A first replay found two faults, both fixed: the replay fed today's live prices to a past day; and early entry
  skipped every stock because the bars request already holds the forming minute (a regression test fails on the old
  code and passes now).
- The 1-second research (sec_timing.py early5nv): checking every 5 seconds without the forming minute's volume keeps
  the gain (tune $328,276 vs $328,276 with it; check $477,660 vs $477,551).

## Handoff

Next: merge, deploy from a clean origin/main, set the bot to 2.7 (the user's go: "make it live today").
