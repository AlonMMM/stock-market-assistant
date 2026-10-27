#!/bin/zsh
# The research market-data database (Railway service "Postgres", project Stock Market Assistant). Run from a folder
# linked to that project (railway link). The password is read from Railway each time, never saved.
#   dbx_db.sh                 open psql
#   dbx_db.sh load <files>    load dbx_cache/[indi/]<date>.csv.gz days with their greeks and open interest (dbx_load.py;
#                             run from the app repo root; skips files already loaded, a row both lists share is kept once)
url() {
  railway variables --service Postgres --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"postgresql://{d['PGUSER']}:{d['PGPASSWORD']}@tokaido.proxy.rlwy.net:37425/{d['PGDATABASE']}\")"
}
U=$(url)
if [[ "$1" != load ]]; then exec psql "$U" "$@"; fi
shift
PGURL="$U" python3 "$(dirname $0)/dbx_load.py" "$@"
