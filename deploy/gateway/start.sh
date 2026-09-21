#!/usr/bin/env bash
set -euo pipefail

install -d -o ibgateway -g ibgateway -m 700 /home/gateway/automated

# A settings volume created by an older runtime can preserve a different API
# port. Keep it aligned with the upstream image's live-mode port before IBC
# starts, so its built-in 4003 -> 4001 bridge always reaches Gateway.
settings_file=/home/gateway/automated/jts.ini
if [[ -f "$settings_file" ]]; then
  sed -i 's/^LocalServerPort=.*/LocalServerPort=4001/' "$settings_file"
  chown ibgateway:ibgateway "$settings_file"
fi

# Railway service DNS resolves to IPv6. Bridge the project's private IPv6
# socket to the upstream image's loopback-only IPv4 socat listener. No public
# domain targets this port.
socat TCP6-LISTEN:4001,ipv6only=1,reuseaddr,fork TCP4:127.0.0.1:4003 &
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
      DISPLAY=:1 xdotool windowclose "$window_id" >/dev/null 2>&1 || true
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
