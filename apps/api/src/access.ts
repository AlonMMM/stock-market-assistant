// Verifies the Cloudflare Access JWT that Access adds to every request it lets
// through. This is defense in depth: Access blocks unauthenticated visitors at
// the edge, and the Worker refuses requests that did not pass through it.

export interface AccessConfig {
  teamDomain: string; // e.g. https://myteam.cloudflareaccess.com
  audience: string; // Application Audience (AUD) tag
}

export interface AccessIdentity {
  email: string;
}

type Jwk = JsonWebKey & { kid?: string };

const keyCache = new Map<
  string,
  { keys: Map<string, CryptoKey>; at: number }
>();
const keyTtl = 10 * 60000;

function base64url(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64url(part)));
}

async function signingKeys(
  teamDomain: string,
  refresh: boolean,
): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(teamDomain);
  if (cached && !refresh && Date.now() - cached.at < keyTtl) return cached.keys;
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
  const { keys } = (await response.json()) as { keys?: Jwk[] };
  const result = new Map<string, CryptoKey>();
  for (const jwk of keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    result.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  keyCache.set(teamDomain, { keys: result, at: Date.now() });
  return result;
}

function tokenFrom(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") ?? "";
  return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1] ?? null;
}

/** Returns the verified identity, or null when the request is not authorized. */
export async function verifyAccess(
  request: Request,
  config: AccessConfig,
  now = Date.now(),
): Promise<AccessIdentity | null> {
  const token = tokenFrom(request);
  const parts = token?.split(".");
  if (!parts || parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(headerPart);
    payload = decodeJson(payloadPart);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  let key = (await signingKeys(config.teamDomain, false)).get(header.kid);
  // Access rotates keys; refetch once when an unknown key id appears.
  key ??= (await signingKeys(config.teamDomain, true)).get(header.kid);
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64url(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return null;

  const seconds = now / 1000;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(config.audience)) return null;
  if (payload.iss !== config.teamDomain) return null;
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60)
    return null;
  if (typeof payload.email !== "string") return null;
  return { email: payload.email };
}
