"""Part 2: rank correlation and thirds per half (tune even ISO weeks / check odd), plus multi-day strength vs beta*SPY.
Run: python3 indi_night_patterns_eval.py rows.json"""
import json, statistics as st
R=json.load(open('rows.json'))
def rank(v):
    o=sorted(range(len(v)),key=lambda i:v[i]); rk=[0]*len(v)
    for j,i in enumerate(o): rk[i]=j
    return rk
def sp(x,y):
    if len(x)<20: return float('nan')
    a,b=rank(x),rank(y); ma,mb=st.mean(a),st.mean(b)
    num=sum((p-ma)*(q-mb) for p,q in zip(a,b)); den=(sum((p-ma)**2 for p in a)*sum((q-mb)**2 for q in b))**.5
    return num/den
feats=[k for k in R[0] if k[:2] in('m_','p_','d1','d5','d2','sr','t_','v_','n_')]
feats=sorted(set(k for r in R for k in r if k[:2] in('m_','p_','d1','d5','d2','sr','t_','v_','n_')))
print('n',len(R),'tune',sum(1 for r in R if r['wk']==0))
print(f"{'feature':18} | rho Y940 tune/check | rho win tune/check | win% low/mid/high third | Y940 median low/mid/high (bp)")
out=[]
for f in feats:
    L=[r for r in R if r.get(f) is not None]
    res=[]
    for Y in ('Y_940','win'):
        for h in (0,1):
            S=[r for r in L if r['wk']==h]
            res.append(sp([r[f] for r in S],[float(r[Y]) for r in S]))
    L.sort(key=lambda r:r[f]); n=len(L); T=[L[:n//3],L[n//3:2*n//3],L[2*n//3:]]
    w=[100*sum(r['win'] for r in t)/len(t) for t in T]; y=[1e4*st.median(r['Y_940'] for r in t) for t in T]
    cut=[L[n//3][f],L[2*n//3][f]]
    out.append((f,res,w,y,cut))
for f,res,w,y,cut in out:
    flag='**' if (res[0]*res[1]>0 and min(abs(res[0]),abs(res[1]))>.1) else ('w*' if res[2]*res[3]>0 and min(abs(res[2]),abs(res[3]))>.1 else '')
    print(f"{f:18} | {res[0]:+.2f} {res[1]:+.2f} | {res[2]:+.2f} {res[3]:+.2f} | {w[0]:.0f}/{w[1]:.0f}/{w[2]:.0f} | {y[0]:+.0f}/{y[1]:+.0f}/{y[2]:+.0f} | cuts {cut[0]:.2f},{cut[1]:.2f} {flag}")
print('base win', 100*sum(r['win'] for r in R)/len(R), 'Y940 median bp', 1e4*st.median(r['Y_940'] for r in R))
