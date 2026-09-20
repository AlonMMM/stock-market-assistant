#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${GATEWAY_DESKTOP_PASSWORD:?Set GATEWAY_DESKTOP_PASSWORD in Railway}"
if [ "${#GATEWAY_DESKTOP_PASSWORD}" -lt 32 ]; then
  echo "Desktop password must have at least 32 characters" >&2
  exit 1
fi

# Railway mounts the persistent home volume as root. IB Gateway itself runs as
# an unprivileged user, and its settings survive container replacements here.
chown gateway:gateway /home/gateway
mkdir -p /home/gateway/Jts
chown -R gateway:gateway /home/gateway/Jts
chmod 711 /root
rm -rf /root/Jts
ln -s /home/gateway/Jts /root/Jts

# The desktop is reachable only through nginx. VNC stays on loopback and has
# an independent Basic Auth boundary at the public HTTPS endpoint.
printf '%s\n' "$GATEWAY_DESKTOP_PASSWORD" | \
  htpasswd -iBc /etc/nginx/desktop.htpasswd trader
unset GATEWAY_DESKTOP_PASSWORD
chown root:www-data /etc/nginx/desktop.htpasswd
chmod 640 /etc/nginx/desktop.htpasswd

cat > /etc/nginx/sites-enabled/default <<'NGINX'
server {
  listen 8080;
  server_name _;

  auth_basic "Private IBKR desktop";
  auth_basic_user_file /etc/nginx/desktop.htpasswd;
  add_header Cache-Control "no-store" always;
  add_header X-Frame-Options DENY always;

  location = /healthz {
    auth_basic off;
    access_log off;
    return 200 "ok\n";
  }

  location = / {
    return 302 /vnc.html?resize=scale&autoconnect=true&show_dot=true;
  }

  location / {
    proxy_pass http://127.0.0.1:6080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }
}
NGINX

nginx -t
cleanup() { jobs -pr | xargs -r kill; }
trap cleanup EXIT
trap 'exit 0' TERM INT

as_gateway() {
  runuser -u gateway -- env HOME=/home/gateway USER=gateway LOGNAME=gateway "$@"
}

as_gateway Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
for attempt in {1..50}; do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done

as_gateway fluxbox &
as_gateway x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -nopw -quiet &
as_gateway websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 &

# IB Gateway exits after some rejected or interrupted login flows. Keep the
# protected desktop alive and reopen the vendor login instead of terminating
# the Railway service and forcing a full image redeploy.
supervise_gateway() {
  while true; do
    status=0
    as_gateway /opt/ibgateway/ibgateway || status=$?
    echo "IB Gateway exited with status $status; restarting login" >&2
    sleep 3
  done
}

supervise_gateway &
nginx -g 'daemon off;' &
wait -n
