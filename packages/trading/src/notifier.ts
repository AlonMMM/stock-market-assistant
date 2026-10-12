import type {
  SendOptions,
  SendResult,
} from "../../notifications/src/telegram.js";
import type { ExitResult } from "./exit.js";
import type { LadderResult } from "./ladder.js";
import {
  formatEntry,
  formatExit,
  formatStopOut,
  type EntryNote,
  type StopFill,
} from "./message.js";

// The trade flow reports through this interface, so another channel is one
// more implementation. A failed notification never blocks or undoes an order.

export type Sent =
  // `ref` names the post, so a later exit can be attached to its entry.
  // `commentError` is set when the post went out but its comment did not.
  | { ok: true; ref?: string; commentError?: string }
  | { ok: false; error: string };

export interface Notifier {
  /** `entryRef` is the trade's first post, when this buy adds to it. */
  entry(
    note: EntryNote,
    result: LadderResult,
    entryRef?: string,
  ): Promise<Sent>;
  exit(
    note: { symbol: string; paper: boolean },
    result: ExitResult,
    entryRef?: string,
  ): Promise<Sent>;
  /** A stop order sold contracts: nobody asked for it, so it must be seen. */
  stopped(
    note: { symbol: string; paper: boolean },
    fill: StopFill,
    entryRef?: string,
  ): Promise<Sent>;
  /** Something worth knowing that is not a problem, such as a waiting order. */
  notice(title: string, lines: string[]): Promise<Sent>;
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
  async stopped() {
    return this.none;
  }
  async alert() {
    return this.none;
  }
  async notice() {
    return this.none;
  }
}

interface HtmlSender {
  send(html: string, options?: SendOptions): Promise<SendResult>;
  // A channel's discussion group and its copy of a post, for comments.
  discussion?(): Promise<string | null>;
  discussionCopy?(postId: number, timeoutMs?: number): Promise<number | null>;
}

/** A post's reference: its id, then "/" and its copy in the discussion group. */
function parseRef(ref: string | undefined) {
  const [post, copy] = (ref ?? "").split("/").map(Number);
  return {
    post: Number.isInteger(post) && post! > 0 ? post! : undefined,
    copy: Number.isInteger(copy) && copy! > 0 ? copy! : undefined,
  };
}

export interface TelegramNotifierOptions {
  // Also comment under the entry post, in the channel's discussion group.
  // The sender then reads the bot's updates, so only one process may do this
  // per bot, and the bot must be a member of that group.
  comments?: boolean;
  // How long an entry waits for the group's copy of its post.
  copyWaitMs?: number;
}

export class TelegramNotifier implements Notifier {
  private readonly comments: boolean;
  private readonly copyWaitMs: number;
  constructor(
    private readonly sender: HtmlSender,
    options: TelegramNotifierOptions = {},
  ) {
    this.comments = options.comments ?? false;
    this.copyWaitMs = options.copyWaitMs ?? 15000;
  }

  private async post(html: string, options?: SendOptions): Promise<Sent> {
    const sent = await this.sender.send(html, options);
    if (!sent.ok) return { ok: false, error: sent.error };
    return sent.messageId === undefined
      ? { ok: true }
      : { ok: true, ref: String(sent.messageId) };
  }

  /** The discussion group, when comments are on and the chat has one. */
  private async group(): Promise<string | null> {
    if (!this.comments || !this.sender.discussion) return null;
    return this.sender.discussion().catch(() => null);
  }

  async entry(note: EntryNote, result: LadderResult, entryRef?: string) {
    const first = parseRef(entryRef).post;
    // Listening for the group's copy starts before the post goes out.
    const group = first === undefined ? await this.group() : null;
    const sent = await this.post(
      formatEntry(note, result),
      first === undefined ? {} : { replyTo: first },
    );
    if (!sent.ok || !sent.ref || !group || !this.sender.discussionCopy)
      return sent;
    const copy = await this.sender
      .discussionCopy(Number(sent.ref), this.copyWaitMs)
      .catch(() => null);
    return copy === null ? sent : { ...sent, ref: `${sent.ref}/${copy}` };
  }

  exit(
    note: { symbol: string; paper: boolean },
    result: ExitResult,
    entryRef?: string,
  ) {
    const replyTo = parseRef(entryRef).post;
    return this.post(
      formatExit(note, result),
      replyTo === undefined ? {} : { replyTo },
    );
  }

  /**
   * Twice (user 2026-10-12): a reply to the entry post in the channel, which
   * quotes it and notifies like any new post, and a comment under the entry
   * post, so the trade's thread is complete.
   */
  async stopped(
    note: { symbol: string; paper: boolean },
    fill: StopFill,
    entryRef?: string,
  ): Promise<Sent> {
    const html = formatStopOut(note, fill);
    const ref = parseRef(entryRef);
    const sent = await this.post(
      html,
      ref.post === undefined ? {} : { replyTo: ref.post },
    );
    if (!sent.ok || ref.post === undefined) return sent;
    const group = await this.group();
    if (!group) return sent;
    const copy =
      ref.copy ??
      (await this.sender.discussionCopy?.(ref.post, 0).catch(() => null));
    if (!copy)
      return {
        ...sent,
        commentError: "the entry post's comment thread is not known",
      };
    const comment = await this.sender.send(html, {
      chatId: group,
      replyTo: copy,
    });
    return comment.ok ? sent : { ...sent, commentError: comment.error };
  }

  notice(title: string, lines: string[]) {
    return this.post(`🕒 <b>${title}</b>\n${lines.join("\n")}`);
  }

  alert(title: string, lines: string[]) {
    return this.post(`🚨 <b>${title}</b>\n${lines.join("\n")}`);
  }
}
