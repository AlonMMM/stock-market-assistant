// How far behind real time SIP data may be requested from Alpaca's REST API
// (board, day chart, backtest, bar cache). An account with real-time SIP
// (Algo Trader Plus, since 2026-10-04) uses 0; Alpaca's free plan serves SIP
// history except the most recent 15 minutes, so a deployment without
// real-time SIP sets ALPACA_SIP_DELAY_MINUTES=15.
export const sipDelayVariable = "ALPACA_SIP_DELAY_MINUTES";
export const defaultSipDelayMinutes = 0;
export const freePlanSipDelayMinutes = 15;

/** Minutes from the environment value; unset or "" → the default. */
export function parseSipDelay(value: string | number | undefined): number {
  if (value === undefined || value === "") return defaultSipDelayMinutes;
  const minutes = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60)
    throw new Error(`${sipDelayVariable} must be an integer from 0 to 60`);
  return minutes;
}

export const sipDelayMs = (minutes: number = defaultSipDelayMinutes) =>
  minutes * 60000;
