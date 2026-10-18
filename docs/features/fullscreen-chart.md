# Feature: Full-screen chart with SPY

Status: agreed
Owner: product-ux
Spec revision: see git log for this file
Amends: [chart-vs-spy](chart-vs-spy.md) (adds an entry point; the chart itself is unchanged)
Mockup: [fullscreen-chart-mockup/index.html](fullscreen-chart-mockup/index.html) (synthetic data)

## User and outcome

The page is at most 940 px wide, so the charts inside rows are small. The trader wants
to open any stock chart across the whole screen and read the stock against SPY there,
on the same day chart the app already draws (stock line, SPY line, bands, volume and
score).

## Scope and exclusions

In scope: one **Full screen** button on every stock chart.

| Where                                    | Chart today                            | Full screen opens                                |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| Alerts: expanded alert row               | Day chart vs SPY with the alert window | Same alert, same window                          |
| Backtest: expanded alert row             | Day chart vs SPY with the alert window | Same alert, same window                          |
| Alerts: market chart                     | QQQ vs SPY                             | QQQ vs SPY                                       |
| Watchlist: expanded row                  | Candles                                | **vs SPY** for that ticker; Candles one tap away |
| Portfolio → Positions: expanded position | Candles / vs SPY switch                | **vs SPY** for the underlying                    |
| Trade: chain                             | Candles / vs SPY switch                | **vs SPY** for the underlying                    |

Excluded: the Portfolio P&L chart (not a stock), sparklines, multi-day ranges, drawing
tools, and adding SPY to the candle chart. "With SPY" always means the existing vs SPY
day chart.

## Flow and states

1. **Button.** An expand icon at the top right of the chart, labelled "Full screen" for
   screen readers and in its tooltip. It has the same height as the Candles / vs SPY switch.
2. **Open.** A layer covering the whole window. It is not the browser's Fullscreen API,
   which iPhone Safari doesn't support. The page behind it doesn't scroll.
3. **Top bar.** From left to right (the bar-size switch comes before the chart-type switch):
   - ticker, last price and day change;
   - session date and the data label already in use (`SIP · 15 min delayed`, `live`, or
     `backtest`);
   - the bar-size switch `1m | 5m | 15m | 1h | 1D`, set to 1m on open;
   - **today's volume chip**, for example `Vol 38.4M · 1.6× avg · 85th pct` (defined
     under "Volume vs the last month" below);
   - a `VWAP` on/off button, **off** when it opens and disabled on 1D;
   - the `Candles | vs SPY` switch, set to vs SPY on open;
   - when the ticker has a sector ETF, the existing `SPY | <sector>` benchmark switch;
   - **✕ Close**.
4. **Chart: a price overlay in the trading-terminal style** (user reference, an eSignal
   chart of IONQ with SPY, 2026-10-17). It fills the rest of the window and keeps the
   live refresh. Opening from an alert keeps the alert window shaded.
   - The background is dark in both themes, with dashed grid lines from the stock axis
     and a dashed vertical line every hour.
   - The **stock** is a green line on the **right** price axis, in $. **SPY** (or the
     chosen sector ETF) is a white line on the **left** price axis, in $. Each axis is
     scaled to its symbol's own day range.
   - Each axis has a tag in the line's colour showing the last price.
   - **Bar sizes and what they show** (regular hours, 09:30–16:00 ET, only):

     | Bar | Shows               | Bars (about) |
     | --- | ------------------- | ------------ |
     | 1m  | yesterday and today | 780          |
     | 5m  | last 5 sessions     | 390          |
     | 15m | last 10 sessions    | 260          |
     | 1h  | last 30 sessions    | 210          |
     | 1D  | last 12 months      | 250          |

     A bold dashed line and a bold label (`Thu 15`) mark each new session. On 1D they
     mark each month (`Nov`, with the year at January). Hour labels fill the gaps on
     1m, 5m and 15m. The chart can be dragged to the left for older bars and zoomed with
     the wheel or a pinch, as in the chart library today. Older bars load on demand.

   - The alert window is shaded on 1m and 5m. On larger bars it is narrower than one
     bar, so it isn't drawn.
   - Two legend lines at the top left show the bar size and the open, high, low and close
     of each symbol for the pointed bar, or for the latest bar when nothing is pointed.
   - The volume pane below shows the stock's volume, with green bars for up minutes and
     red bars for down minutes (bars), on its own right axis.
   - The crosshair shows a price tag on both axes and the time below the chart.
   - A data window at the bottom left shows the date and the time in Israel time (no
     time on 1D). For each symbol it shows open, high, low and close, and the change from
     the previous session's close (on 1D, from the previous day's close). It also shows
     the stock's volume. It is hidden on a phone, where the legend lines are enough.
   - **VWAP** (user request, 2026-10-17): the stock's session VWAP as a yellow line on
     the stock's right axis, in both vs SPY and Candles.
     - It is computed as Σ(bar VWAP × volume) ÷ Σ volume over the session's bars from
       09:30 ET, and starts again at each session's open. Alpaca's bars carry their own
       VWAP (`vw`), the volume-weighted price of all their trades. So the sum gives the
       same value from 1-, 5-, 15- or 30-minute bars at the same bar close. It falls back
       to (high + low + close) ÷ 3 for a bar without `vw`. Each bar shows the VWAP at its
       close.
     - It is regular hours only, matching the hidden pre- and post-market bars, so it
       starts at the regular open (09:30 ET, 16:30 Israel time).
     - A yellow tag on the right axis shows the last VWAP. When it would cover the
       price tag, it moves just off the price.
     - A third legend line reads `VWAP 131.20 · NVDA above by 0.32%`. The data window
       adds `VWAP` and `vs VWAP +0.32%` for the pointed bar.
     - There is no VWAP on 1D, where a session VWAP isn't meaningful. The button is
       greyed out.
     - Only the stock gets a VWAP. SPY's VWAP is out of scope.
   - **Volume vs the last month** (user request, 2026-10-17). "Last month" is the 20
     previous sessions, as Rel vol uses on the board today. Regular hours only.
     - _Top-bar chip:_ today's volume so far; that volume divided by the **average**
       volume over the 20 sessions up to the same New York minute (`1.6× avg`); and the
       **percentile**, the share of those 20 sessions with less volume by that minute
       (`85th pct`, with the tooltip "higher than 17 of the last 20 sessions"). It shows
       "—" with fewer than 15 sessions of history, the same minimum Rel vol uses.
     - _Volume pane:_ a dashed line for the average volume of each bar: the same bar
       time over the 20 sessions, or the 20 days before it on 1D. It is labelled
       "dashed: avg of last 20 sessions at this time".
     - _Data window:_ for the pointed bar, `vs 20-session avg 2.1×` and `Percentile
92nd`, on the same basis as the dashed line.
     - It uses the average because the user asked for it. Rel vol on the board uses the
       median ("typical"), so the two numbers can differ on a day after a very heavy
       session. The percentile isn't skewed by a heavy day.
   - The vs SPY score chip in the top bar is always today's 1-minute score from the
     existing day chart, whatever bar size is shown.
   - Candles shows the stock's candles for the chosen bar size on the right axis, with
     no benchmark.
   - Two scaled price axes don't compare % moves: where the lines cross means nothing.
     The % changes in the data window and the score are the comparison.
5. **Close.** ✕, Esc, or the browser/phone Back button. Focus returns to the Full screen
   button, and the row stays open and scrolled where it was.
6. **Switch memory.** Choices of bar size, Candles / vs SPY and benchmark made in full
   screen last until it is closed. It doesn't change the switch saved in the row (`sma.chart-kind.v1`).

States are the chart's own: "Loading chart…", no bars for the session ("No bars for
this session"), and the read error with retry. The top bar stays visible in all of them,
so the trader can always close.

Phone: the same layer at full height. The top bar wraps to two lines (ticker and price
on the first; switches and ✕ on the second). The chart uses the rest of the height. In
landscape there is one top bar line. Nothing tells the user to rotate.

Keyboard: Tab stays inside the layer while it is open. Esc closes it. The switches are
the existing buttons with `aria-pressed`.

## Semantics and contract needs

Times stay in Israel time as in the row chart. Prices are split-adjusted, so the 1D
chart has no jumps at splits. Today's last bar moves with the live refresh, as it does
in the candle chart now.

**New API, for Backend.** The full-screen layer needs one read: the stock's and the
benchmark's bars for a bar size and a range of sessions. Today `/api/candles` only gives
one session of minute bars. Proposed:
`GET /api/bars?ticker=NVDA&against=SPY&bar=5m&sessions=5[&end=<session date>]`. It answers with
both symbols' OHLCV bars (the `Candle` shape), regular hours only, aligned by bar start,
plus each session's previous close. For each stock bar it also returns the 20-session
average volume and the percentile. Intraday that is the same bar time; on 1D it is the
20 days before. It also returns today's volume so far, the average by the same minute,
and the percentile. Each intraday stock bar also gets `vwap`, the session VWAP at the
bar's close, computed from minute bars. Bar sizes are 1m, 5m, 15m, 1h and 1D. `end` is the last session shown. It loads older bars when the chart is dragged left,
and it pins a past alert's chart to that alert's day. Alpaca gives all five bar sizes for both
symbols in one request (`/v2/stocks/bars`, `1Min | 5Min | 15Min | 1Hour | 1Day`). The
1h bars are 09:30, 10:30 … 15:30 ET; Alpaca's are on the clock hour, so they need
regrouping from 30-minute bars, or Backend picks one and states it. The score chip
keeps using `/api/day-chart`.

## Acceptance scenarios

1. On Watchlist, open NVDA and press Full screen. The layer shows the NVDA vs SPY day
   chart for the board's session. Press Candles to see candles. Press Esc, and the row
   still shows candles. The saved row choice hasn't changed.
2. On Alerts, open an alert and press Full screen. The same alert window is shaded, and
   the readout at a pointed minute shows both the stock and SPY % and $.
3. On Trade, with the chain on Candles, press Full screen. It opens on vs SPY.
4. On a phone, press Full screen and then Back. The layer closes and the app stays in the
   same section and row.
5. While the chart is loading or has failed, the top bar with ✕ is visible.
6. Neither the P&L chart nor a sparkline shows the button.
7. Full screen opens on 1m with yesterday and today. A bold `Thu 15` marks where today
   begins. 5m shows 5 sessions, and 1D shows 12 months with month labels.
8. On 15m, pointing at a bar shows the stock's and SPY's open, high, low and close for
   that bar in the legend and data window, plus each one's change from the previous
   session's close.
9. On 1h from an alert, no alert band is drawn. On 1m and 5m, it is.
10. On 5m, dragging the chart to the left loads older sessions.
11. At 18:00 Israel time NVDA has traded 38.4M shares. The average by 11:00 New York over
    the last 20 sessions is 24.0M, and 17 of those 20 sessions had less. The chip reads
    `Vol 38.4M · 1.6× avg · 85th pct`.
12. On 5m and on 1m, pointing at the bar ending at 17:15 Israel time shows the same
    VWAP. At today's first bar the VWAP equals that bar's own VWAP. On 1D there is no
    line and the VWAP button is disabled.
13. With 12 sessions of history (a recent IPO), the chip reads `Vol 3.1M · — avg`, and
    the dashed line is not drawn.

## Decisions and handoff

Agreed with the user (2026-10-17):

- Full screen always opens on vs SPY.
- The P&L chart gets no button for now.
- The smallest bar is 1 minute; 10-second bars are deferred.
- 1m shows yesterday and today.
- Only full screen gets the dark price-overlay look; the row charts don't change.
- The bar sizes in full screen are 1m, 5m, 15m, 1h and 1D.
- VWAP: the stock's session VWAP from the regular open, for 1m to 1h, **off by default**
  (user, 2026-10-18).
- Volume vs the last month: an average and a percentile over 20 sessions, in the
  top-bar chip, the volume pane and the data window.

- The proposed defaults, accepted when the user said to go ahead (2026-10-18):
  - Each bar size opens with the ranges in the table above.
  - Pre- and post-market bars are hidden.

Handoff once agreed:

- Backend: `/api/bars` as above.
- Frontend: one shared `FullscreenChart` layer used in all six places. It draws the
  overlay with the existing chart library, using two price scales (left for the
  benchmark, right for the stock) and the bar-size switch.
