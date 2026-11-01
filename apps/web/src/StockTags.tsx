import { tagText, useStockTags } from "./stock-tags";

/**
 * A stock's tags as coloured chips (user 2026-11-01): orange for earnings in
 * the next 24 hours, purple for earnings in the last 24 hours, blue for
 * earnings later this week, pink for big news. Renders nothing without tags.
 */
export function StockTags({
  symbol,
  block = false,
  compact = false,
}: {
  symbol: string | null | undefined;
  block?: boolean;
  compact?: boolean;
}) {
  const tags = useStockTags(symbol);
  if (tags.length === 0) return null;
  const now = Date.now();
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
