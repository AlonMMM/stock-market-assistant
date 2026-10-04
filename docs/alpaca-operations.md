# Alpaca collector operation

The collector uses only Alpaca Market Data endpoints. It does not read an Alpaca account
or submit orders.

## Backtest API

`POST /api/backtest` reads `ALPACA_API_KEY` and `ALPACA_API_SECRET` from the server
environment and requests SIP history up to `ALPACA_SIP_DELAY_MINUTES` before now (see
[SIP delay](#sip-delay)). Without the keys it returns 503.

- Local: put both variables in an ignored `.env` file at the repository root; `npm run dev`
  loads it for the API.
- Hosted site: configure both as Worker secrets.

Example body: `{ "tickers": ["AAPL"], "from": "2026-09-14", "to": "2026-09-25",
"config": { "threshold": 3 } }`. See the [task](tasks/backend-alpaca-backtest.md).

## Railway variables

Set these on the existing collector service; never put real values in Git or chat:

- `ALPACA_API_KEY` and `ALPACA_API_SECRET`: Alpaca API credentials.
- `ALPACA_FEED=iex`: safe initial default. Use `sip` only when the account has live SIP
  (this account has Algo Trader Plus since 2026-10-04; see
  [real-time SIP rollout](#real-time-sip-rollout)).
- `ALPACA_MAX_SYMBOLS` (default 30, the free IEX stream limit): symbols on the stream.
  SPY is always streamed for the score vs SPY and takes one slot unless it is on the
  watchlist, so the default streams 29 watchlist symbols. With SIP, raise it to cover
  the watchlist plus SPY.
- `ALPACA_SYMBOLS=AAPL`: initial one-symbol validation.
- `ALPACA_ENABLED=false`: deploy and verify startup before switching to `true`.
- `COLLECTOR_TOKEN`: keep the existing random value of at least 32 characters.
- `COLLECTOR_DB=/data/alpaca.sqlite`: persistent Railway volume path.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`: optional phone notifications; set both or
  neither. `SITE_URL` (the website origin) adds an "Open in site" link to each message; it opens
  the Live view with that alert expanded (`/?alert=<ticker>&end=<UTC bar end>`). See
  [Telegram notifications](#telegram-notifications).

## Validation sequence

1. Deploy the collector with Alpaca disabled and confirm `awaiting-alpaca-activation`.
2. Add credentials as Railway secrets, keep AAPL as the only symbol, then enable it.
3. Confirm history warmup completes and WebSocket state becomes `subscribed`.
4. During an eligible session, confirm AAPL receives fresh one-minute bars and compare
   timestamp/volume with Alpaca's dashboard or another view of the same feed.
5. Expand to the 50-symbol watchlist and watch for rate-limit or stream entitlement errors.

Alpaca commonly limits an account to one connection per market-data endpoint. A 406 stream
error usually means another client is already using that feed connection. IEX volume covers
IEX executions, not consolidated US-market volume; use entitled SIP when full-market volume
is required for the production RVOL signal.

## Telegram notifications

Each new live alert is queued in the `notifications` table and sent to one Telegram chat.

1. In Telegram, message `@BotFather`, send `/newbot`, and keep the token it returns.
2. Send any message to the new bot, then open
   `https://api.telegram.org/bot<token>/getUpdates` and copy `message.chat.id`.
3. Set both as Railway secrets and redeploy.
4. `POST /notifications/test` (collector token) sends a labeled test message now; a
   502 response carries Telegram's error, such as a wrong chat ID.

`POST /notifications/synthetic` publishes a SYNTHETIC alert (ticker `TEST`) on the alert
bus, so it goes through the outbox like a live alert; the message starts with
"SYNTHETIC · not a market alert" and nothing is added to `/alerts`.

`GET /notifications` shows the channel, mute state and the 50 latest deliveries.
`PUT /notifications` with `{ "muted": true }` pauses sending without stopping the
collector; the mute state is stored in SQLite and survives restarts. Alerts raised while
muted are recorded as `muted` and are not sent after unmuting.

Delivery: one message at a time, up to 5 attempts with 5 s × 3ⁿ backoff (or Telegram's
`retry_after`); wrong token or chat fails at once. An alert older than 15 minutes is marked
`expired` instead of sent. A send interrupted by a crash is marked `unknown` and never
repeated, so an alert may be missed but is not sent twice.

## Score vs SPY

Each live alert carries `vsSpy` (score 0–100, β, label), computed before it is stored and
sent ([spec](features/alert-vs-spy.md)). The collector streams SPY with the watchlist and
evaluates no alerts for it unless SPY is on the watchlist. β/σ per watchlist symbol are
computed from SIP split-adjusted daily bars (whatever `ALPACA_FEED` is) once per US
session date: at startup, on each watchlist change, and every 5 minutes for any missing
symbol, so a new date is ready shortly after New York midnight, before the pre-market.
They are stored in the `spy_strength` table of the collector's SQLite file (pruned with
the bars). A failed daily request is logged as `spy-strength-failed` or
`spy-strength-incomplete` and retried; until then alerts go out with no score
(`vs SPY —`). At alert time the collector waits at most 3 s for SPY's bar of the same
minute, then uses SPY's newest earlier bar (`spyLagged: true`). `GET /alerts` adds
`strengthNow` (score now for symbols with an alert today, Israel day), and `GET /health`
adds `benchmark: { ticker: "SPY", lastBar }`.

## SIP delay

`ALPACA_SIP_DELAY_MINUTES` (integer 0–60, default 0) is how far behind real time the
website requests SIP data: the board, day chart, backtest and bar cache (Worker and local
API), and `scripts/backtest.ts` / `scripts/backfill-bars.ts`. 0 needs real-time SIP
(Algo Trader Plus). Alpaca's free plan excludes the most recent 15 minutes: set `15` for a
deployment without real-time SIP, or requests for recent data fail. An invalid value
stops the local API at startup and makes the Worker's API answer 500. `/api/board` and
`/api/day-chart` report the value as `delayMinutes`.

## Real-time SIP rollout

Production changes for the user to make (approved per the spec; nothing here changes them):

1. Railway collector: set `ALPACA_FEED=sip` and raise `ALPACA_MAX_SYMBOLS` to the
   watchlist size plus one (SPY), then redeploy. Confirm `/health` shows `feed: "sip"`,
   state `subscribed`, a fresh `benchmark.lastBar`, and no 406/entitlement error in logs.
2. Cloudflare Worker: `wrangler.jsonc` sets `ALPACA_SIP_DELAY_MINUTES = "0"`; deploying
   applies it. Check `/api/board` returns `delayMinutes: 0` and minutes up to now during a
   session.
3. Local API (optional): add `ALPACA_SIP_DELAY_MINUTES=0` to `.env` (0 is also the default).
4. To go back to the free plan: `ALPACA_FEED=iex`, `ALPACA_MAX_SYMBOLS=30` on Railway and
   `ALPACA_SIP_DELAY_MINUTES = "15"` in `wrangler.jsonc` (and `.env`), then redeploy both.

## Alert rule settings

`RVOL_CONFIG` (JSON) overrides the rule's defaults, e.g.
`{"todayMoveMultiple": 3}` to turn N2 on, `{"directionBars": 3}` for v3's candles, or
`{"inPlayDayRvol": 0}` to drop the ⭐ tag. Unknown or out-of-range values stop startup.
See [relative volume](features/relative-volume.md#rule-v4-rvol-v4-user-confirmed-2026-10-03).

## Alert analysis

Off unless `ANALYSIS_ENABLED=true`, which needs `ALPACA_API_KEY`/`ALPACA_API_SECRET` (it
reads Alpaca bars and news over REST, never the account or order APIs). Set
`ANTHROPIC_API_KEY` as a Railway secret for the three Claude agents; without it only the
relative-strength score and the technical scan run. The image already contains the
technical-scan Python environment (`TECHNICAL_SCAN_PYTHON`, `TECHNICAL_SCAN_SCRIPT`).
Behavior and formulas: [alert analysis](features/alert-analysis.md).

- `GET /analyses` (collector token): enabled state and the 50 latest analyses with their
  results, `status` (`pending`, `running`, `done`, `failed`, `expired`) and `delivery`
  (`sent`, `failed`, `muted`, `off`).
- `POST /analyses` with `{ "ticker": "AAPL", "end": "<alert end>" }` analyzes a stored
  alert again and sends the reply, for checking a deployment. Its web searches can see news
  published after that alert. With `"resend": true` the alert message is first sent again
  (labeled "RE-SENT", even while muted) and the analysis replies under that new message.

`GET /analyses/chart?ticker=&end=&name=01_daily.png` returns a stored chart image.

Comments (preferred): create a channel, link a discussion group (topics off) in the
channel's settings, make the bot an admin in both (channel: Post messages), and set
`TELEGRAM_CHAT_ID` to the channel id (from `getUpdates`, e.g. `-100…`). Alerts become channel
posts and the analysis appears in each post's comments. The collector must be the only
reader of the bot's updates; do not set a webhook.

Topics: in `@BotFather`, open the bot's settings and turn on topics (threaded mode) for
private chats. The collector notices within 10 minutes; from then on each alert opens its
own topic with the analysis inside. Earlier alerts stay in the main chat.

Each analysis makes three Claude Sonnet 5.5 calls (two with up to 3 web searches each);
cost and latency per alert are not measured yet. Mute (`PUT /notifications`) also mutes
analysis replies.
