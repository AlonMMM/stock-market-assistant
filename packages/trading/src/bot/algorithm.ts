import type { Rules } from "./versions.js";

// The bot's full algorithm in words, from a rule set (docs/tasks/backend-bot-settings.md,
// "Versions"): what the settings page shows for each version and what the Bot
// tab shows for the rules in force. One step per decision, in the order the
// bot takes them during a day. The owner's limits (size, buys a day, open
// positions, the daily loss, the drawdown pause, the broker safety stop) are
// not rules of a version and are worded by the page that shows them.

export interface AlgorithmStep {
  name: string;
  text: string;
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

// The D2 bonus (version 2.5): a lower strength enters when the stock held up on the market's bad minutes.
function bonusWords(r: Rules): string {
  if (!r.d2Entry) return "";
  return `Also from t ${r.d2T} when the stock held up on SPY's down minutes of the last 30 (D2 ${r.minD2}+: its move beyond beta × SPY on those minutes, in typical 30-minute moves). `;
}

export function algorithmSteps(r: Rules): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [];
  steps.push({
    name: "Signal",
    text:
      `From ${r.firstEntryMin} minutes after the open to 16 minutes before the close, ${r.earlyEntry ? "checked every 5 seconds on the minute so far (the stocks' and SPY's latest trades), bought at the first check it holds" : "checked once a minute"}: ` +
      `the stock's move against SPY is t ${r.minT}+ (its strength, normalised by its own volatility) and its volume is ${r.minRvol}× normal or more. ` +
      `${bonusWords(r)}A call on strength, a put on weakness. One entry per stock a day, on the side that comes first.`,
  });
  const news: string[] = [];
  if (r.skipEarnings) news.push("on the stock's earnings reaction day");
  if (r.skipPremarket)
    news.push("when its pre-market volume is 4× normal or more");
  steps.push({
    name: "News filter",
    text: news.length
      ? `No entry ${news.join(", or ")}.`
      : "Off: no entry is skipped for news.",
  });
  let floors = `skipped under $${r.minPrice.toFixed(2)}`;
  if (r.cheapFallback)
    floors = `under $${r.minPrice.toFixed(2)}, the nearest strike toward the money at $${r.minPrice.toFixed(2)} or more`;
  if (r.minVolume > 0)
    floors += ` or under ${r.minVolume} contracts traded in 30 minutes`;
  if (r.lowFloorSymbols.length)
    floors += `; ${r.lowFloorSymbols.join(", ")} down to $${r.lowFloorPrice.toFixed(2)}`;
  steps.push({
    name: "Contract",
    text: `The nearest expiry 1–${r.maxDte} days out, the strike with delta closest to ${r.delta}; ${floors}. Bought at the ask, chasing it until filled.`,
  });
  let pyramid = "Off: one position per stock a day.";
  if (r.pyramid)
    pyramid = `After a D2 entry, when the stock first reaches the full signal (t ${r.minT}+) that day on the same side and the first position is up, one more position of ${r.pyramidSharePct}% of the size in a fresh pick; each position then exits on its own.`;
  steps.push({ name: "Pyramid", text: pyramid });
  let size = "Your size on every trade.";
  if (r.sizeSteps.length)
    size = `Your size while the account is small; then ${r.sizeSteps.map((x) => `${x.pct}% from $${x.from.toLocaleString("en-US")}`).join(", ")} (the account's value as the day starts).`;
  if (r.volumeTiers.length)
    size += ` By the signal's volume since the open (× its usual): ${r.volumeTiers.map((x) => `${x.pct}% of that from ${x.atLeast}×`).join(", ")} (its pyramid add too).`;
  steps.push({ name: "Size", text: size });
  let checks =
    "No 10- and 20-minute checks: the position is held until a stop, a failed break or the day exit.";
  if (r.checks)
    checks =
      "10 minutes after the entry, if the stock is against the entry price, half is sold; 20 minutes after, if it is still against, the rest.";
  steps.push({ name: "Early checks", text: checks });
  let stages =
    "Off: the stock's move against the entry is not acted on by itself.";
  if (r.stockStages)
    stages = `On the entry day, half is sold once the stock is ${r.stageHalfS30} of its usual 30-minute move against the price at the signal, the rest at ${r.stageFullS30} against.`;
  steps.push({ name: "Staged stock exit", text: stages });
  let lock = "Off: a winner that comes back is held until another rule sells.";
  if (r.breakEvenLock)
    lock = `On the entry day, once the option is up ${r.lockArmPct}%, the stock price where it would be worth what was paid (Black-Scholes at its implied volatility then, worked out again each minute it is still that far up, the tighter kept) is a stop: all is sold if the stock gets back there.`;
  steps.push({ name: "Break-even lock", text: lock });
  let late = "Off: an entry after 15:00 meets the same exits as any other.";
  if (r.lateHold)
    late =
      "An entry at 15:00 or later is not sold on its entry day while it is above its cost; the 15:50 decision still runs.";
  steps.push({ name: "Late entries", text: late });
  let failed = "Off: a level that holds is not acted on.";
  if (r.sellFailedBreak)
    failed =
      "On the entry day, all is sold when the stock reaches the next level ahead and falls back without breaking it.";
  steps.push({ name: "Failed break", text: failed });
  let strength =
    "Off: a stock that loses its edge over SPY is held until another rule sells.";
  if (r.sellOnWeakness)
    strength = `On the entry day, all is sold when the stock's strength vs SPY × beta since the open (the t-stat that had to reach ${r.minT} to enter) falls to ${r.weaknessT} or under.`;
  steps.push({ name: "Strength gone", text: strength });
  let rest = "";
  if (r.checks && r.restStopPct > 0)
    rest = ` Once the 10-minute check sold half, the rest is sold at ${r.restStopPct}% down on the entry day.`;
  steps.push({
    name: "Stop",
    text: `All out when the option is down ${r.stopPct}% with the stock against the entry.${rest} Exits are checked every 5 seconds.`,
  });
  let carry = `At 15:50 everything is sold, except winners up ${r.holdFromPct}%+ which stay overnight (${plural(r.maxNights, "night")} at most, never into expiry)`;
  if (r.maxNights > 0 && r.nightCapPct > 0)
    carry += `, one contract worth at most ${r.nightCapPct}% of the account (the rest is sold)`;
  if (r.maxNights === 0) carry = "At 15:50 everything is sold";
  steps.push({
    name: "Day exit",
    text: `${carry}. A position held overnight is sold at the next open if the stock gaps against it.`,
  });
  return steps;
}
