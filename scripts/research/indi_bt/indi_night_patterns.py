"""Indi night-book patterns (the user 2026-11-02: "any patterns you see in the graph paths? day before? resistance and supports? ... the vs spy thing. how can we best messure it?").
Part 1 of 2: per-trade features at 15:57 from the night-book JSONs (indi_night_book.py output).
Run: python3 indi_night_patterns.py rows.json <night-book dir>/t ; then indi_night_patterns_eval.py (reads rows.json; RS over 5/20/60 days needs <night-book>/_cache/daily_SPY.json, inline in the 2026-11-02 log row)
"""
import json, glob, math, statistics as st, datetime as dt, sys
D=sys.argv[2].rstrip('/')+'/' if len(sys.argv)>2 else 't/'
rows=[]
def cl(bars, m):  # close at or before minute m
    v=None
    for b in bars:
        if b[0]<=m: v=b
        else: break
    return v
for f in sorted(glob.glob(D+'*.json')):
    d=json.load(open(f))
    if d['right'] not in 'CP': continue
    s=1 if d['right']=='C' else -1
    e=d['entry']; ta=d['ta']; B=d['bars']; S=d['spy']
    if e not in B or e not in S: continue
    reg=B[e]['reg']; sreg=dict((m,p) for m,p in S[e]['reg'])
    if len(reg)<300: continue
    days=d['days']; nd=[x for x in days if x>e]
    if not nd or nd[0] not in B or not B[nd[0]]['reg']: continue
    nreg=B[nd[0]]['reg']
    M=387
    px=cl(reg,M)[4]; o=reg[0][1]; beta=ta.get('beta') or 1
    spy0=sreg.get(0); spyM=None
    for m in range(M,-1,-1):
        if m in sreg: spyM=sreg[m]; break
    if not spy0 or not spyM: continue
    atr=ta['atrPct'] or 0.03
    # outcome
    n0=nreg[0][1]; n10=cl(nreg,9)[4]; n30=cl(nreg,29)[4]
    r=dict(id=d['id'], date=e, sym=d['sym'], s=s, win=(d.get('pnl') or 0)>0, ret=d.get('ret'), pnl=d.get('pnl'))
    r['wk']=dt.date.fromisoformat(e).isocalendar()[1]%2  # 0 even tune,1 odd check
    r['Y_gap']=s*(n0/px-1); r['Y_940']=s*(n10/px-1); r['Y_1000']=s*(n30/px-1)
    r['Y_gap_atr']=r['Y_gap']/atr
    # minute residuals
    cs=[]; prevp=None; prevs=None
    mins=[b for b in reg if b[0]<=M]
    res=[]  # (m, cum residual)
    cum=0
    for b in mins:
        m=b[0]
        if m not in sreg: continue
        if prevp is not None:
            rs=b[4]/prevp-1; rsp=sreg[m]/prevs-1
            cum+= s*(rs-beta*rsp); res.append((m,cum, s*rsp))
        prevp=b[4]; prevs=sreg[m]
    if len(res)<200: continue
    # vs SPY measures (his way)
    dayS=s*(px/ta['prevC']-1); spyD=spyM/spy0-1   # spy from open (no prev close)
    ins=s*(px/o-1)
    r['m_raw_ex']=ins - s*spyD          # open->15:57, stock - spy
    r['m_beta_ex']=ins - s*beta*spyD
    r['m_ta_excess']=s*ta['excess']     # incl gap
    r['m_ex_atr']=r['m_beta_ex']/atr
    inc=[res[i][1]-res[i-1][1] for i in range(1,len(res))]
    sd=st.pstdev(inc) or 1e-9
    r['m_t']=res[-1][1]/(sd*math.sqrt(len(inc)))
    # 15-min cuts consistency, rose on spy-down cuts
    cuts=[]; 
    for k in range(0,M,15):
        a=[x for x in res if k<=x[0]<k+15]
        if len(a)>=5: cuts.append((a[-1][1]-a[0][1], sum(x[2] for x in a)))
    r['m_consist']=sum(1 for c in cuts if c[0]>0)/len(cuts)
    dn=[c[0] for c in cuts if c[1]<0]
    r['m_on_spy_down']=sum(dn)/atr if dn else 0
    # smoothness: R^2 of cum residual vs time
    xs=[x[0] for x in res]; ys=[x[1] for x in res]
    mx=st.mean(xs); my=st.mean(ys)
    sxy=sum((a-mx)*(b-my) for a,b in zip(xs,ys)); sxx=sum((a-mx)**2 for a in xs); syy=sum((b-my)**2 for b in ys) or 1e-12
    slope=sxy/sxx; r['m_trend_r2']=(sxy*sxy/(sxx*syy))*(1 if slope>0 else -1)
    def resat(m):
        v=None
        for x in res:
            if x[0]<=m: v=x[1]
        return v or 0
    r['m_ex_lasthour']=(res[-1][1]-resat(M-60))/atr
    r['m_ex_last30']=(res[-1][1]-resat(M-30))/atr
    r['m_ex_morning']=resat(150)/atr
    r['m_ex_afternoon']=(res[-1][1]-resat(150))/atr
    # max residual and drawback from peak
    pk=max(ys); r['m_ex_off_peak']=(pk-res[-1][1])/atr
    # path (his way)
    hi=max(b[2] for b in mins); lo=min(b[3] for b in mins)
    r['p_gap']=s*(o/ta['prevC']-1)/atr
    r['p_day']=dayS/atr
    r['p_rangepos']=(px-lo)/(hi-lo) if s>0 else (hi-px)/(hi-lo)
    ext=[b for b in mins]; 
    hod_m=max(ext,key=lambda b:b[2])[0] if s>0 else min(ext,key=lambda b:b[3])[0]
    r['p_extreme_late']=hod_m/M
    p60=cl(reg,M-60)[4]; p15=cl(reg,M-15)[4]
    r['p_lasthour']=s*(px/p60-1)/atr; r['p_last15']=s*(px/p15-1)/atr
    # day before
    db=[x for x in days if x<e]
    dly={x[0]:x for x in d['daily']}
    ks=sorted(k for k in dly if k<e)
    if len(ks)>=6:
        c1=dly[ks[-1]][4]; c2=dly[ks[-2]][4]; c6=dly[ks[-6]][4]
        h1,l1=dly[ks[-1]][2],dly[ks[-1]][3]
        r['d1_ret']=s*(c1/c2-1)/atr
        r['d1_closepos']=((c1-l1)/(h1-l1) if s>0 else (h1-c1)/(h1-l1)) if h1>l1 else .5
        r['d5_ret']=s*(c1/c6-1)/atr
        v1=dly[ks[-1]][5]; v20=st.mean(dly[k][5] for k in ks[-21:-1]) if len(ks)>21 else None
        r['d1_rvol']=v1/v20 if v20 else None
        if len(ks)>=21: r['d20_ret']=s*(c1/dly[ks[-21]][4]-1)/atr
    if db and db[-1] in B and db[-1] in S and B[db[-1]]['reg']:
        pr=B[db[-1]]['reg']; ps=dict((m,p) for m,p in S[db[-1]]['reg'])
        if 0 in ps and ps:
            lm=max(ps); r['d1_ex']=s*((pr[-1][4]/pr[0][1]-1)-beta*(ps[lm]/ps[0]-1))/atr
            p_=cl(pr,329); r['d1_lasthour']=s*(pr[-1][4]/p_[4]-1)/atr if p_ else None
    # S/R
    lv=[x['p'] for x in d['levels']]
    ahead=[x for x in lv if (x-px)*s>0]; behind=[x for x in lv if (x-px)*s<0]
    A=atr*px
    r['sr_res_dist']=min(abs(x-px) for x in ahead)/A if ahead else 5
    r['sr_sup_dist']=min(abs(x-px) for x in behind)/A if behind else 5
    r['sr_broke_today']=sum(1 for x in lv if (x-o)*s>0 and (x-px)*s<0)
    r['sr_vs_prevext']=(s*(px-(ta['prevH'] if s>0 else ta['prevL'])))/A
    r['sr_to_20ext']=(s*(px-(ta['hi20'] if s>0 else ta['lo20'])))/A
    r['sr_to_52ext']=(s*(px-(ta['hi52'] if s>0 else ta['lo52'])))/A
    r['sr_sma20']=s*(px/ta['sma20']-1)/atr if ta.get('sma20') else None
    r['sr_sma50']=s*(px/ta['sma50']-1)/atr if ta.get('sma50') else None
    r['t_rsi']=(ta['rsi14']-50)*s if ta.get('rsi14') else None
    # volume
    vols=[b[5] for b in mins]; tot=sum(vols)
    r['v_rvol']=ta.get('rvol1557')
    r['v_lasthour_share']=sum(b[5] for b in mins if b[0]>M-60)/tot
    v5=[sum(vols[i:i+5]) for i in range(30,len(vols)-4,5)]
    med=st.median(v5) or 1
    r['v_burst']=max(v5)/med
    bi=max(range(len(v5)),key=lambda i:v5[i]); r['v_burst_age']=(len(v5)-bi)*5
    upv=sum(b[5] for b in mins if (b[4]-b[1])*s>0); dnv=sum(b[5] for b in mins if (b[4]-b[1])*s<0)
    r['v_updown']=(upv-dnv)/(upv+dnv)
    # news near
    r['n_news']=len(d.get('news') or [])
    r['n_earn']=1 if d.get('earnings') else 0
    rows.append(r)
json.dump(rows,open(sys.argv[1],'w'))
print(len(rows))
