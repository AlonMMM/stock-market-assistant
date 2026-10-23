"""Exports the failed-break watch of every champion trade for the bot's parity check (scripts/bot-level-parity.ts):
the level ahead at the signal and what the stock did at it over the whole entry day (to 15:49, ignoring the sales).

  python3 level_parity_export.py      (from the repo root) -> data/local/x/bt/level_parity.csv
"""
import csv, glob, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import news_filter as nf
from levels import ctx, ahead, NEAR, BREAK, BACK, WAIT, EOD

B = "data/local/x/bt"


def main():
    T = [t for f in glob.glob(f"{B}/s_t18r15_20*.[0-9]_trades.csv") for t in csv.DictReader(open(f)) if t["status"] == "ok"]
    nf.features(T)
    T = sorted((t for t in T if t["e_next"] != 0 and (t["pre_rvol"] is None or t["pre_rvol"] < 4)), key=lambda t: (t["date"], int(t["minute"])))
    out = []
    for t in T:
        bet = 1 if t["right"] == "C" else -1; m0 = int(t["minute"])
        x = ctx(t["sym"], t["date"])
        a = ahead(x, m0, bet) if x and x["c"][m0] is not None else None
        row = dict(date=t["date"], sym=t["sym"], right=t["right"], minute=m0, name="", level="", unit="", state="none", at="")
        if a:
            lv, sd0 = a[1], x["sd"] * x["c"][m0]
            row.update(name=a[0], level=lv, unit=sd0, state="watching")
            touch = None
            for m in range(m0 + 1, EOD):
                p = x["c"][m]
                if p is None: continue
                d = bet * (lv - p) / sd0
                if d <= -BREAK: row.update(state="broken", at=m); break
                if d <= NEAR and touch is None: touch = m
                if touch is not None and m - touch > WAIT: row.update(state="ended", at=m); break
                if touch is not None and d >= BACK: row.update(state="failed", at=m); break
        out.append(row)
    with open(f"{B}/level_parity.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
    print(len(out), "trades,", sum(r["state"] == "failed" for r in out), "failed breaks")


if __name__ == "__main__":
    main()
