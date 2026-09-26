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
