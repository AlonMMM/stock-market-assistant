import type { AlertEvent } from "../../alerts/src/events.js";
import { alertLink } from "../../contracts/src/alert-link.js";
import { vsSpyText } from "../../contracts/src/vs-spy.js";

export type Alert = AlertEvent;

const israelTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const shares = new Intl.NumberFormat("en-US");
const sessionName = {
  pre: "pre-market",
  regular: "regular",
  post: "after-hours",
};

export const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Telegram HTML message for one alert. It shows the evaluator's own values;
// nothing is recomputed here. `resent` labels a manual repeat of an old alert.
export function formatAlert(
  alert: Alert,
  siteUrl?: string,
  resent = false,
): string {
  const arrow =
    alert.direction === "up" ? "▲" : alert.direction === "down" ? "▼" : "•";
  const move = `${alert.move >= 0 ? "+" : ""}${alert.move.toFixed(2)}%`;
  const lines = [
    ...(alert.synthetic ? ["🧪 <b>SYNTHETIC</b> · not a market alert"] : []),
    ...(resent
      ? ["🔁 <b>RE-SENT</b> · earlier alert, sent again for a test"]
      : []),
    // The alert says "look now": a big move is likely, in either direction
    // (study 2026-10-03); the arrow is the burst that just happened.
    `${alert.inPlay ? "⭐ " : ""}<b>${escape(alert.ticker)}</b> · big move likely`,
    // Score vs SPY at alert time (docs/features/alert-vs-spy.md); "vs SPY —"
    // without one. Evidence such as a lagged SPY bar is not shown here.
    escape(vsSpyText(alert.direction, alert.vsSpy)),
    `Burst ${arrow} ${move} in ${alert.config.window} min · ${israelTime.format(new Date(alert.end))} Israel time · ${sessionName[alert.session]}`,
    `Volume ${shares.format(alert.actual)}` +
      (alert.ratio !== null ? ` · ${alert.ratio.toFixed(1)}× usual` : "") +
      (alert.paceRatio !== null
        ? ` · ${alert.paceRatio.toFixed(1)}× today's pace`
        : ""),
    ...(alert.dayRvol !== null && alert.dayRvol !== undefined
      ? [
          `Day volume ${alert.dayRvol.toFixed(1)}× usual${alert.inPlay ? " · in play" : ""}`,
        ]
      : []),
  ];
  if (alert.close !== undefined) lines.push(`Last ${alert.close}`);
  if (siteUrl)
    lines.push(
      `<a href="${escape(alertLink(siteUrl, alert))}">Open in site</a>`,
    );
  return lines.join("\n");
}

export type SendResult =
  | { ok: true; messageId?: number }
  // `retryAfter` in seconds when Telegram asks to slow down.
  | { ok: false; retry: boolean; error: string; retryAfter?: number };

export interface SendOptions {
  // Telegram message to reply to; sent standalone if it is gone.
  replyTo?: number;
  // Topic to post in, when the chat has topics.
  threadId?: number;
  // Another chat than the configured one (a channel's discussion group).
  chatId?: string;
}

export interface Photo {
  png: Buffer;
  caption?: string; // HTML
}

export interface Sender {
  send(html: string, options?: SendOptions): Promise<SendResult>;
  // Optional topic support; senders without it post in the main chat.
  topicsEnabled?(): Promise<boolean>;
  createTopic?(name: string): Promise<number | null>;
  // A channel's linked discussion group, where comments on its posts live.
  discussion?(): Promise<string | null>;
  // The discussion group's copy of a channel post (null after the timeout).
  discussionCopy?(postId: number, timeoutMs?: number): Promise<number | null>;
}

interface ChatInfo {
  type: string;
  isForum: boolean;
  linkedChatId: string | null;
}

export interface PhotoSender extends Sender {
  sendPhotos(photos: Photo[], options?: SendOptions): Promise<SendResult>;
}

type Call =
  | { ok: true; result: unknown }
  | { ok: false; retry: boolean; error: string; retryAfter?: number };

const cacheMs = 10 * 60000;

export class TelegramSender implements PhotoSender {
  private topics: { value: boolean; at: number } | null = null;
  private info: { value: ChatInfo; at: number } | null = null;
  // Channel post id → its automatic copy in the discussion group.
  private copies = new Map<number, number>();
  private tracking = false;
  private stopped = false;
  constructor(
    private token: string,
    private chatId: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  send(html: string, options: SendOptions = {}): Promise<SendResult> {
    return this.message(
      "sendMessage",
      JSON.stringify({
        chat_id: this.chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...target(options),
      }),
      { "Content-Type": "application/json" },
    );
  }
  // One photo, or an album of 2–10 (sendMediaGroup); messageId is the first.
  sendPhotos(photos: Photo[], options: SendOptions = {}): Promise<SendResult> {
    const form = new FormData();
    form.set("chat_id", this.chatId);
    for (const [key, value] of Object.entries(target(options)))
      form.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    const file = (png: Buffer) =>
      new Blob([new Uint8Array(png)], { type: "image/png" });
    const caption = (photo: Photo) =>
      photo.caption ? { caption: photo.caption, parse_mode: "HTML" } : {};
    const album = photos.slice(0, 10);
    if (album.length === 1) {
      form.set("photo", file(album[0]!.png), "chart.png");
      for (const [key, value] of Object.entries(caption(album[0]!)))
        form.set(key, value);
      return this.message("sendPhoto", form, {});
    }
    album.forEach((photo, i) =>
      form.set(`photo${i}`, file(photo.png), `chart${i}.png`),
    );
    form.set(
      "media",
      JSON.stringify(
        album.map((photo, i) => ({
          type: "photo",
          media: `attach://photo${i}`,
          ...caption(photo),
        })),
      ),
    );
    return this.message("sendMediaGroup", form, {});
  }
  // Whether new alerts can open a topic: a private chat needs the bot's
  // threaded mode (BotFather), a supergroup needs topics on. Cached 10 minutes
  // so switching either on is picked up without a restart.
  async topicsEnabled(): Promise<boolean> {
    if (this.topics && Date.now() - this.topics.at < cacheMs)
      return this.topics.value;
    const chat = await this.chat();
    let value = false;
    if (chat?.type === "supergroup") value = chat.isForum;
    else if (chat?.type === "private") {
      const me = await this.call("getMe", "{}", {
        "Content-Type": "application/json",
      });
      if (!me.ok) return this.topics?.value ?? false;
      value =
        (me.result as { has_topics_enabled?: unknown }).has_topics_enabled ===
        true;
    } else if (!chat) return this.topics?.value ?? false;
    this.topics = { value, at: Date.now() };
    return value;
  }
  // Also starts tracking the group's copies of posts on first use; unread
  // updates wait up to 24 hours, so a post sent before that is still found.
  async discussion(): Promise<string | null> {
    const chat = await this.chat();
    const group = chat?.type === "channel" ? chat.linkedChatId : null;
    if (group) void this.trackDiscussion();
    return group;
  }
  private async chat(): Promise<ChatInfo | null> {
    if (this.info && Date.now() - this.info.at < cacheMs)
      return this.info.value;
    const got = await this.call(
      "getChat",
      JSON.stringify({ chat_id: this.chatId }),
      { "Content-Type": "application/json" },
    );
    if (!got.ok) return this.info?.value ?? null;
    const r = got.result as {
      type?: unknown;
      is_forum?: unknown;
      linked_chat_id?: unknown;
    };
    const value = {
      type: typeof r.type === "string" ? r.type : "unknown",
      isForum: r.is_forum === true,
      linkedChatId:
        typeof r.linked_chat_id === "number" ? String(r.linked_chat_id) : null,
    };
    this.info = { value, at: Date.now() };
    return value;
  }
  // Long-polls getUpdates while the chat is a channel with a discussion
  // group, recording each post's automatic copy there. The collector reads no
  // other updates. Runs until stop(); started by discussion().
  async trackDiscussion(): Promise<void> {
    if (this.tracking) return;
    this.tracking = true;
    let offset = 0;
    let failures = 0;
    while (!this.stopped) {
      const group = await this.discussion().catch(() => null);
      if (!group) {
        await pause(60000, () => this.stopped);
        continue;
      }
      const started = Date.now();
      const got = await this.call(
        "getUpdates",
        JSON.stringify({
          offset,
          timeout: 25,
          allowed_updates: ["message"],
        }),
        { "Content-Type": "application/json" },
        35000,
      );
      if (!got.ok) {
        failures++;
        if (failures === 1 || failures % 20 === 0)
          console.error(
            JSON.stringify({
              event: "telegram-updates-failed",
              error: got.error,
            }),
          );
        await pause(Math.min(60000, 2000 * failures), () => this.stopped);
        continue;
      }
      failures = 0;
      for (const update of Array.isArray(got.result) ? got.result : []) {
        const u = update as { update_id?: unknown; message?: unknown };
        if (typeof u.update_id === "number") offset = u.update_id + 1;
        const copy = automaticCopy(u.message, group);
        if (copy) this.copies.set(copy.postId, copy.messageId);
      }
      // Keep the latest few hundred posts.
      for (const key of this.copies.keys())
        if (this.copies.size > 500) this.copies.delete(key);
      // At least a second per round, even if Telegram answers at once.
      await pause(1000 - (Date.now() - started), () => this.stopped);
    }
    this.tracking = false;
  }
  async discussionCopy(
    postId: number,
    timeoutMs = 60000,
  ): Promise<number | null> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const copy = this.copies.get(postId);
      if (copy !== undefined) return copy;
      if (Date.now() >= until || this.stopped) return null;
      await pause(1000, () => this.stopped);
    }
  }
  stop() {
    this.stopped = true;
  }
  async createTopic(name: string): Promise<number | null> {
    const topic = await this.call(
      "createForumTopic",
      JSON.stringify({ chat_id: this.chatId, name: name.slice(0, 128) }),
      { "Content-Type": "application/json" },
    );
    const id = topic.ok
      ? (topic.result as { message_thread_id?: unknown }).message_thread_id
      : undefined;
    if (typeof id === "number") return id;
    console.error(
      JSON.stringify({
        event: "telegram-topic-failed",
        error: topic.ok ? "No topic id" : topic.error,
      }),
    );
    return null;
  }
  private async message(
    method: string,
    body: string | FormData,
    headers: Record<string, string>,
  ): Promise<SendResult> {
    const sent = await this.call(method, body, headers);
    if (!sent.ok) return sent;
    const first = Array.isArray(sent.result) ? sent.result[0] : sent.result;
    const id = (first as { message_id?: unknown } | undefined)?.message_id;
    return typeof id === "number" ? { ok: true, messageId: id } : { ok: true };
  }
  private async call(
    method: string,
    body: string | FormData,
    headers: Record<string, string>,
    timeoutMs = 30000,
  ): Promise<Call> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      return {
        ok: false,
        retry: true,
        error: error instanceof Error ? error.message : "Network error",
      };
    }
    const result = (await response.json().catch(() => ({}))) as {
      description?: string;
      parameters?: { retry_after?: number };
      result?: unknown;
    };
    if (response.ok) return { ok: true, result: result.result };
    // Never echo the URL: it contains the bot token.
    const error = `Telegram ${response.status}: ${result.description ?? "error"}`;
    // 400/401/403/404 mean a wrong token or chat; retrying cannot help.
    const retry = response.status === 429 || response.status >= 500;
    return {
      ok: false,
      retry,
      error,
      retryAfter: result.parameters?.retry_after,
    };
  }
}

// Waits up to `ms`, checking `stop` every second.
async function pause(ms: number, stop: () => boolean) {
  for (let left = ms; left > 0 && !stop(); left -= 1000)
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, left)));
}

// A channel post as automatically forwarded into its discussion group.
export function automaticCopy(
  message: unknown,
  group: string,
): { postId: number; messageId: number } | null {
  const m = message as {
    message_id?: unknown;
    is_automatic_forward?: unknown;
    chat?: { id?: unknown };
    forward_origin?: { type?: unknown; message_id?: unknown };
  } | null;
  if (
    !m ||
    m.is_automatic_forward !== true ||
    String(m.chat?.id) !== group ||
    m.forward_origin?.type !== "channel" ||
    typeof m.forward_origin.message_id !== "number" ||
    typeof m.message_id !== "number"
  )
    return null;
  return { postId: m.forward_origin.message_id, messageId: m.message_id };
}

// Where a message goes: another chat, a topic, a reply.
const target = (options: SendOptions) => ({
  ...(options.chatId === undefined ? {} : { chat_id: options.chatId }),
  ...(options.threadId === undefined
    ? {}
    : { message_thread_id: options.threadId }),
  ...(options.replyTo === undefined
    ? {}
    : {
        reply_parameters: {
          message_id: options.replyTo,
          allow_sending_without_reply: true,
        },
      }),
});
