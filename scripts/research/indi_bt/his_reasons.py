"""His stated reasons for his entries, from his X posts (2023-2026, main account).

For each opening trade: the posts in the same thread as his order post (from 60 minutes before the order
to 20 minutes after), plus his posts that name the stock between the previous close and the order.
Order-only text ("Bought 222.5 Call at 0.28, 2000 contracts") is dropped; what is left is tagged by keyword
(Hebrew and English).

  python3 his_reasons.py      (from the repo root) -> data/local/x/bt/his_reasons.csv + printed tables
"""
import collections, csv, datetime as dt, json, os, re, statistics as st, sys
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
B = "data/local/x/bt"
NAMES = {"TSLA": ["טסלה", "tesla"], "NVDA": ["אנבידיה", "אנוידיה", "נבידיה", "nvidia"], "AAPL": ["אפל", "apple"], "GOOGL": ["גוגל", "google"],
         "META": ["מטא", "פייסבוק"], "AMZN": ["אמזון", "amazon"], "MSFT": ["מייקרוסופט", "microsoft"], "PLTR": ["פלנטיר", "palantir"],
         "COIN": ["קוינבייס", "coinbase"], "MRNA": ["מודרנה", "moderna"], "AVGO": ["ברודקום", "broadcom"], "SMCI": ["סופר מיקרו"],
         "MSTR": ["מיקרוסטרטג", "סיילור"], "IBIT": ["ביטקוין", "bitcoin", "btc"]}
TAGS = {
    "news": ["חדשות", "ידיעה", "הודעה", "דיווח", "פרסום", "שמועה", "שמועות", "שת\"פ", "שתפ", "הסכם", "עסקה", "news", "report", "rumor", "deal",
             "announce", "partnership", "contract", "חוזה", "upgrade", "downgrade", "אנליסט", "analyst", "fda", "tweet", "ציוץ", "טראמפ", "trump", "musk", "מאסק"],
    "earnings": ["דוח", "דוחות", "earnings", "guidance", "תחזית", "רבעון", "quarter"],
    "market": ["השוק", "שוק ", "spy", "qqq", "נאסדק", "nasdaq", "market", "s&p", "ספיי", "פד", "fed", "ריבית", "אינפלציה", "cpi", "פאואל", "powell", "מאקרו", "macro", "מדדים"],
    "level": ["פריצה", "פורצת", "פרצה", "שבירה", "שוברת", "שברה", "התנגדות", "תמיכה", "שיא", "רמה", "breakout", "break", "resistance", "support",
              "high", "level", "vwap", "ממוצע", "דגל", "flag", "טווח", "range", "גאפ", "פער", "gap"],
    "strength": ["חזקה", "חוזק", "חזק", "נגד השוק", "against the market", "strong", "strength", "מחזיקה", "relative", "יחסית"],
    "theme": ["ai", "בינה", "קריפטו", "crypto", "ביטקוין", "bitcoin", "btc", "שבבים", "chips", "סקטור", "sector", "קוונטום", "quantum", "רובוט", "robot", "חלל", "space", "סולאר", "solar"],
    "volume": ["ווליום", "וליום", "מחזור", "volume", "כניסת כסף", "flow", "פלואו", "אופציות חריגות"],
    "momentum": ["מומנטום", "momentum", "סקוויז", "squeeze", "שורטיסטים", "ריצה", "רצה", "טסה", "run", "running"],
    "overnight": ["לילה", "מחר", "overnight", "tomorrow", "סווינג", "swing", "להחזיק", "hold"],
    "feel": ["מרגיש", "תחושה", "feel", "נראה לי", "חושב", "think", "מאמין", "believe", "הימור", "bet", "gamble"],
}
ORDER = re.compile(r"(קונה|מוכר|bought|sold|buy|sell|מוסיף|משלים|יוצא|נכנס).{0,60}?(\d+(\.\d+)?\s*(\$|יח'|יח|contracts|call|put|קול|פוט))", re.I)


def posts():
    out = []
    for y in ("2023", "2024", "2025", "2026"):
        for c in json.load(open(f"data/local/x/ultrawavetrader-{y}/threads.json")):
            for p in c["posts"]:
                t = dt.datetime.fromisoformat(p["time"].replace("Z", "+00:00")).astimezone(NY)
                out.append(dict(id=p["id"], conv=c["conversation"], t=t, text=p["text"]))
    return out


JUNK = re.compile(r"^(\$?[A-Za-z]{1,6}|\$?[A-Z]{1,6}\s*\d.*|\d[\d.,\s]*(call|put|contracts?|יח'?)?|(bought|sold|buy|sell|added|adding)\b.*|"
                  r"(קונה|מוכר|לקחתי|מוסיף|משלים|ממוצע|רווח|הפסד|loss|profit|avg).{0,40}|.*\b(at|ב)\s*~?\d+(\.\d+)?\s*~?\$?)$", re.I)


def reason_text(s):
    s = re.sub(r"https?://\S+", "", s)
    s = re.sub(r"@\w+", "", s)
    if re.match(r"\s*(סיכום|summary|daily summary)", s, re.I): return ""  # daily / weekly summaries, written after the fact
    parts = [x.strip(" ,.:~") for x in re.split(r"[\n|,]", s) if x.strip(" ,.:~")]
    keep = [x for x in parts if not JUNK.match(x) and not (ORDER.search(x) and len(ORDER.sub("", x).strip(" ,.:~$")) < 12)]
    return " | ".join(keep).strip()


def has_word(text, w):
    if re.fullmatch(r"[a-z0-9&$ ]+", w): return re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", text) is not None
    return w in text  # Hebrew: prefixes attach to the word, so a substring is right


def main():
    P_ = posts(); by_id = {p["id"]: p for p in P_}
    by_conv = collections.defaultdict(list)
    for p in P_: by_conv[p["conv"]].append(p)
    P_.sort(key=lambda p: p["t"])
    rows, seen = [], set()
    for y in ("2023", "2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx" or r["action"] != "open" or r["trade"] in seen or not r["time_from"]: continue
            seen.add(r["trade"])
            sym = r["contract"].split()[0]
            t0 = dt.datetime.fromisoformat(f"{r['date']}T{r['time_from'][:8]}").replace(tzinfo=NY)
            prev_close = (t0 - dt.timedelta(days=3 if t0.weekday() == 0 else 1)).replace(hour=16, minute=0, second=0)
            names = [sym.lower(), "$" + sym.lower()] + NAMES.get(sym, [])
            texts = []
            ids = [x for x in (r.get("post_ids") or "").split("|") if x]
            convs = {by_id[i]["conv"] for i in ids if i in by_id}
            for c in convs:
                for p in by_conv[c]:
                    if t0 - dt.timedelta(minutes=60) <= p["t"] <= t0 + dt.timedelta(minutes=2): texts.append(p)  # nothing written after the entry
            for p in P_:
                if p["t"] < prev_close: continue
                if p["t"] > t0 + dt.timedelta(minutes=2): break
                low = p["text"].lower()
                if any(re.search(r"(?<![a-z])" + re.escape(n) + r"(?![a-z])", low) for n in names): texts.append(p)
            uniq = {p["id"]: p for p in texts}
            reason = " || ".join(x for x in (reason_text(p["text"]) for p in sorted(uniq.values(), key=lambda p: p["t"])) if len(x) >= 8)
            low = reason.lower()
            tags = [k for k, words in TAGS.items() if any(has_word(low, w) for w in words)]
            rows.append(dict(year=y, date=r["date"], time=r["time_from"][:5], sym=sym, contract=r["contract"], trade=r["trade"],
                             tags="|".join(tags), has_reason=int(bool(reason)), reason=reason[:600]))
    real = collections.Counter()
    for y in ("2023", "2024", "2025", "2026"):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] == "silexx" and r["realized_step"]: real[r["trade"]] += float(r["realized_step"])
    stop = {}
    if os.path.exists(f"{B}/t_his_miss.csv"):
        for x in csv.DictReader(open(f"{B}/t_his_miss.csv")):
            if x["pnl"]: stop[(x["date"], x["sym"], int(x["minute"]))] = float(x["pnl"])
    for r in rows:
        r["real"] = round(real.get(r["trade"], 0))
        hh, mm = map(int, r["time"].split(":")); r["stop_pnl"] = stop.get((r["date"], r["sym"], hh * 60 + mm - 570), "")
    with open(f"{B}/his_reasons.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    n = len(rows); wr = [r for r in rows if r["has_reason"]]
    print(f"{n} entries, {len(wr)} ({100*len(wr)/n:.0f}%) with some reason text\n")
    print("| Reason tag | Entries | Share of entries with text | His real P&L | Per trade | Win (real) | Years + (real) | Your stop, 40 stocks |\n|---|---|---|---|---|---|---|---|")
    for k in list(TAGS) + ["(no reason text)"]:
        g = [r for r in rows if (k in r["tags"].split("|") if k != "(no reason text)" else not r["has_reason"])]
        if not g: continue
        p = [r["real"] for r in g]; s = [r["stop_pnl"] for r in g if r["stop_pnl"] != ""]
        yrs = "".join("+" if sum(r["real"] for r in g if r["year"] == y) > 0 else "-" for y in ("2023", "2024", "2025", "2026"))
        print(f"| {k} | {len(g)} | {100*len(g)/max(1,len(wr)):.0f}% | {sum(p)/1e6:+.2f}M | {st.fmean(p)/1e3:+.1f}K | {100*sum(x>0 for x in p)/len(p):.0f}% | {yrs} | {sum(s)/1e3:+,.0f}K ({len(s)}) |")


if __name__ == "__main__":
    main()
