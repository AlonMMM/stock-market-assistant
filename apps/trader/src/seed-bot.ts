import {
  botBrokerChoices,
  type BotBroker,
  type BotBrokerChoice,
} from "../../../packages/trading/src/bot/settings.js";
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
// Where the bot's new entries go until the owner saves a choice on the Bot
// settings page (user 2026-10-24: "connect the bot with my interactive
// brokers", then "configurable in the bot settings"): `ibkr` is the owner's
// IBKR paper account behind the Gateway (`IBKR_GATEWAY`, seed.ts); `alpaca`,
// the default, is the bot's own Alpaca account, or the owner's default one
// without the key variables.
export const botBrokerVariable = "BOT_BROKER";

/** The start-up default for new entries; throws on any other value. */
export function botBrokerFromEnv(env: Env): BotBrokerChoice {
  const named = env[botBrokerVariable] || "alpaca";
  if (!(botBrokerChoices as readonly string[]).includes(named))
    throw new Error(`${botBrokerVariable} must be alpaca, ibkr or both`);
  return named as BotBrokerChoice;
}

/** The owner's account the bot trades at `broker`, or null when there is none. */
export function botAccountFor(
  store: TradeStore,
  broker: BotBroker,
): BrokerAccount | null {
  const owner = store.users().find((u) => u.isAdmin);
  if (!owner) return null;
  const accounts = store.accounts(owner.id).filter((a) => a.enabled);
  if (broker === "ibkr")
    return accounts.find((a) => a.broker === "ibkr") ?? null;
  const own = botAccount(store);
  if (own && own.enabled) return own;
  return accounts.find((a) => a.broker === "alpaca" && a.isDefault) ?? null;
}

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
