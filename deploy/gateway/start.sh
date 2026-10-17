#!/usr/bin/env bash
set -euo pipefail

# The owner's trading Gateway (docs/features/multi-user-ibkr.md, phase 2).
# Paper only: the live account needs the owner's separate approval and a
# dedicated username, so a single login does not disconnect IBKR Mobile.
if [[ "${TRADING_MODE:-}" != "paper" ]]; then
  echo "TRADING_MODE must be paper; the live account is not approved" >&2
  exit 1
fi
# The trading service places orders through this Gateway.
export READ_ONLY_API=no

install -d -o ibgateway -g ibgateway -m 700 /home/gateway/automated

# The Gateway keeps its own API port for the mode: 4002 for paper. Moving it
# (to 4001, as in September on the live account) opens a configuration dialog
# that leaves the API listener closed (2026-10-17: "Connection refused" on
# 4001 while that dialog stayed open). Clients still connect to 4001: the
# bridge below forwards it.
gateway_port=4002
ibc_template=/home/ibgateway/ibc/config.ini.tmpl
sed -i "s/^OverrideTwsApiPort=.*/OverrideTwsApiPort=${gateway_port}/" "$ibc_template"

# Normalize settings left by earlier deployments. IBC repeats this setting via
# the UI after login, so the persisted file and runtime configuration agree.
settings_file=/home/gateway/automated/jts.ini
if [[ -f "$settings_file" ]]; then
  sed -i "s/^LocalServerPort=.*/LocalServerPort=${gateway_port}/" "$settings_file"
  chown ibgateway:ibgateway "$settings_file"
fi

# Railway service DNS resolves to IPv6. Bridge the project's private IPv6
# socket directly to Gateway's loopback-only IPv4 API. No public domain targets
# this port, and Gateway sees the client as trusted localhost traffic.
socat TCP6-LISTEN:4001,ipv6only=1,reuseaddr,fork \
  "TCP4:127.0.0.1:${gateway_port}" &
bridge_pid=$!

# This account receives a post-login informational modal that Gateway leaves
# open before starting its API listener. Dismiss only that exact window title;
# the loop expires and cannot interact with any trading or order dialog.
dismiss_login_messages() {
  for _ in {1..240}; do
    window_id="$(
      DISPLAY=:1 xdotool search --onlyvisible --name '^Login Messages$' \
        2>/dev/null | head -n 1 || true
    )"
    if [[ -n "$window_id" ]]; then
      echo ".> Dismissing post-login informational dialog"
      # Activate the exact dialog and invoke its default button. A window-manager
      # close hides the modal without running Gateway's acknowledgement action,
      # which prevents the local API listener from completing initialization.
      DISPLAY=:1 xdotool windowfocus --sync "$window_id" >/dev/null 2>&1 || true
      DISPLAY=:1 xdotool key --clearmodifiers Return >/dev/null 2>&1 || true
      sleep 2
      if ! DISPLAY=:1 xdotool search --onlyvisible \
        --name '^Login Messages$' >/dev/null 2>&1; then
        echo ".> Post-login informational dialog dismissed"
        return 0
      fi
    fi
    sleep 1
  done
  echo ".> Post-login informational dialog was not dismissed" >&2
}
dismiss_login_messages &
dialog_watcher_pid=$!

cleanup() {
  kill "$bridge_pid" 2>/dev/null || true
  kill "$dialog_watcher_pid" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

exec sudo -E -u ibgateway /home/ibgateway/scripts/run.sh
