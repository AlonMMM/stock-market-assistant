# Backlog

Updated: 2026-11-06

What is next for the Stock Market Assistant. This file is the source of truth; the board at
https://claude.ai/artifact/VnRvCnUXzfyXX1a3n9LCiN shows the same items in four parts, with filters and search. How every
session keeps both live: [AGENTS.md, Backlog](../AGENTS.md#backlog). Bugs are not here: they have their own dashboard.

The four parts:

- **Analysis**: what the owner sees when watching the charts and the trades: a question about a trade, something that
  looks off, an improvement idea that came from watching.
- **Research**: open threads in the research logs: a candidate waiting for the owner's yes, a test that came close
  to a candidate and was never closed, a test that did not go deep enough. Every item names its log entry in `log`.
- **App**: the application itself: how it looks and works (UX / UI) and the backend behind it.
- **Data & Infra**: the data, the infrastructure, how we run things and how we run them from anywhere.

Within a part, the first item comes first.

## Item format

One `###` heading per item under its part, then its fields as `- key: value` lines, a blank line and the notes:

- `id`: unique, lowercase words joined by dashes; never reused.
- `status`: one of open, active (being worked on), waiting (blocked; say on what in `waiting`), done.
- `tags`: topics to filter by, comma-separated (for example Main bot, Volume bot, Exits, Charts, Backtest, Deploy).
- `waiting` (optional): what the item is blocked on: a person, a key, a decision, another item.
- `log` (Research items): the research log entry it comes from, as `file: heading` (the logs are on the
  `research/indi-v2` branch, `docs/research/`).
- `source`: where it came from (a PR, a doc, a session, the board).
- `done` (done items only): the date and the PR or session that finished it.

Each part keeps its latest 10 done items. `npm run backlog` checks the file and prints the items as JSON for the
board. The board's page is [backlog-board.html](backlog-board.html): republish it to the same URL with the Artifact
tool (`url`) after a change to the page; its items live in the page's store (`items/<id>`), written from that JSON.

The backlog before 2026-11-06 (Now / Next / Later lanes) is in git history; older acceptance criteria are in
[the October 15 product backlog](product-backlog.md).

## Analysis

## Research

### Main bot 2.10: run the live check

- id: main-210-live-check
- status: active
- tags: Main bot, Live check
- log: bots.md: Champion (Main bot)
- source: Research log, 2026-11-02

2.10 has been the champion since 2026-11-02, but stage 5 (`bot-live-check`: one month of the app's backtest against
the research twin trade by trade, and the end-to-end run) has not run on it. The twin had to be brought up from 2.7.0
to 2.10 first; the 2026-11-06 commits record app vs twin 40 of 45 trades identical. Left: explain or fix the other 5,
then the end-to-end run.

### Volume 1.3.0: run the live check

- id: volume-130-live-check
- status: open
- tags: Volume bot, Live check
- log: bots.md: The Volume bot
- source: Research log, 2026-11-04

1.3.0 (the shock must also be at least 3x the day's pace) has been live as the candidate since 2026-11-04. Stage 5 has
not run on it, nor on 1.1.0 or 1.2.0 before it. It becomes champion only when the live check passes.

### Sell above the bid: decide what is left

- id: main-sale-above-bid
- status: waiting
- tags: Main bot, Exits, Fills
- waiting: The owner's call: stop here, try a live trial, or test the narrow case
- log: best-algorithms.md: Sell above the bid: from the mid, stepped down to the bid over 5 minutes
- source: Research log, 2026-11-04 to 11-06

Candidate 2.11 (sell from the mid, stepped down to the bid over 5 minutes) was withdrawn on 2026-11-05: a backtest bug
booked a stale bid, and with real fill sizes looks 3-4 were not better or tied. The 2026-11-06 release checks still
went on (SL_TICK, SL_BUSY, SL_LATE). Not closed: (1) the one case that looked real, wide-spread morning-gap sales at
09:41 where the bid rose into the limit (PANW, BA), never tested on its own; (2) a live trial on real sales, the only
way to prove a fill; (3) two live risks the audit found: the broker stop is off during the sale window, and only one
working order per symbol (508 sales came within 5 minutes of the previous one).

### Strength exit after 15 minutes at t 1.0: close to a candidate

- id: main-strength-dwell
- status: open
- tags: Main bot, Exits
- log: best-algorithms.md: The strength exit: t 1.0 held 15-45 minutes, on top of 0.5
- source: Research log, 2026-11-06

dw15 (also sell when t stays at 1.0 or under for 15 minutes) tied 2.10: check -0.4% fair / -0.5% Favorites, no giant
touched, the changed check trades better (fair -$52K to -$33K, Favorites -$14K to +$1K). The account is still a little
under 2.10 and the worst drop is higher (23.6% to 25.1%). Open question: is a smaller drop in losers worth a tie in
money, or a variant (dw15 on the D2 legs only, a dwell at 0.75) worth one more look?

### Pyramid on confirmed D2 moves + trim the weak picks

- id: main-pyramid-trim
- status: open
- tags: Main bot, Sizing
- log: bots.md: Next to test (saved)
- source: Research log, 2026-10-25

Saved by the owner on 2026-10-25 ("save it for now; we build on top of it"): $1,667,924 / 12% on 2.5 + cheap + the
next strike for D2. Never re-run on today's champion (2.10, the fixed walk, the tune / check split).

### Re-entry with D2 after an SPY-driven stop

- id: main-reentry-d2
- status: waiting
- tags: Main bot, Entries
- waiting: The owner's three answers (asked 2026-10-25)
- log: bots.md: Next to test (saved)
- source: Research log, 2026-10-25

After an entry-day stop that was mostly SPY's doing, re-enter when D2 since the exit >= 1.5 with t >= 1.2 and volume

> = 1.5x; R0 control without D2. Not run.

### Buy near the fair price (a microprice limit)

- id: main-fair-limit-entry
- status: open
- tags: Main bot, Entries, Fills
- log: best-algorithms.md: Second-level entries; the fair-price limit re-checked
- source: Research log, 2026-10-27

Better on the minute model, unproven on the second data (2026-10-27). Not re-tested since the quote-minute fix
(2026-11-01) or on 2.10. The size-aware fill proof built for the sale test (Databento prints with sizes) could settle
it.

### The fading shock: a lead waiting for more trades

- id: volume-fading-shock
- status: open
- tags: Volume bot, Exits
- log: volume-bot.md: Exits from the trade review
- source: Research log, 2026-11-03

After a shock, sell when the volume falls under 3x usual within 5 minutes (B5): better on both halves (+$1.2K /
+$2.0K, 5 of 6 trades better, no giant touched, same drop), but only 6 trades and a level chosen after the look.
Re-test when more shock trades exist, with the level set before the run.

## App

## Data & Infra

### An MCP server on our database, to run backtests from any computer

- id: infra-mcp-backtest
- status: open
- tags: MCP, Backtest, Remote
- source: The owner, 2026-11-06

Reach the database (D1 and the bar / book stores) through an MCP server, so a backtest can be started and read from
any computer or a cloud session, not only from the Mac that holds the research worktree. To decide: which runs it
exposes (the app's backtest engine, the research scripts or both), read-only vs runs that write, and how it is
authorized.
