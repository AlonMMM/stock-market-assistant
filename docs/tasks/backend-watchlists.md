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

## Frontend (2026-10-17, branch feat/watchlists-ui)

- Watchlist section: list chips above the table ("All tickers" is the engine list), "+ New
  list", and "Edit <name>" to add/remove tickers, rename or delete (with a confirm step).
  The chosen list is remembered per browser.
- Caching (user: no reload on every tab switch): `usePolling` keeps the last answer per
  address while the page is open; a section opened again shows it at once and loads again
  only when it is due. Applies to every polled view.
- Checked in headless Chromium at 390 and 1280 px against the local API with SYNTHETIC
  lists and live Alpaca prices: switching lists, creating one, and leaving the section and
  coming back made 0 board requests; no page errors.

## Next

"Add to watchlist" from a stock's detail, and drag to reorder lists and symbols.
