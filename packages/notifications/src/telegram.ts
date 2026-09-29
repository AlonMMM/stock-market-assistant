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
}

export interface Sender {
  send(html: string, options?: SendOptions): Promise<SendResult>;
}

export interface PhotoSender extends Sender {
  sendPhoto(
    png: Buffer,
    caption: string,
    options?: SendOptions,
  ): Promise<SendResult>;
}

export class TelegramSender implements PhotoSender {
  constructor(
    private token: string,
    private chatId: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  send(html: string, options: SendOptions = {}): Promise<SendResult> {
    return this.call(
      "sendMessage",
      JSON.stringify({
        chat_id: this.chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...reply(options),
      }),
      { "Content-Type": "application/json" },
    );
  }
  sendPhoto(
    png: Buffer,
    caption: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const form = new FormData();
    form.set("chat_id", this.chatId);
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
    const replyTo = reply(options).reply_parameters;
    if (replyTo) form.set("reply_parameters", JSON.stringify(replyTo));
    form.set(
      "photo",
      new Blob([new Uint8Array(png)], { type: "image/png" }),
      "chart.png",
    );
    return this.call("sendPhoto", form, {});
  }
  private async call(
    method: string,
    body: string | FormData,
    headers: Record<string, string>,
  ): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(20000),
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
      result?: { message_id?: unknown };
    };
    if (response.ok)
      return typeof result.result?.message_id === "number"
        ? { ok: true, messageId: result.result.message_id }
        : { ok: true };
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

const reply = (options: SendOptions) =>
  options.replyTo === undefined
    ? {}
    : {
        reply_parameters: {
          message_id: options.replyTo,
          allow_sending_without_reply: true,
        },
      };
