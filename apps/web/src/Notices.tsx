// Warnings stack at the top of a page: the newest is shown, earlier ones are
// collapsed. `items` are in chronological order.
export function Notices({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  const latest = items[items.length - 1]!;
  const earlier = items.slice(0, -1).reverse();
  return (
    <div className="notices" role="status">
      <p className="notice error">{latest}</p>
      {earlier.length > 0 && (
        <details className="notices-earlier">
          <summary>
            {earlier.length} earlier{" "}
            {earlier.length === 1 ? "warning" : "warnings"}
          </summary>
          <ul>
            {earlier.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
