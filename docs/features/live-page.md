# Feature: Live page redesign

Status: agreed
Owner: product-ux
Spec revision: see git log for this file
Mockup: [design canvas](https://claude.ai/artifact/66wz2Zco6yx8EcKrabGvgB) (private to the owner);
source in [live-page-mockup/](live-page-mockup/). Mockup numbers are SAMPLE data.

## User and outcome

A trader watching ~30 US symbols during the day. Opening the Live view they must see,
without scrolling: whether data is flowing, how the market is doing, and which alerts
fired. In the watchlist they must find who is moving and, per symbol, judge volume and
whether it moves with or against SPY.

## Scope and exclusions

In scope: status pill, market strip, Alerts/Watchlist tabs, alert feed layout, watchlist
table, a new day chart (two axes, typical volume, opposite-to-benchmark bands), and the
data each needs.

Excluded (deferred): β-adjusted context on live alerts (the "vs SPY×β" column shows "—"
until live alerts carry it), a watchlist column ranking opposite-to-SPY minutes,
remembering the watchlist sort, phone-specific watchlist layout beyond horizontal
scrolling, Backtest view changes other than what the shared day chart brings.

## Flow and states

All times are Israel time (`Asia/Jerusalem`, 24 h) and labelled as such once per view.

### Header and status pill

The full-width status card is removed. A pill sits beside the "SMA." brand; the
Live/Backtest switch stays on the right. Tapping the pill opens a details popover: feed
(IEX = one exchange's volume), symbols subscribed/receiving, last bar, checked time and
refresh interval, chart source (SIP, 15-min delayed), and the non-blocking warnings that
today stack at the top of the page. The old footer text moves here.

| Pill | When | Page |
|---|---|---|
| ● Live · 30/30 · 17:44 (green, filled dot) | `subscribed` and newest bar < 3 min old | normal |
| ○ Market closed · pre-market Mon 11:00 (grey ring) | `subscribed`, outside every US session per the exchange calendar | normal |
| Warming up (grey dashed ring) | `warming-up` / `starting` | alerts list loading state |
| Streaming off (grey square) | `awaiting-alpaca-activation` | alerts list says no live alerts will arrive |
| ⚠ Delayed · last bar N min ago (amber) | `subscribed`, inside a session, newest bar ≥ 3 min old | normal; popover explains |
| ⚠ Reconnecting (amber) | `disconnected` | normal; popover shows the failure text |
| ⊗ Offline (red) | `unavailable` | blocking banner under the header, last alerts stay visible |

Shape and wording carry the state, not colour alone. A pill showing a warning count
("· 1 warning") replaces the stacked notices.

### Market strip

Below the header: QQQ and SPY tiles (change since previous close, sparkline) and a
session tile with a pre/regular/after timeline and a "now" mark ("Regular session ·
closes 23:00 · 5 h 15 m"). Tapping a tile expands the existing market day chart below.

### Tabs

"Alerts N" and "Watchlist N" tabs. A notification deep link opens the Alerts tab with the
alert expanded (existing behaviour). The deep-link-not-found notice appears inside the
Alerts tab above the list.

### Alerts tab

- Toolbar: direction segmented control (All / ▲ Up / ▼ Down, with counts), a Symbol
  select ("All symbols", then each symbol with its count, most alerts first) that shows a
  removable "NVDA ×" chip when set, and Sort (Newest first / Highest volume ratio). The
  per-ticker chip wall is removed.
- Newest-first groups rows under "Regular session", "Pre-market", "After-hours" headers
  with counts, so rows carry no session tag. Sorting by ratio flattens into one list and
  shows a Pre/After tag on extended-session rows.
- Row columns: time, symbol (+ "New" for alerts since the viewer's last visit, stored per
  device), move as a ▲/▼ tag, volume ratio with a bar (scaled to 8×), vs SPY×β ("—" when
  absent), chevron. Expanding shows the evidence line, the day chart and actions
  ("Only NVDA alerts", copy link).
- Empty/loading/offline states keep today's wording (pre-market 11:00, regular 16:30).

### Watchlist tab

A dense table of all watchlist symbols, default sort biggest move (|change|) first.

- Toolbar: Show (All / Moving / With alerts, with counts), Compare (vs SPY / vs sector),
  Find (prefix match on symbol), source note (SIP, 15-min delayed).
- Columns, each header sortable (click toggles direction; ▲/▼ shows the active one):
  Symbol + sector name, Last, Change (▲/▼ tag; sorts by size of move), vs SPY | vs
  sector (change minus benchmark change, in % points), Rel vol (value + bar; bold at
  ≥ 2×), Day range (low–high track with a mark at the last price), Alerts today (count),
  Today (sparkline with dashed benchmark and dotted regular-open line).
- "Moving" = |change| ≥ 1% or rel vol ≥ 2× (proposed thresholds).
- Clicking a row expands it in place (no modal): the day chart, then a side panel with
  day range, rel vol, benchmark change, today's alerts and "Show in Alerts →" (opens the
  Alerts tab filtered to that symbol).
- Below ~940 px the table scrolls horizontally inside its box.

### Day chart (watchlist row, alert row, and Backtest through the shared component)

- Range: Today (default) / Since open / Last hour. Pre-market shaded, dashed "Open 16:30"
  line, ▼ alert markers with their time.
- Price pane: ticker on the right axis (blue, solid), benchmark on the left axis
  (orange, dashed), both as % from the previous regular close, each auto-fitted to its own
  range so a flat SPY still shows its shape. The previous "beta" mode is not offered here.
- Opposite-to-benchmark bands: a light band behind the lines and a solid strip between
  price and volume panes. Red = held while the benchmark fell; blue = fell while the
  benchmark held. Summary chips above the chart: "Held while SPY fell: 1 time · 10 min",
  "Fell while SPY held: none today".
- Volume pane: 1-minute bars green up / red down, full strength when ≥ 2× typical,
  faded otherwise; a dashed line shows typical volume for each minute.
- Readout line (latest bar; follows the pointer): time, ticker %, benchmark %, gap
  (ticker − benchmark, % points), volume and "N× typical", state chip ("▲ Holding while
  SPY falls" / "▼ Falling while SPY holds" / "With SPY").
- Legend sentence states the band rule and "Times in Israel time".

## Semantics and contract needs

### Rel vol (user-confirmed 2026-10-03)

Regular-session volume from 09:30 New York to the as-of minute ÷ the median of the same
cumulative volume up to the same New York minute over the previous 20 sessions. Null
("—") before the regular open, and when fewer than 15 of those sessions have data for
that minute. The as-of minute is the board's newest bar (board data is SIP, 15-minute
delayed), so rel vol is equally delayed; the UI says so in the source note.

### Typical volume per minute

For a bar at New York minute m and session s: the median volume of that symbol's bars at
minute m, session s, over the previous 20 sessions; null when fewer than 15 exist. Same
baseline style as the alert evaluator ([relative-volume](relative-volume.md)).

### Opposite to benchmark (proposed thresholds, user-agreed rule shape 2026-10-03)

Evaluated each regular-session minute i ≥ open + 5, on % from previous close:

- `bR = bench[i] − bench[i−5]`, `tR = ticker[i] − ticker[i−5]`
- `usual` = median of |ticker[k] − ticker[k−5]| over today's regular-session minutes up
  to i (no future data). Until 15 such moves exist, no weak state is assigned.
- **strong (red)**: `bR ≤ −0.05` and `tR ≥ 0`.
- **weak (blue)**: `bR ≥ −0.02` and `tR ≤ −2 × usual`.
- otherwise none. Consecutive minutes of the same kind form an episode, drawn from
  i−5 of its first minute to its last minute.

Window (5), benchmark fall (0.05 pts), benchmark hold (−0.02 pts) and weak multiple (2)
are named defaults in one config object, not hard-coded at call sites. The rule is a
display aid, not a validated signal; do not describe it as predictive.

### API changes

`GET /api/board` — each `BoardSeries` for a watchlist symbol gains optional `stats`:

```ts
stats?: {
  asOf: number;             // Unix s, end of newest bar used
  dayLow: number | null;    // today's low/high, pre-market included
  dayHigh: number | null;
  volume: number;           // regular-session cumulative volume to asOf
  typicalVolume: number | null;
  relVolume: number | null; // volume / typicalVolume, null per the rule above
}
```

`POST /api/day-chart` — the requested ticker's `ChartSeries` gains
`typicalVolume: (number | null)[]` aligned with `bars`. The benchmark series omits it.
Existing fields and errors are unchanged; the request already accepts `benchmark`.

Shared pure function (packages/market-data, Node-tested, imported by the web app):
`opposite(ticker: ChartSeries, bench: ChartSeries, options?)` →
`{ states: ("strong" | "weak" | null)[] /* aligned to ticker bars */, episodes:
{ kind, from, to }[] /* bar indices */ }`.

Market closed vs delayed uses the existing exchange calendar (`calendar.ts`) in the web
app; no API change.

## Acceptance scenarios

1. Saturday, collector subscribed, last bar Fri 23:59 → pill "Market closed · pre-market
   Mon 11:00", no amber/red, no status card.
2. Tuesday 18:00 Israel, newest bar 17:54 → pill "Delayed · last bar 6 min ago".
3. Collector unreachable → red "Offline" pill and banner; previously loaded alerts stay.
4. A failed `/api/board` poll → pill shows "· 1 warning"; the popover lists it; nothing
   stacks above the page.
5. 7 alerts, 4 up, NVDA ×2 → Up shows 4; choosing NVDA in Symbol shows 2 rows and an
   "NVDA ×" chip; clearing restores 7.
6. Newest first with pre-market and regular alerts → two group headers with counts, no
   per-row session tags; switching to ratio sort → one list, pre-market rows tagged Pre.
7. Watchlist opens sorted by |change|; clicking Rel vol sorts highest first, again lowest
   first; the active header shows ▼/▲.
8. Before 16:30 Israel time every Rel vol cell is "—" and sorting puts them last.
9. A symbol with 10 of 20 prior sessions → Rel vol "—"; typical-volume line has gaps.
10. "With alerts" filter shows only symbols with ≥ 1 alert today; its "2 alerts" count
    matches the Alerts tab; "Show in Alerts →" opens the tab filtered to that symbol.
11. Day chart, SPY range +0.0…+0.3% and ticker −1…+2.5% → each axis spans its own
    range; left labels orange, right blue.
12. SPY −0.06 pts over 5 min while ticker +0.02 → that minute is strong (red band);
    SPY −0.04 → none (boundary). SPY +0.01 while ticker falls 2.1× usual → weak; 1.9× →
    none.
13. Bands and summary only cover the regular session; pre-market has none.
14. Volume bar at 2.0× typical is full strength; 1.9× is faded; with typical null the bar
    is faded and the line has a gap.
15. Hovering 17:15 shows that minute's values and state chip; leaving returns to latest.
16. Every visible time is Israel time; API payloads remain UTC/US session dates.

## Decisions and handoff

Agreed with the user on 2026-10-03: status beside the title, market strip, tabs, alert
filters/grouping, dense watchlist table with sortable Rel vol, rel vol definition
(regular session only), two-axis day chart, opposite-to-benchmark bands with
red = strong, blue = weak.

Proposed defaults (change without re-design): thresholds above, "Moving" thresholds,
ratio bar scale 8×, rel-vol bold at 2×, 3-minute delayed threshold.

Open: colours overlap (red also marks down-volume bars, blue is the ticker line) — the user
chose red/blue; revisit after real use. Divergence thresholds need checking on real days.

Handoff:

- **Backend** (`session/backend-live-page`): board `stats`, day-chart `typicalVolume`,
  `opposite()` with tests for scenarios 8, 9, 12, 13; reuse the bar cache for the 20-session
  history; keep Worker/local parity.
- **Frontend** (`session/frontend-live-page`): header/pill/popover, market strip, tabs,
  alerts tab, watchlist table, day chart changes, using `stats`/`typicalVolume` when
  present and "—"/no line when absent so it can ship before or after Backend.
- **Integration**: merge Backend before Frontend if both are ready, update docs/state.md.
