import { useEffect, useRef, useState } from "react";
import { israelClock } from "./time.js";

// When a bot enters a trade (user 2026-10-27: "Show somehow when you enter a
// trade - it could be banner on green or red ... and show it on the page in
// small sign"): a banner, green for a call and red for a put, while the page
// is open, and a small sign by the bot's name for as long as it is held.

export interface HeldTrade {
  id: string;
  symbol: string;
  side: "C" | "P";
  at: number; // when it was bought (ms)
  what: string; // "CRWV 66 call 30 Oct · 10 contracts"
}

// On opening the page, a trade bought this recently still gets its banner.
const freshMs = 3 * 60000;
// A banner closes itself after this.
const showMs = 60000;

/** The banners for trades entered while the page is open. */
function useNewEntries(trades: HeldTrade[] | null) {
  const seen = useRef<Set<string> | null>(null);
  const [shown, setShown] = useState<HeldTrade[]>([]);
  useEffect(() => {
    if (!trades) return;
    const first = seen.current === null;
    const known = seen.current ?? new Set<string>();
    const fresh = trades.filter(
      (t) => !known.has(t.id) && (!first || Date.now() - t.at < freshMs),
    );
    for (const t of trades) known.add(t.id);
    seen.current = known;
    if (fresh.length === 0) return;
    setShown((s) => [...s, ...fresh]);
    try {
      navigator.vibrate?.(200);
    } catch {
      // Not every browser lets a page vibrate.
    }
  }, [trades]);
  useEffect(() => {
    if (shown.length === 0) return;
    const timer = setTimeout(() => setShown((s) => s.slice(1)), showMs);
    return () => clearTimeout(timer);
  }, [shown]);
  const dismiss = (id: string) => setShown((s) => s.filter((t) => t.id !== id));
  return { shown, dismiss };
}

/** The banners at the top of a bot's page. */
export function EntryBanners({
  bot,
  trades,
}: {
  bot: string; // "Main bot", "Volume bot"
  trades: HeldTrade[] | null;
}) {
  const { shown, dismiss } = useNewEntries(trades);
  if (shown.length === 0) return null;
  return (
    <div className="entry-banners" role="status" aria-live="assertive">
      {shown.map((t) => (
        <div
          key={t.id}
          className={`entry-banner ${t.side === "C" ? "call" : "put"}`}
        >
          <span className="entry-banner-icon" aria-hidden="true">
            {t.side === "C" ? "▲" : "▼"}
          </span>
          <span>
            <b>
              {bot} entered {t.symbol} {t.side === "C" ? "call" : "put"}
            </b>{" "}
            <span className="num">· {israelClock(t.at)}</span>
            <span className="entry-banner-what">{t.what}</span>
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** The small sign by the bot's name: each trade it holds now. */
export function InTradeSign({
  trades,
  target,
}: {
  trades: HeldTrade[];
  target: string; // the id of the page's holdings, scrolled to on a tap
}) {
  if (trades.length === 0) return null;
  return (
    <a
      className="in-trade-sign"
      href={`#${target}`}
      onClick={(e) => {
        e.preventDefault();
        document
          .getElementById(target)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
      title="The bot's open trades"
    >
      <span className="in-trade-dot" aria-hidden="true" />
      In trade:
      {trades.map((t) => (
        <span
          key={t.id}
          className={`in-trade-tag ${t.side === "C" ? "up" : "down"}`}
        >
          {t.symbol} {t.side}
        </span>
      ))}
    </a>
  );
}
