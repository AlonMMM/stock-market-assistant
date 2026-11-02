# Indi's overnight trades: where the money comes from (buy->close, close->open, open->sale), timing, SPY, side, weekday, expiry, size, repeats, years. The user 2026-11-02: "I still want to understand his overnight. reasearch all the overnight". Reads the night-book trade JSONs (indi_night_book.py) from ./night-book/t; joins data/local/x/bt/indi_night_reasons.json (his reasons from his posts, read and labelled per trade).
import json,glob,statistics as st,collections,datetime as dt
R=[]
def at(bars,m):
    v=None
    for b in bars:
        if b[0]<=m: v=b[4]
    return v
tm=lambda t:(int(t[:2])-9)*60+int(t[3:5])-30 if t and len(t)>=5 else 389
for f in sorted(glob.glob('night-book/t/*.json')):
    d=json.load(open(f))
    if d['right'] not in 'CP': continue
    s=1 if d['right']=='C' else -1; e=d['entry']; B=d['bars']
    if e not in B or not B[e]['reg']: continue
    buys=[a for a in d['acts'] if a['side']=='B' and a['d']==e]
    sells=[a for a in d['acts'] if a['side']=='S']
    if not buys or not sells: continue
    m=tm(buys[0]['t']); px=at(B[e]['reg'],m); cl=B[e]['reg'][-1][4]
    nd=[x for x in d['days'] if x>e]
    if not nd or nd[0] not in B or not B[nd[0]]['reg']: continue
    no=B[nd[0]]['reg'][0][1]
    ls=sells[-1]; ex=at(B[ls['d']]['reg'],max(tm(ls['t']),0)) if ls['d'] in B and B[ls['d']]['reg'] else None
    fs=sells[0]
    spy=d['spy'][e]['reg']; spyd=s*(spy[-1][1]/spy[0][1]-1)
    cost=sum(a['qty']*a['px']*100 for a in d['acts'] if a['side']=='B')
    R.append(dict(id=d['id'],sym=d['sym'],date=e,s=s,m=m,pnl=d['pnl'] or 0,ret=d['ret'] or 0,
      a_buy_close=s*(cl/px-1) if px else None,b_overnight=s*(no/cl-1),c_open_exit=s*(ex/no-1) if ex else None,
      first_sell_day=fs['d']==nd[0], first_sell_min=tm(fs['t']) if fs['d']==nd[0] else None, last_sell=ls['d'],
      expired=any('expired' in (a['kind'] or '') for a in sells), cost=cost, spy_his_way=spyd, wd=dt.date.fromisoformat(e).weekday(),
      added_next=any(a['side']=='B' and a['d']>e for a in d['acts']), dte=(dt.date.fromisoformat(d['exp'])-dt.date.fromisoformat(e)).days))
json.dump(R,open('nb_an/flow.json','w'))
md=lambda v:st.median([x for x in v if x is not None])
pc=lambda S,f:100*sum(1 for r in S if f(r))/len(S)
print('trades',len(R),'won',sum(r['pnl']>0 for r in R),'total $K',round(sum(r['pnl'] for r in R)/1e3))
print('buy time: before 12:00',sum(r['m']<150 for r in R),'| 12-15',sum(150<=r['m']<330 for r in R),'| 15:00+',sum(r['m']>=330 for r in R))
for nm,f in (('before 12',lambda r:r['m']<150),('12-15',lambda r:150<=r['m']<330),('15+',lambda r:r['m']>=330)):
    S=[r for r in R if f(r)]; print('  ',nm,len(S),'win %d%%'%pc(S,lambda r:r['pnl']>0),'median %+.0f%%'%(100*md([r['ret'] for r in S])),'sum $K',round(sum(r['pnl'] for r in S)/1e3),'buy->close bp %+.0f'%(1e4*md([r['a_buy_close'] for r in S])))
for nm,S in (('all',R),('won',[r for r in R if r['pnl']>0]),('lost',[r for r in R if r['pnl']<=0])):
    print(nm,len(S),'stock his way, median bp: buy->close %+.0f | close->next open %+.0f | open->last sale %+.0f'%(1e4*md([r['a_buy_close'] for r in S]),1e4*md([r['b_overnight'] for r in S]),1e4*md([r['c_open_exit'] for r in S])),
      '| first sale next day %d%% (median minute %s) | added later %d%% | expired worthless %d%%'%(pc(S,lambda r:r['first_sell_day']), md([r['first_sell_min'] for r in S]), pc(S,lambda r:r['added_next']), pc(S,lambda r:r['expired'])))
p=sorted((r['pnl'] for r in R),reverse=True); print('top 10 trades $K',round(sum(p[:10])/1e3),'| top 20',round(sum(p[:20])/1e3),'| the other',len(p)-20,round(sum(p[20:])/1e3))
for nm,f in (('SPY with him >0.3%',lambda r:r['spy_his_way']>0.003),('SPY flat',lambda r:abs(r['spy_his_way'])<=0.003),('SPY against him',lambda r:r['spy_his_way']<-0.003)):
    S=[r for r in R if f(r)]; print(nm,len(S),'win %d%%'%pc(S,lambda r:r['pnl']>0),'median %+.0f%%'%(100*md([r['ret'] for r in S])),'sum $K',round(sum(r['pnl'] for r in S)/1e3))
for s,nm in ((1,'calls'),(-1,'puts')):
    S=[r for r in R if r['s']==s]; print(nm,len(S),'win %d%%'%pc(S,lambda r:r['pnl']>0),'median %+.0f%%'%(100*md([r['ret'] for r in S])),'sum $K',round(sum(r['pnl'] for r in S)/1e3))
print('weekday:',' | '.join('%s %d win %d%% $%dK'%('MTWTF'[w],len(S),pc(S,lambda r:r['pnl']>0),sum(r['pnl'] for r in S)/1e3) for w in range(5) for S in [[r for r in R if r['wd']==w]] if S))
print('days to expiry:',' | '.join('%s %d win %d%% med %+.0f%% $%dK'%(nm,len(S),pc(S,lambda r:r['pnl']>0),100*md([r['ret'] for r in S]),sum(r['pnl'] for r in S)/1e3) for nm,f in (('1',lambda r:r['dte']<=1),('2-4',lambda r:2<=r['dte']<=4),('5-10',lambda r:5<=r['dte']<=10),('11+',lambda r:r['dte']>10)) for S in [[r for r in R if f(r)]] if S))
Q=sorted(R,key=lambda r:r['cost']); n=len(Q)
for i,S in enumerate((Q[:n//3],Q[n//3:2*n//3],Q[2*n//3:])):
    print('size third',i,'cost median $%d'%md([r['cost'] for r in S]),'win %d%%'%pc(S,lambda r:r['pnl']>0),'median %+.0f%%'%(100*md([r['ret'] for r in S])),'sum $K',round(sum(r['pnl'] for r in S)/1e3))
c=collections.Counter(r['sym'] for r in R); print('names',len(c),'top',c.most_common(15))
# repeat: same name traded overnight in the previous 10 trading days
byname=collections.defaultdict(list)
for r in sorted(R,key=lambda r:r['date']): byname[r['sym']].append(r)
for r in R:
    prev=[x for x in byname[r['sym']] if x['date']<r['date'] and (dt.date.fromisoformat(r['date'])-dt.date.fromisoformat(x['date'])).days<=14]
    r['repeat']=bool(prev); r['prev_won']=prev and prev[-1]['pnl']>0
for nm,f in (('repeat within 2 weeks',lambda r:r['repeat']),('first in 2 weeks',lambda r:not r['repeat']),('repeat after a win',lambda r:r['repeat'] and r['prev_won']),('repeat after a loss',lambda r:r['repeat'] and not r['prev_won'])):
    S=[r for r in R if f(r)]; print(nm,len(S),'win %d%%'%pc(S,lambda r:r['pnl']>0),'median %+.0f%%'%(100*md([r['ret'] for r in S])),'sum $K',round(sum(r['pnl'] for r in S)/1e3))
for y in ('2023','2024','2025','2026'):
    S=[r for r in R if r['date'][:4]==y]; print(y,len(S),'win %d%%'%pc(S,lambda r:r['pnl']>0),'median %+.0f%%'%(100*md([r['ret'] for r in S])),'sum $K',round(sum(r['pnl'] for r in S)/1e3))
