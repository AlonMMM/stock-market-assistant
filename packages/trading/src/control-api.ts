// Position controls on the site (user 2026-10-12): the Portfolio page may
// resize or close a position, for one signed-in person only. The site holds
// no broker key; it forwards to the trading service, which runs the same
// checks as any other order.

export interface ControlConfig {
  // The only email that may trade from the site. Nobody may when it is unset.
  owner?: string | undefined;
  url?: string | undefined;
  // The trading service's full token; the read-only one cannot send orders.
  token?: string | undefined;
}

export interface ControlAccess {
  canTrade: boolean;
  // Why not, in words for the page; absent when trading is allowed.
  reason?: string;
}

/** Who is asking, as verified by the site's sign-in; null when nobody is. */
export type Identity = { email: string } | null;

export function controlAccess(
  config: ControlConfig,
  identity: Identity,
): ControlAccess {
  if (!config.owner || !config.url || !config.token)
    return {
      canTrade: false,
      reason: "Position controls are not set up on this site",
    };
  if (!identity)
    return {
      canTrade: false,
      reason: "Position controls need a verified sign-in",
    };
  return identity.email.trim().toLowerCase() ===
    config.owner.trim().toLowerCase()
    ? { canTrade: true }
    : {
        canTrade: false,
        reason: "Only the account owner can change positions",
      };
}

type Answer = { status: number; body: unknown };

const occ = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const jobPath = /^\/api\/portfolio\/control\/jobs\/([\w-]{1,64})$/;

export interface ControlRequest {
  method: string;
  path: string; // /api/portfolio/control or …/jobs/<id>
  body?: unknown;
  // The page's own address and the Origin header of the request: a request
  // another site makes the browser send is refused.
  origin: string;
  requestOrigin: string | null;
}

/**
 * `GET  /api/portfolio/control`: whether this person may trade.
 * `POST /api/portfolio/control` `{ contract, qty }`: bring the position to
 * `qty` contracts (0 closes it).
 * `GET  /api/portfolio/control/jobs/<id>`: how that order is doing.
 */
export async function handleControl(
  config: ControlConfig,
  identity: Identity,
  request: ControlRequest,
  fetcher: typeof fetch = fetch,
): Promise<Answer> {
  const access = controlAccess(config, identity);
  const job = jobPath.exec(request.path)?.[1];
  if (request.method === "GET" && !job) return { status: 200, body: access };
  if (!access.canTrade) return { status: 403, body: { error: access.reason } };
  let path: string;
  let body: unknown;
  if (job) {
    if (request.method !== "GET")
      return { status: 405, body: { error: "Use GET" } };
    path = `/v1/jobs/${job}`;
  } else {
    if (request.method !== "POST")
      return { status: 405, body: { error: "Use GET or POST" } };
    if (request.requestOrigin !== request.origin)
      return {
        status: 403,
        body: { error: "This request did not come from the site itself" },
      };
    const b = (
      request.body && typeof request.body === "object" ? request.body : {}
    ) as { contract?: unknown; qty?: unknown };
    if (typeof b.contract !== "string" || !occ.test(b.contract))
      return { status: 400, body: { error: "contract is not valid" } };
    if (typeof b.qty !== "number" || !Number.isInteger(b.qty) || b.qty < 0)
      return {
        status: 400,
        body: { error: "qty must be a whole number of contracts, 0 or more" },
      };
    path = "/v1/resize";
    // `via` is kept in the trading service's log with the request.
    body = { contract: b.contract, qty: b.qty, via: "site" };
  }
  let response: Response;
  try {
    response = await fetcher(new URL(path, config.url), {
      method: request.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      status: 502,
      body: {
        error: timedOut
          ? "The trading service did not answer in time. The order may have been received: check the position before trying again."
          : "The trading service could not be reached. Nothing was sent.",
      },
    };
  }
  const answer: unknown = await response.json().catch(() => ({
    error: `The trading service answered HTTP ${response.status}`,
  }));
  // The service's own credential failing is a setup fault, not the visitor's.
  const status =
    response.status === 401 || response.status === 403 ? 502 : response.status;
  return { status, body: answer };
}
