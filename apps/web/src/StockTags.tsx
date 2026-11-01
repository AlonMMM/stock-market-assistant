import { tagText, useStockTags } from "./stock-tags";

/**
 * A stock's tags as coloured chips (user 2026-11-01): teal for earnings in
 * the next 24 hours, purple for earnings in the last 24 hours, blue for
 * earnings later this week, pink for big news. Renders nothing without tags.
 */
export function StockTags({
  symbol,
  block = false,
  compact = false,
  dots = false,
}: {
  symbol: string | null | undefined;
  block?: boolean;
  compact?: boolean;
  // Coloured dots laid over the symbol's corner, taking no room (the
  // Watchlist, user 2026-11-01: the chips "are moving the data away").
  dots?: boolean;
}) {
  const tags = useStockTags(symbol);
  if (tags.length === 0) return null;
  const now = Date.now();
  if (dots) {
    const title = tags.map((t) => tagText(t, now).title).join("\n");
    return (
      <span className="stock-dots" title={title}>
        {tags.map((t) => (
          <span key={t.kind} className={`stock-dot ${t.kind}`} />
        ))}
        <span className="sr-only">, {title}</span>
      </span>
    );
  }
  return (
    <span className={block ? "stock-tags block" : "stock-tags"}>
      {tags.map((t) => {
        const { label, title } = tagText(t, now, compact);
        return (
          <span
            key={t.kind}
            className={`stock-tag ${t.kind}`}
            title={title}
            aria-label={title}
          >
            {label}
          </span>
        );
      })}
    </span>
  );
}
