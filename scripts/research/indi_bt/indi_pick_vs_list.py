"""Why did Indi pick this stock tonight? (the user 2026-11-02: "I do want to look on each night on other stocks from my 50 lists and see the differents, why did he pick specific this stock for tthe night? winner or not- I do not care.")
Each of his overnight option trades from Feb 2024 (night-book list.json) against the top 50 of strangle_rank.json the same day, same side:
nightly_feat.py measures at 15:57 + daily measures (5/20/60-day residual vs beta*SPY in z, room to the 52-week extreme and distance from the 50-day average in ATR, volatility, beta, dollar volume).
Per measure: his percentile among the others; combined scores (mean percentile) -> his rank of the day.
Run from the app root: python3 indi_pick_vs_list.py out.json   (NB = the night-book list.json path)
"""
import json, gzip, csv, sqlite3, statistics as st, math, sys, datetime as dt
NB='/private/tmp/claude-501/-Users-alonmo-Desktop-Personal-stock-market-assistant/37f43448-efc2-4b55-8041-aa338d12ddbe/scratchpad/night-book/list.json'
APP='/Users/alonmo/Desktop/Personal/stock-market-assistant/'
TOP=json.load(open('/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt/strangle_rank.json'))[:50]
picks=[r for r in json.load(open(NB)) if r['right'] in 'CP' and r['entry']>='2024-02-01']
dates={r['entry'] for r in picks}
F=['rs_day','gap_z','rs_3d','t','consist','rs_down','rvol','rvol_late','updown','dollar','burst','burst_size','lh_run','depth','pos','vwap_ext']
feat={}
with gzip.open(APP+'data/local/x/bt/nightly_feat.csv.gz','rt') as fh:
    for x in csv.DictReader(fh):
        if x['date'] in dates:
            feat[(x['sym'],x['date'],x['side'])]={k:(float(x[k]) if x[k] not in ('',None) else None) for k in F}
db=sqlite3.connect(APP+'data/local/x/bt/daily_all.sqlite')
cache={}
def daily(sym):
    if sym not in cache:
        cache[sym]=db.execute('select date,o,h,l,c,v from day where symbol=? order by date',(sym,)).fetchall()
    return cache[sym]
spy={r[0]:r[4] for r in daily('SPY')}
def dfeat(sym,date,s):
    D=[r for r in daily(sym) if r[0]<date]
    if len(D)<130: return None
    C=[r[4] for r in D]; dd=[r[0] for r in D]
    if any(x not in spy for x in dd[-61:]): return None
    S=[spy[x] for x in dd]
    rs=[C[i]/C[i-1]-1 for i in range(len(C)-60,len(C))]; rm=[S[i]/S[i-1]-1 for i in range(len(S)-60,len(S))]
    mm=st.mean(rm); b=sum((a-st.mean(rs))*(c-mm) for a,c in zip(rs,rm))/sum((c-mm)**2 for c in rm)
    res=[a-b*c for a,c in zip(rs,rm)]; sd=st.pstdev(res) or 1e-9
    tr=[max(D[i][2],D[i-1][4])-min(D[i][3],D[i-1][4]) for i in range(len(D)-14,len(D))]; atr=st.mean(tr)
    o={}
    for n in (5,20,60):
        o[f'rs{n}']=s*((C[-1]/C[-1-n]-1)-b*(S[-1]/S[-1-n]-1))/(sd*math.sqrt(n))
    hi=max(r[2] for r in D[-252:]); lo=min(r[3] for r in D[-252:])
    o['to52']=((C[-1]-hi) if s>0 else (lo-C[-1]))/atr
    sma50=st.mean(C[-50:]); o['sma50']=s*(C[-1]-sma50)/atr
    o['vol']=sd; o['beta']=b; o['adv$']=math.log(st.mean(r[4]*r[5] for r in D[-20:]))
    return o
COMBOS={'day3':['rs_day','t','vwap_ext'],'day6':['rs_day','t','vwap_ext','pos','rvol','burst'],'day6+trend':['rs_day','t','vwap_ext','pos','rvol','burst','rs5','sma50'],'rs_day':['rs_day']}
rows=[]
for p in picks:
    s=1 if p['right']=='C' else -1; side=p['right']; d=p['entry']
    cand=[]
    for sym in set(TOP)|{p['sym']}:
        f=dict(feat.get((sym,d,side)) or {})
        df=dfeat(sym,d,s)
        if df: f.update(df)
        if not f: continue
        f['_sym']=sym; cand.append(f)
    me=[c for c in cand if c['_sym']==p['sym']]
    if not me: continue
    me=me[0]; out={'id':p['id'],'sym':p['sym'],'late':p['late'],'win':(p['pnl'] or 0)>0,'half':dt.date.fromisoformat(d).isocalendar()[1]%2,'inTop':p['sym'] in TOP,'n':len(cand)}
    for k in F+['rs5','rs20','rs60','to52','sma50','vol','beta','adv$']:
        v=me.get(k)
        others=[c[k] for c in cand if c['_sym']!=p['sym'] and c.get(k) is not None]
        if v is None or len(others)<15: continue
        out[k]=(sum(1 for x in others if x<v)+0.5*sum(1 for x in others if x==v))/len(others)  # percentile among the others
        out[k+'_rank']=1+sum(1 for x in others if x>v)
    for name,keys in COMBOS.items():
        sc={}
        for c in cand:
            ps=[]
            for k in keys:
                vals=[x[k] for x in cand if x.get(k) is not None]
                if c.get(k) is None or len(vals)<15: ps=None; break
                ps.append(sum(1 for x in vals if x<c[k])/len(vals))
            if ps: sc[c['_sym']]=st.mean(ps)
        if p['sym'] in sc and len(sc)>=15:
            out['top_'+name]=[dict(c,score=sc[c['_sym']]) for c in sorted(cand,key=lambda c:-sc.get(c['_sym'],-1))[:6]]
            out['C_'+name]=1+sum(1 for v in sc.values() if v>sc[p['sym']]); out['C_'+name+'_n']=len(sc)
    rows.append(out)
json.dump(rows,open(sys.argv[1],'w'))
print(len(picks),'picks from Feb 2024;',len(rows),'compared; in top50:',sum(r['inTop'] for r in rows),'; median candidates',st.median(r['n'] for r in rows))
