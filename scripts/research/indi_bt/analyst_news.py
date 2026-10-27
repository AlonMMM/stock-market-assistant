"""Analyst rating actions from the news (the user, 2026-10-27: "what do you think about testing a bonus for stock that had
upgrade/downgrade from an know analyst organisation?"; "yes start it"). Alpaca's news (Benzinga) for Indi's 40 and
today's Favorites, 2024-01-01 to today; the analyst headlines are kept with their time and parsed:
  "<firm> Upgrades <co> to <rating>"                     direction +1, kind upgrade
  "<firm> Downgrades <co> to <rating>"                   -1, downgrade
  "... Raises Price Target to $X" / "Lowers ..."         +1 / -1, kind target
  "<firm> Initiates Coverage On <co> with <rating> ..."  +1 for buy-like ratings, -1 for sell-like, kind initiate
  "Maintains" / "Reiterates" with an unchanged target    0, kind maintain
`known` = the firm is one of the big houses below (set before looking at any result).

  node --env-file=.env <dir>/run.mjs analyst_news.py <symbols file>      (from the app repo root)
-> data/local/x/bt/analyst_actions.csv: time (UTC), date and minute (New York session minute, negative before the
   open), sym, firm, known, kind, direction, headline
"""
import csv, datetime as dt, os, re, sys, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import _get
from low_delta import HIS40

B = "data/local/x/bt"
NY = ZoneInfo("America/New_York")
A, Z = "2024-01-01T00:00:00Z", dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
KNOWN = ("Goldman Sachs", "Morgan Stanley", "JP Morgan", "JPMorgan", "B of A", "BofA", "Bank of America", "Citigroup", "Citi",
         "Wells Fargo", "Barclays", "UBS", "Deutsche Bank", "Jefferies", "Bernstein", "Mizuho", "Evercore", "Wedbush", "RBC",
         "KeyBanc", "Piper Sandler", "Needham", "Loop Capital", "Rosenblatt", "Cantor Fitzgerald")
VERB = re.compile(r"^(?P<firm>.+?)\s+(?P<verb>Upgrades|Downgrades|Maintains|Reiterates|Initiates Coverage On|Initiates|Resumes|Assumes)\b", re.I)
BUY = re.compile(r"\b(buy|outperform|overweight|strong buy|accumulate|positive|market outperform|sector outperform)\b", re.I)
SELL = re.compile(r"\b(sell|underperform|underweight|reduce|negative|market underperform|sector underperform)\b", re.I)


def parse(h):
    m = VERB.search(h)
    if not m: return None
    firm, verb = m.group("firm").strip(), m.group("verb").lower()
    kind, direction = "maintain", 0
    if verb == "upgrades": kind, direction = "upgrade", 1
    elif verb == "downgrades": kind, direction = "downgrade", -1
    elif verb.startswith(("initiates", "resumes", "assumes")):
        kind = "initiate"
        if BUY.search(h): direction = 1
        elif SELL.search(h): direction = -1
    if kind == "maintain":
        if re.search(r"raises price target", h, re.I): kind, direction = "target", 1
        elif re.search(r"lowers price target", h, re.I): kind, direction = "target", -1
    return dict(firm=firm, known=int(any(k.lower() in firm.lower() for k in KNOWN)), kind=kind, direction=direction)


def fetch(sym):
    out, token = [], None
    while True:
        q = dict(symbols=sym, start=A, end=Z, limit=50, sort="asc")
        if token: q["page_token"] = token
        j = _get("https://data.alpaca.markets/v1beta1/news?" + urllib.parse.urlencode(q))
        for n in j.get("news") or []:
            if sym not in (n.get("symbols") or []): continue
            p = parse(n["headline"])
            if not p: continue
            t = dt.datetime.fromisoformat(n["created_at"].replace("Z", "+00:00")).astimezone(NY)
            minute = (t.hour * 60 + t.minute) - (9 * 60 + 30)
            out.append(dict(time=n["created_at"], date=t.date().isoformat(), minute=minute, sym=sym, **p, headline=n["headline"]))
        token = j.get("next_page_token")
        if not token: break
    return sym, out


def main():
    syms = sorted(set(HIS40) | set(open(sys.argv[1]).read().strip().split(",")) | {"TSEM"})
    rows = []
    with ThreadPoolExecutor(4) as ex:
        for n, (sym, out) in enumerate(ex.map(fetch, syms), 1):
            rows += out
            print(f"{n}/{len(syms)} {sym}: {len(out)} analyst headlines, {sum(r['known'] and r['direction'] != 0 for r in out)} known with a direction", flush=True)
    rows.sort(key=lambda r: (r["date"], r["sym"], r["time"]))
    with open(f"{B}/analyst_actions.csv", "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(len(rows), "rows ->", f"{B}/analyst_actions.csv")


if __name__ == "__main__":
    main()
