#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${GATEWAY_DESKTOP_PASSWORD:?Set GATEWAY_DESKTOP_PASSWORD in Railway}"
if [ "${#GATEWAY_DESKTOP_PASSWORD}" -lt 32 ]; then
  echo "Gateway access password must have at least 32 characters" >&2
  exit 1
fi

# Keep an independent outer authentication layer around the IBKR login and API.
# Brokerage credentials are entered only into IBKR's own browser SSO form.
printf '%s\n' "$GATEWAY_DESKTOP_PASSWORD" | \
  htpasswd -iBc /etc/nginx/gateway.htpasswd trader
unset GATEWAY_DESKTOP_PASSWORD
chown root:www-data /etc/nginx/gateway.htpasswd
chmod 640 /etc/nginx/gateway.htpasswd

cat > /etc/nginx/sites-enabled/default <<'NGINX'
server {
  listen 8080;
  server_name _;

  auth_basic "Private IBKR connection";
  auth_basic_user_file /etc/nginx/gateway.htpasswd;
  add_header Cache-Control "no-store" always;
  add_header X-Frame-Options DENY always;

  location = /healthz {
    auth_basic off;
    access_log off;
    return 200 "ok\n";
  }

  location / {
    proxy_pass https://127.0.0.1:5000;
    proxy_ssl_verify off;
    proxy_http_version 1.1;
    proxy_set_header Host localhost:5000;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_buffering off;
    proxy_redirect https://localhost:5000/ /;
    proxy_redirect https://127.0.0.1:5000/ /;
    proxy_cookie_domain localhost $host;
  }
}
NGINX

nginx -t
cleanup() { jobs -pr | xargs -r kill; }
trap cleanup EXIT
trap 'exit 0' TERM INT

chown gateway:gateway /home/gateway
cd /opt/clientportal.gw
runuser -u gateway -- env HOME=/home/gateway USER=gateway LOGNAME=gateway \
  ./bin/run.sh root/conf.yaml &

# Do not publish nginx until the local vendor proxy is accepting connections.
for attempt in {1..120}; do
  if curl --insecure --silent --output /dev/null --max-time 1 \
    https://127.0.0.1:5000/; then
    break
  fi
  if ! jobs -pr | grep -q .; then
    echo "Client Portal Gateway exited during startup" >&2
    exit 1
  fi
  if [ "$attempt" -eq 120 ]; then
    echo "Client Portal Gateway did not become ready" >&2
    exit 1
  fi
  sleep 0.5
done

nginx -g 'daemon off;' &
wait -n
