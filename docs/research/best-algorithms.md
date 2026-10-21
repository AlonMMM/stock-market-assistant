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

| Since      | Version                                                                                                                                          | Fair list: end / worst drop / years           | 151 unseen: end / worst drop |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------- |
| 2026-10-21 | **V1 + news filter**: V1, but no entry on the stock's earnings reaction day, and none when its pre-market volume is 4× or more its 20-day median | $297,160 / 16% / +2,637 +1,687 +1,448 a trade | $121,443 / 11%               |

- At 2% a trade: $688,039 / 30% worst drop (V1 $499,412 / 46%).
- It holds at delta 0.10 too: fair list $503,674 / 15% (V1 $495,349 / 23%), unseen $102,663 / 9% (V1 $86,369 / 20%).
- Each half alone also helps on both lists and both deltas. The cut-offs (reaction day, pre-market 4×) are the
  buckets of the entry-context study of his trades, set before these runs; the unseen stocks and delta 0.10 were
  not used to pick them.
- With the give-back guard 500 → 200 on top: $317,326 / 15%, unseen $122,929 / 11%; the guard stays fragile (it
  does not hold at 0.10 on its own).
- Also skipping a pre-market move of 3% or more our way does more at 0.15 ($311,994 / 15%) but fails at 0.10
  ($300,367 vs $503,674), so it is left out.
- Needs in the bot: the earnings calendar and pre-market 5-minute bars before 09:30. Not in the paper bot yet.

V1 (C signal t ≥ 2 vs SPY × β, day volume ≥ 1.5×, delta 0.15, your stop + overnight hold for winners ≥ +100%) is the
paper bot: $257,698 / 26% on the fair list, $107,869 / 21% on the unseen.

## Log

| Date       | Version                                                                | Fair list: end / worst drop | 151 unseen     | vs champion                                             | Status                                          |
| ---------- | ---------------------------------------------------------------------- | --------------------------- | -------------- | ------------------------------------------------------- | ----------------------------------------------- |
| 2026-10-21 | V1                                                                     | $257,698 / 26%              | $107,869 / 21% | —                                                       | paper bot (deploy pending)                      |
| 2026-10-21 | V1 + guard 500 → 200                                                   | $278,941 / 25%              | $109,188 / 20% | +$21K, −1 pt drop; unseen +$1K                          | champion until the news filter; fragile at 0.10 |
| 2026-10-21 | V1 + news filter (no earnings reaction day, no pre-market volume ≥ 4×) | $297,160 / 16%              | $121,443 / 11% | +$18K, −9 pts drop; unseen +$12K, −9 pts; holds at 0.10 | 🏆 champion (backtest only)                     |

## Tested, not better (V2, 2026-10-21)

- IV filters (own IV rank, low-IV stocks, IV / realized vol): about the same as trading less; fail at 0.10 and unseen.
- Rolling out when the stock nears the strike fast (to delta 0.15 or 0.30): $161K – $206K; it sells the big winners.
- Overnight: no hold after a 5/10-minute premium drop; a 3–5% cap on what goes into the night: all worse or mixed.
- Give-back locks 200 → 50 and 300 → 100, trails 100/50, 200/40, 300/50, the ladder: worse or worse on the unseen.
- End-of-day entries for tomorrow (volume-free strength vs SPY, near the high): lose 2024 and 2025.
- Score and moving-volume entries (t ≥ 3 with 1×, t ≥ 2.5 with 1.2×, t ≥ 1.5 with 2.5×, scores 2.0 / 3.0, moving-volume
  blend, speeding-up boost, 5-minute burst): none better on both lists.
- Selling 25% at +150% and 25% at +250%: $142,572 / 20%. Carried-day trailing stops (25 / 40 / 50%): worse.
- False alarms (the stock or SPY against the bet at the signal): only 3 of 820 trades; filters do not help.

## Candidates

- Entry score ≥ 2.5 (t/2 + volume/1.5, floors t 1.5, volume 1×): fair list $490,168 / 11%, but unseen $82,370 / 30%.
- Sell everything at the morning gap (not half): about 27% more at the same worst drop on the fair list at 0.15, but
  worse at 0.10 and on the unseen.
