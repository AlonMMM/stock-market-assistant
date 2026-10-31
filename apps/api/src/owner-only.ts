import type { AccessIdentity } from "./access.js";

// Every change in the app is the owner's (user 2026-10-26: "all other people
// that have permission to see the application cannot change ... All the
// changed is read-only ... for all the bots and all the application").
// These POSTs only compute and change nothing of the owner's, so any viewer
// may use them. The bot backtest (the Backtest page, user 2026-10-31: "20 parts
// failed ... Read-only: only the owner can change this" on the phone) only
// fills the shared option-bar cache, which is market data, not a setting.
const computeOnly = new Set([
  "/api/backtest",
  "/api/bot-backtest",
  "/api/day-chart",
  "/api/replay",
]);

/** Why a request may not change anything, or null when it may go on. */
export function changeRefusal(
  method: string,
  path: string,
  identity: AccessIdentity | null,
  owner: string | undefined,
): string | null {
  if (method === "GET" || method === "HEAD") return null;
  if (!path.startsWith("/api/") || computeOnly.has(path)) return null;
  // No sign-in configured (local runs and tests); the site always has it.
  if (!identity) return null;
  const isOwner =
    Boolean(owner) && identity.email.toLowerCase() === owner!.toLowerCase();
  if (isOwner) return null;
  return "Read-only: only the owner can change this";
}
