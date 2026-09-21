#!/usr/bin/env bash
set -euo pipefail

install -d -o ibgateway -g ibgateway -m 700 /home/gateway/automated

# IB Gateway persists its actual local API port in jts.ini. With this image the
# authenticated live session listens on loopback port 4000. Railway service DNS
# resolves to IPv6, so expose only an IPv6 private-network bridge to that local
# socket. The Gateway still sees every API client as trusted localhost traffic.
socat TCP6-LISTEN:4001,ipv6only=1,reuseaddr,fork TCP4:127.0.0.1:4000 &
bridge_pid=$!

cleanup() {
  kill "$bridge_pid" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

exec sudo -E -u ibgateway /home/ibgateway/scripts/run.sh
