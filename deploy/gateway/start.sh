#!/usr/bin/env bash
set -euo pipefail

install -d -o ibgateway -g ibgateway -m 700 /home/gateway/automated

# The upstream image exposes the live Gateway through socat on 4003. Railway
# service DNS resolves to IPv6, so bridge the project's private IPv6 socket to
# that loopback-only IPv4 endpoint. No public domain targets this port.
socat TCP6-LISTEN:4001,ipv6only=1,reuseaddr,fork TCP4:127.0.0.1:4003 &
bridge_pid=$!

cleanup() {
  kill "$bridge_pid" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

exec sudo -E -u ibgateway /home/ibgateway/scripts/run.sh
