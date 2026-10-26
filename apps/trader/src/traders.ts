import { TelegramSender } from "../../../packages/notifications/src/telegram.js";
import {
  AlpacaTrading,
  paperUrl,
} from "../../../packages/trading/src/alpaca-trading.js";
import type { Broker } from "../../../packages/trading/src/broker.js";
import { TradeEngine } from "../../../packages/trading/src/engine.js";
import {
  IbkrTrading,
  type TwsClient,
} from "../../../packages/trading/src/ibkr-trading.js";
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
import { BotRoutedNotifier, botAccountIds } from "./bot-channel.js";
import { readSecret, type SecretSource } from "./secrets.js";
import { RequestError, TraderService } from "./service.js";
import type {
  BrokerAccount,
  BrokerName,
  Channel,
  TradeStore,
  User,
} from "./store.js";

// Each trader's broker, channels, validator and service, built from the
// store (docs/features/multi-user-ibkr.md). One TraderService per broker
// account. The records of a user's default account keep the user's id, as
// before; another account's are kept under "<user>/<account>".

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
  // The bots' own chat (bot-channel.ts): its notifier, and the tags of the
  // bots' orders. Without it every post goes to the owner's channels.
  bots?: { notifier: Notifier; tags: readonly string[] } | null;
  // The connection to an IB Gateway (main.ts: @stoqey/ib).
  makeTws?: (host: string, port: number) => TwsClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Trader {
  user: User;
  account: BrokerAccount;
  scope: string; // whose records: the user's id, or "<user>/<account>"
  notifier: Notifier;
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
    if (account.broker === "ibkr") {
      // The Gateway holds the login; the account only says where it is.
      const [host, port] = (account.gatewayUrl ?? "").split(":");
      if (!host || !port || !this.options.makeTws)
        throw new Error(`Account ${account.id}: no IB Gateway to connect to`);
      const store = this.options.store;
      return new IbkrTrading(this.options.makeTws(host, Number(port)), {
        paper: true,
        // The service's own record of the account's closes (equity-log.ts).
        history: async () => store.equityDays(account.id),
      });
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

  /**
   * The trader of one enabled user on one broker: the default account, or
   * the user's account at `broker`. Built on first use.
   */
  get(userId: string, broker?: BrokerName): Trader {
    const user = this.user(userId);
    const accounts = this.options.store
      .accounts(user.id)
      .filter((a) => a.enabled);
    // Naming the broker still means the default account when it is at that
    // broker; a second account there (the bot's) is reached by id only.
    const matching = broker
      ? accounts.filter((a) => a.broker === broker)
      : accounts;
    const account =
      matching.find((a) => a.isDefault) ?? (broker ? matching[0] : undefined);
    if (!account)
      throw new RequestError(
        broker
          ? `This trader has no ${broker} account`
          : "This trader has no broker account",
        409,
      );
    return this.build(user, account);
  }

  /** The trader of one account, by its id (the bot's own account). */
  forAccount(accountId: string): Trader {
    for (const user of this.options.store.users()) {
      const account = this.options.store
        .accounts(user.id)
        .find((a) => a.id === accountId);
      if (account) {
        if (!account.enabled || !user.enabled)
          throw new RequestError("This account is switched off", 409);
        return this.build(this.user(user.id), account);
      }
    }
    throw new RequestError(`No account "${accountId}"`, 409);
  }

  private user(userId: string): User {
    const user = this.options.store.findUser(userId);
    if (!user || user.id !== userId || !user.enabled)
      throw new RequestError("This trader is not allowed", 403);
    return user;
  }

  private build(user: User, account: BrokerAccount): Trader {
    const { store, log, now, sleep } = this.options;
    const cached = this.built.get(account.id);
    if (cached) return cached;
    const scope = account.isDefault ? user.id : `${user.id}/${account.id}`;
    const clock = { ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) };
    const built = this.broker(account);
    const owned = this.channels(user.id);
    const bots = this.options.bots;
    const notifier = bots
      ? new BotRoutedNotifier(
          owned,
          bots.notifier,
          botAccountIds(user.id).includes(account.id),
          bots.tags,
        )
      : owned;
    const validator = resolveValidator(user.validatorId, user.validatorParams);
    const engine = new TradeEngine({
      broker: built,
      notifier,
      posts: store.posts(scope),
      buys: store.buys(scope),
      decisions: store.decisions(scope),
      limits: validator.limits,
      riskRules: validator.riskRules,
      validate: validator.check,
      enabled: this.options.enabled,
      log,
      ...clock,
    });
    const service = new TraderService({
      userId: scope,
      store,
      engine,
      broker: built,
      notifier,
      posts: store.posts(scope),
      log,
      ...clock,
    });
    const trader = {
      user,
      account,
      scope,
      notifier,
      broker: built,
      engine,
      service,
    };
    this.built.set(account.id, trader);
    return trader;
  }

  /**
   * The trader a request is for. `caller` is the verified email or id the
   * site forwards; without one, the request is the owner's (the connector
   * has one person until per-person sign-in, phase 6).
   */
  forCaller(caller: string | undefined, broker?: BrokerName): Trader {
    const id = caller
      ? this.options.store.findUser(caller)?.id
      : this.options.store.users().find((u) => u.isAdmin && u.enabled)?.id;
    if (!id) throw new RequestError("This trader is not allowed", 403);
    return this.get(id, broker);
  }

  /** Every enabled account that can be built; the others are logged. */
  all(): Trader[] {
    const traders: Trader[] = [];
    for (const user of this.options.store.users()) {
      if (!user.enabled) continue;
      for (const account of this.options.store.accounts(user.id)) {
        if (!account.enabled) continue;
        try {
          traders.push(this.build(user, account));
        } catch (error) {
          this.options.log(
            `${user.id}'s ${account.broker} account not started: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
