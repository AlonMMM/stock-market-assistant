import type {
  SendOptions,
  SendResult,
} from "../../notifications/src/telegram.js";
import type { ExitResult } from "./exit.js";
import type { LadderResult } from "./ladder.js";
import { formatEntry, formatExit, type EntryNote } from "./message.js";

// The trade flow reports through this interface, so another channel is one
// more implementation. A failed notification never blocks or undoes an order.

export type Sent =
  // `ref` names the post, so a later exit can be attached to its entry.
  { ok: true; ref?: string } | { ok: false; error: string };

export interface Notifier {
  entry(note: EntryNote, result: LadderResult): Promise<Sent>;
  exit(
    note: { symbol: string; paper: boolean },
    result: ExitResult,
    entryRef?: string,
  ): Promise<Sent>;
  /** Something the user must see at once, such as a short option position. */
  alert(title: string, lines: string[]): Promise<Sent>;
}

/** No channel is configured: nothing is sent, and the caller is told so. */
export class NoNotifier implements Notifier {
  private readonly none: Sent = {
    ok: false,
    error: "No notification channel is configured",
  };
  async entry() {
    return this.none;
  }
  async exit() {
    return this.none;
  }
  async alert() {
    return this.none;
  }
}

interface HtmlSender {
  send(html: string, options?: SendOptions): Promise<SendResult>;
}

export class TelegramNotifier implements Notifier {
  constructor(private readonly sender: HtmlSender) {}

  private async post(html: string, options?: SendOptions): Promise<Sent> {
    const sent = await this.sender.send(html, options);
    if (!sent.ok) return { ok: false, error: sent.error };
    return sent.messageId === undefined
      ? { ok: true }
      : { ok: true, ref: String(sent.messageId) };
  }

  entry(note: EntryNote, result: LadderResult) {
    return this.post(formatEntry(note, result));
  }

  exit(
    note: { symbol: string; paper: boolean },
    result: ExitResult,
    entryRef?: string,
  ) {
    const replyTo = Number(entryRef);
    return this.post(
      formatExit(note, result),
      entryRef !== undefined && Number.isInteger(replyTo) ? { replyTo } : {},
    );
  }

  alert(title: string, lines: string[]) {
    return this.post(`🚨 <b>${title}</b>\n${lines.join("\n")}`);
  }
}
