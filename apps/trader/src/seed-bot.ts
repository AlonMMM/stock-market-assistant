import type { BrokerAccount, TradeStore } from "./store.js";

// The Indi bot's own Alpaca paper account (user 2026-10-23: "I create one
// more paper account - can the bot use it?"). Next to the owner's default
// account, so the bot's trades and the user's own no longer mix. Its keys are
// BOT_ALPACA_API_KEY / BOT_ALPACA_API_SECRET on the trading service; the
// record only references them (docs/tasks/backend-bot-account.md).

type Env = Record<string, string | undefined>;

export const botAccountSuffix = "bot";
export const botKeyVariable = "BOT_ALPACA_API_KEY";
export const botSecretVariable = "BOT_ALPACA_API_SECRET";

/** The owner's bot account, if it was added. */
export function botAccount(store: TradeStore): BrokerAccount | null {
  const owner = store.users().find((u) => u.isAdmin);
  if (!owner) return null;
  return (
    store
      .accounts(owner.id)
      .find((a) => a.id === `${owner.id}-${botAccountSuffix}`) ?? null
  );
}

/**
 * Adds the bot's account once both key variables are set and there is an
 * owner. Returns the account id when added, else null. The account stays
 * once added; without the variables it cannot be built and the bot stops.
 */
export function ensureBotAccount(
  store: TradeStore,
  env: Env,
  now: number,
): string | null {
  if (!env[botKeyVariable] || !env[botSecretVariable]) return null;
  const owner = store.users().find((u) => u.isAdmin);
  if (!owner || botAccount(store)) return null;
  const id = `${owner.id}-${botAccountSuffix}`;
  store.addAccount(
    {
      id,
      userId: owner.id,
      broker: "alpaca",
      mode: "paper",
      isDefault: false,
      credentials: {
        key: { env: botKeyVariable },
        secret: { env: botSecretVariable },
      },
      gatewayUrl: null,
      enabled: true,
    },
    now,
  );
  return id;
}
