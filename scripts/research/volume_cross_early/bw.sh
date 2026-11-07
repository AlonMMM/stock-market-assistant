#!/bin/zsh
# Plan burst window (2026-11-07, look 1): five versions over the year, in parallel.
cd ~/Desktop/Personal/sma-shock-early
S=/private/tmp/claude-501/-Users-alonmo-Desktop-Personal-stock-market-assistant/1b4baa86-b4e5-446c-ba46-c6840f4c7de0/scratchpad/run
one() { MEMO=$S/out/memo PLAN_BURST_ALT=$3 node --env-file=/Users/alonmo/Desktop/Personal/stock-market-assistant/.env --import tsx scripts/.addyear.ts $S/d1.sqlite $2 $S/cross/$1 > $S/cross/$1.log 2>&1; echo "$1 exit $?"; }
one BW10 $S/settings_c30.json 10:1.1 &
one BW10-08 $S/settings_c30.json 10:0.8 &
one BW10-15 $S/settings_c30.json 10:1.5 &
one BW15 $S/settings_c30.json 15:1.1 &
one BW10-c15 $S/settings.json 10:1.1 &
wait
echo all done
