"""Steps 3-5 of the trader study: compares his entries with random control minutes, his winners
with his losers, and what precedes his adds vs his cuts. Reads features.csv, control.csv and
manage.csv from <dir> (indi-features.py, indi-manage.py); prints tables and writes report.json.

  python3 scripts/research/indi-report.py <data dir>
Medians with interquartile ranges; "share" rows are the fraction meeting a simple condition.
Exploratory: no multiple-comparison correction, ~300 entries.
"""
import csv, json, sys, statistics as st, collections, random

d = sys.argv[1]
num = lambda x: float(x) if x not in ("", None, "None") else None
load = lambda p: [{k: (num(v) if k not in ("trade", "date", "time", "und", "action", "right", "expired", "overnight") else v)
                   for k, v in r.items()} for r in csv.DictReader(open(f"{d}/{p}"))]
F, C, M = load("features.csv"), load("control.csv"), {r["trade"]: r for r in load("manage.csv")}
opens = [f for f in F if f["action"] == "open"]
for f in opens:
    m = M.get(f["trade"], {})
    f["pnl"], f["ret"] = m.get("pnl"), m.get("ret")
FEATS = ["ex5", "ex15", "ex60", "ex_open", "ret15", "ret_open", "gap", "range_pos", "vs_vwap", "beyond_prev",
         "rvol15", "rvol_day", "burst", "burst_ago", "minute", "otm", "dte", "prem_pct"]


def q(xs):
    xs = sorted(x for x in xs if x is not None)
    if len(xs) < 5:
        return None
    k = lambda p: xs[min(len(xs) - 1, int(p * len(xs)))]
    return dict(n=len(xs), p25=round(k(.25), 2), med=round(k(.5), 2), p75=round(k(.75), 2))


def share(rows, cond):
    ok = [r for r in rows if all(r.get(c) is not None for c in cond[0])]
    return round(sum(cond[1](r) for r in ok) / len(ok), 3) if ok else None


def boot_diff(a, b, n=2000):
    """Bootstrap 90% interval of median(a) - median(b)."""
    a, b = [x for x in a if x is not None], [x for x in b if x is not None]
    if len(a) < 8 or len(b) < 8:
        return None
    random.seed(1)
    ds = sorted(st.median(random.choices(a, k=len(a))) - st.median(random.choices(b, k=len(b))) for _ in range(n))
    return [round(ds[int(.05 * n)], 2), round(ds[int(.95 * n)], 2)]


report = {}
CONDS = {
    "beats SPY x beta, 15 min (ex15 > 0)": (["ex15"], lambda r: r["ex15"] > 0),
    "beats SPY x beta by > 1% since open": (["ex_open"], lambda r: r["ex_open"] > 1),
    "volume burst > 3x in prior 15 min": (["burst"], lambda r: r["burst"] > 3),
    "15-min volume > 1.5x normal": (["rvol15"], lambda r: r["rvol15"] > 1.5),
    "top 20% of the day range in bet direction": (["range_pos"], lambda r: r["range_pos"] > .8),
    "beyond prior-day high/low in bet direction": (["beyond_prev"], lambda r: r["beyond_prev"] > 0),
    "broke the 15-min opening range in bet direction": (["or_break"], lambda r: r["or_break"] == 1),
    "on the bet side of VWAP": (["vs_vwap"], lambda r: r["vs_vwap"] > 0),
}
print("== Entries vs random minutes (same stock, day, direction) ==")
rows = []
for k in FEATS:
    a, b = q([f[k] for f in opens]), q([c[k] for c in C])
    if a and b:
        rows.append(dict(feature=k, entries=a, control=b, diff90=boot_diff([f[k] for f in opens], [c[k] for c in C])))
        print(f"{k:12} entries med {a['med']:>8} [{a['p25']}, {a['p75']}]   control med {b['med']:>8} [{b['p25']}, {b['p75']}]   diff90 {rows[-1]['diff90']}")
report["entry_vs_control"] = rows
print()
for name, c in CONDS.items():
    print(f"{name:52} entries {share(opens, c)}   control {share(C, c)}")
report["conditions"] = {n: dict(entries=share(opens, c), control=share(C, c)) for n, c in CONDS.items()}

print("\n== Winners vs losers at entry ==")
done = [f for f in opens if f["pnl"] is not None]
done.sort(key=lambda f: -f["pnl"])
top = done[: max(10, len(done) // 10)]
win = [f for f in done if f["pnl"] > 0]
lose = [f for f in done if f["pnl"] <= 0]
print(f"{len(done)} entries with a result: {len(win)} winners, {len(lose)} losers; top group {len(top)}")
rows = []
for k in FEATS:
    a, b, c = q([f[k] for f in top]), q([f[k] for f in win]), q([f[k] for f in lose])
    if a and b and c:
        rows.append(dict(feature=k, top=a, winners=b, losers=c, win_minus_lose90=boot_diff([f[k] for f in win], [f[k] for f in lose])))
        print(f"{k:12} top med {a['med']:>8}   winners {b['med']:>8}   losers {c['med']:>8}   win-lose90 {rows[-1]['win_minus_lose90']}")
report["win_vs_lose"] = rows
for name, c in CONDS.items():
    print(f"{name:52} top {share(top, c)}  winners {share(win, c)}  losers {share(lose, c)}")

print("\n== Adds vs cuts (what the stock did since his previous step) ==")
by = collections.defaultdict(list)
for f in F:
    by[f["action"]].append(f)
for k in ["ret5", "ret15", "ex15", "range_pos", "vs_vwap", "rvol15"]:
    print(f"{k:10} " + "  ".join(f"{a}: {q([f[k] for f in by[a]])['med'] if q([f[k] for f in by[a]]) else '-'}" for a in ["open", "add", "trim", "close"]))

print("\n== Management (option bars) ==")
mm = [m for m in M.values() if m.get("pnl") is not None]
for k in ["hold_min", "first_cut_pct", "first_cut_min", "first_cut_qty_share", "mae_pct", "mfe_pct", "after_best_pct", "after_last_pct", "ret"]:
    w, l = q([m.get(k) for m in mm if m["pnl"] > 0]), q([m.get(k) for m in mm if m["pnl"] <= 0])
    print(f"{k:20} winners {w}   losers {l}")
report["manage"] = {k: dict(winners=q([m.get(k) for m in mm if m["pnl"] > 0]), losers=q([m.get(k) for m in mm if m["pnl"] <= 0]))
                    for k in ["hold_min", "first_cut_pct", "first_cut_min", "mae_pct", "mfe_pct", "after_best_pct", "after_last_pct", "ret"]}
on = [m for m in mm if m.get("overnight") == "True"]
print(f"overnight holds: {len(on)} trades, P&L {sum(m['pnl'] for m in on):,.0f}; same-day: {len(mm) - len(on)}, P&L {sum(m['pnl'] for m in mm if m.get('overnight') != 'True'):,.0f}")
tod = collections.defaultdict(list)
for f in done:
    b = "09:30-10:00" if f["minute"] <= 30 else "10:00-12:00" if f["minute"] <= 150 else "12:00-15:00" if f["minute"] <= 330 else "15:00-15:45" if f["minute"] <= 375 else "15:45-16:00"
    tod[b].append(f["pnl"])
print("by entry time: " + "; ".join(f"{b}: {len(v)} trades, win {sum(x > 0 for x in v)}, P&L {sum(v):,.0f}" for b, v in sorted(tod.items())))
report["time_of_day"] = {b: dict(n=len(v), wins=sum(x > 0 for x in v), pnl=sum(v)) for b, v in tod.items()}
json.dump(report, open(f"{d}/report.json", "w"), indent=1)
