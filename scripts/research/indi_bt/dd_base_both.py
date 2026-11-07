"""dd_base.py with the two lists in one account (the user, 2026-11-07: "combined the 2 lists together to see"): the fair
list's and the Favorites' trades together (Favorites from FR.A24, as each list alone); a trade on both lists (same day,
stock, side) counted once, the fair list's.

  node --env-file=.env <dir>/run.mjs dd_base_both.py
"""
import json, os, pickle, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import dd_base as DB
import fav_real as FR


def both(R, adds, part):
    fair = DB.entries(R, adds, "fair", part, "")
    keys = {(r["date"], r["sym"], r["right"]) for r in R if r["src"] == "fair" and r["kind"] == "main"}
    R2 = [r for r in R if not (r["src"] == "fav" and (r["date"], r["sym"], r["right"]) in keys)]
    fav = DB.entries(R2, adds, "fav", part, FR.A24)
    return sorted(fair + fav, key=lambda e: e[:2]), len(fair), len(fav)


def main():
    R, adds = pickle.load(open(f"{DB.BR.B}/be_ramp_R.pkl", "rb"))
    out = {}
    for pct, flats in ((0.02, (0.02, 0.0175, 0.015)), (0.03, (0.03, 0.025, 0.0225))):
        print(f"\n### Both lists in one account, {pct:.0%} basic size, from $100,000\n")
        print("| Version | Tune: end / worst drop | vs e | Check: end / worst drop | vs e | All weeks: end / worst drop | vs e | giants cut (all) |")
        print("|---|---|---|---|---|---|---|---|")
        for name, p, rule in [(f"e flat {f:.2%}", f, None) for f in flats] + [(f"DD on {pct:.0%}", pct, DB.RULES["DD"])]:
            cells = []
            for part in ("tune", "check", "all"):
                E, nf, nv = both(R, adds, part)
                s = DB.account(E, p, rule); out[f"{pct}|{part}|{name}"] = s
                b = out[f"{pct}|{part}|e flat {pct:.2%}"]
                cells.append(f"${s['acct']:,} / {s['dd']:.1%} | {s['acct'] / b['acct']:.3f}")
            print(f"| {name} | " + " | ".join(cells) + f" | {s['gcut']} of {s['giants']} |", flush=True)
        print(f"(all weeks: {nf} fair entries + {nv} Favorites entries not on the fair list)")
    json.dump(out, open(f"{DB.BR.B}/dd_base_both_summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
