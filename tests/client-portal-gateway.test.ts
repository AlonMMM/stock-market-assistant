import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Client Portal Gateway uses the official browser proxy without a remote desktop", () => {
  const dockerfile = readFileSync("Dockerfile.gateway", "utf8");
  const startup = readFileSync("deploy/gateway/start.sh", "utf8");

  assert.match(
    dockerfile,
    /download2\.interactivebrokers\.com\/portal\/clientportal\.gw\.zip/,
  );
  assert.doesNotMatch(dockerfile, /x11vnc|novnc|fluxbox|xvfb/i);
  assert.match(startup, /proxy_pass https:\/\/127\.0\.0\.1:5000/);
  assert.match(startup, /auth_basic "Private IBKR connection"/);
  assert.match(startup, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(startup, /cd \/opt\/clientportal\.gw/);
  assert.doesNotMatch(startup, /IBKR_(USERNAME|PASSWORD)/);
});
