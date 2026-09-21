#!/usr/bin/env bash
set -euo pipefail

install -d -o ibgateway -g ibgateway -m 700 /home/gateway/automated

# Let IBC apply the live Gateway API port through the Gateway configuration UI
# after login. The command server is loopback-only and is used once to ensure
# that the Socket API checkbox is enabled; it is never exposed by Railway.
ibc_template=/home/ibgateway/ibc/config.ini.tmpl
sed -i \
  -e 's/^OverrideTwsApiPort=.*/OverrideTwsApiPort=4001/' \
  -e 's/^CommandServerPort=.*/CommandServerPort=7462/' \
  -e 's/^BindAddress=.*/BindAddress=127.0.0.1/' \
  "$ibc_template"

# Normalize settings left by earlier deployments. IBC repeats this setting via
# the UI after login, so the persisted file and runtime configuration agree.
settings_file=/home/gateway/automated/jts.ini
if [[ -f "$settings_file" ]]; then
  sed -i 's/^LocalServerPort=.*/LocalServerPort=4001/' "$settings_file"
  chown ibgateway:ibgateway "$settings_file"
fi

# Railway service DNS resolves to IPv6. Bridge the project's private IPv6
# socket directly to Gateway's loopback-only IPv4 API. No public domain targets
# this port, and Gateway sees the client as trusted localhost traffic.
socat TCP6-LISTEN:4001,ipv6only=1,reuseaddr,fork TCP4:127.0.0.1:4001 &
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
        sleep 3
        # IBC's ENABLEAPI command sets only the API enablement checkbox. The
        # command server is bound to loopback, and EXIT closes this connection.
        if timeout 10 bash -c \
          "exec 3<>/dev/tcp/127.0.0.1/7462; printf 'ENABLEAPI\\nEXIT\\n' >&3; cat <&3"; then
          echo ".> Socket API enablement requested through IBC"
        else
          echo ".> Unable to request Socket API enablement through IBC" >&2
        fi
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
