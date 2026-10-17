# Task: Multiple watchlists

Status: backend completed (in review); frontend not started
Owner: backend
Branch: feat/watchlists

## Outcome

User request (2026-10-17): "support multiple watchlists". The user keeps named lists of
stocks and picks which one the Watchlist section shows.

## Decisions

- ASSUMPTION (to confirm): a watchlist is only for viewing. It does not change what the
  collector streams or alerts on. That stays the engine list (Manage engine tickers),
  shown as the built-in list "All", first and not editable through this API. A symbol in
  a watchlist that is not on the engine list still gets its board row (prices, Rel vol,
  vs SPY) from Alpaca, but no live alerts.
- Up to 20 lists, 200 symbols each, names up to 40 characters, unique ignoring case;
  "All" is reserved. Symbols are upper-cased, kept unique and kept in the user's order.

## Contract (for Frontend)

- `GET /api/watchlists` → `{ lists: [{ id, name, tickers[], builtIn? }] }`, `"all"` first.
- `POST /api/watchlists` `{ name, tickers? }` → 201 with the list.
- `PATCH /api/watchlists/<id>` `{ name?, tickers?, add?, remove? }` → the list.
  `tickers` replaces the symbols in that order (use it for drag-to-reorder); `add`
  appends; `remove` takes out.
- `DELETE /api/watchlists/<id>` → `{ deleted }`.
- `POST /api/watchlists/order` `{ ids }` → `{ lists }` in the new order.
- `GET /api/board?list=<id>` → the board for that list's symbols (404 for an unknown
  list); no `list` or `list=all` is the engine list, as before. `sectors=1` still works
  with it.
- Errors are `{ error }`: 400 bad input, 404 unknown list, 409 duplicate name, too many
  lists, or a change to "All".

Storage: D1 tables `watchlists` and `watchlist_symbols`, created on first use (the local
API uses the same SQLite file as the bar cache). No migration step.

## Verification evidence

- `npm run typecheck`, `npm test` (425: 424 pass, 1 skipped, 0 fail), `npm run build`;
  Prettier clean on every changed file.
- `tests/watchlists.test.ts`: create/list/rename/delete, add/remove/replace/reorder,
  refusals (duplicate, reserved, empty or long names, bad symbols, the size limits, a
  change to "All", no database), and `/api/board?list=` through both the Worker and the
  local server on SQLite with SYNTHETIC empty market data.
- Not run: the hosted D1 database.

## Next

Frontend: a list switcher on the Watchlist section (remembered per browser), create,
rename and delete, add/remove symbols from a row, and "Add to watchlist" from a stock's
detail.
