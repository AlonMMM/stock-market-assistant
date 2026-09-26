# Task: Invite-only Cloudflare deployment of the website

Status: active
Owner: backend
Branch: feat/cloudflare-deploy
Spec/contract revision: 7d43b66

## Outcome

The website and its API (`apps/api/src/worker.ts`) run on the user's own Cloudflare
account at a public URL. Only emails approved in Cloudflare Access can open it.

## Scope and exclusions

In scope: Wrangler config, deploy script, in-Worker verification of the Access JWT.
Deferred: custom domain, per-user rate limiting of `/api/backtest`, CI deploys,
connecting the Worker to the Railway collector, retiring the Sites publication.
The collector is a separate deployable (`Dockerfile.collector`, Railway).

## Design (user-confirmed: invite-only, own Cloudflare account)

- Cloudflare Access (Zero Trust) protects the whole hostname with an email allow-list.
- The Worker also verifies the `Cf-Access-Jwt-Assertion` header (or `CF_Authorization`
  cookie): RS256 signature against `<team>/cdn-cgi/access/certs`, audience, issuer,
  expiry, email. Any failure returns 401, including for static pages. This keeps the
  Worker closed if the edge policy is misconfigured or a URL is not covered by Access.
- Protection is enabled when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set; one without
  the other returns 500. Without both, the Worker stays open (tests, Sites).
- `wrangler.jsonc` ships placeholder values, so a deploy before Access setup fails closed.
- `/api/backtest` already caps requests at 10 tickers and 20 sessions.

## Setup steps (user, Cloudflare dashboard)

1. Zero Trust → Settings: choose a team name (`<team>.cloudflareaccess.com`).
2. Access → Applications → Add → Self-hosted: the Worker hostname
   (`stock-market-assistant.<subdomain>.workers.dev` or a custom domain).
   Policy: Allow, Include → Emails → the approved list. Login: One-time PIN.
3. Copy the application's Audience (AUD) tag into `wrangler.jsonc` with the team domain.
4. `npx wrangler secret put ALPACA_API_KEY` and `ALPACA_API_SECRET`.
5. `npm run deploy`.

## Risk

Alpaca market-data terms may treat showing data to other people as redistribution.
Keep the allow-list to the owner until the Alpaca agreement is checked.

## Verification evidence

`tests/access.test.ts` covers valid header/cookie tokens and rejects missing, malformed,
expired, wrong-audience, wrong-issuer, email-less, wrong-key and unknown-kid tokens,
plus incomplete configuration. `npm run check` passed locally (30 tests, build).

2026-09-26: first deploy with placeholder Access values (fails closed) to
https://stock-market-assistant.stock-market-assistant.workers.dev (version
f6a948f9). The HTTP 401 response was not confirmed from the development Mac: its
network fails TLS to that host (curl exit 35). The Wrangler OAuth token has no Access
scope, so the Access application must be created in the dashboard.

Second deploy (version fa46c4fe) with team `broad-boat-f733` and the application AUD.
Unauthenticated requests now get a 302 to the Access login; the certs endpoint returns 200. Alpaca secrets are not yet set, so backtest returns 503.

## Handoff

Pending: Alpaca Worker secrets, live check that an unapproved email is
refused and an approved one sees the site.
