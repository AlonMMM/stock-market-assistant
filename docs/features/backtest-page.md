# Feature: Backtest page redesign

Status: agreed
Owner: product-ux
Spec revision: see git log for this file
Mockup: `Backtest.dc.html` on the [design canvas](https://claude.ai/artifact/66wz2Zco6yx8EcKrabGvgB)
(private to the owner); source in [backtest-page-mockup/](backtest-page-mockup/). Mockup
numbers are SAMPLE data.

## User and outcome

The trader tuning the relative-volume rule. They pick symbols, dates and (optionally)
changed rule settings, run the replay, and must answer quickly: did alerts do better
than ordinary momentum entries (the baseline), on which symbols, and is the sample large enough to trust?

## Scope and exclusions

In scope: the Backtest view's layout and visual style (matching the Live redesign,
[live-page](live-page.md)), setup presets, grouped rule settings with change tracking,
the verdict block, results tabs (Alerts, By symbol, Data quality), retrying failed
batches, a per-symbol baseline from the API, and phone layout.

Excluded: new rule parameters or scoring logic, server-side presets, saving named
configurations, profitability/P&L figures. The page keeps saying it is a signal check,
not a profitability test.

## Layout

Header as on Live (brand, status pill, Live/Backtest switch). Below, two columns that
wrap on narrow screens: setup (≈ 340 px) and results (rest). On a phone the setup column
collapses into a full-width "Setup · 30 symbols · 5 sessions · rvol-v4 + 1 change"
button above the results that expands the four cards; it starts expanded before the
first run and collapsed after a run.

### Setup (four cards, then the Run button)

1. **Symbols**: "N of M · max 40". Presets: Whole watchlist, Alerted recently (symbols in
   the current `/api/live` alerts; disabled with a reason when there are none), and one
   preset per sector benchmark present in the watchlist (label = the ETF, e.g. "SMH").
   A one-line preview of the selection ("NVDA, AMD, … +22 more"), "Add a symbol" input,
   and "Edit list" opening today's chip picker. Selection stays saved per device.
2. **Dates**: presets Last 5 / 10 / 20 sessions (US session dates ending on the last
   complete session, via the exchange calendar) and Custom (shows From/To inputs; the
   inputs are always visible but presets fill them). Note "US sessions · max 20".
3. **Rule**: one-sentence summary of the live rule (rvol-v4) generated from the live
   defaults. A badge "Live settings" or "N changes from live". "Customize rule" discloses
   the fields in four labelled groups:
   - Volume burst: volume × typical, minimum volume, today's pace ×.
   - Price move: move × typical, minimum move %, last-minute move %, same-direction
     candles.
   - Today-relative (optional): burst vs today's volume ×, move vs today's typical ×.
   - Tags and pacing: in-play day volume ×, cooldown min.
     A changed field gets a highlighted border and "· live X" after its label; "0 = off"
     hints stay. "Reset to live settings" restores all. Field order and validation ranges
     stay as today.
4. **Scoring**: one sentence explaining good / stopped / weak and u, then Good (u),
   Stop (u), Horizon (min).

Run button: "Run backtest · N symbols · K sessions"; while running "Running… 9 / 30
symbols" with a progress bar; a "Runs in batches of 3 symbols" note. Changing any input
after a run marks results "Settings changed — run again" (instead of clearing them).

### Results

- Title: "84 alerts · 21 of 30 symbols · Fri 25 Sep – Fri 2 Oct · rvol-v4 + 1 change",
  "Download JSON".
- **Verdict** card, heading "Did the move follow, compared with ordinary momentum entries?":
  for Good, Stopped and Weak a pair of horizontal bars (Alerts full colour, Baseline faded)
  with percentages and a difference "+2 pts vs baseline" (green when better: more good /
  fewer stopped; red when worse; neutral for weak). Then median move in the alert's
  direction at 5/15/30/60 min and median best run (u). Meta line: scored count, unscored
  count with reason, baseline description (momentum entries at every 5th regular minute in
  the same symbols and days, scored the same way; not random). Under 50 scored alerts: amber note "Only N
  scored alerts: a difference of a few points is within noise…".
- **Tabs** with counts:
  - **Alerts**: the Live alert feed (Israel-day groups, collapsible, header shows count and
    "% good"; session sub-groups) plus an outcome filter (All / Good / Stopped / Weak with
    counts), symbol select and sort (Newest, Highest volume ratio, Best run). Columns:
    time, symbol (+ "In play" tag), move tag, volume ratio, outcome tag, "best run · after
    15 / 60 min". Expanded rows keep evidence, analysis and the day chart (opens Around
    alert), and the chart marks entry, good and stop levels.
  - **By symbol**: table sorted by good % (desc), columns Symbol, Alerts, a stacked bar
    good/weak/stopped (green/grey/red, with text in the accessible label), Good %, vs baseline
    (symbol's good % minus that symbol's baseline good %, in pts), Median run (u).
    Sortable headers like the Live watchlist. Rows with fewer than 5 scored alerts are
    faded and sort after the rest. Clicking a row opens the Alerts tab filtered to it.
  - **Data quality**: "Why windows did not alert" (diagnostics as log-scale bars with
    counts, plus the evaluated total), "Data coverage" (missing sessions per symbol,
    bar-cache hits/misses/errors), and failed batches with "Retry these" that reruns only
    those symbols and merges the result. Tab count shows issues ("1 gap") or "OK".
- Empty (before run): results column shows what the run will produce. No alerts: verdict
  hidden, message "No alerts matched these settings" with the rule badge.
- Errors: invalid settings stop the run with the message next to the Run button; batch
  failures go to Data quality and to the status pill's warnings, not stacked at the top.

## Semantics and contract needs

- No change to rule evaluation or scoring.
- `POST /api/backtest` response: `validation.baselineBySymbol: Record<ticker, { scored,
good, stopped, weak }>` (same baseline entries as today's `validation.baseline`, split
  by symbol). Additive; existing fields unchanged. The web `merge()` of batches must merge
  it too.
- Per-symbol good % in the By-symbol tab is computed in the web app from alerts'
  outcomes; median run per symbol likewise.
- Date presets use US session dates (inputs stay US dates, per product display
  conventions); displayed ranges use Israel-style labels ("Fri 25 Sep").

## Acceptance scenarios

1. Changing "Volume (× typical)" from 3 to 2.5 → field highlighted with "· live 3",
   badge "1 change from live", results title "+ 1 change"; Reset clears all three.
2. "Last 10 sessions" fills From/To with 10 US sessions ending on the last complete one,
   skipping weekends and holidays.
3. "Alerted recently" with 0 live alerts → disabled with "No recent live alerts".
4. 84 scored alerts, 32% good vs 30% baseline → Good shows "+2 pts vs baseline" in green;
   stopped 41% vs 44% → "−3 pts vs baseline" in green; the under-50 note is absent; with 40
   scored alerts the note shows.
5. By symbol: a symbol with 4 alerts is faded and below symbols with ≥ 5; clicking NVDA
   opens Alerts filtered to NVDA.
6. "vs baseline" for NVDA uses NVDA's own baseline from `baselineBySymbol`; if absent
   (older API), the column shows "—".
7. One batch times out → Data quality tab count shows the issue; "Retry these" reruns
   only that batch and the totals update.
8. Editing a field after a run keeps results, shows "Settings changed — run again".
9. Phone width 390 px: setup collapsed into the summary button after a run; no
   horizontal page scroll; tables scroll inside their box.
10. Every displayed time is Israel time; dates in inputs are US session dates.

## Decisions and handoff

Agreed with the user on 2026-10-03 ("build it" after reviewing the mockup). Product+UX
defaults: By symbol included with per-symbol baseline; phone setup collapses; "Alerted
recently" uses current live alerts (no history API).

Handoff:

- **Backend** (`session/backend-backtest-page`): `validation.baselineBySymbol` in
  `/api/backtest`, local and Worker, with tests (scenario 6).
- **Frontend** (`session/frontend-backtest-page`): everything else; works with or
  without `baselineBySymbol`.
