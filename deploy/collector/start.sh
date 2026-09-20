#!/usr/bin/env sh
set -eu
# Railway mounts a new volume as root. Repair only the collector's private data
# directory, then permanently drop privileges before starting Node.
mkdir -p /data
chown node:node /data
exec gosu node node /app/collector.mjs
