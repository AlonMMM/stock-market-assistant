"""His end-of-day picks against the other candidates of the same day.

Candidates: every stock-day where eod.py's basic rule holds at 15:46 (up >= 2%, top 20% of the range, beyond
yesterday's level, not Friday), 2023 - Oct 2026. Features at 15:46 measure what his posts describe: the stock
held near its high all afternoon ("doesn't want to go down"), closed strong, on volume.

  python3 eod_profile.py      (from the repo root)
"""
import collections, csv, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import P, day, calendar
from signals import series, beta
import eod

B = "data/local/x/bt"
M = 376


def feats(sym, d, i, cal, bet):
    bars = day(sym, d); pb = day(sym, cal[i - 1])
    c, h, l, v = series(bars)
    spy = series(day("SPY", d))[0]; spb = day("SPY", cal[i - 1])
    x = next(c[m] for m in range(M, 360, -1) if c[m])
    pc = pb[-1][4]
    ext = (lambda arr, lo, hi_: max(z for z in arr[lo:hi_] if z)) if bet > 0 else (lambda arr, lo, hi_: min(z for z in arr[lo:hi_] if z))
    hi_day = ext(h if bet > 0 else l, 0, M + 1)
    # afternoon giveback: worst point since 13:00 vs the day's extreme so far at that time
    worst = min((bet * (c[m] / ext(h if bet > 0 else l, 0, m + 1) - 1) * 100 for m in range(210, M + 1) if c[m]), default=0)
    when_ext = max((m for m in range(M + 1) if (h if bet > 0 else l)[m] == hi_day), default=0)
    norm = []
    for dd in cal[i - 20:i]:
        vv = [0] * 390
        for b in day(sym, dd): vv[b[0]] = b[5]
        norm.append(vv)
    n_day = st.median(sum(z[:M + 1]) for z in norm); n_30 = st.median(sum(z[M - 30:M + 1]) for z in norm)
    bt = beta(sym, d, i, cal) or 1.0
    p5 = day(sym, cal[i - 6])
    return dict(move=bet * (x / pc - 1) * 100, ex=bet * (x / pc - 1) * 100 - bt * bet * (spy[M] / spb[-1][4] - 1) * 100,
                giveback=worst, from_ext=bet * (x / hi_day - 1) * 100, min_since_ext=M - when_ext,
                last30=bet * (x / next(c[m] for m in range(M - 30, M) if c[m]) - 1) * 100,
                rvol=sum(v[:M + 1]) / n_day if n_day else None, rvol30=sum(v[M - 30:M + 1]) / n_30 if n_30 else None,
                prev_day=bet * (pc / day(sym, cal[i - 2])[-1][4] - 1) * 100, ret5=bet * (pc / p5[-1][4] - 1) * 100 if p5 else None,
                spy_day=bet * (spy[M] / spb[-1][4] - 1) * 100)


def main():
    cal = calendar(); idx = {d: i for i, d in enumerate(cal)}
    cand = f"{B}/e_sig_eod_all.csv"
    if not os.path.exists(cand): eod.main("2023-02-01", "2026-10-12", cand)
    C = list(csv.DictReader(open(cand)))
    his = collections.defaultdict(float); his_n = collections.Counter()
    for y in ("2023", "2024", "2025", "2026"):
        real = collections.Counter(); first = {}
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx": continue
            if r["realized_step"]: real[r["trade"]] += float(r["realized_step"])
            if r["action"] == "open" and r["time_from"] and r["time_from"][:5] >= "15:40" and r["trade"] not in first:
                und, exp, sr = r["contract"].rsplit(" ", 2)
                if und in P["universe"] and not sr.endswith("S"): first[r["trade"]] = (r["date"], und, sr[-1])
        for t, k in first.items(): his[k] += real[t]; his_n[k] += 1
    rows = []
    for r in C:
        k = (r["date"], r["sym"], r["right"])
        f = feats(r["sym"], r["date"], idx[r["date"]], cal, 1 if r["right"] == "C" else -1)
        rows.append(dict(r, his=int(k in his), his_real=his.get(k, ""), **f))
    with open(f"{B}/eod_profile_rows.csv", "w") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    picked = [r for r in rows if r["his"]]; other = [r for r in rows if not r["his"]]
    win = [r for r in picked if r["his_real"] > 0]; lose = [r for r in picked if r["his_real"] <= 0]
    print(f"{len(rows)} candidates 2023-Oct 2026; his end-of-day picks among them: {len(picked)} of {len(his)} on the 40 stocks "
          f"(real {sum(r['his_real'] for r in picked)/1e6:+.2f}M of {sum(his.values())/1e6:+.2f}M)\n")
    print("| At 15:46 (median) | His picks | His winners | His losers | Other candidates |\n|---|---|---|---|---|")
    for k in ("move", "ex", "giveback", "from_ext", "min_since_ext", "last30", "rvol", "rvol30", "prev_day", "ret5", "spy_day"):
        g = lambda s: f"{st.median(x[k] for x in s if x[k] is not None):.2f}" if s else ""
        print(f"| {k} | {g(picked)} | {g(win)} | {g(lose)} | {g(other)} |")
    missing = [k for k in his if k not in {(r["date"], r["sym"], r["right"]) for r in rows}]
    print(f"\nhis end-of-day entries that fail the basic rule: {len(missing)} (real {sum(his[k] for k in missing)/1e6:+.2f}M)")


if __name__ == "__main__":
    main()
