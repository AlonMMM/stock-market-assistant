import type { Notifier, Sent } from "../../../packages/trading/src/notifier.js";
import type {
  EntryNote,
  ExitNote,
  StopFill,
} from "../../../packages/trading/src/message.js";
import type { ExitResult } from "../../../packages/trading/src/exit.js";
import type { LadderResult } from "../../../packages/trading/src/ladder.js";
import { strangleAccountSuffix } from "./seed-bot.js";

// The Alert leg bot's own Telegram chat (user 2026-10-26: "the leg bot should
// use the chat of the volume [alerts]; the other bot should not be touched"):
// tradisiomos_bot in "Trade ideas". Its buys, sales, stop fills and notices go
// there; the Indi bot's and the owner's posts stay on the owner's channel. An
// urgent alert (a short option position) always goes to the owner's channel.

/** The accounts only the volume bot (Alert leg) trades: everything they post is its. */
export const botAccountIds = (userId: string) => [
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
