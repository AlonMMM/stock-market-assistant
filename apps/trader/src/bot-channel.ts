import type { Notifier, Sent } from "../../../packages/trading/src/notifier.js";
import type {
  EntryNote,
  ExitNote,
  StopFill,
} from "../../../packages/trading/src/message.js";
import type { ExitResult } from "../../../packages/trading/src/exit.js";
import type { LadderResult } from "../../../packages/trading/src/ladder.js";
import { botAccountSuffix, strangleAccountSuffix } from "./seed-bot.js";

// The bots' own Telegram chat (user 2026-10-26: the Tradisimo chat through
// tradisiomos_bot). The bots' buys, sales, stop fills and notices go there;
// the owner's own trades stay on the owner's channel. An urgent alert (a short
// option position) always goes to the owner's channel, whoever caused it.

/** The accounts only a bot trades: everything they post is the bots'. */
export const botAccountIds = (userId: string) => [
  `${userId}-${botAccountSuffix}`,
  `${userId}-${strangleAccountSuffix}`,
];

export class BotRoutedNotifier implements Notifier {
  constructor(
    private readonly owner: Notifier,
    private readonly bots: Notifier,
    // A bot-only account; else a shared one, where the order's tag decides.
    private readonly botAccount: boolean,
    private readonly botTags: readonly string[],
  ) {}

  private by(tag: string | undefined): Notifier {
    if (this.botAccount) return this.bots;
    const tagged = tag !== undefined && this.botTags.includes(tag);
    return tagged ? this.bots : this.owner;
  }

  private account(): Notifier {
    return this.botAccount ? this.bots : this.owner;
  }

  entry(
    note: EntryNote,
    result: LadderResult,
    entryRef?: string,
  ): Promise<Sent> {
    return this.by(note.tag).entry(note, result, entryRef);
  }

  exit(note: ExitNote, result: ExitResult, entryRef?: string): Promise<Sent> {
    return this.by(note.tag).exit(note, result, entryRef);
  }

  stopped(
    note: { symbol: string; paper: boolean },
    fill: StopFill,
    entryRef?: string,
  ): Promise<Sent> {
    return this.account().stopped(note, fill, entryRef);
  }

  notice(title: string, lines: string[]): Promise<Sent> {
    return this.account().notice(title, lines);
  }

  alert(title: string, lines: string[]): Promise<Sent> {
    return this.owner.alert(title, lines);
  }
}
