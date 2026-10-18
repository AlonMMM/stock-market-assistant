import { lazy, Suspense, useState } from "react";
import type { FullscreenChartProps } from "./FullscreenChart.js";

// The expand button on every stock chart; the full-screen chart loads on
// first use.
const FullscreenChart = lazy(() =>
  import("./FullscreenChart.js").then((m) => ({ default: m.FullscreenChart })),
);

export function FullscreenButton(props: Omit<FullscreenChartProps, "onClose">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="expand-chart"
        aria-label="Full screen"
        title="Full screen"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      </button>
      {open && (
        <Suspense fallback={null}>
          <FullscreenChart {...props} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
