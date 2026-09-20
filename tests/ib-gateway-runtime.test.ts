import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("IB Gateway uses the official installer and a protected private desktop", () => {
  const dockerfile = readFileSync("Dockerfile.gateway", "utf8");
  const startup = readFileSync("deploy/gateway/start.sh", "utf8");

  assert.match(
    dockerfile,
    /download2\.interactivebrokers\.com\/installers\/ibgateway\/stable-standalone/,
  );
  assert.match(dockerfile, /x11vnc/);
  assert.match(dockerfile, /novnc/);
  assert.match(startup, /auth_basic "Private IBKR desktop"/);
  assert.match(startup, /vnc\.html\?resize=scale&autoconnect=true/);
  assert.match(startup, /x11vnc .* -localhost /);
  assert.match(startup, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(startup, /supervise_gateway/);
  assert.match(startup, /restarting login/);
  assert.match(
    startup,
    /socat TCP6-LISTEN:4001,ipv6only=1,reuseaddr,fork TCP4:127\.0\.0\.1:4000/,
  );
  assert.doesNotMatch(startup, /IBKR_(USERNAME|PASSWORD)/);
});
