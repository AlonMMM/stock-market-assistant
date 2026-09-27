# Alpaca collector operation

The collector uses only Alpaca Market Data endpoints. It does not read an Alpaca account
or submit orders.

## Backtest API

`POST /api/backtest` reads `ALPACA_API_KEY` and `ALPACA_API_SECRET` from the server
environment and requests SIP history (the most recent 15 minutes are excluded). Without
them it returns 503.

- Local: put both variables in an ignored `.env` file at the repository root; `npm run dev`
  loads it for the API.
- Hosted site: configure both as Worker secrets.

Example body: `{ "tickers": ["AAPL"], "from": "2026-09-14", "to": "2026-09-25",
"config": { "threshold": 3 } }`. See the [task](tasks/backend-alpaca-backtest.md).

## Railway variables

Set these on the existing collector service; never put real values in Git or chat:

- `ALPACA_API_KEY` and `ALPACA_API_SECRET`: Alpaca API credentials.
- `ALPACA_FEED=iex`: safe initial default. Use `sip` only when the account has live SIP.
- `ALPACA_SYMBOLS=AAPL`: initial one-symbol validation.
- `ALPACA_ENABLED=false`: deploy and verify startup before switching to `true`.
- `COLLECTOR_TOKEN`: keep the existing random value of at least 32 characters.
- `COLLECTOR_DB=/data/alpaca.sqlite`: persistent Railway volume path.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`: optional phone notifications; set both or
  neither. `SITE_URL` optionally adds the website link to each message. See
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

`GET /notifications` shows the channel, mute state and the 50 latest deliveries.
`PUT /notifications` with `{ "muted": true }` pauses sending without stopping the
collector; the mute state is stored in SQLite and survives restarts. Alerts raised while
muted are recorded as `muted` and are not sent after unmuting.

Delivery: one message at a time, up to 5 attempts with 5 s × 3ⁿ backoff (or Telegram's
`retry_after`); wrong token or chat fails at once. An alert older than 15 minutes is marked
`expired` instead of sent. A send interrupted by a crash is marked `unknown` and never
repeated, so an alert may be missed but is not sent twice.
