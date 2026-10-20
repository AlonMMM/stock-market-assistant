#!/bin/bash
# The early (9:40-9:50) and late (~10:30) signals on 2026 (40 stocks): no stop and your stop (10/20 min, -30%).
cd /Users/alonmo/Desktop/Personal/stock-market-assistant
W=$(dirname "$0"); B=data/local/x/bt
for m in early rv; do
  [ -f $B/sig_${m}_2026.csv ] || { python3 $W/signals.py 2026-01-02 2026-10-12 $m > $B/sig_${m}26.log 2>&1; cp $B/signals_$m.csv $B/sig_${m}_2026.csv; }
done
H='"carry_min_gain": 99, "win_arm": 99, "takes": [], "fast_minutes": null, "runner_stall_min": 999, "trail": 1.0, "cut1": -1.0, "floor": -1.0'
for m in early rv; do
  for v in nostop chk30; do
    if [ $v = nostop ]; then X="{$H}"; else X="{$H, \"user_stop\": {\"checks\": [[10, 0.5], [20, 1.0]], \"out\": -0.30}}"; fi
    for i in 0 1 2 3; do BT_VARIANT=v2 BT_EXIT="$X" node --env-file=.env $W/run.mjs sim.py $B/sig_${m}_2026.csv $B/x_${m}_${v}_2026 $i/4 > $B/x_${m}_${v}_2026.$i.log 2>&1 & done
  done
  wait
done
echo done
