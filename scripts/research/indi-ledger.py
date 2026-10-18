# Records one day's hand-transcribed fills and Portfolio lines, replacing that day's rows,
# then checks summed fills against each Portfolio line (main account).
# Input (stdin):
#   D 2026-01-02 <post id>
#   F 09:33:52 B 250 AAPL 260911 327.5C 0.85 O      fill: time side qty ticker yymmdd strike+right price open/close
#   P AAPL 260911 327.5C 1500 .8952 1500 .8141 -12155 [pos]   portfolio: buyQty buyAvg sellQty sellAvg realized
#   iF / iP = same for the IBKR account (time may be '-'); xF = second Silexx account 3OC08912; N <text> = note
import csv, sys, os, collections
FILLS, PORT, NOTES = "fills.csv", "portfolio.csv", "notes.csv"
FH = "date,time_et,account,side,qty,underlying,expiry,strike,right,fill_price,open_close,source_post".split(",")
PH = "date,account,underlying,expiry,strike,right,buy_qty,buy_avg,sell_qty,sell_avg,realized,position,source_post".split(",")
def load(p, h): return list(csv.DictReader(open(p))) if os.path.exists(p) else []
def save(p, h, rows):
    w = csv.DictWriter(open(p, "w"), fieldnames=h); w.writeheader(); w.writerows(sorted(rows, key=lambda r: (r["date"], r.get("time_et", ""))))
def exp(s): return f"20{s[:2]}-{s[2:4]}-{s[4:]}"
def num(s): return "" if s in ("-", "") else str(float(s))
import datetime as _dt
from zoneinfo import ZoneInfo as _Z
def to_et(day, tm):
    # screen time in Israel -> US Eastern (handles both DST calendars)
    t = _dt.datetime.fromisoformat(f"{day}T{tm}").replace(tzinfo=_Z("Asia/Jerusalem")).astimezone(_Z("America/New_York"))
    return t.strftime("%H:%M:%S")
isr = False
value = None
day = post = None; fills = []; port = []; notes = []
for line in sys.stdin:
    t = line.split()
    if not t: continue
    k = t[0]; acct = {"i": "ibkr", "x": "silexx-912"}.get(k[0], "silexx") if len(k) > 1 else "silexx"; k = k[-1]
    if k == "D": day, post = t[1], t[2]; isr = len(t) > 3 and t[3] == "ISR"
    elif k == "V": value = t[1]
    elif k == "N": notes.append(dict(date=day, note=" ".join(t[1:])))
    elif k == "F":
        tm, side, q, und = t[1], t[2], t[3], t[4]
        # underlying may be multi-word for futures options: join until the yymmdd token
        i = 5
        while not (t[i].isdigit() and len(t[i]) == 6): und += " " + t[i]; i += 1
        e, sr, px = t[i], t[i + 1], t[i + 2]; oc = t[i + 3] if len(t) > i + 3 else ""
        if isr and tm != "-": tm = to_et(day, tm)
        fills.append(dict(date=day, time_et="" if tm == "-" else tm, account=acct, side=side, qty=int(q), underlying=und, expiry=exp(e),
                          strike=num(sr[:-1]), right=sr[-1], fill_price=num(px), open_close=oc, source_post=post))
    elif k == "P":
        und = t[1]; i = 2
        while not (t[i].isdigit() and len(t[i]) == 6): und += " " + t[i]; i += 1
        e, sr = t[i], t[i + 1]; v = t[i + 2:] + ["-"] * 6
        port.append(dict(date=day, account=acct, underlying=und, expiry=exp(e), strike=num(sr[:-1]), right=sr[-1],
                         buy_qty=int(v[0]), buy_avg=num(v[1]), sell_qty=int(v[2]), sell_avg=num(v[3]), realized=num(v[4]), position=num(v[5]), source_post=post))
F = [r for r in load(FILLS, FH) if r["date"] != day] + fills
P = [r for r in load(PORT, PH) if r["date"] != day] + port
N = [r for r in load(NOTES, ["date", "note"]) if r["date"] != day] + notes
save(FILLS, FH, F)
if value:
    V = [r for r in load("values.csv", ["date", "value"]) if r["date"] != day] + [dict(date=day, value=value)]
    w = csv.DictWriter(open("values.csv", "w"), fieldnames=["date", "value"]); w.writeheader(); w.writerows(sorted(V, key=lambda r: r["date"]))
save(PORT, PH, P); save(NOTES, ["date", "note"], N)
key = lambda r: (r["account"], r["underlying"], r["expiry"], float(r["strike"]), r["right"])
s = collections.defaultdict(lambda: [0, 0.0, 0, 0.0])
for f in fills:
    x = s[key(f)]
    if f["side"] == "B": x[0] += int(f["qty"]); x[1] += int(f["qty"]) * float(f["fill_price"])
    else: x[2] += int(f["qty"]); x[3] += int(f["qty"]) * float(f["fill_price"])
bad = []
for p in port:
    if p["account"] != "silexx": continue
    x = s.get(key(p), [0, 0, 0, 0])
    ok = x[0] == p["buy_qty"] and x[2] == p["sell_qty"]
    if ok and x[0] and p["buy_avg"]: ok = abs(x[1] / x[0] - float(p["buy_avg"])) < 0.0006
    if ok and x[2] and p["sell_avg"]: ok = abs(x[3] / x[2] - float(p["sell_avg"])) < 0.0006
    if not ok: bad.append(f"{key(p)} fills B{x[0]}@{x[1]/x[0] if x[0] else 0:.4f} S{x[2]}@{x[3]/x[2] if x[2] else 0:.4f} vs P B{p['buy_qty']}@{p['buy_avg']} S{p['sell_qty']}@{p['sell_avg']}")
pk = {key(p) for p in port}
for k in s:
    if k[0] == "silexx" and k not in pk: bad.append(f"{k} has fills but no portfolio line")
print(day, f"fills={len(fills)} lines={len(port)}", "OK" if not bad else "MISMATCH", *bad, sep="\n  " if bad else " ")
