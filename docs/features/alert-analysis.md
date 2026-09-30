# Alert analysis

Each new live relative-volume alert gets a follow-up: a relative-strength score against
SPY and the stock's sector benchmark, a technical read from the user's `technical-scan`
skill, the current sentiment, and the newest news that may explain the move. Decision
support, not investment advice; no orders are placed.

User-confirmed 2026-09-28/29: Claude Sonnet 5.5 runs the agents; news comes from Alpaca
News plus Claude web search; results are stored and sent as a Telegram reply under the
alert; the technical analysis runs the user's `technical-scan` skill script as-is, without
options open interest for now.

## Relative strength score (user-confirmed 2026-09-28)

Hypothesis (user): a stock that does not move with the index has its own catalyst and is
strong. Computed separately for SPY (`market`) and for the watchlist's sector benchmark
(`sector`, e.g. MSTR → IBIT, chosen by the syncing agent; omitted when none). SPY is not
scored against itself. All values are percent.

Two horizons, from the alert's own bars:

- **window:** the alert window. The stock's change is the alert's `move`; the benchmark's
  is its close at the alert bar's end vs its close `window` minutes earlier.
- **day:** previous regular-session close → the alert bar close.

For each benchmark B and horizon: `excess = r_stock − β · r_B`, where β is the OLS beta
of daily close-to-close returns over the 60 sessions before the alert day (split-adjusted,
as on the day chart; β = 1 when fewer than 40 paired returns, flagged `betaAssumed`).

Relation, on the day horizon:

| Relation      | Condition (checked in this order)                              |
| ------------- | -------------------------------------------------------------- |
| `independent` | \|r_B\| < 0.3% (index flat, stock moved)                       |
| `against`     | r_stock and r_B have opposite signs                            |
| `with`        | \|β · r_B\| ≥ 50% of \|r_stock\| (the index explains the move) |
| `outperform`  | same sign, the index explains < 50%                            |

Score (0–100) = clamp(50 + 10 × excess_day ÷ σ, 0, 100), rounded. σ is the sample standard
deviation of the stock's daily excess vs B over the 20 sessions before the alert day
(needs ≥ 15; otherwise no score). Above 50 the stock is stronger than B, below 50 weaker.
The message reads it with the alert's direction: a down alert weaker than the index
"confirms the alert".

Evidence kept per benchmark: β, `betaReturns`, both horizons with the benchmark bar ends
used, σ. The benchmark value is its last bar at or before the alert bar; a missing or stale
bar makes that horizon null rather than substituting another time. Bars after the alert
are never read.

## Technical analysis (the user's technical-scan skill)

`packages/analysis/technical-scan/analyze.py` is the skill's script, vendored with one
change (options optional; see its README). Inputs, all regular session, from Alpaca:

- daily: 125 split-adjusted sessions before the alert day, ticker and benchmark;
- hourly: the collector's stored one-minute bars (20 sessions), aggregated like IBKR's RTH
  bars (9:30–10:00, then on the hour);
- 5-minute: the last two sessions up to the alert bar, ticker and benchmark.

The scan's benchmark is the sector benchmark when the watchlist names one, else SPY. Claude
writes the skill's "bottom line" from `summary.json`: an immediate and a follow-through
take with a lean, one or two drivers, nearest support and resistance, in options terms
(the user trades options). Chart `06_trade_levels.png` is attached under the analysis.

## Sentiment and news agents

One Alpaca News request covers the three days before the alert. The **sentiment** agent
gets all of it plus up to 3 web searches and returns positive/negative/mixed/neutral with
a confidence. The **news** agent gets the items since the previous regular close plus up
to 3 web searches and says whether news explains the move (yes/partly/no/unknown), naming
a listed item by id or an https web source. Timing is shown relative to the alert; the
message computes it from the item's own timestamp.

News, search results and pages are treated as data in the prompts. Agents report through a
strict `submit_report` tool; a malformed or missing report, a refusal, or an API error is
recorded as that agent's error and does not stop the others.

## Flow and failure behavior

Collector alert bus → `analyses` table (SQLite, keyed like `alerts`) → after 5 s, market
data (benchmark minute bars, daily bars) → score + scan + agents in parallel → stored
result → Telegram reply. Two alerts run at a time.

- Synthetic alerts are ignored. Backtest and replay never analyze.
- Market-data failures retry up to 3 attempts, 15 s × 3ⁿ apart; then `failed`.
- A request older than 30 minutes when its turn comes is `expired`.
- A restart runs an interrupted analysis again, so its reply can be sent twice when a
  crash lands between sending and recording.
- Mute (`PUT /notifications`) also mutes the analysis replies; results are still stored.

## Telegram layout (user-confirmed 2026-09-29)

When topics are enabled for the bot's private chat (BotFather, Bot API 9.3; checked with
`getMe.has_topics_enabled`, cached 10 minutes), each alert opens its own topic named like
`SMCI ▲ +0.79% · 28/09, 18:22` (Israel time), and the alert plus every analysis part are
posted inside it: relative strength, technical (bottom line and the skill's numbers:
pivots, VWAP, volume profile, swing levels, β 60d/20d with regime shift, alpha, RS
rotation, divergence windows, support/resistance ladder), the charts as one album,
sentiment, and news with a link to the site. With topics off, or when creating a topic
fails, the alert goes to the main chat and each part replies to it. `delivery` is
`partial` when some parts failed.

## Telegram channel with comments (user-confirmed 2026-09-30)

When `TELEGRAM_CHAT_ID` is a channel with a linked discussion group, each alert is a channel
post and every analysis part is a comment on it: a reply, in the discussion group, to the
post's automatic copy there. The collector finds the group from `getChat.linked_chat_id`
and reads only message updates (`getUpdates` long polling, started on first use) to match
copies to posts. If no copy appears within 60 s, the parts go to the group without a reply
(`analysis-comment-missing` is logged). A group with topics on gets a topic per alert; a
private chat needs the bot's threaded mode.

## On the site

`GET /api/live` adds `analysis: {status, error, result}` to each live alert that has one
(a collector without analyses leaves alerts unchanged). `GET /api/live/chart?ticker&end&name`
serves a stored chart through the site (collector `GET /analyses/chart`). The Live view's
expanded alert row, which the Telegram link opens, shows the scores, the technical bottom
line with the same numbers and the charts, sentiment and news. The collapsed row shows the
SPY score. Charts are kept 60 days.

## Data limitations

- IEX feed by default: volume is IEX-only (a small share of consolidated volume), and
  closes are IEX prints. The score uses closes only; the technical scan's volume profile
  is proportionally meaningful, not absolute. The prompts say so.
- Sector ETFs may trade sparsely on IEX; a stale bar nulls the window horizon.
- No options open interest (call wall, put wall, max pain) yet.
- Pre-market and after-hours alerts: the scan uses regular-session bars only.
