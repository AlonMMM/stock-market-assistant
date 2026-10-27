"""Two more trade sizes on the Bot vs Indi dashboard (the user, 2026-10-27: "add 2.5 and 3% premia pleast"; the live bot
runs 3%): every benchmark trade's return at 2.5% and 3% of the account, the 10% overnight cap at that size, from the
fills the dashboard shows: the +-2% walk (the paths files) and each fill model (fills_f5 / f10 / real / fair). A pyramid
add (key ...+add) is half a trade at half the size, as everywhere.

  python3 <dir>/rets_extra.py <benchmark dir>      (from the app repo root)
-> <dir>/rets_extra.csv (key, ret_25pct, ret_3pct) and rets_extra_{f5,f10,real,fair}.csv
"""
import csv, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim

csv.field_size_limit(10 ** 9)
SIZES = ((0.025, "ret_25pct"), (0.03, "ret_3pct"))


def parse(steps):
    out = []
    for x in steps.split(";"):
        d, m, side, q, px, rule = x.split(",")
        out.append((d, int(m), side, float(q), float(px), rule))
    return out


def rets(key, cost, steps):
    k = 0.5 if key.endswith("+add") else 1.0
    return {col: round(k * sim.result(cost, steps, s * k), 4) for s, col in SIZES}


def write(path, rows):
    with open(path, "w") as f:
        w = csv.DictWriter(f, fieldnames=["key"] + [c for _, c in SIZES]); w.writeheader(); w.writerows(rows)
    print(os.path.basename(path), len(rows), "rows", os.path.getsize(path) // 1024, "KB", flush=True)


def main():
    d = sys.argv[1]
    keys = {r["key"] for r in csv.DictReader(open(f"{d}/all_trades_v3.csv"))}
    base = {}
    for name in ("paths", "paths_fb", "paths_fav", "paths_fav_fb", "paths_champ", "paths_early"):
        p = f"{d}/{name}.csv"
        if not os.path.exists(p): p = os.path.join(os.path.dirname(d), "out", f"{name}.csv")
        for r in csv.DictReader(open(p)):
            if r["key"] in keys and r["key"] not in base: base[r["key"]] = (float(r["cost"]), r["steps"])
    write(f"{d}/rets_extra.csv", [dict(key=k, **rets(k, c, parse(s))) for k, (c, s) in base.items()])
    real = {}
    for m in ("f5", "f10", "real"):
        rows = []
        for r in csv.DictReader(open(f"{d}/fills_{m}.csv")):
            if r["key"] not in keys: continue
            rows.append(dict(key=r["key"], **rets(r["key"], float(r["cost"]), parse(r["steps"]))))
            if m == "real": real[r["key"]] = r["steps"]
        write(f"{d}/rets_extra_{m}.csv", rows)
    rows = []
    for r in csv.DictReader(open(f"{d}/fills_fair.csv")):
        if r["key"] not in real: continue
        steps = parse(real[r["key"]])
        steps = [(steps[0][0], int(r["buy_m"]), "buy", 1.0, float(r["buy_px"]), steps[0][5])] + steps[1:]
        rows.append(dict(key=r["key"], **rets(r["key"], float(r["buy_px"]), steps)))
    write(f"{d}/rets_extra_fair.csv", rows)


if __name__ == "__main__":
    main()
