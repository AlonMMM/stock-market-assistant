"""nightly-bet v2: which measurements matter (tune weeks only; the check weeks stay unseen for the final option test).

Reads nightly_feat.csv.gz (nightly_feat.py). Rows: stock-side-nights, no earnings night or morning, not Friday. Pool:
the side is at least somewhat strong (rs_day >= 0.5, pos >= 0.6) - the stocks a night bet would choose from. Per
measurement, five equal bins (quintiles of the pool) and, for each: nights, the modelled 0.20-delta option's mean and
median return, the share up 100%+ and 300%+ (the big winners), the share of overnight moves >= 1 and >= 2 usual moves
our way, and Spearman's rho of the measurement with the option return. A measurement matters when the top bin's big-
winner share and mean beat the bottom bin's steadily (monotone), not when one bin spikes.

  python3 scripts/research/indi_bt/nightly_bins.py      (from the app repo root)
"""
import csv, datetime as dt, gzip, math
import numpy as np

F = "data/local/x/bt/nightly_feat.csv.gz"
FEATS = ["rs_day", "gap_z", "rs_3d", "t", "consist", "rs_down", "rvol", "rvol_late", "updown", "dollar",
         "burst", "burst_n", "burst_size", "burst_hold", "burst_age", "lh_run", "depth", "lh_range", "pos", "gap_hold", "vwap_ext"]


def num(x):
    try: return float(x)
    except (TypeError, ValueError): return None


def rank(a):
    o = np.argsort(a); r = np.empty(len(a)); r[o] = np.arange(len(a)); return r


def main():
    rows = []
    with gzip.open(F, "rt") as f:
        for r in csv.DictReader(f):
            if r["half"] != "tune" or r["earn"] == "1" or dt.date.fromisoformat(r["date"]).weekday() == 4: continue
            if num(r["opt"]) is None or num(r["z_on"]) is None: continue
            rows.append(r)
    pool = [r for r in rows if num(r["rs_day"]) >= 0.5 and num(r["pos"]) >= 0.6]
    nights = len({r["date"] for r in rows})
    print(f"tune side-nights {len(rows):,}; pool (rs_day >= 0.5, pos >= 0.6) {len(pool):,} on {nights} nights ({len(pool) / nights:.1f} a night)")
    def stats(R):
        o = np.array([min(num(r["opt"]), 50) for r in R]); z = np.array([num(r["z_on"]) for r in R])
        return f"{len(R):>6,} | {o.mean():+.0%} | {np.median(o):+.0%} | {(o >= 1).mean():.1%} | {(o >= 3).mean():.1%} | {(z >= 1).mean():.0%} | {(z >= 2).mean():.1%}"
    print(f"\nall pool: n | mean opt | median opt | >= +100% | >= +300% | z >= 1 | z >= 2\n         {stats(pool)}")
    base = [r for r in rows if num(r["t"]) >= 1.8 and num(r["pos"]) >= 0.9 and num(r["rvol"]) >= math.log(1.3)]
    print(f"today's pick's rule (t >= 1.8, top 10% range, volume 1.3x), all nights: {stats(base)}")
    out = []
    for k in FEATS:
        R = [r for r in pool if num(r[k]) is not None]
        if len(R) < 500: continue
        x = np.array([num(r[k]) for r in R]); o = np.array([min(num(r["opt"]), 50) for r in R])
        rho = float(np.corrcoef(rank(x), rank(o))[0, 1])
        qs = np.quantile(x, [0.2, 0.4, 0.6, 0.8])
        b = np.searchsorted(qs, x, side="right")
        print(f"\n### {k}  (rho with the option return {rho:+.3f})\n| bin | range | n | mean opt | median opt | >= +100% | >= +300% | z >= 1 | z >= 2 |\n|---|---|---|---|---|---|---|---|---|")
        tops = []
        for j in range(5):
            Rj = [r for r, bj in zip(R, b) if bj == j]
            if not Rj: continue
            xs = x[b == j]
            print(f"| {j + 1} | {xs.min():.2f} .. {xs.max():.2f} | {stats(Rj).replace(' | ', ' | ')} |")
            oj = o[b == j]; tops.append(((oj >= 3).mean(), oj.mean()))
        out.append((k, rho, tops[-1][0] - tops[0][0], tops[-1][1] - tops[0][1]))
    print("\n### Summary: rho, top bin - bottom bin (big-winner share, mean option return)\n| measure | rho | +300% share, top - bottom | mean, top - bottom |\n|---|---|---|---|")
    for k, rho, g, m in sorted(out, key=lambda q: -abs(q[1])):
        print(f"| {k} | {rho:+.3f} | {g:+.1%} | {m:+.0%} |")


if __name__ == "__main__":
    main()
