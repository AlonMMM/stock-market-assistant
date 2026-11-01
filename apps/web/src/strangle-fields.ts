import {
  clockOf,
  type StrangleNumberKey,
} from "../../../packages/trading/src/strangle/settings.js";

// The Volume bot's settings in words: the settings page (StranglePanel.tsx)
// and the Volume bot's backtest (BotBacktest.tsx) show the same fields.

export interface Spec {
  key: StrangleNumberKey;
  label: string;
  help: string;
  fmt: (v: number) => string;
}
const pct = (v: number) => `${v}%`;
const count = (v: number) => String(v);
const clock = (v: number) => clockOf(v);
export const groups: { title: string; specs: Spec[] }[] = [
  {
    title: "Size and limits",
    specs: [
      {
        key: "sizePct",
        label: "Size of one trade",
        help: "The leg, as a share of the account.",
        fmt: pct,
      },
      {
        key: "maxTradesPerDay",
        label: "Most trades a day",
        help: "One buy a trade; the account allows ten a day.",
        fmt: count,
      },
      {
        key: "maxPerStock",
        label: "Most trades a stock a day",
        help: "A later alert burst on a stock counts once it has nothing open, up to this many trades.",
        fmt: count,
      },
      {
        key: "maxOpen",
        label: "Most open trades",
        help: "A new alert waits out while this many are open.",
        fmt: count,
      },
      {
        key: "dayLossPct",
        label: "Day loss limit",
        help: "No new trade after the account is down this much today.",
        fmt: pct,
      },
      {
        key: "safetyStopPct",
        label: "Broker safety stop",
        help: "On every leg, in case the service is down. The account's rules need a stop.",
        fmt: (v) => `−${v}%`,
      },
    ],
  },
  {
    title: "Entry",
    specs: [
      {
        key: "firstMinute",
        label: "From",
        help: "New York time; alerts from here count.",
        fmt: clock,
      },
      {
        key: "lastMinute",
        label: "Until",
        help: "No new strangle after this.",
        fmt: clock,
      },
      {
        key: "delta",
        label: "Delta of the leg",
        help: "The call or the put of the same-day expiry (or the next session's, on 1DTE days).",
        fmt: (v) => v.toFixed(2),
      },
      {
        key: "minPrice",
        label: "Cheapest leg",
        help: "Each leg's mid at least this.",
        fmt: (v) => `$${v.toFixed(2)}`,
      },
      {
        key: "minVolume",
        label: "Liquidity",
        help: "Contracts traded in the last 30 minutes, each leg.",
        fmt: count,
      },
    ],
  },
  {
    title: "The side and the exit",
    specs: [
      {
        key: "confirmUnits",
        label: "The side at",
        help: "The stock's move from the fill, in typical 30-minute moves.",
        fmt: (v) => `${v.toFixed(2)}×`,
      },
      {
        key: "waitMinutes",
        label: "Wait for the side",
        help: "No side by then: no trade.",
        fmt: (v) => `${v} min`,
      },
      {
        key: "giveBackUnits",
        label: "Sell on the stock's give-back",
        help: "Of its typical 30-minute move, from its best since the buy.",
        fmt: (v) => `${v.toFixed(2)}×`,
      },
      {
        key: "endMinute",
        label: "Everything out by",
        help: "New York time.",
        fmt: clock,
      },
      {
        key: "crossMaxSeconds",
        label: "Fast cross within",
        help: "With the fast-cross switch on: the side has to come this many seconds after the alert, else no trade.",
        fmt: (v) => `${v} s`,
      },
      {
        key: "burstMin",
        label: "Burst at least",
        help: "With the burst switch on: the 3 minutes up to the alert moved this many typical 30-minute moves the side's way.",
        fmt: (v) => `${v.toFixed(1)}×`,
      },
      {
        key: "burstMinWeek",
        label: "Same-week burst at least",
        help: "With same-week expiries on: the burst a 2-4 DTE trade needs (stronger than the 0/1 DTE one).",
        fmt: (v) => `${v.toFixed(1)}×`,
      },
      {
        key: "noStopMinutes",
        label: "No give-back sale for",
        help: "Minutes after the buy; the end of the day still sells.",
        fmt: (v) => `${v} min`,
      },
    ],
  },
];
export const switches: {
  key:
    | "nextDay"
    | "liquidFallback"
    | "strengthFilter"
    | "crossFilter"
    | "burstFilter"
    | "weekExpiry"
    | "exitOnMinuteClose"
    | "fastAlert"
    | "shockAlert"
    | "skipEarnings"
    | "skipPremarket"
    | "followFavorites";
  label: string;
  help: string;
}[] = [
  {
    key: "nextDay",
    label: "Also 1DTE days",
    help: "Days with no same-day expiry but one the next session (mostly Thursdays): the same rule on that expiry, still sold the same day.",
  },
  {
    key: "liquidFallback",
    label: "Liquid fallback",
    help: "The leg too thin: buy the nearest strike that trades enough, further out (to delta 0.25) first, then toward the money (to 0.50).",
  },
  {
    key: "strengthFilter",
    label: "Strength must agree",
    help: "Buy only when the stock's strength vs SPY since the open points the way of the side; else no trade.",
  },
  {
    key: "crossFilter",
    label: "Fast cross only",
    help: "Buy only when the side comes within the seconds set above after the alert (the 2026-10-28 winner).",
  },
  {
    key: "burstFilter",
    label: "Burst must agree",
    help: "Buy only when the 3 minutes before the alert already moved the side's way by the burst set above.",
  },
  {
    key: "weekExpiry",
    label: "Same-week expiries",
    help: "Days with no expiry today or the next session: the nearest expiry later that week (2-4 DTE), only with the stronger burst; still sold the same day.",
  },
  {
    key: "exitOnMinuteClose",
    label: "Give-back on minute closes",
    help: "Read the give-back on each minute's close, as the backtest does, not on every 10-second tick.",
  },
  {
    key: "fastAlert",
    label: "60-second alert",
    help: "A second alert on 10-second bars: 60 seconds of volume at 2× normal or today's pace with a move of 3× normal, 09:40 to 13:00, same-day or next-session expiry only (F60x2).",
  },
  {
    key: "shockAlert",
    label: "Shock alert",
    help: "The same 60-second rule at 15× volume, 09:40 to 15:30. Bought when the side holds 5 seconds within 5 minutes, the burst at least 0 the side's way, an expiry at most 2 days out; the leg steps toward the money up to 0.35 delta while too cheap, and no buy when its spread is over 30% of the mid.",
  },
  {
    key: "skipEarnings",
    label: "Skip earnings days",
    help: "No entry on the stock's earnings reaction day.",
  },
  {
    key: "skipPremarket",
    label: "Skip busy pre-markets",
    help: "No entry when pre-market volume is 4× normal or more.",
  },
  {
    key: "followFavorites",
    label: "Watch the favorites list",
    help: "The site sends it before each session.",
  },
];
