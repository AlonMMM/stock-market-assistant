"""The mid-limit buy rechecked (2026-10-28): STR_BUY=mid read its fallback price from the second book (opt2: cmbp-1 before
2025-02-20, stale quotes at times; SMCI 2024-09-26 bought at $10.65 instead of $4.13). Here everything comes from the book
the baseline buys on (sec_cache/opt): a limit at the mid at the buy second for W s (filled when the ask comes down to it),
else the usual price W s later (the mid + half to the ask, the same 10-second chase). Sale and exit unchanged.
  WS_IN=<STR_DUMP_ALL file> python3 mid_buy.py      (from the app repo root)"""
import csv, gzip, json, os
os.environ.setdefault("BT_VARIANT", "v2")
import leg_seconds as LS
import sell_limit as SL


def usual(rows, s):
    q = LS.book_at(rows, s)
    if not q: return None
    mid = (q[0] + q[1]) / 2; buy = mid + (q[1] - mid) / 2
    later = LS.book_at(rows, s + 10)
    if later and later[0] > buy: buy = min(later[1], buy * 1.1)
    return buy


def main():
    T = SL.trades_in()
    ev = {(e["date"], e["sym"], e["m"]): e for e in json.load(open(os.path.join(LS.OUT, f"events{LS.TAG}.json")))}
    print("| Wait at the mid | Filled at the mid | Buy vs today (avg) | $100K becomes (2%) | Avg | Drop | Tune / check | Check without 2025-10-10 |")
    print("|---|---|---|---|---|---|---|---|")
    avg = lambda L: sum(L) / max(1, len(L))
    for wait in (0, 1, 2, 5, 10):
        P, filled, ratio = [], 0, []
        for t in T:
            e = ev[(t["date"], t["sym"], int(t["minute"]))]
            sec = int(t["to_cross"]) + e.get("sec0", (e["m"] + 1) * 60)
            p = LS.opt_path(e, t["contract"], sec)
            rows = [(int(a), b, c) for a, b, c in csv.reader(gzip.open(p, "rt")) if float(b) > 0 and float(c) > 0] if os.path.exists(p) else []
            if os.environ.get("MB_CLEAN"):   # drop a flickering book (spread over MB_CLEAN of the mid), for today's buy and the waited one alike
                k = float(os.environ["MB_CLEAN"])
                rows = [r for r in rows if (float(r[2]) - float(r[1])) <= k * (float(r[1]) + float(r[2])) / 2]
            t0 = sec + LS.LAG
            base = usual(rows, t0)
            if base is None: P.append(t); continue
            buy = base
            if wait:
                q = LS.book_at(rows, t0); lim = (q[0] + q[1]) / 2
                hit = next((s for s in range(t0 + 1, t0 + wait + 1) if (b := LS.book_at(rows, s)) and b[1] <= lim + 1e-9), None)
                if hit: buy = lim; filled += 1
                else: buy = usual(rows, t0 + wait) or base
            ratio.append(buy / float(t["buy"]))
            P.append(dict(t, buy=buy))
        end, dd, R, _, _ = SL.kept(P, 2)
        ret = lambda r: (r["sell"] * 100 - 0.62) / (r["buy"] * 100 + 0.62) - 1
        tune, chk = avg([ret(r) for r in R if r["date"] < "2025-07"]), avg([ret(r) for r in R if r["date"] >= "2025-07"])
        chk_wo = avg([ret(r) for r in R if r["date"] >= "2025-07" and r["date"] != "2025-10-10"])
        print(f"| {wait} s | {filled} | {100 * (avg(ratio) - 1):+.2f}% | ${end:,.0f} | {100 * avg([ret(r) for r in R]):+.1f}% | {100 * dd:.1f}% | {100 * tune:+.1f} / {100 * chk:+.1f} | {100 * chk_wo:+.1f} |", flush=True)


if __name__ == "__main__": main()
