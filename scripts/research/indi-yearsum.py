import csv, sys, collections
for y in sys.argv[1:]:
    R = [r for r in csv.DictReader(open(f"ultrawavetrader-{y}/actions.csv")) if r["account"] == "silexx"]
    by = collections.defaultdict(list)
    for r in R: by[r["trade"]].append(r)
    T = []
    for t, s in by.items():
        pnl = next((float(x["realized_total"]) for x in reversed(s) if x["realized_total"]), None)
        if pnl is None: continue
        o = next((x for x in s if x["action"] == "open"), s[0])
        T.append(dict(t=t, pnl=pnl, stock=s[0]["contract"].endswith("S"), time=o["time_from"], days=len({x["date"] for x in s})))
    op = [x for x in T if not x["stock"]]; op.sort(key=lambda x: -x["pnl"])
    net = sum(x["pnl"] for x in op); w = [x for x in op if x["pnl"] > 0]
    late = [x for x in op if x["time"] >= "15:45:00"]; rest = [x for x in op if x["time"] and x["time"] < "15:45:00"]
    def wo3(L): L = sorted(L, key=lambda x: -x["pnl"]); return sum(x["pnl"] for x in L[3:])
    print(f"{y}: option trades {len(op)}, wins {len(w)} ({len(w)/len(op):.0%}), net {net/1e6:+.2f}M, top10 {sum(x['pnl'] for x in op[:10])/1e6:+.2f}M, "
          f"avg win {sum(x['pnl'] for x in w)/len(w)/1e3:+.0f}K avg loss {sum(x['pnl'] for x in op if x['pnl']<=0)/max(1,len(op)-len(w))/1e3:+.0f}K; "
          f"shares {sum(x['pnl'] for x in T if x['stock'])/1e6:+.2f}M\n   late(>=15:45) {len(late)} trades {sum(x['pnl'] for x in late)/1e6:+.2f}M (w/o top3 {wo3(late)/1e6:+.2f}M); "
          f"rest {len(rest)} {sum(x['pnl'] for x in rest)/1e6:+.2f}M (w/o top3 {wo3(rest)/1e6:+.2f}M); overnight {sum(x['days']>1 for x in op)} trades {sum(x['pnl'] for x in op if x['days']>1)/1e6:+.2f}M")
