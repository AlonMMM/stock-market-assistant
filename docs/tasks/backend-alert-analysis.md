# Task: Analyze each live alert

Status: implemented; not yet run against live Alpaca, Claude or Telegram
Owner: backend
Branch: feat/alert-analysis
Spec: [alert analysis](../features/alert-analysis.md)

## Outcome

When the collector raises an alert, the user receives, under the alert's Telegram
message, a relative-strength score vs SPY and the sector benchmark, the technical-scan
bottom line with its level chart, the stock's sentiment, and the newest news that may
explain the move.

## User-confirmed (2026-09-28/29)

- Four parts: technical analysis, sentiment, fresh news, relative-strength score vs SPY
  and sector (formula in the spec).
- Claude Sonnet 5.5; Alpaca News + web search; Telegram reply + stored results.
- Technical analysis = the user's `technical-scan` skill (AlonMMM/stock-scanner), run
  as-is; options open interest skipped for now.

## Design

- `packages/analysis/src/relative-strength.ts`: the score (pure).
- `packages/analysis/src/technical.ts`: Alpaca bars → the skill's JSON inputs, runs the
  vendored `technical-scan/analyze.py`, reads `summary.json` and chart 06.
- `packages/analysis/src/agents.ts`: Claude loop (strict `submit_report` tool, optional
  `web_search_20260209`, adaptive thinking at medium effort, server-side fallback
  `"default"`), and the three agent specs.
- `packages/analysis/src/news.ts`: Alpaca News client.
- `packages/analysis/src/pipeline.ts`: data loading, analysis, `AnalysisQueue`.
- `packages/analysis/src/format.ts`: Telegram message and threaded delivery.
- Telegram: `send` returns the message id and can reply; `sendPhoto`; the outbox stores
  each alert's message id (`message_id` column added to existing databases).
- Collector: `ANALYSIS_ENABLED=true` (opt-in, needs Alpaca keys), `ANTHROPIC_API_KEY`
  (optional; without it the score and scan still run). Endpoints (collector token):
  `GET /analyses` (50 latest with results), `POST /analyses {ticker, end}` re-runs a
  stored alert. Image: Python venv with the script's pinned libraries.

## Contract notes for Frontend / Integration

`GET /analyses` rows: `{ticker, end, status, attempts, error, delivery, result}`;
`result` is `AnalysisResult` in `pipeline.ts`. Not yet proxied by the site API. The
decisions above are recorded here and in the spec, not yet in `docs/decisions.md` or
`docs/state.md` (Integration).

## Verification evidence (2026-09-29)

- `npm run check`: exit 0 — format, types, 107 tests (106 pass, 1 opt-in skipped), build.
  `npm run doctor` passes; `git diff --check` clean.
- `tests/relative-strength.test.ts`: against/with/outperform/independent at the 0.3% and
  50% boundaries, exact β and σ from constructed returns, clamping, β fallback, stale and
  missing benchmark bars, no bars after the alert.
- `tests/alert-analysis.test.ts`: RTH aggregation, script inputs/outputs and cleanup,
  script failure, the agent loop (pause_turn, nudge, refusal, invalid report, API error
  without secrets), news parsing, queue dedupe/retry/expiry/restart/re-run, synthetic
  alerts ignored, message format (Israel time, escaping), threaded delivery and mute.
- Opt-in `TECHNICAL_SCAN_PYTHON=<python with requirements.txt>`: the vendored script
  runs on the converted synthetic series. Passed locally on Python 3.12 and 3.11.
- Vendored script vs the original on the skill's NVDA 2026-09-19 example: identical
  `summary.json` (apart from `generated_at`) on Python 3.12 and 3.11 with the pinned
  libraries. numpy is pinned to 2.4.6 because 2.5 has no Python 3.11 (bookworm) wheels;
  x86_64 and arm64 wheels exist for every pin.
- `tests/collector-startup.test.ts`: opt-in switch, key requirement, endpoint auth and
  errors.
- Not verified: the Docker image build (the local Docker VM could not reach Docker Hub or
  deb.debian.org), live Alpaca News/REST responses, real Claude calls (cost and latency
  per alert unmeasured), Telegram photo upload, Railway.

## Next

1. Deploy with `ANALYSIS_ENABLED=true` and `ANTHROPIC_API_KEY`, then `POST /analyses` for a
   stored alert and check the Telegram reply.
2. Measure Claude cost and latency per alert; tune effort and web-search limits.
3. Frontend: show `result` on the Live view alert row.
4. Options open interest source (Alpaca option contracts, previous-day OI) if wanted.
