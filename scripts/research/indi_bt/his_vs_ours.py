"""His real trades against the same entries under our exit (your stop, sold by 15:50), 2024 - Oct 2026, 40 stocks.

His return = his real P&L / all the premium he paid in the trade (adds included); ours = the P&L of his first
entry (his contract, his minute) under our exit / $10K. Both are then put on $10K a trade, and compounded at
1.5% of the current account from $2M.

  python3 his_vs_ours.py      (from the repo root) -> data/local/x/bt/his_vs_ours.csv + printed tables
"""
import collections, csv, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
P = json.load(open(os.path.join(HERE, "params.json")))
B = "data/local/x/bt"


def main():
    ours = collections.defaultdict(list)
    for x in csv.DictReader(open(f"{B}/t_his_miss.csv")):
        if x["pnl"]: ours[(x["date"], x["sym"], int(x["minute"]))].append(float(x["pnl"]))
    T = collections.OrderedDict()
    for y in ("2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx": continue
            und, exp, sr = r["contract"].rsplit(" ", 2)
            if und not in P["universe"] or sr.endswith("S") or r["date"] < "2024-02-01": continue
            t = T.setdefault(r["trade"], dict(cost=0.0, pnl=0.0, key=None, days=set(), adds=0))
            t["days"].add(r["date"])
            if r["side"] == "B":
                t["cost"] += float(r["qty"]) * float(r["avg_price"]) * 100
                if t["key"] is None and r["time_from"]:
                    hh, mm = map(int, r["time_from"][:5].split(":")); t["key"] = (r["date"], und, min(389, hh * 60 + mm - 570))
                else: t["adds"] += 1
            if r["realized_step"]: t["pnl"] += float(r["realized_step"])
    rows, used = [], collections.Counter()
    for tid, t in T.items():
        k = t["key"]
        if not k or not t["cost"] or k not in ours: continue
        i = used[k]; used[k] += 1
        if i >= len(ours[k]): continue
        rows.append(dict(trade=tid, date=k[0], sym=k[1], minute=k[2], his_ret=t["pnl"] / t["cost"], our_ret=ours[k][i] / 1e4,
                         his_real=round(t["pnl"]), his_cost=round(t["cost"]), nights=len(t["days"]) - 1, adds=t["adds"]))
    rows.sort(key=lambda r: (r["date"], r["minute"]))
    with open(f"{B}/his_vs_ours.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(len(rows), "trades matched of", sum(1 for t in T.values() if t["key"] and t["cost"]))
    print("\n| Year | Trades | His per $10K | Ours per $10K | His win | Our win | His w/o best 5 | Ours w/o best 5 |\n|---|---|---|---|---|---|---|---|")
    for y in ("2024", "2025", "2026", "all"):
        g = [r for r in rows if y == "all" or r["date"][:4] == y]
        h = sorted(1e4 * r["his_ret"] for r in g); o = sorted(1e4 * r["our_ret"] for r in g)
        print(f"| {y} | {len(g)} | {st.fmean(h):+,.0f} | {st.fmean(o):+,.0f} | {100*sum(x>0 for x in h)/len(h):.0f}% | {100*sum(x>0 for x in o)/len(o):.0f}% | "
              f"{sum(h[:-5])/1e3:+,.0f}K | {sum(o[:-5])/1e3:+,.0f}K |")
    print("\n| Outcome | Trades | His $10K | Ours $10K | His real $ |\n|---|---|---|---|---|")
    cat = lambda r: ("both win" if r["our_ret"] > 0 else "he wins, we lose") if r["his_ret"] > 0 else ("we win, he loses" if r["our_ret"] > 0 else "both lose")
    for c in ("both win", "he wins, we lose", "we win, he loses", "both lose"):
        g = [r for r in rows if cat(r) == c]
        print(f"| {c} | {len(g)} | {sum(1e4*r['his_ret'] for r in g)/1e3:+,.0f}K | {sum(1e4*r['our_ret'] for r in g)/1e3:+,.0f}K | {sum(r['his_real'] for r in g)/1e6:+.2f}M |")
    print("\n| Held | Trades | His $10K | Ours $10K |\n|---|---|---|---|")
    for lab, f in (("same day", lambda r: r["nights"] == 0), ("overnight+", lambda r: r["nights"] > 0)):
        g = [r for r in rows if f(r)]
        print(f"| {lab} | {len(g)} | {sum(1e4*r['his_ret'] for r in g)/1e3:+,.0f}K | {sum(1e4*r['our_ret'] for r in g)/1e3:+,.0f}K |")
    E = [-1, -0.5, -0.25, 0, 0.5, 1, 3, 99]
    lab = ["<-50%", "-50..-25%", "-25..0%", "0..+50%", "+50..+100%", "+100..+300%", ">+300%"]
    print("\n| Return | His | Ours |\n|---|---|---|")
    for a, b, l in zip(E, E[1:], lab):
        print(f"| {l} | {sum(a < r['his_ret'] <= b if a > -1 else r['his_ret'] <= b for r in rows)} | {sum(a < r['our_ret'] <= b if a > -1 else r['our_ret'] <= b for r in rows)} |")


if __name__ == "__main__":
    main()
