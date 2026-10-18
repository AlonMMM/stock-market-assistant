# Trade-log data v2: trades + steps (times in Israel), entry size as % of his portfolio, his entry
# reasons (posts at entry + the day's summary sentences naming the ticker, with keyword tags),
# entry-time context from 1-min bars (vs SPY, volume, breakout), and per-month chart files.
#   python3 build_data2.py <out dir> <daybars.sqlite> <year dir>...
import csv, json, sys, re, collections, sqlite3, os, datetime as dt
from zoneinfo import ZoneInfo
out, dbp, dirs = sys.argv[1], sys.argv[2], sys.argv[3:]
NY, IL = ZoneInfo("America/New_York"), ZoneInfo("Asia/Jerusalem")
os.makedirs(f"{out}/bars", exist_ok=True)
db = sqlite3.connect(dbp)

def mult(u, r): return 1 if r == "S" else 100 if u.startswith("GC ") else 1000 if "FOP" in u else 100
PROXY = {"SPXW": "SPY", "SPX": "SPY", "NDXP": "QQQ", "NDX": "QQQ", "VIXW": "VIXY", "VIX": "VIXY", "GC": "GLD", "CL": "USO", "ZB": "TLT"}
def chart_sym(u): r = u.split(" ")[0]; return PROXY.get(r, r)
def to_il(date, t):
    if not t: return ""
    x = dt.datetime.fromisoformat(f"{date}T{t}").replace(tzinfo=NY).astimezone(IL)
    return x.strftime("%H:%M") + ("" if x.date().isoformat() == date else "+1")

# --- his posts (all years): summaries per trading day, all posts by time
summ, posts = {}, []
for d in dirs:
    for th in json.load(open(f"{d}/threads.json")):
        for p in th["posts"]:
            t = dt.datetime.fromisoformat(p["time"].replace("Z", "+00:00")).astimezone(NY)
            txt = p["text"].strip()
            posts.append((t, txt, th["conversation"]))
            if re.match(r"\.?\s*(סיכום|daily\s*summ?[ae]ry)", txt, re.I) and not txt.startswith("סיכום שנה"):
                day = (t - dt.timedelta(hours=6)).date().isoformat()
                summ.setdefault(day, txt)

# --- portfolio value at the start of each day
val = {}
for d in dirs:
    if os.path.exists(f"{d}/values.csv"):
        for r in csv.DictReader(open(f"{d}/values.csv")): val[r["date"]] = ("close", float(r["value"]))
for day, txt in summ.items():
    head = txt[:160]
    m = re.search(r"\$?\s*([\d,]{3,})\s*\$?.{0,25}?\(\s*(-?[\d.]+)\s*%\s*-?\)", head) or re.search(r"\$?\s*([\d,]{3,})\s*\$?\s+(-?[\d.]+)\s*%", head)
    if m and day not in val:
        pnl, pct = int(m.group(1).replace(",", "")), abs(float(m.group(2)))
        if pct >= 0.05: val[day] = ("open", pnl / pct * 100)
days_sorted = sorted(val)
def value_before(day):
    # prefer that day's opening value; else last close before
    if day in val and val[day][0] == "open": return val[day][1]
    prev = [d for d in days_sorted if d < day]
    return val[prev[-1]][1] if prev else None

# --- reason tags
TAGS = [
    ("vs SPY / relative strength", r"נבדל|חוזק|חזקה|מחזיק|לא יורדת|לא נשבר|ביחס ל|מול השוק|נגד השוק|השוק|relative|stands out|holding|strong|against the market|disconnect|\bSPY\b|\bSPX\b|\bQQQ\b|נאסד|S&P"),
    ("breakout / level", r"פריצ|פורצ|פרצה|שבר|break|new high|ATH|שיא|התנגדות|resistance|תמיכה|support|רמה|level|ממוצע|VWAP"),
    ("volume / flow", r"מחזור|volume|open int|OPEN ITREST|זרימה|flow"),
    ("news / earnings", r"דוח|דו\"ח|חדשות|earnings|report|news|FED|הפד|CPI|הכרזה|tariff|מכס|טראמפ|trump"),
    ("overnight bet", r"overnight|אוורנייט|לילה|למחר|tomorrow|פקיעה מחר|next week|שבוע הבא"),
    ("weakness / short", r"חולשה|חלשה|weak|שורט|short|כבדה|heavy"),
    ("bitcoin / crypto", r"ביטקוי|bitcoin|BTC|קריפטו"),
    ("gold / bonds / macro", r"זהב|gold|אג\"ח|bond|ריבית|yield|נפט|oil"),
]
ORDER = r"https://t\.co/\S+|\$?[A-Z]{1,5}\s*[|/]?\s*[\d.]*\s*(call|put|קול|פוט)?\s*[\d/]*\s*(0DTE)?\s*(second try|first try)?\s*(bought at|bought|קונה|נכנס|added|מוסיף|מגדיל)[\s\S]{0,30}?(contracts|contracs|cotracts|options|יח'|יחידות|op')|(רווח|הפסד|profit|loss)[:\s]*\$?[\d,]+|\$?[A-Z]{1,5}\s*[|/]\s*[\d.]+\s*(call|put)\b"
def clean(text): return re.sub(r"\s+", " ", re.sub(ORDER, " ", text, flags=re.I)).strip(" |,.-")
def tags_of(text): return [n for n, rx in TAGS if re.search(rx, text, re.I)]
ALIAS = {"TSLA": ["טסלה"], "NVDA": ["אנבידיה", "אנוידיה"], "META": ["מטא"], "AAPL": ["אפל"], "GOOGL": ["גוגל"], "AMZN": ["אמזון"],
         "MSFT": ["מיקרוסופט"], "SPXW": ["SPX", "ספי"], "IBIT": ["ביטקוין"], "GLD": ["זהב"], "TLT": ["אג"], "MSTR": ["מייקל"], "IWM": ["ראסל", "Russell"]}
def sentences_about(text, und):
    names = [und] + ALIAS.get(und, [])
    parts = re.split(r"(?<=[.!?\n])\s+", text)
    return [s.strip() for s in parts if any(n.lower() in s.lower() for n in names)][:3]

# --- bars helpers (RTH minute grid 0..389)
cache = {}
def bars(sym, date):
    k = (sym, date)
    if k not in cache:
        r = db.execute("SELECT bars FROM bars WHERE symbol=? AND date=?", (sym, date)).fetchone()
        grid = [None] * 390
        if r:
            for t, o, h, l, c, v in json.loads(r[0]):
                m = dt.datetime.fromtimestamp(t, NY); i = m.hour * 60 + m.minute - 570
                if 0 <= i < 390: grid[i] = (o, h, l, c, v)
        cache[k] = grid
    return cache[k]
def full_day(sym, date):
    # 960 one-minute (close, volume) slots from 04:00 to 20:00 New York time
    r = db.execute("SELECT bars FROM bars WHERE symbol=? AND date=?", (sym, date)).fetchone()
    grid = [None] * 960
    if r:
        for t, o, h, l, c, v in json.loads(r[0]):
            m = dt.datetime.fromtimestamp(t, NY); i = m.hour * 60 + m.minute - 240
            if 0 <= i < 960: grid[i] = (c, v)
    return grid
def minute_of(t): h, m, *_ = map(int, t.split(":")); return h * 60 + m - 570
def close_at(g, i):
    for j in range(min(i, 389), -1, -1):
        if g[j]: return g[j][3]
    return None
def entry_ctx(sym, date, t, bet):
    g, s = bars(sym, date), bars("SPY", date)
    i = minute_of(t)
    if not t or i < 0 or not any(g) or not any(s): return None
    i = min(i, 389)
    o = next((b[0] for b in g if b), None); so = next((b[0] for b in s if b), None)
    def chg(grid, a, b):
        x, y = close_at(grid, a), close_at(grid, b)
        return (y / x - 1) * 100 if x and y else None
    c = close_at(g, i); sc = close_at(s, i)
    day = (c / o - 1) * 100 if c and o else None; sday = (sc / so - 1) * 100 if sc and so else None
    m5 = chg(g, i - 5, i) if i >= 5 else None; s5 = chg(s, i - 5, i) if i >= 5 else None
    m15 = chg(g, i - 15, i) if i >= 15 else None; s15 = chg(s, i - 15, i) if i >= 15 else None
    hi = max((b[1] for b in g[:i + 1] if b), default=None); lo = min((b[2] for b in g[:i + 1] if b), default=None)
    hi0 = max((b[1] for b in g[:max(i - 5, 0)] if b), default=None); lo0 = min((b[2] for b in g[:max(i - 5, 0)] if b), default=None)
    vols = [b[4] for b in g if b]; avgv = sum(vols) / len(vols) if vols else 0
    v5 = sum(b[4] for b in g[max(i - 4, 0):i + 1] if b) / 5
    sign = 1 if bet > 0 else -1
    rel = lambda a, b: round(sign * (a - b), 2) if a is not None and b is not None else None
    return dict(
        dayVsSpy=rel(day, sday), m5VsSpy=rel(m5, s5), m15VsSpy=rel(m15, s15),
        dayMove=round(day, 2) if day is not None else None, spyDay=round(sday, 2) if sday is not None else None,
        rangePos=round((c - lo) / (hi - lo), 2) if hi and lo and hi > lo and c else None,
        newExtreme=bool(hi0 and lo0 and ((sign > 0 and hi > hi0) or (sign < 0 and lo < lo0))),
        vol5x=round(v5 / avgv, 1) if avgv else None)

# --- trades
trades, monthly = [], collections.defaultdict(dict)
for d in dirs:
    tr = collections.OrderedDict()
    for a in csv.DictReader(open(f"{d}/actions.csv")):
        t = tr.setdefault(a["trade"], dict(id=a["trade"], account=a["account"], contract=a["contract"], steps=[]))
        t["steps"].append(dict(date=a["date"], et=a["time_from"][:8], t=to_il(a["date"], a["time_from"][:8]), kind=a["action"], side=a["side"],
            qty=int(a["qty"]), px=float(a["avg_price"]), fills=int(a["fills"]),
            pos=int(a["position_after"]) if a["position_after"] != "" else None,
            avg=float(a["avg_cost_after"]) if a["avg_cost_after"] else None,
            pnl=int(a["realized_step"]) if a["realized_step"] != "" else None,
            total=int(a["realized_total"]) if a["realized_total"] != "" else None,
            posts=[dict(t=to_il(a["date"], m[0] + ":00"), text=m[1]) for m in re.findall(r"\[(\d\d:\d\d)\] (.*?)(?= \| \[\d\d:\d\d\]|$)", a["his_post"])]))
    for t in tr.values():
        und, exp, sr = t["contract"].rsplit(" ", 2)
        st = sorted(t["steps"], key=lambda x: (x["date"], x["et"] or "99"))
        t["steps"] = st
        rl = [x for x in st if x["kind"] != "expired (assumed 0)"]
        buys = [x for x in rl if x["side"] == "B"]; sells = [x for x in rl if x["side"] == "S"]
        bq = sum(x["qty"] for x in buys); sq = sum(x["qty"] for x in sells)
        m = mult(und, sr[-1]); right = sr[-1]
        total = next((x["total"] for x in reversed(st) if x["total"] is not None), None)
        kinds = {x["kind"] for x in st}
        status = ("expired" if "expired (assumed 0)" in kinds else "closed") if total is not None and "exit (entry not shown)" not in kinds else \
                 "pre" if "exit (entry not shown)" in kinds else "open"
        first = buys[0] if buys and right != "S" else st[0]
        cost = round(abs(sum(x["qty"] * x["px"] for x in buys)) * m) if bq and right != "S" else None
        # size: first entry step and peak cost at risk, as % of portfolio value that morning
        pv = value_before(first["date"])
        first_cost = abs(first["qty"] * first["px"] * m) if right != "S" else None
        peak, cum = 0.0, 0.0
        for x in rl:
            if x["side"] == "B": cum += x["qty"] * x["px"] * m
            elif x["pos"] is not None and x["avg"] is not None: cum = x["pos"] * x["avg"] * m
            else: cum = 0
            peak = max(peak, abs(cum))
        sym = chart_sym(und)
        bet = 1 if right == "C" else -1 if right == "P" else 1
        ctx = entry_ctx(sym, first["date"], first["et"], bet) if right != "S" and first["et"] else None
        # reasons
        ent_posts = [p["text"] for p in first["posts"]]
        # his follow-up comments: posts in the entry post's thread, or naming the ticker, within 20 min after entry
        e_t = dt.datetime.fromisoformat(f"{first['date']}T{first['et'] or '15:59:00'}").replace(tzinfo=NY)
        convs = {c for (pt, tx, c) in posts if any(tx[:60] == q[:60] for q in ent_posts)}
        root = und.split(" ")[0]
        names = [root] + ALIAS.get(root, [])
        follow = [tx for (pt, tx, c) in posts if 0 <= (pt - e_t).total_seconds() <= 1200 and (c in convs or any(n.lower() in tx.lower() for n in names))
                  and not re.match(r"\.?\s*(סיכום|daily summ)", tx, re.I) and tx not in ent_posts]
        why = list(dict.fromkeys(w for w in (clean(x) for x in ent_posts + follow) if len(re.sub(r"[^A-Za-zא-ת]", "", w)) >= 12))[:4]
        day_sum = summ.get(first["date"], "")
        sum_lines = sentences_about(day_sum, und.split(" ")[0]) if day_sum else []
        reason_text = clean(" ".join(why + sum_lines))
        t.update(underlying=und, expiry=exp, strike=sr[:-1], right=right, mult=m, chart=sym,
            entry=f"{first['date']} {first['t']}".strip(), buyQty=bq,
            buyAvg=round(sum(x["qty"] * x["px"] for x in buys) / bq, 4) if bq else None,
            sellQty=sq, sellAvg=round(sum(x["qty"] * x["px"] for x in sells) / sq, 4) if sq else None,
            cost=cost, pnl=total, status=status,
            pv=round(pv) if pv else None,
            sizePct=round(first_cost / pv * 100, 2) if pv and first_cost else None,
            peakPct=round(peak / pv * 100, 2) if pv and peak and right != "S" else None,
            pnlPctPv=round(total / pv * 100, 2) if pv and total is not None else None,
            ctx=ctx, why=why, summary=sum_lines, tags=tags_of(reason_text))
        t["pct"] = round(total / t["cost"] * 100, 1) if total is not None and t["cost"] else None
        trades.append(t)
        # chart data for each date the trade has steps
        for dd in sorted({x["date"] for x in st}):
            for s_ in (sym, "SPY"):
                key = f"{s_}|{dd}"
                if key in monthly[dd[:7]]: continue
                g = bars(s_, dd)
                if not any(g): continue
                o = dt.datetime.fromisoformat(f"{dd}T04:00:00").replace(tzinfo=NY).astimezone(IL)
                t0 = int(dt.datetime(o.year, o.month, o.day, o.hour, o.minute, tzinfo=dt.timezone.utc).timestamp())
                fg = full_day(s_, dd)  # 04:00-20:00 ET; regular session starts at index 330
                monthly[dd[:7]][key] = dict(t0=t0, o=330, c=[round(b[0], 4) if b else None for b in fg], v=[b[1] if b else 0 for b in fg])
trades.sort(key=lambda t: (t["steps"][0]["date"], t["steps"][0]["et"] or "99"))
real = collections.defaultdict(int)
for t in trades:
    for x in t["steps"]:
        if x["pnl"] is not None: real[x["date"]] += x["pnl"]
def posted(day):
    txt = summ.get(day)
    if not txt: return None
    head = txt[:120]
    m_ = re.search(r"(רווח|הפסד)[:\s]*\$?\s*([\d,]+)", head)
    if m_: return int(m_.group(2).replace(",", "")) * (-1 if m_.group(1) == "הפסד" else 1)
    m_ = re.search(r"\$\s*([\d,]+)\s*(profit|loss)", head, re.I)
    if m_: return int(m_.group(1).replace(",", "")) * (-1 if m_.group(2).lower() == "loss" else 1)
    return 0
alld = sorted(d for d in set(summ) | set(real) if d >= "2023-01-02" and not d.endswith("-01-01"))
json.dump(dict(trades=trades, days=[dict(date=k, extracted=real.get(k, 0), posted=posted(k),
          value=round(val[k][1]) if k in val else None) for k in alld]), open(f"{out}/data.json", "w"), ensure_ascii=False)
for mo, d in monthly.items():
    json.dump(d, open(f"{out}/bars/{mo}.json", "w"), separators=(",", ":"))
print(len(trades), "trades;", sum(t["sizePct"] is not None for t in trades), "with size%;", sum(t["ctx"] is not None for t in trades), "with ctx;",
      sum(bool(t["tags"]) for t in trades), "with tags;", len(monthly), "month files;", os.path.getsize(f"{out}/data.json") // 1024, "KB data")
