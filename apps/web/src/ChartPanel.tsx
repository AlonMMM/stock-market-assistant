import { useState } from "react";
import {
  FullscreenChart,
  type FullscreenChartProps,
} from "./FullscreenChart.js";
import { usSessionDate } from "./time.js";

// The one stock chart (user 2026-10-19: "replace all the places where we
// build this graph with the full-screen graph"): the full-screen chart drawn
// in the page, SPY on its own axis, bar sizes, candles or vs SPY, VWAP and
// volume, with a button that opens the same chart over the whole screen.
// An alert row gives its alert's end; its session is the day charted.

export function ChartPanel({
  date,
  ...props
}: Omit<FullscreenChartProps, "onClose" | "inline" | "onExpand" | "date"> & {
  date?: string | undefined;
}) {
  const [full, setFull] = useState(false);
  const day =
    date ??
    (props.alertEnd
      ? usSessionDate(Date.parse(props.alertEnd) - 60000)
      : usSessionDate(Date.now()));
  return (
    <>
      <FullscreenChart
        {...props}
        date={day}
        inline
        onExpand={() => setFull(true)}
      />
      {full && (
        <FullscreenChart {...props} date={day} onClose={() => setFull(false)} />
      )}
    </>
  );
}
