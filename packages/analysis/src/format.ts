import type { AlertEvent } from "../../alerts/src/events.js";
import { escape, type PhotoSender } from "../../notifications/src/telegram.js";
import type { Outbox } from "../../notifications/src/outbox.js";
import type { AnalysisResult, Deliver } from "./pipeline.js";
import type { BenchmarkScore, Relation } from "./relative-strength.js";

const israelTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const relationName: Record<Relation, string> = {
  against: "AGAINST the index",
  independent: "INDEPENDENT (index flat)",
  with: "WITH the index",
  outperform: "OUTPERFORMS the index",
};

const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const clip = (value: string, max = 300) =>
  escape(value.length > max ? `${value.slice(0, max - 1)}…` : value);

function scoreLine(ticker: string, alert: AlertEvent, s: BenchmarkScore) {
  if (!s.day || s.relation === null)
    return `vs ${escape(s.benchmark)}: not enough data`;
  const parts = [
    `vs ${escape(s.benchmark)}: <b>${relationName[s.relation]}</b>` +
      (s.score !== null ? ` · <b>${s.score}/100</b>` : ""),
    `${escape(ticker)} ${pct(s.day.stock)} vs ${escape(s.benchmark)} ${pct(s.day.benchmark)} today`,
    `excess ${s.day.excess >= 0 ? "+" : ""}${s.day.excess.toFixed(2)} pts (β ${s.beta.toFixed(2)}${s.betaAssumed ? " assumed" : ""})`,
  ];
  if (s.score !== null && s.score !== 50 && alert.direction) {
    const stronger = s.score > 50;
    const confirms = stronger === (alert.direction === "up");
    parts.push(
      `${stronger ? "stronger" : "weaker"} than ${escape(s.benchmark)}, ${confirms ? "confirms" : "against"} the alert`,
    );
  }
  return parts.join(" · ");
}

/** Telegram HTML follow-up for one analysis; shows stored values only. */
export function formatAnalysis(
  alert: AlertEvent,
  result: AnalysisResult,
): string {
  const arrow =
    alert.direction === "up" ? "▲" : alert.direction === "down" ? "▼" : "•";
  const lines = [
    `📊 <b>${escape(alert.ticker)}</b> ${arrow} analysis · alert ${israelTime.format(new Date(alert.end))} Israel time`,
    "",
    "<b>Relative strength</b>",
    ...(result.scores.length
      ? result.scores.map((s) => scoreLine(alert.ticker, alert, s))
      : ["No benchmark"]),
    "",
  ];
  const t = result.technical;
  if (t.ok) {
    lines.push(
      `<b>Technical</b> · ${t.value.lean}`,
      `Now: ${clip(t.value.immediate)}`,
      `Follow-through: ${clip(t.value.followThrough)}`,
    );
    const levels = [
      t.value.support !== null ? `support ${t.value.support}` : null,
      t.value.resistance !== null ? `resistance ${t.value.resistance}` : null,
    ].filter(Boolean);
    if (levels.length) lines.push(`Levels: ${levels.join(" · ")}`);
    if (t.value.caveat) lines.push(`<i>${clip(t.value.caveat, 200)}</i>`);
  } else lines.push(`<b>Technical</b> · unavailable (${escape(t.error)})`);
  lines.push("");
  const s = result.sentiment;
  lines.push(
    s.ok
      ? `<b>Sentiment</b> · ${s.value.sentiment} (${s.value.confidence} confidence)\n${clip(s.value.summary)}`
      : `<b>Sentiment</b> · unavailable (${escape(s.error)})`,
  );
  lines.push("");
  const n = result.news;
  if (n.ok) {
    const item = n.value.item;
    const minutes = item
      ? Math.floor((Date.parse(alert.end) - Date.parse(item.createdAt)) / 60000)
      : null;
    lines.push(
      `<b>News</b> · explains the move: ${n.value.explains}`,
      clip(n.value.catalyst ?? n.value.summary),
    );
    const url = item?.url ?? n.value.url;
    const source = item
      ? `${escape(item.source)}, ${minutes! < 120 ? `${minutes} min` : `${Math.round(minutes! / 60)} h`} before the alert`
      : null;
    if (source || url)
      lines.push(
        [source, url ? `<a href="${escape(url)}">source</a>` : null]
          .filter(Boolean)
          .join(" · "),
      );
  } else lines.push(`<b>News</b> · unavailable (${escape(n.error)})`);
  lines.push("", "<i>AI analysis, not investment advice.</i>");
  return lines.join("\n");
}

// Replies under the alert's own message when it was sent, then attaches the
// technical-scan level chart under the analysis.
export function telegramDelivery(
  sender: PhotoSender,
  outbox: Pick<Outbox, "muted" | "messageId">,
): Deliver {
  return async (alert, result, chart) => {
    if (outbox.muted()) return "muted";
    const replyTo = outbox.messageId(alert.ticker, alert.end) ?? undefined;
    const sent = await sender.send(formatAnalysis(alert, result), { replyTo });
    if (!sent.ok) {
      console.error(
        JSON.stringify({
          event: "analysis-delivery-failed",
          ticker: alert.ticker,
          end: alert.end,
          error: sent.error,
        }),
      );
      return "failed";
    }
    if (chart) {
      const photo = await sender.sendPhoto(
        chart,
        `${escape(alert.ticker)} · technical-scan levels`,
        { replyTo: sent.messageId },
      );
      if (!photo.ok)
        console.error(
          JSON.stringify({
            event: "analysis-chart-failed",
            ticker: alert.ticker,
            end: alert.end,
            error: photo.error,
          }),
        );
    }
    return "sent";
  };
}
