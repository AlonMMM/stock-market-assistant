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
// Which broker the bot trades at (user 2026-10-24: "connect the bot with my
// interactive brokers"): `ibkr` is the owner's IBKR paper account behind the
// Gateway (`IBKR_GATEWAY`, seed.ts); `alpaca`, the default, keeps the bot on
// its own Alpaca account, or the owner's default one without the key variables.
export const botBrokerVariable = "BOT_BROKER";

/** The account the bot trades: a named one, or the owner's default account. */
export type BotAccountChoice =
  | { kind: "ibkr"; account: BrokerAccount }
  | { kind: "own"; account: BrokerAccount }
  | { kind: "default" };

/**
 * Reads `BOT_BROKER`. Throws on a value that is not `alpaca` or `ibkr`, and on
 * `ibkr` without the owner's IBKR account, so a misconfigured bot never trades
 * the wrong account.
 */
export function chooseBotAccount(
  store: TradeStore,
  env: Env,
): BotAccountChoice {
  const named = env[botBrokerVariable] || "alpaca";
  if (named !== "alpaca" && named !== "ibkr")
    throw new Error(`${botBrokerVariable} must be alpaca or ibkr`);
  if (named === "ibkr") {
    const owner = store.users().find((u) => u.isAdmin);
    const account = owner
      ? store.accounts(owner.id).find((a) => a.broker === "ibkr" && a.enabled)
      : undefined;
    if (!account)
      throw new Error(
        `${botBrokerVariable}=ibkr needs the owner's IBKR account (set IBKR_GATEWAY)`,
      );
    return { kind: "ibkr", account };
  }
  const own = botAccount(store);
  return own ? { kind: "own", account: own } : { kind: "default" };
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
