import { useEffect, useRef, useState } from "react";
import type { LiveStatus } from "../../../packages/market-data/src/live.js";
import { sipDelayText, type Pill } from "./live-model.js";
import {
  israelClock,
  israelDate,
  israelDateTime,
  israelLabel,
} from "./time.js";

function Icon({ icon }: { icon: Pill["icon"] }) {
  if (icon === "warn")
    return (
      <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M7 1.5l6 11H1z" fill="none" stroke="currentColor" />
        <path d="M7 6v3M7 10.8v.2" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  if (icon === "error")
    return (
      <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5.8" fill="none" stroke="currentColor" />
        <path
          d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    );
  return <span className={`pill-icon ${icon}`} aria-hidden="true" />;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Connection status beside the brand. The popover holds the feed details and
 * the non-blocking warnings that would otherwise stack above the page.
 */
export function StatusPill({
  pill,
  status,
  checkedAt,
  refreshSeconds,
  warnings,
  onClearWarnings,
  chartDelay,
}: {
  pill: Pill;
  status: LiveStatus | null;
  checkedAt: number | null;
  refreshSeconds: number;
  warnings: string[];
  onClearWarnings: () => void;
  // Board data's delay, on pages that load the board; omitted elsewhere.
  chartDelay?: { minutes: number | undefined };
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const last = status?.lastBarAt ? Date.parse(status.lastBarAt) : null;
  const lastText =
    last === null
      ? "No live bars yet"
      : `${
          checkedAt && israelDate(last) === israelDate(checkedAt)
            ? israelClock(last)
            : israelDateTime(last)
        } ${israelLabel}`;
  const count = warnings.length
    ? ` · ${plural(warnings.length, "warning")}`
    : "";
  return (
    <div className="status" ref={box}>
      <button
        type="button"
        className={`pill ${pill.tone}`}
        aria-expanded={open}
        aria-controls="status-details"
        aria-label={`Connection status: ${pill.label} ${pill.detail.replace(/^· /, "")}${count}. Show details`}
        onClick={() => setOpen(!open)}
      >
        <Icon icon={pill.icon} />
        {pill.label}
        {pill.detail && <span className="pill-detail">{pill.detail}</span>}
        {count && <span className="pill-detail">{count}</span>}
        <svg
          className="pill-chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <path
            d="M3 4.5l3 3 3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      </button>
      {open && (
        <div
          className="status-popover"
          id="status-details"
          role="dialog"
          aria-label="Connection details"
        >
          <strong>{pill.heading}</strong>
          <dl>
            <dt>Feed</dt>
            <dd>
              {status?.feed === "iex"
                ? "Alpaca IEX — one exchange's volume"
                : status?.feed
                  ? `Alpaca ${status.feed.toUpperCase()}`
                  : "—"}
            </dd>
            <dt>Symbols</dt>
            <dd>
              {status
                ? `${status.symbols} subscribed · ${status.receiving} receiving`
                : "—"}
            </dd>
            <dt>Last bar</dt>
            <dd>{lastText}</dd>
            <dt>Checked</dt>
            <dd>
              {checkedAt ? israelClock(checkedAt) : "not yet"} · refreshes every{" "}
              {refreshSeconds} s
            </dd>
            <dt>Charts</dt>
            <dd>
              {chartDelay
                ? `Alpaca ${sipDelayText(chartDelay.minutes)}`
                : "Alpaca SIP"}
            </dd>
            {status?.failure && (
              <>
                <dt>Failure</dt>
                <dd>{status.failure}</dd>
              </>
            )}
          </dl>
          {pill.kind === "delayed" && (
            <p className="status-note">
              A US session is open by the exchange calendar, but the newest bar
              is {pill.detail.replace(/^· /, "")}. Quiet symbols, a stalled
              stream or an unlisted market holiday can cause this.
            </p>
          )}
          <div className="status-warnings">
            {warnings.length === 0 ? (
              <p>
                No warnings. Non-blocking warnings collect here instead of
                stacking above the page.
              </p>
            ) : (
              <>
                <ul>
                  {[...warnings].reverse().map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="chip"
                  onClick={onClearWarnings}
                >
                  Clear warnings
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
