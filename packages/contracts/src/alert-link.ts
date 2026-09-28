// Site link that opens one live alert: `/?alert=<ticker>&end=<bar end, UTC>`.
// `synthetic=1` marks a made-up alert that is never stored.
export interface AlertLink {
  ticker: string;
  end: string;
  synthetic: boolean;
}

export function alertLink(
  siteUrl: string,
  alert: { ticker: string; end: string; synthetic?: boolean },
): string {
  const url = new URL(siteUrl);
  url.search = "";
  url.searchParams.set("alert", alert.ticker);
  url.searchParams.set("end", alert.end);
  if (alert.synthetic) url.searchParams.set("synthetic", "1");
  return url.toString();
}

// Null unless both values are present and `end` is a valid time.
export function parseAlertLink(search: string): AlertLink | null {
  const params = new URLSearchParams(search);
  const ticker = params.get("alert");
  const end = params.get("end");
  if (!ticker || !end || Number.isNaN(Date.parse(end))) return null;
  return { ticker, end, synthetic: params.get("synthetic") === "1" };
}
