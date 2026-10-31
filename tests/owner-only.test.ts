import assert from "node:assert/strict";
import test from "node:test";
import { changeRefusal } from "../apps/api/src/owner-only.js";

const owner = "Owner@Example.com";
const me = { email: "owner@example.com" };
const viewer = { email: "friend@example.com" };

test("owner only: a viewer reads everything but changes nothing", () => {
  for (const [method, path] of [
    ["POST", "/api/watchlists"],
    ["PATCH", "/api/watchlists/abc"],
    ["DELETE", "/api/watchlists/abc"],
    ["POST", "/api/price-alerts"],
    ["DELETE", "/api/price-alerts/1"],
    ["POST", "/api/backtest/symbols"],
    ["PUT", "/api/risk"],
    ["PUT", "/api/bot/settings"],
    ["PUT", "/api/strangle/settings"],
    ["POST", "/api/portfolio/control/buy"],
  ] as const)
    assert.match(
      String(changeRefusal(method, path, viewer, owner)),
      /Read-only/,
      `${method} ${path}`,
    );
  assert.equal(changeRefusal("GET", "/api/risk", viewer, owner), null);
  assert.equal(changeRefusal("HEAD", "/api/bot", viewer, owner), null);
});

test("owner only: the owner changes, in any letter case", () => {
  assert.equal(changeRefusal("PUT", "/api/risk", me, owner), null);
  assert.equal(changeRefusal("POST", "/api/watchlists", me, owner), null);
});

test("owner only: computing is not changing", () => {
  for (const path of [
    "/api/backtest",
    "/api/bot-backtest",
    "/api/day-chart",
    "/api/replay",
    "/api/volume-backtest",
  ])
    assert.equal(changeRefusal("POST", path, viewer, owner), null);
});

test("owner only: with no owner set, nobody signed in may change", () => {
  assert.match(
    String(changeRefusal("PUT", "/api/risk", me, undefined)),
    /Read-only/,
  );
});
