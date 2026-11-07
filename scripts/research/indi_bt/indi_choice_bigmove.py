import json, statistics as st, sys
sys.path.insert(0,"/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
from split import half
R=json.load(open(sys.argv[1]))
X=[]
for n,c in R:
    for x in c:
        if x.get("on") is None: continue
        x=dict(x); x["p"]=half(n["date"]); x["his"]=x["sym"]==n["sym"]; x["mv"]=x["on"]*100; X.append(x)
M=["atr_pct","rs_day","t","dollar","rvol","rvol_late","burst","brk20","pos","vwap_ext","to52","ma50","rs5","rs20","lh_run","his_before","tight10","yday"]
print("share of nights with the stock 2%+ HIS WAY / 2%+ AGAINST by 15:57 measure, fifths (low -> high); tune | check")
for m in M:
    out=[]
    for p in ("tune","check"):
        v=sorted([x for x in X if x["p"]==p and x.get(m) is not None],key=lambda x:x[m]); k=len(v)//5
        cells=[]
        for i in range(5):
            g=v[i*k:(i+1)*k] if i<4 else v[4*k:]
            cells.append(f"{100*sum(x['mv']>=2 for x in g)/len(g):3.0f}/{100*sum(x['mv']<=-2 for x in g):3.0f}".replace(f"/{100*sum(x['mv']<=-2 for x in g):3.0f}",f"/{100*sum(x['mv']<=-2 for x in g)/len(g):.0f}"))
        out.append(" ".join(cells))
    print(f"{m:11s} {out[0]}  |  {out[1]}")
