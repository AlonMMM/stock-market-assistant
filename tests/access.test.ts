import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/worker.js";

const team = "https://example-team.cloudflareaccess.com";
const aud = "test-audience";
const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud };

const encode = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");
const encodeJson = (value: unknown) =>
  encode(new TextEncoder().encode(JSON.stringify(value)));

const pair = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const other = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const publicJwk = {
  ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  kid: "k1",
};

async function sign(
  claims: Record<string, unknown>,
  key = pair.privateKey,
  kid = "k1",
) {
  const now = Math.floor(Date.now() / 1000);
  const head = encodeJson({ alg: "RS256", kid, typ: "JWT" });
  const body = encodeJson({
    aud: [aud],
    iss: team,
    email: "owner@example.com",
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${encode(new Uint8Array(signature))}`;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  assert.equal(String(input), `${team}/cdn-cgi/access/certs`);
  return Response.json({ keys: [publicJwk] });
};
test.after(() => {
  globalThis.fetch = realFetch;
});

const health = (headers: Record<string, string> = {}) =>
  worker.fetch(new Request("https://app.test/api/health", { headers }), env);

test("Access-protected Worker accepts a valid Access token", async () => {
  const token = await sign({});
  assert.equal(
    (await health({ "Cf-Access-Jwt-Assertion": token })).status,
    200,
  );
  assert.equal(
    (await health({ Cookie: `a=b; CF_Authorization=${token}` })).status,
    200,
  );
});

test("Access-protected Worker rejects missing and invalid tokens", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    missing: undefined,
    garbage: "not.a.jwt",
    expired: await sign({ exp: now - 1 }),
    "wrong audience": await sign({ aud: ["other"] }),
    "wrong issuer": await sign({ iss: "https://evil.cloudflareaccess.com" }),
    "no email": await sign({ email: undefined }),
    "wrong key": await sign({}, other.privateKey),
    "unknown key id": await sign({}, pair.privateKey, "k2"),
  };
  for (const [name, token] of Object.entries(cases)) {
    const response = await health(
      token ? { "Cf-Access-Jwt-Assertion": token } : {},
    );
    assert.equal(response.status, 401, name);
  }
  const page = await worker.fetch(new Request("https://app.test/"), env);
  assert.equal(page.status, 401, "static pages are protected too");
});

test("Access configuration must be complete when present", async () => {
  const response = await worker.fetch(
    new Request("https://app.test/api/health"),
    { ACCESS_TEAM_DOMAIN: team },
  );
  assert.equal(response.status, 500);
});
