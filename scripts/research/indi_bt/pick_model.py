"""Would Indi trade this stock today? One row per stock and day, with what is known at 10:00 (minute 30).
Label: he opened a main-account trade on that stock that day (any time, either direction).

  python3 pick_model.py build            -> data/local/x/bt/pick_rows.csv
  python3 pick_model.py fit <train years,> <test year>   e.g. fit 2023,2024 2025
                                          -> scores for the test year in data/local/x/bt/pick_scores_<year>.csv

Check (set before running): at least half of his test-year stock-days rank in the model's top 10%.
"""
import collections, csv, datetime as dt, math, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta

B = "data/local/x/bt"
U = P["universe"]
SNAP = 30  # 10:00
FEATS = ["gap", "agap", "mv", "amv", "ex", "aex", "rvol", "pd_ret", "pd_range", "pd_rvol", "ret5", "ret20", "vol20", "range_pos",
         "beyond", "spy_gap", "spy_mv", "dow", "fav60", "fav_all", "since_last", "t_abs"]


def his_days():
    """{(date, sym): first entry minute} and the dates of his trades per stock (main account, all years)."""
    first, hist = {}, collections.defaultdict(list)
    for y in ("2023", "2024", "2025", "2026"):
        seen = set()
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx" or r["action"] != "open" or r["trade"] in seen: continue
            seen.add(r["trade"])
            sym = r["contract"].split()[0]
            hist[sym].append(r["date"])
            if sym in U and r["time_from"]:
                hh, mm = map(int, r["time_from"][:5].split(":"))
                m = hh * 60 + mm - 570
                first[(r["date"], sym)] = min(first.get((r["date"], sym), 999), m)
    return first, {s: sorted(v) for s, v in hist.items()}


def build():
    cal = calendar(); first, hist = his_days()
    daily = {}  # (sym, date) -> (close, high, low, volume, cumulative volume by minute)
    def dinfo(sym, d):
        k = (sym, d)
        if k not in daily:
            b = day(sym, d)
            if not b: daily[k] = None
            else:
                v = [0] * 390
                for x in b: v[x[0]] = x[5]
                cum, t_ = [0] * 390, 0
                for m in range(390): t_ += v[m]; cum[m] = t_
                daily[k] = (b[-1][4], max(x[2] for x in b), min(x[3] for x in b), t_, cum)
        return daily[k]
    rows = []
    for i, d in enumerate(cal):
        if i < 21: continue
        spy = series(day("SPY", d))[0]
        spd = dinfo("SPY", cal[i - 1])
        if not spy[0] or not spd: continue
        for sym in U:
            bars = day(sym, d)
            if len(bars) < 300 or bars[0][0] > 5: continue
            c, h, l, v = series(bars)
            prev = [dinfo(sym, cal[j]) for j in range(i - 20, i)]
            if any(p is None for p in prev): continue
            pc, phi, plo, pvol, _ = prev[-1]
            o = bars[0][1]
            m = SNAP
            while m > 0 and c[m] is None: m -= 1
            x = c[m]
            norm = st.median(p[4][SNAP] for p in prev)
            closes = [p[0] for p in prev]
            rets = [closes[j] / closes[j - 1] - 1 for j in range(1, len(closes))]
            bt = beta(sym, d, i, cal) or 1.0
            hi, lo = max(y for y in h[:m + 1] if y), min(y for y in l[:m + 1] if y)
            steps = [(c[j] / c[j - 1] - 1) - bt * (spy[j] / spy[j - 1] - 1) for j in range(1, m + 1) if c[j] and c[j - 1] and spy[j] and spy[j - 1]]
            sd = st.pstdev(steps) if len(steps) > 2 else 0
            ex = (x / o - 1) - bt * (spy[m] / spy[0] - 1)
            hd = hist.get(sym, [])
            d0 = dt.date.fromisoformat(d)
            before = [z for z in hd if z < d]
            fav60 = sum(1 for z in before if (d0 - dt.date.fromisoformat(z)).days <= 60)
            rows.append(dict(date=d, sym=sym, label=int((d, sym) in first), his_minute=first.get((d, sym), ""),
                             gap=(o / pc - 1) * 100, agap=abs(o / pc - 1) * 100, mv=(x / o - 1) * 100, amv=abs(x / o - 1) * 100,
                             ex=ex * 100, aex=abs(ex) * 100, rvol=sum(v[:m + 1]) / norm if norm else None,
                             pd_ret=(pc / prev[-2][0] - 1) * 100, pd_range=(phi - plo) / pc * 100,
                             pd_rvol=pvol / st.median(p[3] for p in prev[:-1]) if st.median(p[3] for p in prev[:-1]) else None,
                             ret5=(pc / prev[-6][0] - 1) * 100, ret20=(pc / prev[0][0] - 1) * 100, vol20=st.pstdev(rets) * 100,
                             range_pos=(x - lo) / (hi - lo) if hi > lo else 0.5, beyond=1 if x > phi else -1 if x < plo else 0,
                             spy_gap=(spy[0] / spd[0] - 1) * 100, spy_mv=(spy[m] / spy[0] - 1) * 100, dow=d0.weekday(),
                             fav60=fav60, fav_all=len(before), since_last=(d0 - dt.date.fromisoformat(before[-1])).days if before else 999,
                             t_abs=abs(st.fmean(steps) / sd * math.sqrt(len(steps))) if sd else 0))
        if d.endswith("-01"): print(d, len(rows), flush=True)
    with open(f"{B}/pick_rows.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(len(rows), "rows,", sum(r["label"] for r in rows), "of his stock-days")


def fit(train_years, test_year):
    import numpy as np
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    R = list(csv.DictReader(open(f"{B}/pick_rows.csv")))
    f = lambda r: [float(r[k]) if r[k] not in ("", "None") else np.nan for k in FEATS]
    tr = [r for r in R if r["date"][:4] in train_years]; te = [r for r in R if r["date"][:4] == test_year]
    Xtr, ytr = np.array([f(r) for r in tr]), np.array([int(r["label"]) for r in tr])
    Xte, yte = np.array([f(r) for r in te]), np.array([int(r["label"]) for r in te])
    print(f"train {train_years}: {len(tr)} stock-days, {ytr.sum()} his | test {test_year}: {len(te)}, {yte.sum()} his ({100*yte.mean():.1f}%)")
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40, l2_regularization=1.0, random_state=1).fit(Xtr, ytr)
    def report(name, s):
        order = np.argsort(-s); n10 = len(s) // 10; n20 = len(s) // 5
        top10 = yte[order[:n10]].sum() / yte.sum(); top20 = yte[order[:n20]].sum() / yte.sum()
        # per day: his days among the day's top 4
        by = collections.defaultdict(list)
        for r, sc, y in zip(te, s, yte): by[r["date"]].append((sc, y))
        hit4 = sum(sum(y for _, y in sorted(v, reverse=True)[:4]) for v in by.values()) / yte.sum()
        print(f"| {name} | {roc_auc_score(yte, s):.3f} | {100*top10:.0f}% | {100*top20:.0f}% | {100*hit4:.0f}% |")
    print("| Model | AUC | His days in top 10% | in top 20% | in each day's top 4 |\n|---|---|---|---|---|")
    report("favorites only (his trades on the stock, last 60 days)", Xte[:, FEATS.index("fav60")] + 0.001 * Xte[:, FEATS.index("fav_all")])
    report("move only (|move by 10:00| x volume)", np.nan_to_num(Xte[:, FEATS.index("amv")]) * np.nan_to_num(Xte[:, FEATS.index("rvol")], nan=1))
    s = gb.predict_proba(Xte)[:, 1]
    report("model (all inputs)", s)
    # without the favorites inputs: is there anything beyond "he trades TSLA a lot"?
    keep = [i for i, k in enumerate(FEATS) if k not in ("fav60", "fav_all", "since_last")]
    gb2 = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40, l2_regularization=1.0, random_state=1).fit(Xtr[:, keep], ytr)
    report("model without his favorites", gb2.predict_proba(Xte[:, keep])[:, 1])
    from sklearn.inspection import permutation_importance
    pi = permutation_importance(gb, Xte, yte, scoring="roc_auc", n_repeats=5, random_state=1)
    print("\ninputs that matter (AUC drop when shuffled):", ", ".join(f"{FEATS[i]} {pi.importances_mean[i]:.3f}" for i in np.argsort(-pi.importances_mean)[:10]))
    with open(f"{B}/pick_scores_{test_year}.csv", "w") as fh:
        w = csv.writer(fh); w.writerow(["date", "sym", "score", "label"])
        for r, sc in zip(te, s): w.writerow([r["date"], r["sym"], round(float(sc), 5), r["label"]])


if __name__ == "__main__":
    if sys.argv[1] == "build": build()
    else: fit(sys.argv[2].split(","), sys.argv[3])
