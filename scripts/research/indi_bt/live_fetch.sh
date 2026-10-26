#!/usr/bin/env bash
# Reads the live bots' records from the trading service (read-only) for live_review.py: the Indi bot's status
# (signals, skips, sales and their reasons), its closed trades with fills on each account, and the Alert leg's status.
# The token comes from Railway and is never printed.
#   scripts/research/indi_bt/live_fetch.sh            (from the main checkout's root, Railway logged in)
#   -> data/local/x/review/live/*.json
set -euo pipefail
OUT=data/local/x/review/live
mkdir -p "$OUT"
DEPLOY=${SMA_DEPLOY:-$HOME/Desktop/Personal/sma-deploy}
T=$(cd "$DEPLOY" && railway variables --service sma-trader --kv | grep '^TRADER_TOKEN=' | cut -d= -f2-)
B=https://sma-trader-production.up.railway.app
get() { curl -sf -H "Authorization: Bearer $T" "$B/v1/$1" > "$OUT/$2.json" || echo "{}" > "$OUT/$2.json"; }
get bot bot
get bot/settings bot_settings
get "bot/portfolio/history?broker=alpaca&period=3M" trades_alpaca
get "bot/portfolio/history?broker=ibkr&period=3M" trades_ibkr
get strangle strangle
get strangle/settings strangle_settings
ls -l "$OUT"
