import { TelegramSender } from "../../../packages/notifications/src/telegram.js";
import {
  AlpacaTrading,
  paperUrl,
} from "../../../packages/trading/src/alpaca-trading.js";
import type { Broker } from "../../../packages/trading/src/broker.js";
import { TradeEngine } from "../../../packages/trading/src/engine.js";
import {
  channelEvents,
  FanOutNotifier,
  type ChannelEvent,
  type Subscribed,
} from "../../../packages/trading/src/fan-out.js";
import {
  TelegramNotifier,
  type Notifier,
} from "../../../packages/trading/src/notifier.js";
import { resolveValidator } from "../../../packages/trading/src/validators.js";
import { readSecret, type SecretSource } from "./secrets.js";
import { RequestError, TraderService } from "./service.js";
import type { BrokerAccount, Channel, TradeStore, User } from "./store.js";

// Each trader's broker, channels, validator and service, built from the
// store (docs/features/multi-user-ibkr.md). One TraderService per user, on
// that user's default broker account.

export interface TradersOptions {
  store: TradeStore;
  secrets: SecretSource;
  // The global kill switch: false refuses every buy of every trader.
  enabled: boolean;
  optionsFeed?: "opra" | "indicative";
  log: (line: string) => void;
  // Tests replace the real brokers and senders.
  makeBroker?: (account: BrokerAccount) => Broker;
  makeNotifier?: (channel: Channel) => Notifier;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Trader {
  user: User;
  account: BrokerAccount;
  broker: Broker;
  engine: TradeEngine;
  service: TraderService;
}

export class Traders {
  private readonly built = new Map<string, Trader>();
  constructor(private readonly options: TradersOptions) {}

  private secret(value: unknown, name: string) {
    return readSecret(value, name, this.options.secrets);
  }

  broker(account: BrokerAccount): Broker {
    if (this.options.makeBroker) return this.options.makeBroker(account);
    // The live account needs the user's separate authorization and its own
    // switch (phase 5).
    if (account.mode !== "paper")
      throw new Error(`Account ${account.id}: only paper accounts can trade`);
    if (account.broker === "alpaca") {
      const c = account.credentials;
      return new AlpacaTrading(
        this.secret(c.key, "Alpaca key"),
        this.secret(c.secret, "Alpaca secret"),
        paperUrl,
        this.options.optionsFeed ?? "opra",
      );
    }
    throw new Error(
      `Account ${account.id}: ${account.broker} is not supported yet`,
    );
  }

  notifier(channel: Channel): Notifier {
    if (this.options.makeNotifier) return this.options.makeNotifier(channel);
    const c = channel.config;
    if (channel.provider === "telegram")
      return new TelegramNotifier(
        new TelegramSender(
          this.secret(c.botToken, "Telegram bot token"),
          this.secret(c.chatId, "Telegram chat"),
        ),
        // Comments need the bot in the channel's discussion group, and no
        // other process may read this bot's updates.
        { comments: flag(c.comments, this.options.secrets) },
      );
    throw new Error(
      `Channel ${channel.id}: ${channel.provider} is not supported yet`,
    );
  }

  private channels(userId: string): Notifier {
    const subscribed: Subscribed[] = [];
    for (const channel of this.options.store.channels(userId)) {
      if (!channel.enabled) continue;
      try {
        subscribed.push({
          name: `${channel.provider} ${channel.id}`,
          notifier: this.notifier(channel),
          events:
            channel.events === null
              ? null
              : channel.events.filter((e): e is ChannelEvent =>
                  (channelEvents as readonly string[]).includes(e),
                ),
        });
      } catch (error) {
        // One broken channel must not stop the others or the trading.
        this.options.log(
          `channel ${channel.id} skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return new FanOutNotifier(subscribed, this.options.log);
  }

  /** The trader for one enabled user, built on first use. */
  get(userId: string): Trader {
    const cached = this.built.get(userId);
    if (cached) return cached;
    const { store, log, now, sleep } = this.options;
    const clock = { ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) };
    const user = store.findUser(userId);
    if (!user || user.id !== userId || !user.enabled)
      throw new RequestError("This trader is not allowed", 403);
    const account = store
      .accounts(user.id)
      .find((a) => a.enabled && a.isDefault);
    if (!account)
      throw new RequestError("This trader has no broker account", 409);
    const broker = this.broker(account);
    const notifier = this.channels(user.id);
    const validator = resolveValidator(user.validatorId, user.validatorParams);
    const engine = new TradeEngine({
      broker,
      notifier,
      posts: store.posts(user.id),
      buys: store.buys(user.id),
      decisions: store.decisions(user.id),
      limits: validator.limits,
      riskRules: validator.riskRules,
      validate: validator.check,
      enabled: this.options.enabled,
      log,
      ...clock,
    });
    const service = new TraderService({
      userId: user.id,
      store,
      engine,
      broker,
      notifier,
      posts: store.posts(user.id),
      log,
      ...clock,
    });
    const trader = { user, account, broker, engine, service };
    this.built.set(user.id, trader);
    return trader;
  }

  /**
   * The trader a request is for. `caller` is the verified email or id the
   * site forwards; without one, the request is the owner's (the connector
   * has one person until per-person sign-in, phase 6).
   */
  forCaller(caller: string | undefined): Trader {
    const id = caller
      ? this.options.store.findUser(caller)?.id
      : this.options.store.users().find((u) => u.isAdmin && u.enabled)?.id;
    if (!id) throw new RequestError("This trader is not allowed", 403);
    return this.get(id);
  }

  /** Every enabled trader that can be built; the others are logged. */
  all(): Trader[] {
    const traders: Trader[] = [];
    for (const user of this.options.store.users()) {
      if (!user.enabled) continue;
      try {
        traders.push(this.get(user.id));
      } catch (error) {
        this.options.log(
          `trader ${user.id} not started: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return traders;
  }
}

/** A setting that is a boolean, or a reference to "true" in the environment. */
function flag(value: unknown, secrets: SecretSource): boolean {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "env" in value)
    return secrets.env[String((value as { env: unknown }).env)] === "true";
  return false;
}
