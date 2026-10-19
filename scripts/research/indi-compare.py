"""Side-by-side yearly comparison of the trader study outputs (report.json, manage.csv,
triggers-<y>.txt, exits-<y>.txt). Run from data/local/x: python3 ../../scripts/research/indi-compare.py 2023 2024 2025 2026"""
import json, csv, sys, re, statistics as st
ys = sys.argv[1:]
num = lambda x: float(x) if x not in ("", None, "None") else None
rows = {}
for y in ys:
    d = f"ultrawavetrader-{y}"; r = {}
    try: rep = json.load(open(f"{d}/report.json"))
    except FileNotFoundError: rows[y] = None; continue
    c = rep["conditions"]
    for k, lab in [("beats SPY x beta, 15 min (ex15 > 0)", "beats SPY 15m"), ("top 20% of the day range in bet direction", "top 20% of range"),
                   ("on the bet side of VWAP", "bet side of VWAP"), ("15-min volume > 1.5x normal", "15m vol >1.5x"),
                   ("broke the 15-min opening range in bet direction", "beyond opening range")]:
        r[lab] = f"{c[k]['entries']:.0%} vs {c[k]['control']:.0%}"
    M = [{k: (num(v) if k not in ("trade", "und", "right", "date", "time", "expired", "overnight") else v) for k, v in x.items()} for x in csv.DictReader(open(f"{d}/manage.csv"))]
    M = [m for m in M if m["pnl"] is not None]
    W, L = [m for m in M if m["pnl"] > 0], [m for m in M if m["pnl"] <= 0]
    med = lambda xs: st.median([x for x in xs if x is not None]) if [x for x in xs if x is not None] else None
    r["trades (timed)"] = f"{len(M)}, {len(W) / len(M):.0%} win"
    r["P&L timed trades"] = f"{sum(m['pnl'] for m in M) / 1e6:+.2f}M"
    r["avg win / avg loss"] = f"{st.fmean(m['pnl'] for m in W) / 1e3:+.0f}K / {st.fmean(m['pnl'] for m in L) / 1e3:+.0f}K"
    hasbars = sum(1 for m in M if m.get("option_bars")) / len(M)
    r["option bars"] = f"{hasbars:.0%} of trades"
    r["losers: first sale"] = f"{med([m.get('first_cut_pct') for m in L]):+.0f}% after {med([m.get('first_cut_min') for m in L]):.0f} min"
    r["winners: first sale"] = f"{med([m.get('first_cut_pct') for m in W]):+.0f}% after {med([m.get('first_cut_min') for m in W]):.0f} min"
    if hasbars > .5:
        r["losers: worst while held"] = f"{med([m.get('mae_pct') for m in L]):+.0f}%"
        r["winners: best while held"] = f"{med([m.get('mfe_pct') for m in W]):+.0f}%"
        r["after his last sale (to expiry)"] = f"{med([m.get('after_last_pct') for m in M]):+.0f}%"
    tod = rep["time_of_day"]
    for b in ["09:30-10:00", "10:00-12:00", "12:00-15:00", "15:00-15:45", "15:45-16:00"]:
        if b in tod: r[f"entries {b}"] = f"{tod[b]['n']} · {tod[b]['wins'] / tod[b]['n']:.0%} win · {tod[b]['pnl'] / 1e6:+.2f}M"
    late = sorted([m["pnl"] for m in M if m["time"] >= "15:45:00"], reverse=True); rest = sorted([m["pnl"] for m in M if m["time"] < "15:45:00"], reverse=True)
    r["last 15 min w/o top 3"] = f"{sum(late[3:]) / 1e6:+.2f}M"; r["rest w/o top 3"] = f"{sum(rest[3:]) / 1e6:+.2f}M"
    # entry type: chart event within 5 min before (breakout = new day high/low, prior-day or opening-range break; strength = 5m jump vs SPY)
    pnl = {m["trade"]: m["pnl"] for m in M}; near = lambda v: v not in ("", None) and float(v) <= 5; et = {}
    for e in csv.DictReader(open(f"{d}/triggers_entries.csv")):
        if e["trade"] not in pnl: continue
        pnl_e = pnl.pop(e["trade"])  # first entry of each trade only
        br = near(e["new_high"]) or near(e["prev_break"]) or near(e["or_break"]); sj = near(e["rs_jump"])
        k = "last 15 min" if e["late"] == "1" else "breakout + strength" if br and sj else "breakout only" if br else "strength only" if sj else "no event"
        et.setdefault(k, []).append(pnl_e)
    for k in ["breakout + strength", "breakout only", "strength only", "no event", "last 15 min"]:
        v = sorted(et.get(k, []), reverse=True)
        if v: r[f"entry type: {k}"] = f"{len(v)} · {sum(x > 0 for x in v) / len(v):.0%} win · {sum(v) / 1e6:+.2f}M ({sum(v[2:]) / 1e6:+.2f}M w/o top 2)"
    try:
        t = open(f"analysis/triggers-{y}.txt").read()
        for e, lab in [("new_high", "new day high/low"), ("or_break", "opening-range break"), ("prev_break", "prior-day break"), ("rs_jump", "5m jump vs SPY")]:
            m = re.search(rf"^{e}\s+(\d+)%\s+(\d+)%\s+([\d.]+)", t, re.M); r[f"10 min before entry: {lab}"] = f"{m[1]}% vs {m[2]}% ({m[3]}x)"
        m = re.search(r"^vwap_lost\s+(\d+)%\s+(\d+)%\s+([\d.]+)", t, re.M); r["at his sells: lost VWAP"] = f"{m[1]}% vs {m[2]}% holding"
    except FileNotFoundError: pass
    try:
        x = open(f"analysis/exits-{y}.txt").read()
        m = re.search(r"first sale at a loss: (\d+) of (\d+); among them P&L median ([+-]\d+)%.*within 15 min (\d+)%", x)
        r["first sale at a loss"] = f"{m[1]}/{m[2]} · median {m[3]}% · {m[4]}% within 15 min"
    except (FileNotFoundError, TypeError): pass
    rows[y] = r
keys = list(dict.fromkeys(k for r in rows.values() if r for k in r))
print("| | " + " | ".join(ys) + " |\n|---|" + "---|" * len(ys))
for k in keys: print(f"| {k} | " + " | ".join((rows[y] or {}).get(k, "–") for y in ys) + " |")
