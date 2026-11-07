import json, statistics as st, sys, random
sys.path.insert(0,"/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
from split import half
R=json.load(open(sys.argv[1]))
def stats(v):
    n=len(v)
    return dict(n=n, up2=100*sum(x>=2 for x in v)/n, up4=100*sum(x>=4 for x in v)/n, dn2=100*sum(x<=-2 for x in v)/n,
                pos=st.mean([max(x,0) for x in v]), neg=st.mean([max(-x,0) for x in v]))
def line(lab,v):
    s=stats(v); print(f"  {lab:34s} n{s['n']:5d}  +2%+ {s['up2']:5.1f}%  +4%+ {s['up4']:4.1f}%  -2%- {s['dn2']:5.1f}%  avg gain part {s['pos']:.2f}%  avg loss part {s['neg']:.2f}%  ratio {s['pos']/s['neg']:.2f}")
for key,lab in (("on","raw % move his way, 15:57 -> 09:45"),("z_on","z (vs its own usual night)")):
    print(f"\n== {lab}")
    for p in ("tune","check"):
        print(p)
        groups={"his pick":[], "others, all names":[], "others, 10 strongest today":[], "others, 10 biggest":[], "others, his usual names":[]}
        for n,c in R:
            if half(n["date"])!=p: continue
            me=next(x for x in c if x["sym"]==n["sym"])
            if me.get(key) is None: continue
            v=me[key]*(100 if key=="on" else 1)
            groups["his pick"].append(v)
            oth=[x for x in c if x["sym"]!=n["sym"] and x.get(key) is not None]
            strong=sorted([x for x in oth if x["rs_day"] is not None],key=lambda x:-x["rs_day"])[:10]
            big=sorted([x for x in oth if x.get("dollar") is not None],key=lambda x:-x["dollar"])[:10]
            usual=[x for x in oth if x.get("his_before",0)>=3]
            for g,L in (("others, all names",oth),("others, 10 strongest today",strong),("others, 10 biggest",big),("others, his usual names",usual)):
                groups[g]+= [x[key]*(100 if key=="on" else 1) for x in L]
        for g,v in groups.items():
            if v: line(g,v)
