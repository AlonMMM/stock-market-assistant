# Task: Live page redesign (Frontend)

Status: completed
Owner: frontend
Branch: session/frontend-live-page
Spec/contract revision: [live-page spec](../features/live-page.md) at 6c82de2
(formatted in 22ca1a8); Backend contract merged from `session/backend-live-page`
at 84bd5ae (`opposite()`, `BoardSeries.stats`, `ChartSeries.typicalVolume`).

## Outcome

The Live view follows the spec. A status pill beside the brand opens a details
popover. Below it are the market strip, then Alerts and Watchlist tabs with counts.
The Alerts tab has filters and session groups. The Watchlist is a dense sortable table
whose rows expand in place. All three entry points (alert row, watchlist row, Backtest)
share one day chart with two % axes, typical volume and opposite-to-benchmark bands.

## Scope and exclusions

Built (commits on this branch):

1. `812b628` Header status pill and popover. It covers every state in the spec table:
   market closed vs delayed comes from the exchange calendar. Warnings collect in the
   popover and the pill shows a count. Offline shows a blocking banner and keeps the
   last alerts. The status card and footer are removed.
2. `cd7f7a8` Market strip: QQQ and SPY tiles (change since the previous close, plus a
   sparkline), and a session tile with a pre/regular/after timeline, a now mark and
   the time left. Either tile expands the QQQ vs SPY day chart.
3. `bc7225f` Alerts and Watchlist tabs (ARIA tabs, arrow keys) with counts. The deep
   link opens Alerts with the alert expanded; the not-found notice sits inside the tab.
4. `418c2a9` Alerts tab:
   - Toolbar: direction segmented control with counts, Symbol select (by count) with a
     removable chip, and Sort.
   - Grouping: newest first groups by US session date and session, with a header and a
     count. Ratio sort shows one flat list with Pre/After tags.
   - Row columns: time, symbol + New, ▲/▼ move tag, ratio bar (scaled to 8×), vs SPY×β
     ("—" when absent), chevron.
   - "New" marks alerts after the previous visit. The visit is stored per device under
     `sma.live.lastVisit.v1`, with all storage access in try/catch.
   - Expanded row: evidence, day chart, "Only X alerts" and "Copy link".
5. `a49ad95` and `6f5b62c` Watchlist table:
   - Toolbar: Show All/Moving/With alerts (with counts), Compare vs SPY/vs sector, Find
     (prefix match), and a source note with the rel-vol as-of time.
   - Headers are sortable. Default sort is |change| descending. Clicking a header
     toggles direction and ▼/▲ marks the active one; "—" values always sort last.
   - Columns use `stats` from `/api/board` and show "—" when absent.
   - Rows expand in place to the day chart plus a side panel ending in "Show in Alerts →".
   - The table scrolls horizontally inside its box below 940 px.
6. `ef4a5c7` Day chart:
   - Axes: ticker on the right (blue) and benchmark on the left (orange dashed), both as
     % from the previous close and each auto-fitted. The beta mode is removed.
   - Range: Today / Since open / Last hour.
   - Volume: bars at full strength from 2× typical, faded below. A dashed typical line
     has gaps where typical volume is null.
   - Opposite-to-benchmark: red/blue bands, a strip pane and summary chips, all from the
     shared `opposite()`.
   - Readout: time, both %, gap in points, volume and N× typical, plus a state chip. It
     follows the pointer and returns to the latest bar on leave.
   - Legend sentence built from `oppositeDefaults`.
7. `ad60c5e` and `ab4be64` Fixes found in the browser check. The session timeline had
   collapsed. A failed board request now shows "—" or the error instead of a permanent
   "Loading…". β stays lower-case in the uppercase header. The Today header is aligned.
   A full day of minute bars now fits on a phone.

Pure logic is in `apps/web/src/live-model.ts` (pill state, session phase, alert
filter/group, watchlist rows/filter/sort) and `apps/web/src/chart-model.ts` (volume
strength, episode summaries, band coverage, state text). Node tests are in
`tests/live-model.test.ts` and `tests/chart-model.test.ts`. `WatchBoard.tsx` and its
modal are deleted. `AlertFeed.tsx` stays for Backtest; its evidence line is exported as
`AlertEvidence` and reused.

Excluded per the spec: β context on live alerts, an opposite-minutes column,
remembering the watchlist sort, and a phone-specific watchlist layout.

## Deviations from the spec / mockup

- **Open line:** the "Open 16:30" line is a thin solid background bar plus the existing
  "Open HH:MM" marker. lightweight-charts has no dashed vertical line without a custom
  plugin.
- **Pre-market shading:** drawn as a background histogram, so it looks faintly striped
  when zoomed in.
- **Bands:** drawn as histogram columns on a hidden full-height scale, not as rectangles.
- **Volume without typical data:** when `typicalVolume` is absent (an older API), the
  previous rule applies: the alert window is full strength, or every bar when there is
  no alert. When the field is present, the 2× rule applies and a null typical is faded.
- **Readout chip outside the regular session:** shows the session name ("Pre-market",
  "After-hours") instead of "With SPY", because bands are regular-session only.
- **Sector name:** the watchlist shows the sector ETF symbol (e.g. "SMH") because the
  board carries no sector names.
- **vs SPY / vs sector:** shown as "+1.20 pts" to make the % point unit explicit.
- **"Alerts today":** counts the recent live alerts whose US session date equals the
  board's date. The same alert list feeds the Alerts tab, so the counts agree for that
  session.
- **"Delayed":** applies in pre-market and after-hours too (the spec's "inside a
  session"), and to a date outside the 2026–2028 calendar.
- **Warnings:** the collector `failure` text shows in the popover's Failure row and is
  no longer added to the warnings list. A "Clear warnings" button was added to the
  popover.
- **Pill on phones:** below 560 px the pill shows only its label (no detail and no
  warning count), as in the phone mockup.

## Verification evidence

- `npm run check` passes on ab4be64: Prettier clean, both typechecks, 118/118 tests
  (including 10 live-model and 4 chart-model tests covering scenarios 1, 2, 5–8, 10, 12
  (the UI side), 14), and the build. `git diff --check 6c82de2 HEAD` is clean.
- **Real API path:** `npm run dev` on the session ports (web 5212, api 5213), loaded in
  headless Chrome through a scratch CDP script. This worktree has no `.env`, so
  `/api/live` returned `unavailable` and `/api/board` returned 503. Checked: the red
  Offline pill with "· 1 warning", the blocking banner, the popover (Failure row and the
  board warning), market tiles "—", the timeline, and the empty Alerts state. No console
  errors or exceptions, only the expected 503s and a favicon 404.
- **SYNTHETIC mock path:** a scratch mock API (not committed; made-up data) on 5215
  with Vite on 5214. Checked at 1280 px and 390 px:
  - Alerts: the deep link opens Alerts with NVDA expanded. Group headers read
    "Regular session · 2 Oct · 16:30–23:00 · 5 alerts" and "Pre-market". Picking NVDA
    leaves 2 rows, an "NVDA ×" chip and counts 2/2/0.
  - Watchlist: default |change| order; Rel vol ▼ then ▲ with "—" last; With alerts
    counts; vs sector; the expanded side panel; "Show in Alerts →" opens Alerts filtered
    to NVDA.
  - Day chart: two coloured axes, bands, strip, summary chips, a dashed typical line
    with a gap, and solid/faded bars.
  - Phone: no horizontal page overflow at 390 px.
  - Backtest view: renders.
  - No console errors.
- **Not verified:**
  - Live data from the real collector and Alpaca; Live, Delayed, Reconnecting and
    Warming-up pills in a browser (unit-tested only).
  - Pointer-hover readout updates and keyboard-only operation.
  - The "New" marker across two real visits.
  - "Copy link" clipboard permission.
  - Backtest alert rows with the new chart (needs Alpaca).
  - Screenshots are in the session scratchpad, not committed.

## Handoff

- Integration: merge Backend before Frontend (this branch already contains Backend at
  84bd5ae, so the Frontend merge brings it in too). Update `docs/state.md`: the Live
  page redesign, Telegram notifications and alert deep links.
- **Open questions:**
  - Should the alert row's day chart open on the full day (spec: Today default) or on
    the previous ±1 h around the alert? It now opens on Today, which makes minute bars
    dense.
  - Is "Moving" (|change| ≥ 1% or rel vol ≥ 2×) right on real days?
  - Do the opposite thresholds need tuning? With noisy symbols the weak state may fire
    often.
- **Next action:** a manual check with real data during a US session (pill states,
  hover readout, bands on a real day). Then decide the open questions.
