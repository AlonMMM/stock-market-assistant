# Feature: Score vs SPY on every alert, in real time

Status: agreed
Owner: product-ux
Spec revision: see git log for this file
Builds on: [chart-vs-spy](chart-vs-spy.md) (score formula, shared `rs-score.ts`),
[relative-volume](relative-volume.md) (the alert), [alert-analysis](alert-analysis.md)
(follow-up, unchanged).

## User and outcome

When a volume alert fires, the trader must see in the same message whether the move is
confirmed by strength against the market, and keep seeing on the site how that strength
develops. Today the vs-SPY score only arrives later in the analysis follow-up.

## Decisions (user, 2026-10-04)

- Placement: the Telegram alert and the site's alert row, at the moment the alert fires.
- Live: the site updates today's alerts ("at alert 78 → now 84") every 30 s; Telegram is
  sent once (no edits).
- Direction label combining the alert's move and the score (thresholds are proposals,
  to be validated by backtest):

| Alert move | Score at alert | Label                      |
| ---------- | -------------- | -------------------------- |
| ▲          | ≥ 60           | ▲ Long · confirmed vs SPY  |
| ▼          | ≤ 40           | ▼ Short · confirmed vs SPY |
| ▲          | ≤ 40           | ▲ Up · against SPY         |
| ▼          | ≥ 60           | ▼ Down · against SPY       |
| any        | 41–59          | ▲/▼ · moving with market   |
| any        | null           | ▲/▼ · vs SPY — (no score)  |

"Long"/"Short" describe the direction of the alert's move confirmed by relative
strength; they are not trade recommendations. The page and message never say "buy".

## Semantics

- Score: exactly the shared `rsScore` (chart-vs-spy): `round(clamp(50 + 10·excess/σ,
0, 100))`, `excess = r_stock − β·r_SPY`, % from the previous regular close to the alert
  bar's close, β = 60-session daily beta vs SPY (1 when unknown, flagged), σ = stdev of
  the stock's daily excess over the previous 20 sessions (≥ 15 needed).
- At alert time: SPY's close for the same minute. The alert must not wait for the
  analysis queue; if SPY's same-minute bar is not in yet, wait at most 3 s for it, else
  use SPY's latest bar and mark the score "SPY bar lagged" in evidence (not shown in the
  Telegram line).
- Live "now" score on the site: same formula with each symbol's latest bar and SPY's
  latest bar, for symbols with an alert today (Israel day), regular and extended
  sessions; trend arrow ↑/↓ when now − at-alert ≥ 5 / ≤ −5, else →.
- The analysis follow-up keeps its own score (same function; values agree for the same
  minute).
- Data must be real time: the collector streams SPY in addition to the watchlist, and
  runs on SIP once the user switches `ALPACA_FEED=sip` (the account has Algo Trader Plus
  since 2026-10-04). The website's fixed 15-minute SIP cutoff (`sipDelay`) is removed
  for this account; keep it configurable (e.g. `ALPACA_SIP_DELAY_MINUTES`, default 0
  in config, 15 when a deployment lacks real-time SIP).

## Contract needs

- Alert record (`/api/live` alerts, collector store, Telegram input): `vsSpy: { score:
number | null, beta: number, betaAssumed: boolean, label: "confirmed" | "against" |
"market" | "none", spyLagged: boolean }` — additive.
- `/api/live`: `strengthNow: Record<ticker, { score: number | null, at: string }>` for
  symbols with an alert today.
- Backtest alerts get the same `vsSpy` at alert time so the label thresholds can be
  validated (By symbol/Alerts can show it; a "Direction label" breakdown in the look-now
  card is a later step).
- β/σ: computed once per day in the collector from daily bars (cached in its SQLite),
  before the regular open; failures → score null, alert still sent.

## UI

- Telegram: one new line directly under the alert's headline:
  `▲ Long · confirmed vs SPY · 78/100` (or `vs SPY —`). Existing lines unchanged.
- Site alert row (Live): a "vs SPY" cell replacing nothing — the Live table's
  "Rel. strength" column becomes this alert-time score with the label tag; expanded row
  shows "at alert 78 → now 84 ↑ · β 1.4". The analysis RS score stays in the analysis
  panel.
- Backtest alert rows: the same cell (alert-time score and label).
- Colours: confirmed = green tag, against = red tag, market = grey; ▲/▼ and words always
  present.

## Acceptance scenarios

1. ▲ alert, NVDA +2.31%, SPY +0.31%, β 1.5, σ 1.2 → score 65 → "▲ Long · confirmed vs SPY
   · 65/100" in Telegram and on the site within the alert's own delivery.
2. ▲ alert with score 38 → "▲ Up · against SPY · 38/100", red tag.
3. ▼ alert with score 50 → "▼ · moving with market · 50/100", grey.
4. σ unavailable → "vs SPY —"; alert still delivered on time.
5. SPY same-minute bar arrives 1 s late → used; 5 s late → latest SPY bar used,
   `spyLagged: true`; Telegram delivery not delayed more than 3 s.
6. Site 20 min later: "at alert 65 → now 72 ↑".
7. Analysis follow-up score equals the alert-time score for the same minute.
8. With `ALPACA_SIP_DELAY_MINUTES=0`, board and day-chart include the latest minute.

## Handoff

- **Backend** (`session/backend-alert-vs-spy`): collector SPY subscription, daily β/σ
  cache, `vsSpy` on alerts (live and backtest), label function (shared, tested),
  `strengthNow` in `/api/live`, Telegram line, configurable SIP delay; tests for 1–5, 7, 8. Note for rollout: `ALPACA_FEED=sip` on Railway is a user-approved production change.
- **Frontend** (`session/frontend-alert-vs-spy`): Live and Backtest alert cells, expanded
  "at alert → now" line with trend, colours/labels; "—" when absent.
