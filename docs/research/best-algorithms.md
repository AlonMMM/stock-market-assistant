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

| Since      | Version                                                                                                                          | Fair list: end / worst drop / years           | 151 unseen: end / worst drop |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| 2026-10-21 | **V1 + give-back guard 500 → 200**: V1, and once the option has been up +500%, sell all if it falls back to +200% (any day held) | $278,941 / 25% / +1,543 +1,154 +1,816 a trade | $109,188 / 20%               |

At 2% a trade: $584,770 / 44% worst drop (V1 $499,412 / 46%). Only 11 trades on the fair list hit the guard; 9 made
more, 1 the same, 1 less (SMCI 2024-02-05, $26.9K → $22.2K). Picked as the best of 7 guards tested together (thresholds
set before the run): the tighter locks and the trails lose, so the gain is small and rests on 11 trades. Delta 0.10
recheck running. Not in the paper bot yet.

V1 (C signal t ≥ 2 vs SPY × β, day volume ≥ 1.5×, delta 0.15, your stop + overnight hold for winners ≥ +100%) is the
paper bot: $257,698 / 26% on the fair list, $107,869 / 21% on the unseen.

## Log

| Date       | Version              | Fair list: end / worst drop | 151 unseen     | vs champion                    | Status                      |
| ---------- | -------------------- | --------------------------- | -------------- | ------------------------------ | --------------------------- |
| 2026-10-21 | V1                   | $257,698 / 26%              | $107,869 / 21% | —                              | paper bot (deploy pending)  |
| 2026-10-21 | V1 + guard 500 → 200 | $278,941 / 25%              | $109,188 / 20% | +$21K, −1 pt drop; unseen +$1K | 🏆 champion (backtest only) |

## Tested, not better (V2, 2026-10-21)

- IV filters (own IV rank, low-IV stocks, IV / realized vol): about the same as trading less; fail at 0.10 and unseen.
- Rolling out when the stock nears the strike fast (to delta 0.15 or 0.30): $161K – $206K; it sells the big winners.
- Overnight: no hold after a 5/10-minute premium drop; a 3–5% cap on what goes into the night: all worse or mixed.
- Give-back locks 200 → 50 and 300 → 100, trails 100/50, 200/40, 300/50, the ladder: worse or worse on the unseen.
- End-of-day entries for tomorrow (volume-free strength vs SPY, near the high): lose 2024 and 2025.

## Waiting for the unseen check

Better on the fair list, not yet checked on the 151 unseen stocks; not a champion until they pass:

- V1 + skip a pre-market move of 3% or more our way: $316,819 / 19% (pre-market data for the 151 is downloading).
- V1 + skip pre-market volume ≥ 4×: $286,606 / 17%.
- V1 + skip the earnings reaction day: $287,937 / 26% (it also lost 2 of 3 years on the unseen stocks, so the
  reaction day looks bad there too; the full check is pending).
