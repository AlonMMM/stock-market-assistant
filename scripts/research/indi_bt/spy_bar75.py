"""spy_bar.py, the user's own level (0.75% at the entry) on check, all weeks and 2022-23 (it was not the tune pick)."""
import os, pickle, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import spy_bar as SB
R, adds = pickle.load(open(f"{SB.DB.BR.B}/be_ramp_R.pkl", "rb"))
L = (("fair", ""), ("fav", SB.DB.FR.A24))
for part in ("check", "all"):
    out = {}
    for v in ("e", "E7.5-T22", "E7.5-T26", "E7.5-V175", "E7.5-V25", "E7.5-TV"):
        for src, a in L: out[(src, v)] = SB.run(R, adds, part, src, a, SB.VERS[v])
        print(part, v, " | ".join(SB.line(v, out[(s, v)], out[(s, "e")]) for s, _ in L), flush=True)
for v in ("E7.5-T26", "E7.5-V175", "E7.5-TV"):
    y = SB.y2223(SB.VERS[v]); print("y2223", v, {k: (x["n"], x["giants"], x["sum"], x["acct"], x["bdd"]) for k, x in y.items()})
