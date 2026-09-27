import type { Evaluation } from "../../alerts/src/relative-volume.js";

export type Alert = Evaluation & { close?: number };

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

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Telegram HTML message for one alert. It shows the evaluator's own values;
// nothing is recomputed here.
export function formatAlert(alert: Alert, siteUrl?: string): string {
  const arrow =
    alert.direction === "up" ? "▲" : alert.direction === "down" ? "▼" : "•";
  const move = `${alert.move >= 0 ? "+" : ""}${alert.move.toFixed(2)}%`;
  const lines = [
    `<b>${escape(alert.ticker)}</b> ${arrow} ${move} in ${alert.config.window} min`,
    `${israelTime.format(new Date(alert.end))} Israel time · ${sessionName[alert.session]}`,
    `Volume ${shares.format(alert.actual)}` +
      (alert.ratio !== null ? ` · ${alert.ratio.toFixed(1)}× usual` : "") +
      (alert.paceRatio !== null
        ? ` · ${alert.paceRatio.toFixed(1)}× today's pace`
        : ""),
  ];
  if (alert.close !== undefined) lines.push(`Last ${alert.close}`);
  if (siteUrl) lines.push(escape(siteUrl));
  return lines.join("\n");
}

export type SendResult =
  | { ok: true }
  // `retryAfter` in seconds when Telegram asks to slow down.
  | { ok: false; retry: boolean; error: string; retryAfter?: number };

export interface Sender {
  send(html: string): Promise<SendResult>;
}

export class TelegramSender implements Sender {
  constructor(
    private token: string,
    private chatId: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async send(html: string): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: html,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch (error) {
      return {
        ok: false,
        retry: true,
        error: error instanceof Error ? error.message : "Network error",
      };
    }
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as {
      description?: string;
      parameters?: { retry_after?: number };
    };
    // Never echo the URL: it contains the bot token.
    const error = `Telegram ${response.status}: ${body.description ?? "error"}`;
    // 400/401/403/404 mean a wrong token or chat; retrying cannot help.
    const retry = response.status === 429 || response.status >= 500;
    return {
      ok: false,
      retry,
      error,
      retryAfter: body.parameters?.retry_after,
    };
  }
}
