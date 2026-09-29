import type { AlertEvent } from "../../alerts/src/events.js";
import { alertLink } from "../../contracts/src/alert-link.js";

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
    `<b>${escape(alert.ticker)}</b> ${arrow} ${move} in ${alert.config.window} min`,
    `${israelTime.format(new Date(alert.end))} Israel time · ${sessionName[alert.session]}`,
    `Volume ${shares.format(alert.actual)}` +
      (alert.ratio !== null ? ` · ${alert.ratio.toFixed(1)}× usual` : "") +
      (alert.paceRatio !== null
        ? ` · ${alert.paceRatio.toFixed(1)}× today's pace`
        : ""),
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
  // Topic to post in, when the bot's private chat has topics enabled.
  threadId?: number;
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
}

export interface PhotoSender extends Sender {
  sendPhotos(photos: Photo[], options?: SendOptions): Promise<SendResult>;
}

type Call =
  | { ok: true; result: unknown }
  | { ok: false; retry: boolean; error: string; retryAfter?: number };

const topicsCacheMs = 10 * 60000;

export class TelegramSender implements PhotoSender {
  private topics: { value: boolean; at: number } | null = null;
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
        typeof value === "number" ? String(value) : JSON.stringify(value),
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
  // Whether the bot has topics enabled in private chats (BotFather), cached
  // for 10 minutes so switching it on is picked up without a restart.
  async topicsEnabled(): Promise<boolean> {
    if (this.topics && Date.now() - this.topics.at < topicsCacheMs)
      return this.topics.value;
    const me = await this.call("getMe", "{}", {
      "Content-Type": "application/json",
    });
    if (!me.ok) return this.topics?.value ?? false;
    const value =
      (me.result as { has_topics_enabled?: unknown }).has_topics_enabled ===
      true;
    this.topics = { value, at: Date.now() };
    return value;
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
  ): Promise<Call> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(30000),
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

// Where a message goes: a topic, a reply, or both.
const target = (options: SendOptions) => ({
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
