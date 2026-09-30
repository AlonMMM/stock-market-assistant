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
import {
  chartTitles,
  regimeShiftThreshold,
  technicalFacts,
  type Zone,
} from "./technical-facts.js";

const israelTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const clock = (iso: string) => israelTime.format(new Date(iso));

export const relationName: Record<Relation, string> = {
  against: "AGAINST the index",
  independent: "INDEPENDENT (index flat)",
  with: "WITH the index",
  outperform: "OUTPERFORMS the index",
};

const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const pp = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)} pts`;
const clip = (value: string, max = 400) =>
  escape(value.length > max ? `${value.slice(0, max - 1)}…` : value);

// Whether a score supports the alert's direction; null when it cannot say.
export function confirms(alert: AlertEvent, s: BenchmarkScore) {
  if (s.score === null || s.score === 50 || !alert.direction) return null;
  return s.score > 50 === (alert.direction === "up");
}

function scoreLine(alert: AlertEvent, s: BenchmarkScore) {
  const b = escape(s.benchmark);
  if (!s.day || s.relation === null) return `vs ${b}: not enough data`;
  const verdict = confirms(alert, s);
  return [
    `vs ${b}: <b>${relationName[s.relation]}</b>` +
      (s.score !== null ? ` · <b>${s.score}/100</b>` : ""),
    `  today ${escape(alert.ticker)} ${pct(s.day.stock)} vs ${b} ${pct(s.day.benchmark)} · excess ${pp(s.day.excess)} (β ${s.beta.toFixed(2)}${s.betaAssumed ? " assumed" : ""})`,
    ...(s.window
      ? [
          `  alert window ${escape(alert.ticker)} ${pct(s.window.stock)} vs ${b} ${pct(s.window.benchmark)}`,
        ]
      : []),
    ...(verdict === null
      ? []
      : [
          `  ${s.score! > 50 ? "stronger" : "weaker"} than ${b}, ${verdict ? "confirms" : "against"} the alert`,
        ]),
  ].join("\n");
}

const zone = (z: Zone) =>
  `${z.level} (${pct(z.distancePct)}) ${escape(z.labels.join("/"))}`;

function technicalMessage(alert: AlertEvent, result: AnalysisResult) {
  const t = result.technical;
  const lines = [`📈 <b>Technical</b> · ${escape(alert.ticker)}`];
  if (t.ok) {
    lines.push(
      `<b>Bottom line: ${t.value.lean}</b>`,
      `Now: ${clip(t.value.immediate)}`,
      `Follow-through: ${clip(t.value.followThrough)}`,
      ...t.value.drivers.map((d) => `• ${clip(d, 300)}`),
    );
    if (t.value.caveat) lines.push(`<i>${clip(t.value.caveat, 250)}</i>`);
  } else lines.push(`Bottom line unavailable (${escape(t.error)})`);
  if (!result.technicalSummary) return lines.join("\n");
  const f = technicalFacts(result.technicalSummary);
  lines.push("");
  if (f.spot !== null)
    lines.push(
      `Spot ${f.spot}` +
        (f.vwap !== null
          ? ` · VWAP ${f.vwap} (${f.spot >= f.vwap ? "above" : "below"})`
          : ""),
    );
  if (f.pivots)
    lines.push(
      `Pivots PP ${f.pivots.pp} · R1 ${f.pivots.r1} · R2 ${f.pivots.r2} · S1 ${f.pivots.s1} · S2 ${f.pivots.s2}`,
    );
  if (f.volumeProfile)
    lines.push(
      `Volume profile POC ${f.volumeProfile.poc} · VAH ${f.volumeProfile.vah} · VAL ${f.volumeProfile.val}`,
    );
  if (f.priorWeek)
    lines.push(`Prior week ${f.priorWeek.low}–${f.priorWeek.high}`);
  if (f.swings.length)
    lines.push(
      `Swing levels ${f.swings
        .slice(0, 4)
        .map((s) => `${s.level} (${s.strength}×)`)
        .join(" · ")}`,
    );
  if (f.benchmark && f.beta60 !== null) {
    const shift =
      f.regimeShift !== null && Math.abs(f.regimeShift) > regimeShiftThreshold;
    lines.push(
      `β vs ${escape(f.benchmark)}: 60d ${f.beta60}` +
        (f.correlation60 !== null ? ` (corr ${f.correlation60})` : "") +
        (f.beta20 !== null ? ` · 20d ${f.beta20}` : "") +
        (shift ? " · <b>beta regime shift</b>" : ""),
    );
  }
  if (f.alphaNowPp !== null)
    lines.push(
      `Alpha now ${pp(f.alphaNowPp)}` +
        (f.alphaPositivePct !== null
          ? ` · positive ${f.alphaPositivePct}% of the session`
          : ""),
    );
  if (f.quadrant)
    lines.push(
      `RS quadrant <b>${escape(f.quadrant)}</b>` +
        (f.rsRatio !== null && f.rsMomentum !== null
          ? ` (ratio ${f.rsRatio}, momentum ${f.rsMomentum})`
          : "") +
        (f.rsNewHigh ? " · RS line at a new high" : ""),
    );
  for (const d of f.divergences.slice(-3))
    lines.push(
      `${d.kind === "against" ? "Moved against" : "Held through"} the tape ${clock(d.start)}–${clock(d.end)}: stock ${pp(d.stockPp)}, benchmark ${pp(d.benchmarkPp)}`,
    );
  if (f.resistance.length)
    lines.push(`Resistance ${f.resistance.slice(0, 3).map(zone).join(" · ")}`);
  if (f.support.length)
    lines.push(`Support ${f.support.slice(0, 3).map(zone).join(" · ")}`);
  lines.push(
    "<i>Options open interest not included. RS quadrant is an open reconstruction, not the licensed RRG.</i>",
  );
  return lines.join("\n");
}

/** Telegram HTML messages for one analysis, in order; charts go after the technical one. */
export function formatAnalysis(
  alert: AlertEvent,
  result: AnalysisResult,
  siteUrl?: string,
): { scores: string; technical: string; sentiment: string; news: string } {
  const link = siteUrl
    ? `\n<a href="${escape(alertLink(siteUrl, alert))}">Full analysis on the site</a>`
    : "";
  const scores = [
    `📊 <b>Relative strength</b> · ${escape(alert.ticker)} · alert ${clock(alert.end)} Israel time`,
    ...(result.scores.length
      ? result.scores.map((s) => scoreLine(alert, s))
      : ["No benchmark"]),
  ].join("\n");
  const s = result.sentiment;
  const sentiment = s.ok
    ? [
        `💬 <b>Sentiment</b> · ${s.value.sentiment} (${s.value.confidence} confidence)`,
        clip(s.value.summary, 700),
        ...s.value.drivers.map((d) => `• ${clip(d, 300)}`),
        ...s.value.sources.map(
          (src) => `<a href="${escape(src.url)}">${clip(src.title, 120)}</a>`,
        ),
      ].join("\n")
    : `💬 <b>Sentiment</b> · unavailable (${escape(s.error)})`;
  const n = result.news;
  let news: string;
  if (n.ok) {
    const item = n.value.item;
    const minutes = item
      ? Math.floor((Date.parse(alert.end) - Date.parse(item.createdAt)) / 60000)
      : null;
    const url = item?.url ?? n.value.url;
    news = [
      `📰 <b>News</b> · explains the move: <b>${n.value.explains}</b>`,
      ...(n.value.catalyst ? [`<b>${clip(n.value.catalyst, 300)}</b>`] : []),
      clip(n.value.summary, 700),
      ...(item || url
        ? [
            [
              item
                ? `${escape(item.source)}, ${minutes! < 120 ? `${minutes} min` : `${Math.round(minutes! / 60)} h`} before the alert`
                : null,
              url ? `<a href="${escape(url)}">source</a>` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          ]
        : []),
      `<i>AI analysis, not investment advice.</i>${link}`,
    ].join("\n");
  } else
    news = `📰 <b>News</b> · unavailable (${escape(n.error)})\n<i>AI analysis, not investment advice.</i>${link}`;
  return {
    scores,
    technical: technicalMessage(alert, result),
    sentiment,
    news,
  };
}

// Where the parts go: for a channel, comments on the alert's post (replies to
// its copy in the discussion group); otherwise the alert's topic, or replies
// to the alert's message.
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

// Posts every part as comments on the alert's channel post, into its topic,
// or as replies to it (see placement).
export function telegramDelivery(
  sender: PhotoSender,
  outbox: Pick<Outbox, "muted" | "messageId" | "threadId">,
  siteUrl?: string,
): Deliver {
  return async (alert, result, charts) => {
    if (outbox.muted()) return "muted";
    const where = await placement(sender, outbox, alert);
    const text = formatAnalysis(alert, result, siteUrl);
    let failed = 0;
    const report = (part: string, error: string) => {
      failed++;
      console.error(
        JSON.stringify({
          event: "analysis-delivery-failed",
          ticker: alert.ticker,
          end: alert.end,
          part,
          error,
        }),
      );
    };
    for (const [part, html] of [
      ["scores", text.scores],
      ["technical", text.technical],
    ] as const) {
      const sent = await sender.send(html, where);
      if (!sent.ok) report(part, sent.error);
    }
    if (charts.length) {
      const sent = await sender.sendPhotos(
        charts.map((c) => ({
          png: c.png,
          caption: escape(`${alert.ticker} · ${chartTitles[c.name] ?? c.name}`),
        })),
        where,
      );
      if (!sent.ok) report("charts", sent.error);
    }
    for (const [part, html] of [
      ["sentiment", text.sentiment],
      ["news", text.news],
    ] as const) {
      const sent = await sender.send(html, where);
      if (!sent.ok) report(part, sent.error);
    }
    return failed === 0 ? "sent" : failed < 5 ? "partial" : "failed";
  };
}
