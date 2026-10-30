"""Why the last-3-minutes strategy missed Indi's late overnight buys (the user, 2026-10-30: "why D2 >= 0.5? didn't we have
D2 >= 2 with indi trades? can you show indi enters with analysis why we did not catch it?").

His trades from his_tvd.csv (main account, first buy) bought at 15:00 or later and held overnight, on a stock of our
lists (his 40 + the Favorites), Feb 2024 on. For each, the strategy's checks at 15:57 on his side (indi_close.features):
range position >= 0.90, t >= 1.0 / 1.2 / 1.5, D2 >= 0.5 over the last 30 min / 2 hours / best 30 min today / the day,
volume >= 1.3x, no earnings reaction tomorrow, not a Friday; then whether a version took it (indi_close_rs_trades.json).
-> data/local/x/bt/close_miss.csv + printed tables.

  python3 close_miss.py      (from the app repo root)
"""
import collections, csv, datetime as dt, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["IC_SET"] = "rs"
import indi_close as IC
import news_filter as nf
import retry_roll as rr
import fav_real as FR
from low_delta import HIS40, PRIOR
from split import half

B = "data/local/x/bt"
H = [h for h in csv.DictReader(open(f"{B}/his_tvd.csv")) if int(h["minute"]) >= 330 and h["night"] == "1" and h["date"] >= "2024-02-01"
     and (h["sym"] in HIS40 or h["sym"] in FR.FAV)]
J = json.load(open(f"{B}/indi_close_rs_trades.json"))
took = collections.defaultdict(set)
for k, E in J.items():
    v = k.split("|")[0]
    for e in E: took[(e["date"], e["sym"], e["right"])].add(v)
RX = nf.reactions()
rows = []
for h in H:
    if h["date"] not in rr.CAL or rr.CAL.index(h["date"]) + 1 >= len(rr.CAL): continue
    f = IC.features(("fair", h["sym"], h["date"]))
    if not f: continue
    bet = 1 if h["right"] == "C" else -1
    s = "c" if bet > 0 else "p"
    i = rr.CAL.index(h["date"])
    r = dict(date=h["date"], time=h["time"], sym=h["sym"], right=h["right"], his_ret=round(float(h["ret"]), 3), his_pnl=round(float(h["pnl"])),
             pos=round(f["pos"] if bet > 0 else 1 - f["pos"], 3), t=round(bet * f["t"], 2), rvol=round(f["rvol"], 2),
             d2_30=round(f[f"{s}_c30"], 2), d2_120=round(f[f"{s}_c120"], 2), d2_max=round(f[f"{s}_max30"], 2), d2_day=round(f[f"{s}_day"], 2),
             move=round(bet * f["move"], 4), earn=int((i + 1) in set(RX.get(h["sym"], []))), friday=int(dt.date.fromisoformat(h["date"]).weekday() == 4))
    fails = []
    if r["friday"]: fails.append("Friday")
    if r["earn"]: fails.append("earnings tomorrow")
    if r["pos"] < 0.90: fails.append("not in top 10% of range")
    if r["rvol"] < 1.3: fails.append("volume < 1.3x")
    if r["t"] < 1.0: fails.append("t < 1.0")
    if max(r["d2_30"], r["d2_120"], r["d2_max"], r["d2_day"]) < 0.5: fails.append("D2 < 0.5 on every window")
    r["half"] = half(h["date"])
    r["fair"] = int(h["sym"] in HIS40 and h["sym"] in PRIOR[h["date"][:4]])
    r["fav"] = int(h["sym"] in FR.FAV and h["date"] >= FR.A24)
    r["pnl10k"] = round(1e4 * max(-1.0, float(h["ret"])))
    r["fails"] = "; ".join(fails)
    r["first_fail"] = fails[0] if fails else ""
    r["taken_by"] = " ".join(sorted(took.get((h["date"], h["sym"], h["right"]), set())))
    rows.append(r)
with open(f"{B}/close_miss.csv", "w") as fo:
    w = csv.DictWriter(fo, list(rows[0])); w.writeheader(); w.writerows(rows)
print(f"{len(rows)} of his late (15:00+) overnight buys on our lists' stocks, Feb 2024 on; his P&L ${sum(r['his_pnl'] for r in rows):+,.0f}; giants (3x) {sum(r['his_ret'] >= 3 for r in rows)}")
print(f"taken by any version: {sum(bool(r['taken_by']) for r in rows)}; by t15-c120-n: {sum('t15-c120-n' in r['taken_by'] for r in rows)}")
print("\n| Check at 15:57 | His buys that fail it | their P&L | giants among them |\n|---|---|---|---|")
for lab, f in (("Friday", lambda r: r["friday"]), ("Earnings tomorrow", lambda r: r["earn"]), ("Range position < 0.90", lambda r: r["pos"] < 0.9),
               ("Volume < 1.3x", lambda r: r["rvol"] < 1.3), ("t < 1.0", lambda r: r["t"] < 1.0), ("t < 1.5", lambda r: r["t"] < 1.5),
               ("D2 last 30 min < 0.5", lambda r: r["d2_30"] < 0.5), ("D2 last 2 hours < 0.5", lambda r: r["d2_120"] < 0.5),
               ("D2 best 30 min today < 0.5", lambda r: r["d2_max"] < 0.5), ("D2 best 30 min today < 2", lambda r: r["d2_max"] < 2),
               ("D2 whole day < 0.5", lambda r: r["d2_day"] < 0.5)):
    X = [r for r in rows if f(r)]
    print(f"| {lab} | {len(X)} ({len(X) / len(rows):.0%}) | ${sum(r['his_pnl'] for r in X):+,.0f} | {sum(r['his_ret'] >= 3 for r in X)} |")
print("\n| First failed check | His buys | P&L | giants |\n|---|---|---|---|")
for k, n in collections.Counter(r["first_fail"] or "passes everything" for r in rows).most_common():
    X = [r for r in rows if (r["first_fail"] or "passes everything") == k]
    print(f"| {k} | {n} | ${sum(r['his_pnl'] for r in X):+,.0f} | {sum(r['his_ret'] >= 3 for r in X)} |")
print("\nmedians (all / his winners / his giants): " + "; ".join(
    f"{k} {st.median(r[k] for r in rows):.2f} / {st.median(r[k] for r in rows if r['his_pnl'] > 0):.2f} / {st.median([r[k] for r in rows if r['his_ret'] >= 3] or [0]):.2f}"
    for k in ("pos", "t", "rvol", "d2_30", "d2_120", "d2_max", "d2_day", "move")))
