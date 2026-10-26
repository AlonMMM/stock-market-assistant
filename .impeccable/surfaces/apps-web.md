---
version: 1
slug: "apps-web"
primary_target: "apps/web"
related_targets: []
---

# Web app (Live + Backtest) — surface brief

Scope: apps/web, both views, desktop and phone. Mode: Operate.
Audience and job: one trader in Israel watching ~30 US symbols through the US session (pre-market 11:00, regular 16:30–23:00 Israel time), mostly in the evening on a second monitor, with phone notifications. They need: is data flowing, what fired, is it moving with or against SPY, and (Backtest) did the move after alerts beat random minutes.
Constraints: Israel time everywhere; SAMPLE/live/delayed labels; shape plus colour for state; ticker blue solid vs benchmark orange dashed in charts (user-agreed).
Unresolved: direction was inferred unattended (user asked not to wait); master-detail alerts layout replaces expand-in-place and needs the user's approval.

## Direction contract

THESIS: every symbol is read as a rider against the pack. SPY is the fixed centre line; the ticker sits ahead or behind it. Refuses the category default of a grey terminal grid with one neon accent and a wall of cards.

OWN-WORLD: road-race timing graphics. Dusk-tarmac blue-slate ground, panels split by hairline seams, road-paint off-white for primary actions and selection, one yellow reserved for "needs attention" only, green ahead / coral behind with drawn triangles. Barlow and Barlow Semi Condensed, tabular figures, timing-sheet row density.

STORY: the trader sees the feed is live, scans who broke away, opens one alert and judges volume and the gap to SPY without scrolling.

FIRST VIEWPORT: top bar (brand, status pill, Live/Backtest, Israel clock); market strip (QQQ, SPY, session timeline); Alerts/Watchlist tabs; left a dense alert list with filters; right the selected alert's evidence and two-axis day chart. Primary action: selecting a row.

FORM: cycling race time-gap graphics, position 3 of 7 on the grounded list, seed key db3898f4. Signature move: the gap track (centre tick = SPY, marker = ticker) in alert rows, watchlist rows and the backtest by-symbol table.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
