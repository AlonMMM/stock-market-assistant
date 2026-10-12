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
const root = "/api/portfolio/control";

export interface ControlRequest {
  method: string;
  // /api/portfolio/control, or under it: jobs/<id>, chain, check, buy.
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  // The page's own address and the Origin header of the request: a request
  // another site makes the browser send is refused.
  origin: string;
  requestOrigin: string | null;
}

const bad = (error: string): Answer => ({ status: 400, body: { error } });

/** The order fields a page may send; nothing else is passed on. */
function order(body: unknown): Record<string, unknown> | Answer {
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  if (typeof b.contract !== "string" || !occ.test(b.contract))
    return bad("contract is not valid");
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const hasPct = b.sizePct !== undefined;
  const hasQty = b.qty !== undefined;
  if (hasPct === hasQty) return bad("Give a size: sizePct or qty, not both");
  if (hasPct && !num(b.sizePct)) return bad("sizePct must be a number");
  if (hasQty && !(Number.isInteger(b.qty) && (b.qty as number) >= 1))
    return bad("qty must be a whole number of contracts");
  if (b.stopPct !== undefined && !num(b.stopPct))
    return bad("stopPct must be a number");
  if (b.force !== undefined && typeof b.force !== "boolean")
    return bad("force must be true or false");
  return {
    contract: b.contract,
    ...(hasPct ? { sizePct: b.sizePct } : { qty: b.qty }),
    ...(b.stopPct === undefined ? {} : { stopPct: b.stopPct }),
    ...(b.force === true ? { force: true } : {}),
  };
}

/**
 * Everything here is for the owner only, except the first line.
 * `GET  /api/portfolio/control`: whether this person may trade.
 * `POST /api/portfolio/control` `{ contract, qty }`: bring the position to
 * `qty` contracts (0 closes it).
 * `GET  …/jobs/<id>`: how that order is doing.
 * `GET  …/chain?underlying=&right=&expiry=`: strikes to pick from.
 * `POST …/check` `{ contract, sizePct | qty, stopPct?, force? }`: what a buy
 * would be and each check; sends nothing.
 * `POST …/buy` with the same fields: buys.
 */
export async function handleControl(
  config: ControlConfig,
  identity: Identity,
  request: ControlRequest,
  fetcher: typeof fetch = fetch,
): Promise<Answer> {
  const access = controlAccess(config, identity);
  const job = jobPath.exec(request.path)?.[1];
  const sub = request.path.startsWith(`${root}/`)
    ? request.path.slice(root.length + 1)
    : "";
  if (request.method === "GET" && request.path === root)
    return { status: 200, body: access };
  if (!access.canTrade) return { status: 403, body: { error: access.reason } };
  let path: string;
  let body: unknown;
  if (request.method === "GET") {
    if (job) path = `/v1/jobs/${job}`;
    else if (sub === "chain") {
      const q = request.query ?? new URLSearchParams();
      const underlying = q.get("underlying") ?? "";
      const right = q.get("right") ?? "";
      const expiry = q.get("expiry") ?? "";
      if (!/^[A-Za-z][A-Za-z.]{0,5}$/.test(underlying))
        return bad("underlying is not a ticker");
      if (right !== "call" && right !== "put")
        return bad("right must be call or put");
      if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry))
        return bad("expiry must be a date");
      path = `/v1/chain?${new URLSearchParams({
        underlying: underlying.toUpperCase(),
        right,
        ...(expiry ? { expiry } : {}),
      })}`;
    } else return { status: 404, body: { error: "Not found" } };
  } else if (request.method === "POST") {
    if (request.requestOrigin !== request.origin)
      return {
        status: 403,
        body: { error: "This request did not come from the site itself" },
      };
    if (request.path === root) {
      const b = (
        request.body && typeof request.body === "object" ? request.body : {}
      ) as { contract?: unknown; qty?: unknown };
      if (typeof b.contract !== "string" || !occ.test(b.contract))
        return bad("contract is not valid");
      if (typeof b.qty !== "number" || !Number.isInteger(b.qty) || b.qty < 0)
        return bad("qty must be a whole number of contracts, 0 or more");
      path = "/v1/resize";
      // `via` is kept in the trading service's log with the request.
      body = { contract: b.contract, qty: b.qty, via: "site" };
    } else if (sub === "check" || sub === "buy") {
      const fields = order(request.body);
      if ("status" in fields) return fields as Answer;
      path = `/v1/${sub}`;
      body = { ...fields, via: "site" };
    } else return { status: 404, body: { error: "Not found" } };
  } else return { status: 405, body: { error: "Use GET or POST" } };
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
