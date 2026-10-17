import type { TradeStore } from "./store.js";

// The first start with the users table empty: the single trader of before
// becomes the owner, with the same Alpaca paper keys and Telegram channel,
// read from the same environment variables. Nothing changes for the owner,
// and no new secret is needed (docs/features/multi-user-ibkr.md).

type Env = Record<string, string | undefined>;

const firstSet = (env: Env, ...names: string[]) => names.find((n) => env[n]);

/** Adds the owner when there is no user yet; returns the owner's id or null. */
export function seedOwner(store: TradeStore, env: Env, now: number) {
  if (store.users().length > 0) return null;
  const key = firstSet(env, "ALPACA_API_KEY", "APCA_API_KEY_ID");
  const secret = firstSet(env, "ALPACA_API_SECRET", "APCA_API_SECRET_KEY");
  if (!key || !secret)
    throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET");
  const id = env.TRADER_USER || "owner";
  store.addUser(
    {
      id,
      email: env.TRADER_OWNER_EMAIL || null,
      name: "Owner",
      enabled: true,
      isAdmin: true,
      validatorId: "owner-v1",
      validatorParams: null,
    },
    now,
  );
  store.addAccount(
    {
      id: `${id}-alpaca`,
      userId: id,
      broker: "alpaca",
      mode: "paper",
      isDefault: true,
      credentials: { key: { env: key }, secret: { env: secret } },
      gatewayUrl: null,
      enabled: true,
    },
    now,
  );
  if (env.TRADES_TELEGRAM_BOT_TOKEN && env.TRADES_TELEGRAM_CHAT_ID)
    store.addChannel(
      {
        id: `${id}-telegram`,
        userId: id,
        provider: "telegram",
        config: {
          botToken: { env: "TRADES_TELEGRAM_BOT_TOKEN" },
          chatId: { env: "TRADES_TELEGRAM_CHAT_ID" },
          comments: { env: "TRADES_TELEGRAM_COMMENTS" },
        },
        events: null,
        enabled: true,
      },
      now,
    );
  return id;
}
