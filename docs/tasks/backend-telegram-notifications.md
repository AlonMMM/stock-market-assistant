# Task: Phone notifications through Telegram

Status: implemented; test message delivered, live alert check pending
Owner: backend
Branch: feat/telegram-notifications

## Outcome

Each new live relative-volume alert from the collector reaches the user's phone as a
Telegram message, with Israel time, direction, move, volume and ratio.

## User-confirmed (2026-09-27)

Channel: Telegram bot. First version includes a durable send log with retry and no
duplicate after restart, a mute switch, and a test endpoint. Rate capping is deferred.

## Design

- `packages/notifications/src/telegram.ts`: message format and `sendMessage` client.
  The message shows the evaluator's values only; nothing is recomputed.
- `packages/alerts/src/events.ts`: `AlertEvents`, an in-process bus. The collector
  publishes each new stored alert (`store.alert` returns true) and knows no consumers.
  A consumer that throws or rejects is logged as `alert-listener-failed` and affects
  neither the collector nor other consumers. New consumers call `subscribe(name, fn)`.
- `packages/notifications/src/outbox.ts`: SQLite outbox keyed by `(ticker, end)` in the
  collector database. `notifyOnAlerts` subscribes it to the bus; it drains sequentially
  after each alert and every 5 s.
- Collector endpoints (collector token): `GET/PUT /notifications`,
  `POST /notifications/test`, `POST /notifications/synthetic` (labeled synthetic alert
  through the bus and outbox; not stored as an alert). Operation details: [operations](../alpaca-operations.md#telegram-notifications).
- Backtest and replay never send notifications; only the live stream enqueues.

## Limits

- The bus is in-process and not durable: a consumer that needs delivery guarantees must
  persist the event synchronously in its listener, as the outbox does.

- At-most-once: a crash between Telegram accepting a message and the outbox recording it
  leaves the row `unknown`; that alert is not resent.
- Alerts older than 15 minutes are not sent. No rate cap: a burst sends one message per
  alert, paced only by Telegram's 429 `retry_after`.
- Single chat, no per-user settings. The website does not show delivery state yet.

## Verification evidence

- `tests/notifications.test.ts`: Israel-time formatting (summer/winter), duplicate enqueue
  and reopen, backoff and `retry_after`, permanent failure, attempt limit, expiry, mute
  persistence without backlog replay, crash recovery, token never in errors.
- `tests/alert-events.test.ts`: fan-out, failing-listener isolation, unsubscribe,
  duplicate names, new-alert detection in the store.
- `tests/collector-startup.test.ts`: endpoint auth, unconfigured 409s, mute toggle,
  half-configured Telegram stops startup.
- 2026-09-27: with a real bot and the user's chat, a local collector
  (`ALPACA_ENABLED=false`) delivered the `POST /notifications/test` message to the phone.
- Not verified: an alert message through the outbox with a real bot; live alerts
  (collector's Alpaca validation pending); Railway configuration.

## Next

Set the Railway secrets (new bot token after revoking the exposed one), run the test
endpoint against Railway, then watch the first live alert.
