# Task: the bot trades its own paper account; Bot trades tab

Status: implemented, deploy pending
Owner: backend (the Portfolio tab included at the user's request)
Branch: feat/bot-account
Spec/contract revision: user request 2026-10-23 ("I create one more paper account - can the bot
use it? connect it - add another tab in the portfolio - bot trades and show there the trades
from the bot")

## Outcome

The Indi bot trades a second Alpaca paper account of the owner's, so its trades and the
user's own no longer mix. The Portfolio page gets a **Bot trades** tab that shows that
account: value, open P&L, positions, open orders and closed trades with the P&L chart.

## Scope and exclusions

- Trading service: a second broker account record for the owner, `owner-bot` (Alpaca,
  paper, not the default), added once `BOT_ALPACA_API_KEY` and `BOT_ALPACA_API_SECRET`
  are set (`apps/trader/src/seed-bot.ts`). The bot's calls go through a trader built on
  that account (`Traders.forAccount`), with the owner's validator, risk manager, Telegram
  channels and stop watch, and its own records scope `owner/owner-bot`. Without the two
  variables the bot keeps trading the owner's default account, as before.
- Naming a broker (`X-Trader-Broker: alpaca`, the connector, the Trade page) still means
  the owner's default account. The bot's account is reached by id only.
- Site: `GET /api/portfolio/bot` and `GET /api/portfolio/bot/history?period=` answer the
  bot account from `BOT_ALPACA_API_KEY` / `BOT_ALPACA_API_SECRET` on the Worker (and the
  local API's environment), 503 with a clear message when unset. Read-only: no position
  controls, no order editing, since the owner's controls act on the owner's account.
- Not changed: the 🤖 Bot tab (signals, scan, the bot's own log), the Orders tab (the
  owner's decisions), market data (the owner's keys), Telegram.
- Not done: the bot's decisions on the Orders tab (they are now under the bot's scope);
  the Bot chip on Live trades and History becomes moot once the accounts are separate.

## Switches

| Setting                   | Where              | Effect                                                  |
| ------------------------- | ------------------ | ------------------------------------------------------- |
| `BOT_ALPACA_API_KEY`      | trader env, Worker | The bot's paper account key (Alpaca dashboard, Paper)   |
| `BOT_ALPACA_API_SECRET`   | trader env, Worker | Its secret                                              |
| both unset on the trader  |                    | The bot trades the owner's default account (as before)  |
| both unset on the Worker  |                    | The Bot trades tab says the account is not connected    |
| set, then removed, trader | after a restart    | The bot does not run at all (logged), the account stays |

## Acceptance criteria

- With the variables set, the trader logs `the bot trades its own account "owner-bot"`;
  every bot buy, sell and stop is on that account; the owner's Trade page, connector and
  Orders tab are unchanged.
- `traders.all()` includes the bot account, so its stops and short checks are watched.
- The Bot trades tab shows the bot account's totals, positions, orders and closed trades,
  refreshed every 5 s (history every minute), and never shows the owner's account.
- Without the Worker variables the tab shows the 503 message, not a blank page.

## Verification evidence

- `tests/traders.test.ts`: the bot account is seeded once from its two variables, reached
  by id, keeps its own records, and `all()` watches it; naming `alpaca` still gives the
  owner's default. `tests/worker.test.ts`: the bot routes answer 503 without keys and send
  only the bot's key to the paper endpoint with them.
- `npm run check` (see the commit for the run's result).
- Not verified here: a real run on the new paper account (needs the deploy below).

## Deploy and connect (after merge, from a clean `origin/main`)

1. Railway, trader service: set `BOT_ALPACA_API_KEY` and `BOT_ALPACA_API_SECRET` (Railway
   redeploys the service; the log then shows `added the bot's own Alpaca paper account`
   and `the bot trades its own account "owner-bot"`).
2. Worker: `npx wrangler secret put BOT_ALPACA_API_KEY` and `…_SECRET`, then deploy.
3. Alpaca dashboard: enable options trading on the new paper account at the same level
   as the old one, or the bot's buys are refused.
4. The secret was pasted into a chat; regenerate it in the dashboard afterwards and
   update both places.
