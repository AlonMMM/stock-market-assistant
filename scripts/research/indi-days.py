# lists summary days (with extra continuation posts) and their image files in a date range
import json,os,sys
pl=json.load(open('plan.json')); fs=sorted(os.listdir('media'))
a,b=sys.argv[1],sys.argv[2]
for p in pl:
  if a<=p['day']<=b and not p['notrade']:
    for pid in [p['post']]+p.get('extra',[]):
      print(p['day'],pid,' '.join(f for f in fs if f.startswith(pid+'-')) or 'NO-IMAGES', '|',p['line'][:50] if pid==p['post'] else '(continuation)')
