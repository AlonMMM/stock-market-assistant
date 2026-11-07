"""dd_base_both.py with the ladder (2.8.1's size steps, live in 2.9 / 2.10): 3% under $300K, 2.5% from $300K, 1.5% from
$1M, 1% from $4M (the user, 2026-11-07: "it's with the ladder?"). The drawdown rule multiplies the ladder's size; flat
yardsticks multiply the whole ladder (x0.875, x0.75, x0.5).

  node --env-file=.env <dir>/run.mjs dd_base_ladder.py
"""
import json, os, pickle, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import dd_base as DB
import dd_base_both as BB


def ladder(k):
    def size(eq):
        if eq >= 4e6: return 0.01 * k
        if eq >= 1e6: return 0.015 * k
        if eq >= 3e5: return 0.025 * k
        return 0.03 * k
    return size


def main():
    R, adds = pickle.load(open(f"{DB.BR.B}/be_ramp_R.pkl", "rb"))
    out = {}
    print("\n### The ladder (3% / 2.5% / 1.5% / 1%), from $100,000\n")
    print("| Version | List | Tune: end / worst drop | vs e | Check: end / worst drop | vs e | All weeks: end / worst drop | vs e | giants cut (all) |")
    print("|---|---|---|---|---|---|---|---|---|")
    for lst in ("fair", "fav", "both"):
        for name, k, rule in (("e ladder", 1.0, None), ("e ladder x0.875", 0.875, None), ("e ladder x0.75", 0.75, None), ("DD on the ladder", 1.0, DB.RULES["DD"])):
            cells = []
            for part in ("tune", "check", "all"):
                if lst == "both": E = BB.both(R, adds, part)[0]
                else: E = DB.entries(R, adds, lst, part, DB.FR.A24 if lst == "fav" else "")
                s = DB.account(E, ladder(k), rule); out[f"{lst}|{part}|{name}"] = s
                b = out[f"{lst}|{part}|e ladder"]
                cells.append(f"${s['acct']:,} / {s['dd']:.1%} | {s['acct'] / b['acct']:.3f}")
            print(f"| {name} | {lst} | " + " | ".join(cells) + f" | {s['gcut']} of {s['giants']} |", flush=True)
    json.dump(out, open(f"{DB.BR.B}/dd_base_ladder_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
