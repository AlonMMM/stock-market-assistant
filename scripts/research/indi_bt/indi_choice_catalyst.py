import csv, gzip, json, os, sys, collections, statistics as st, bisect, datetime as dt, sqlite3
sys.path.insert(0, "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
from split import half
import news_filter as nf
A = "data/local/x/bt/"
N = json.load(open(A + "indi_nights.json")); his = {(n["sym"], n["date"], n["right"]) for n in N}
R = nf.reactions(); CAL = nf.CAL; IDX = nf.IDX
def earn_tomorrow(s, d):
    i = IDX.get(d); r = R.get(s, [])
    return i is not None and (i + 1) in r
rows = []
with gzip.open(A + "nightly_feat.csv.gz", "rt") as fh:
    for x in csv.DictReader(fh):
        if x["earn"] != "0" or x["on"] in ("", None) or x["date"] < "2024-02-01": continue
        rows.append(dict(sym=x["sym"], date=x["date"], side=x["side"], sect=x["sect"], on=float(x["on"]), rs=float(x["rs_day"] or 0), dollar=float(x["dollar"] or 0)))
syms_by_sect = collections.defaultdict(set)
for r in rows: syms_by_sect[r["sect"]].add(r["sym"])
ALLS = set(R)
db = sqlite3.connect(A + "daily_all.sqlite")
atr = {}
def atrp(s, d):
    k = (s, d)
    if k not in atr:
        b = db.execute("select date,h,l,c from day where symbol=? and date<=? order by date desc limit 16", (s, d)).fetchall()[::-1]
        atr[k] = None if len(b) < 16 or b[-1][0] != d else st.mean([max(b[i][1], b[i-1][3]) - min(b[i][2], b[i-1][3]) for i in range(1, 15)]) / b[-1][3] * 100
    return atr[k]
# earnings tomorrow anywhere among the big names (market-moving reports), and in the same sector
BIG = ["AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AVGO","NFLX","AMD","ORCL","CRM","ADBE","MU","TSM","ASML","QCOM","INTC","SMCI","ARM","PLTR","COIN","MSTR","JPM","WMT","COST","UBER","SHOP","SNOW","PANW"]
def news(s, d):
    p = f"{A}news_day/{s}_{d}.json"
    if not os.path.exists(p): return None
    j = json.load(open(p)); return len(j) if isinstance(j, list) else len(j.get("news", j)) if isinstance(j, dict) else None
out = collections.defaultdict(lambda: collections.defaultdict(list))
for r in rows:
    a = atrp(r["sym"], r["date"])
    if a is None or a >= 3.6: continue
    grp = "his" if (r["sym"], r["date"], r["side"]) in his else "others"
    p = half(r["date"])
    peer = any(earn_tomorrow(s, r["date"]) for s in syms_by_sect[r["sect"]] if s != r["sym"])
    bigrep = any(earn_tomorrow(s, r["date"]) for s in BIG if s != r["sym"])
    wd = dt.date.fromisoformat(r["date"]).weekday()
    o = out[(grp, p)]
    o["peer"].append(peer); o["bigrep"].append(bigrep); o["thu"].append(wd == 3); o["fri"].append(wd == 4); o["mon"].append(wd == 0)
    nn = news(r["sym"], r["date"])
    if nn is not None: o["news"].append(nn)
for k in sorted(out):
    o = out[k]
    print(k, f"n{len(o['peer'])}", f"same-sector peer reports tonight {100*st.mean(o['peer']):.0f}%", f"a big-name report tonight {100*st.mean(o['bigrep']):.0f}%",
          f"Mon {100*st.mean(o['mon']):.0f}% Thu {100*st.mean(o['thu']):.0f}% Fri {100*st.mean(o['fri']):.0f}%",
          f"news cached {len(o['news'])}, median headlines {st.median(o['news']) if o['news'] else '-'}")
