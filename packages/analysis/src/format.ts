import type { AlertEvent } from "../../alerts/src/events.js";
import { alertLink } from "../../contracts/src/alert-link.js";
import type { Outbox } from "../../notifications/src/outbox.js";
import {
  escape,
  type PhotoSender,
  type SendOptions,
} from "../../notifications/src/telegram.js";
import type { AnalysisResult, Deliver } from "./pipeline.js";
import type { BenchmarkScore, Relation } from "./relative-strength.js";
import { technicalFacts } from "./technical-facts.js";

// The Telegram follow-up is one short message for a quick decision
// (user request 2026-09-30); the site shows the full analysis and charts.

const israelTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const relationShort: Record<Relation, string> = {
  against: "against",
  independent: "own move",
  with: "with",
  outperform: "outperforms",
};

const clip = (value: string, max = 110) =>
  escape(value.length > max ? `${value.slice(0, max - 1)}…` : value);
const first = (value: string) => value.split(/(?<=[.;])\s/)[0] ?? value;
const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

// Whether a score supports the alert's direction; null when it cannot say.
export function confirms(alert: AlertEvent, s: BenchmarkScore) {
  if (s.score === null || s.score === 50 || !alert.direction) return null;
  return s.score > 50 === (alert.direction === "up");
}

function strengthLine(alert: AlertEvent, scores: BenchmarkScore[]) {
  const parts = scores.map((s) =>
    s.score === null || !s.relation
      ? `vs ${escape(s.benchmark)} —`
      : `vs ${escape(s.benchmark)} <b>${s.score}</b> (${relationShort[s.relation]})`,
  );
  const verdicts = scores
    .map((s) => confirms(alert, s))
    .filter((v) => v !== null);
  if (verdicts.length) {
    const up = alert.direction === "up";
    parts.push(
      verdicts.every(Boolean)
        ? `✅ ${up ? "stronger" : "weaker"} than the index`
        : verdicts.some(Boolean)
          ? "⚠️ mixed vs the index"
          : `⚠️ ${up ? "weaker" : "stronger"} than the index`,
    );
  }
  return `📊 ${parts.join(" · ") || "no benchmark"}`;
}

/** The Telegram follow-up for one analysis: one short HTML message. */
export function formatAnalysis(
  alert: AlertEvent,
  result: AnalysisResult,
  siteUrl?: string,
): string {
  const arrow =
    alert.direction === "up" ? "▲" : alert.direction === "down" ? "▼" : "•";
  const move = `${alert.move >= 0 ? "+" : ""}${alert.move.toFixed(2)}%`;
  const lines = [
    `<b>${escape(alert.ticker)} ${arrow} ${move}</b> · ${israelTime.format(new Date(alert.end))} Israel time`,
    strengthLine(alert, result.scores),
  ];
  const t = result.technical;
  lines.push(
    t.ok
      ? `📈 <b>${cap(t.value.lean)}</b>: ${clip(t.value.brief ?? first(t.value.immediate))}`
      : "📈 Technical unavailable",
  );
  if (result.technicalSummary) {
    const f = technicalFacts(result.technicalSummary);
    const s = f.support[0];
    const r = f.resistance[0];
    if (s || r)
      lines.push(
        `    ${[
          s ? `Support ${s.level}` : null,
          r ? `Resistance ${r.level}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}`,
      );
  }
  const s = result.sentiment;
  lines.push(
    s.ok
      ? `💬 <b>${cap(s.value.sentiment)}</b> (${s.value.confidence}): ${clip(s.value.brief ?? first(s.value.summary))}`
      : "💬 Sentiment unavailable",
  );
  const n = result.news;
  lines.push(
    n.ok
      ? `📰 ${n.value.explains === "yes" || n.value.explains === "partly" ? `<b>${cap(n.value.explains)}</b>: ` : ""}${clip(n.value.brief ?? n.value.catalyst ?? first(n.value.summary))}`
      : "📰 News unavailable",
  );
  if (siteUrl)
    lines.push(
      `<a href="${escape(alertLink(siteUrl, alert))}">Full analysis and charts ›</a>`,
    );
  return lines.join("\n");
}

// Where the follow-up goes: for a channel, a comment on the alert's post (a
// reply to its copy in the discussion group); otherwise the alert's topic, or
// a reply to the alert's message.
async function placement(
  sender: PhotoSender,
  outbox: Pick<Outbox, "messageId" | "threadId">,
  alert: AlertEvent,
): Promise<SendOptions> {
  const post = outbox.messageId(alert.ticker, alert.end);
  const group = await sender.discussion?.();
  if (group) {
    const copy =
      post !== null && sender.discussionCopy
        ? await sender.discussionCopy(post)
        : null;
    if (copy === null)
      console.error(
        JSON.stringify({
          event: "analysis-comment-missing",
          ticker: alert.ticker,
          end: alert.end,
        }),
      );
    return { chatId: group, ...(copy === null ? {} : { replyTo: copy }) };
  }
  const threadId = outbox.threadId(alert.ticker, alert.end);
  return threadId !== null ? { threadId } : { replyTo: post ?? undefined };
}

export function telegramDelivery(
  sender: PhotoSender,
  outbox: Pick<Outbox, "muted" | "messageId" | "threadId">,
  siteUrl?: string,
): Deliver {
  return async (alert, result) => {
    if (outbox.muted()) return "muted";
    const where = await placement(sender, outbox, alert);
    const sent = await sender.send(
      formatAnalysis(alert, result, siteUrl),
      where,
    );
    if (sent.ok) return "sent";
    console.error(
      JSON.stringify({
        event: "analysis-delivery-failed",
        ticker: alert.ticker,
        end: alert.end,
        error: sent.error,
      }),
    );
    return "failed";
  };
}
