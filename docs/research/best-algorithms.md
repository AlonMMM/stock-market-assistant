# Best algorithms log

Every time a backtested version beats the current champion, it is added here, and the user gets a big signal
(see the rule in [AGENTS.md](../../AGENTS.md)). Losers and ties are not logged here; they go in the research log
(`docs/tasks/research-indi-backtest.md`) and the report doc.

## What counts as better

A version beats the champion only when **all** hold, on the same period (Feb 2024 – Oct 2026), the same trade model
(fills at the bar middle ± 2%) and the same sizing (1% of the current account from $100,000):

1. **Fair list:** it ends higher than the champion on the stocks Indi traded the year before (no look-ahead), or
   ends about the same with a clearly smaller worst drop.
2. **Every year positive** on the fair list (2024, 2025, 2026).
3. **Unseen stocks:** on the 151 stocks outside his 40 it is no worse than the champion. A filter that helps only
   on his 40 stocks does not count; the sector filter failed exactly this way.
4. It was not tuned on the result it is judged by. If its thresholds were picked from these numbers, say so.

## Champion

| Since      | Version                                                                                                            | Fair list: end / worst drop / years | 151 unseen: end / worst drop |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ---------------------------- |
| 2026-10-21 | **V1**: C signal (t ≥ 2 vs SPY × β, day volume ≥ 1.5×), delta 0.15, your stop + overnight hold for winners ≥ +100% | $257,698 / 26% / +33% +34% +44%     | $107,869 / 21%               |

Delta 0.10 ends higher ($495,349, 23%) but the user chose 0.15 for the paper bot; both are tracked.

## Log

| Date       | Version    | Fair list: end / worst drop / years | 151 unseen     | vs champion | Status                               |
| ---------- | ---------- | ----------------------------------- | -------------- | ----------- | ------------------------------------ |
| 2026-10-21 | V1 (above) | $257,698 / 26%                      | $107,869 / 21% | —           | champion, paper bot (deploy pending) |

## Waiting for the unseen check

Better on the fair list, not yet checked on the 151 unseen stocks; not a champion until they pass:

- V1 + skip a pre-market move of 3% or more our way: $316,819 / 19% (pre-market data for the 151 is downloading).
- V1 + skip pre-market volume ≥ 4×: $286,606 / 17%.
- V1 + skip the earnings reaction day: $287,937 / 26% (it also lost 2 of 3 years on the unseen stocks, so the
  reaction day looks bad there too; the full check is pending).
