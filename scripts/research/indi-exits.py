"""When does he sell? Minute-by-minute hazard of a sale given the option's state while he holds.

For each main-account option trade (times known), steps through every regular-session minute from his
first buy to his last sale. At each minute where he holds, the state is: option P&L vs his average cost
(last option trade), drawdown from the option's best price since his entry, and minutes held. A minute
"ends in a sale" if he sold in it. Hazard = sales / minutes in that state. Also: P&L at his first sale.

  python3 scripts/research/indi-exits.py <data dir>
"""
import csv, json, sqlite3, sys, collections, datetime as dt
from zoneinfo import ZoneInfo

d = sys.argv[1]
NY = ZoneInfo("America/New_York")
db = sqlite3.connect(f"{d}/bars.sqlite")


def occ(u, e, k, r):
    return f"{u}{e[2:4]}{e[5:7]}{e[8:10]}{r}{round(k * 1000):08d}"


def ep(date, t):
    return dt.datetime.fromisoformat(f"{date}T{t}").replace(tzinfo=NY).timestamp()


def session_minute(ts):
    t = dt.datetime.fromtimestamp(ts, NY)
    return t.hour * 60 + t.minute - 570


rows = [r for r in csv.DictReader(open(f"{d}/actions.csv"))
        if r["account"] == "silexx" and not r["contract"].endswith("S") and r["time_from"]]
by = collections.defaultdict(list)
for r in rows:
    by[r["trade"]].append(r)

PNL = [(-1, -.5), (-.5, -.35), (-.35, -.25), (-.25, -.15), (-.15, -.05), (-.05, .05), (.05, .25), (.25, .5), (.5, 1), (1, 99)]
DD = [(0, .1), (.1, .2), (.2, .3), (.3, .45), (.45, 1)]
HELD = [(0, 5), (5, 15), (15, 30), (30, 60), (60, 120), (120, 9999)]
lab = lambda b, pct=True: f"{b[0]:+.0%}..{b[1]:+.0%}" if pct else f"{b[0]}-{b[1]}m"
find = lambda bins, x: next((b for b in bins if b[0] <= x < b[1]), None)
held_n, sold_n = collections.Counter(), collections.Counter()
cross = collections.Counter(), collections.Counter()
first_cut = []
for trade, st in by.items():
    st.sort(key=lambda r: (r["date"], r["time_from"]))
    und, exp, sr = st[0]["contract"].rsplit(" ", 2)
    bars = []
    for (b,) in db.execute("SELECT bars FROM bars WHERE symbol=? ORDER BY date", (occ(und, exp, float(sr[:-1]), sr[-1]),)):
        bars += json.loads(b)
    px = {int(b[0] // 60): b[4] for b in bars}
    ev = collections.defaultdict(list)
    for r in st:
        ev[int(ep(r["date"], r["time_from"]) // 60)].append(r)
    start, end = min(ev), max(ev)
    pos = cost = 0.0
    last = peak = None
    t_open = None
    first_done = False
    for m in range(start, end + 1):
        if not 0 <= session_minute(m * 60) < 390 and m not in ev:
            continue
        state = None
        if pos > 0 and last is not None:
            avg = cost / pos
            state = (last / avg - 1, 1 - last / peak if peak else 0, m - t_open)
        sold_here = any(r["side"] == "S" for r in ev.get(m, []))
        if state:
            k = (find(PNL, state[0]), find(DD, state[1]), find(HELD, state[2]))
            held_n[k] += 1
            if sold_here:
                sold_n[k] += 1
                if not first_done:
                    first_cut.append(state)
                    first_done = True
        for r in ev.get(m, []):
            q, p = int(r["qty"]), float(r["avg_price"])
            if r["side"] == "B":
                pos += q; cost += q * p
                t_open = t_open or m
                peak = max(peak or p, p)
            else:
                avg = cost / pos if pos else 0
                pos -= q; cost -= avg * q
        if m in px:
            last = px[m]
            if pos > 0:
                peak = max(peak or last, last)


def show(title, idx, bins, pct=True):
    print(f"\n{title}")
    print(f"{'state':>16} {'minutes held':>13} {'sales':>6} {'chance he sells this minute':>28}")
    for b in bins:
        h = sum(v for k, v in held_n.items() if k[idx] == b)
        s = sum(v for k, v in sold_n.items() if k[idx] == b)
        if h:
            print(f"{lab(b, pct):>16} {h:13} {s:6} {s / h:28.1%}")


show("By option P&L vs his cost", 0, PNL)
show("By drawdown from the option's best price since entry", 1, DD)
show("By minutes since entry", 2, HELD, pct=False)
print("\nP&L vs minutes held (chance of a sale per minute)")
print(" " * 16 + "".join(f"{lab(h, False):>11}" for h in HELD))
for b in PNL:
    cells = []
    for h in HELD:
        hn = sum(v for k, v in held_n.items() if k[0] == b and k[2] == h)
        sn = sum(v for k, v in sold_n.items() if k[0] == b and k[2] == h)
        cells.append(f"{sn / hn:10.1%}" if hn >= 40 else f"{'·':>10}")
    print(f"{lab(b):>16} " + " ".join(cells))
fc = sorted(first_cut)
q = lambda xs, p: xs[int(p * (len(xs) - 1))]
pn = sorted(x[0] for x in fc); hm = sorted(x[2] for x in fc)
print(f"\nFirst sale ({len(fc)} trades): option P&L p25 {q(pn, .25):+.0%} median {q(pn, .5):+.0%} p75 {q(pn, .75):+.0%}; "
      f"minutes held p25 {q(hm, .25)} median {q(hm, .5)} p75 {q(hm, .75)}")
loss = [x for x in fc if x[0] < 0]
print(f"first sale at a loss: {len(loss)} of {len(fc)}; among them P&L median {q(sorted(x[0] for x in loss), .5):+.0%}, "
      f"at -20% or worse {sum(x[0] <= -.2 for x in loss) / len(loss):.0%}, within 15 min {sum(x[2] <= 15 for x in loss) / len(loss):.0%}")
