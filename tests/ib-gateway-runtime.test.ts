import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("IB Gateway uses pinned IBC automation over Railway private networking", () => {
  const dockerfile = readFileSync("Dockerfile.gateway", "utf8");
  const startup = readFileSync("deploy/gateway/start.sh", "utf8");

  assert.match(dockerfile, /FROM ghcr\.io\/gnzsnz\/ib-gateway:10\.45\.1j/);
  assert.match(dockerfile, /start-railway\.sh/);
  assert.match(dockerfile, /USER root/);
  assert.match(dockerfile, /apt-get install[^\n]*xdotool/);
  assert.match(startup, /install -d -o ibgateway -g ibgateway -m 700/);
  assert.match(
    startup,
    /sed -i 's\/\^LocalServerPort=\.\*\/LocalServerPort=4001\/'/,
  );
  assert.match(
    startup,
    /exec sudo -E -u ibgateway \/home\/ibgateway\/scripts\/run\.sh/,
  );
  assert.match(
    startup,
    /socat TCP6-LISTEN:4001,ipv6only=1,reuseaddr,fork TCP4:127\.0\.0\.1:4003/,
  );
  assert.match(startup, /--name '\^Login Messages\$'/);
  assert.match(startup, /xdotool windowclose/);
  assert.match(startup, /informational dialog dismissed/);
  assert.doesNotMatch(startup, /Order|Transmit/);
  assert.doesNotMatch(dockerfile + startup, /TWS_(USERID|PASSWORD)=/);
  assert.doesNotMatch(dockerfile + startup, /IBKR_(USERNAME|PASSWORD)/);
});
