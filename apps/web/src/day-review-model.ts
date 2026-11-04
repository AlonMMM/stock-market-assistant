import type {
  DayReview,
  ReviewRow,
  Verdict,
} from "../../../packages/market-data/src/day-review.js";

// The Analyse page (the user, 2026-11-05): each evening's end-of-day review
// of a bot, live against the app's backtest. The analysis is written in
// markdown by the end-of-day skill; it is shown as plain text blocks, never
// as HTML.

export const verdictWords: Record<Verdict, string> = {
  optimistic: "Backtest too optimistic",
  pessimistic: "Backtest too pessimistic",
  "on target": "Backtest on target",
  "no trades": "No trades to judge",
};

export const verdictTone: Record<Verdict, string> = {
  optimistic: "red",
  pessimistic: "amber",
  "on target": "green",
  "no trades": "grey",
};

/** What a review's status means for the reader. */
export function statusWords(r: DayReview): string {
  if (r.status === "running") return "The backtest of the day is running…";
  if (r.status === "failed")
    return `The review failed: ${r.error ?? "unknown"}`;
  if (!r.analysis) return "Compared; the written analysis is not in yet.";
  return "";
}

/** The verdict shown: the written one, else the comparison's. */
export function shownVerdict(r: DayReview): Verdict | null {
  return r.analysis?.verdict ?? r.comparison?.summary.verdict ?? null;
}

export const matchWords: Record<ReviewRow["match"], string> = {
  both: "both",
  "live-only": "live only",
  "backtest-only": "backtest only",
};

/** "+1.2" / "−0.4", or "—" for nothing. */
export function signed(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(n).toFixed(digits)}`;
}

export const price = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toFixed(2);

/** The average of a side's exits, by quantity or share; null when none. */
export function averageExit(
  exits: readonly {
    price?: number;
    paper?: number;
    qty?: number;
    share?: number;
  }[],
): number | null {
  let weight = 0;
  let sum = 0;
  for (const e of exits) {
    const w = e.qty ?? e.share ?? 0;
    const p = e.price ?? e.paper;
    if (p === undefined) continue;
    weight += w;
    sum += p * w;
  }
  return weight > 0 ? sum / weight : null;
}

export type Block =
  | { kind: "heading"; level: 2 | 3 | 4; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "paragraph"; text: string };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Markdown as blocks: headings, lists, pipe tables and paragraphs. */
export function markdownBlocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      let level: 2 | 3 | 4 = 4;
      if (depth <= 2) level = 2;
      else if (depth === 3) level = 3;
      out.push({ kind: "heading", level, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "list", items });
      continue;
    }
    const isRule = (l: string | undefined) =>
      l !== undefined && /^\s*\|?\s*:?-{3,}/.test(l);
    if (line.trim().startsWith("|") && isRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(cells(lines[i]!));
        i++;
      }
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4})\s/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith("|")
    ) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push({ kind: "paragraph", text: para.join(" ") });
  }
  return out;
}

/** A line's **bold** and `code` spans, the rest plain. */
export function inlineSpans(
  text: string,
): { kind: "text" | "bold" | "code"; text: string }[] {
  const out: { kind: "text" | "bold" | "code"; text: string }[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last)
      out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else out.push({ kind: "code", text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
