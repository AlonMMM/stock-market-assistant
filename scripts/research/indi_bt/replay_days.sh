#!/usr/bin/env bash
# The live Main bot's own code replayed on each session from <first> to <last> (the review's yardstick since 2026-10-28:
# week.py runs older exits and none of 2.7's bonus entry, early entry or pyramid). scripts/bot-replay.ts from the deploy
# checkout (a clean origin/main, the code in production), with the live settings and the live Favorites read by
# live_fetch.sh, a tick every 5 seconds (early entry needs it). "both" brokers become alpaca: the replay has one account.
#   scripts/research/indi_bt/replay_days.sh <first> <last>      (from the main checkout's root, after live_fetch.sh)
#   -> data/local/x/review/replay/replay-<day>.md, then replay_compare.py
set -euo pipefail
FIRST=$1; LAST=$2
ROOT=$(pwd)
DEPLOY=${SMA_DEPLOY:-$HOME/Desktop/Personal/sma-deploy}
LIVE=data/local/x/review/live
OUT=data/local/x/review/replay
mkdir -p "$OUT"
[ -f "$LIVE/bot.json" ] && [ -f "$LIVE/bot_settings.json" ] || { echo "run live_fetch.sh first" >&2; exit 1; }
( cd "$DEPLOY" && git fetch -q origin && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ) ||
  echo "warning: $DEPLOY is not at origin/main; the replay runs that checkout's code" >&2
python3 - "$LIVE" "$OUT" <<'EOF'
import json, sys
live, out = sys.argv[1:]
s = json.load(open(f"{live}/bot_settings.json"))
if s.get("broker") == "both": s["broker"] = "alpaca"
json.dump(s, open(f"{out}/settings.json", "w"))
b = json.load(open(f"{live}/bot.json"))
f = b.get("favorites")
f = f.get("tickers", f) if isinstance(f, dict) else f
open(f"{out}/favorites.txt", "w").write(",".join(f or []))
EOF
DAYS=$(python3 -c "
import datetime as d, sys
a, z = d.date.fromisoformat('$FIRST'), d.date.fromisoformat('$LAST')
print(' '.join((a + d.timedelta(n)).isoformat() for n in range((z - a).days + 1) if (a + d.timedelta(n)).weekday() < 5))")
for DAY in $DAYS; do
  echo "replay $DAY"
  ( cd "$DEPLOY" && BOT_REPLAY_FAVORITES="$(cat "$ROOT/$OUT/favorites.txt")" BOT_REPLAY_SETTINGS="$ROOT/$OUT/settings.json" \
      BOT_REPLAY_TICK_S=5 BOT_REPLAY_10S="$ROOT/data/local/bars-10s.sqlite" \
      node --env-file="$ROOT/.env" --import tsx scripts/bot-replay.ts "$DAY" "$ROOT/$OUT/replay-$DAY.md" \
      > "$ROOT/$OUT/replay-$DAY.log" 2>&1 ) || echo "  $DAY: no replay (not a session, or failed; see $OUT/replay-$DAY.log)"
done
