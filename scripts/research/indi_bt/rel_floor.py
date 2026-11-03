"""The 200 floor scaled by the stock's usual option volume, on the champion 2.10 (the user, 2026-11-03: "what about
relative volume? 200 contract should not signal on appl but should on coin"). The usual = vol_ratio.py's: the median
30-minute volume of the 0.15-delta pick on the stock's last 30 main signals on earlier days (both lists pooled, needs 5,
else the 200 floor). It reads high: signal days are busier than ordinary days. The same contract, the $0.20 floor
($0.10 IBIT), 2.10's exits, size and pyramid (the add uses the same rule with its own pick). Set before running:
  champ   2.10 as is (200 contracts in 30 minutes)
  K0.5    the pick needs 0.5x its usual (no 200)
  K1      1x its usual (no 200)
  UP1     max(200, 1x usual): raise only (AAPL needs more, COIN keeps 200)
  DN0.5   min(200, 0.5x usual): lower only (COIN may need less, AAPL keeps 200)
Tested before: vol_ratio.py (2026-11-03) R2 / R3 / R2f50 (a thin pick at 2x / 3x) and RO2 (2x for every stock, no 200)
all fail. The multiples under 2x and the one-sided versions are new: look 1. Added thin trades are "fill unproven".
Lists: the fair list + the Favorites (24 months); tune = even entry weeks, check = odd (split.py), the same run; one pick
on tune by min(fair, Favorites) vs champ at 2%; check for champ and the pick, at 2% and 3%.

  node --env-file=.env <dir>/run.mjs rel_floor.py      (from the app repo root)
-> data/local/x/bt/rel_floor_summary.json, rel_floor_trades.csv
"""
import collections, csv, json, multiprocessing as mp, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vol_ratio as VR
import thin_strike as TS
import fav_real as FR
import floor_exception as fe
import real_bench as RB

B = "data/local/x/bt"
MODES = ("champ", "K0.5", "K1", "UP1", "DN0.5")


def takes(vol, r):
    """r = vol / usual (99 when the usual is 0), None without a usual (the 200 floor)."""
    if r is None: return list(MODES) if vol >= 200 else []
    out = []
    if vol >= 200: out += ["champ"]
    if r >= 0.5: out += ["K0.5"]
    if r >= 1: out += ["K1"]
    if vol >= 200 and r >= 1: out += ["UP1"]
    if vol >= 200 or r >= 0.5: out += ["DN0.5"]
    return out


VR.MODES, VR.takes = MODES, takes


def usual_by_stock(U):
    print("\n#### The usual by stock (median 30-minute volume of the 0.15 pick, every main signal, both lists)\n")
    rows = sorted(((s, st.median(v for _, v in xs), len(xs)) for s, xs in U.items() if len(xs) >= 5), key=lambda x: -x[1])
    print("| Busiest | Usual | Signals | | Quietest | Usual | Signals |")
    print("|---|---|---|---|---|---|---|")
    q = rows[::-1]
    for a, b in zip(rows[:15], q[:15]):
        print(f"| {a[0]} | {a[1]:,.0f} | {a[2]} | | {b[0]} | {b[1]:,.0f} | {b[2]} |")
    for s in ("AAPL", "COIN"):
        x = [r for r in rows if r[0] == s]
        if x: print(f"{s}: usual {x[0][1]:,.0f} over {x[0][2]} signals")
    return {s: dict(usual=u, n=n) for s, u, n in rows}


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    print(len(jobs), "signals; data to", RB.LAST, flush=True)
    with mp.Pool(8) as pool: P = [p for p in pool.map(VR.first, jobs, chunksize=4) if p]
    U = VR.usual_table(P)
    J = [(job, best, *VR.ratio(U, job[2]["sym"], job[2]["date"], best[5])) for job, best in P]
    print(f"{len(P)} picks; with a usual: {sum(j[2] is not None for j in J)}", flush=True)
    with mp.Pool(8) as pool: R = [r for r in pool.map(VR.second, J, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out, rows = {}, []
    TS.table(R, adds, "tune", out, "Tune weeks (even)", MODES)
    score = lambda v: min(out[f"tune|{v}|fair|0.02"]["acct"] / out["tune|champ|fair|0.02"]["acct"],
                          out[f"tune|{v}|fav|0.02"]["acct"] / out["tune|champ|fav|0.02"]["acct"])
    pick = max(MODES[1:], key=score)
    out["pick"] = pick
    print(f"\n🎯 Picked on tune (min of fair and Favorites vs champ, 2%): {pick} ({score(pick):.3f}); better on both: {score(pick) > 1}")
    TS.table(R, adds, "check", out, "Check weeks (odd), the same run, champ and the pick only", ("champ", pick))
    VR.diff(R, "tune", out, MODES[1:], rows)
    VR.diff(R, "check", out, (pick,), rows)
    out["usual"] = usual_by_stock(U)
    json.dump(out, open(f"{B}/rel_floor_summary.json", "w"), indent=1)
    with open(f"{B}/rel_floor_trades.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
