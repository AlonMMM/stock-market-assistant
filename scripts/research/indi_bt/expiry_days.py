"""Which stocks have option expiries 3 or more days a week, month by month (the user, 2026-10-27: "all the tickers that
have options 3 times or more a week (APPL TSLA etc.)"). Point in time: a month counts when its median full week (Mon-Fri,
inside the month) has 3+ listed expiries (store.expiries, expired contracts included). Indi's 40 + today's 69 Favorites.

  node --env-file=.env <dir>/run.mjs expiry_days.py      (from the app repo root)
-> data/local/x/bt/expiry_days.json  {month: [symbols]}
"""
import datetime as dt, json, os, statistics as st, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import expiries
from low_delta import HIS40

B = "data/local/x/bt"


def months():
    m = dt.date(2024, 1, 1)
    while m <= dt.date(2026, 10, 1):
        yield m
        m = (m + dt.timedelta(days=32)).replace(day=1)


def per_week(und, m):
    end = (m + dt.timedelta(days=32)).replace(day=1) - dt.timedelta(days=1)
    ex = [dt.date.fromisoformat(e) for e in expiries(und, m.isoformat(), (m + dt.timedelta(days=40)).isoformat())]
    weeks = {}
    d = m
    while d <= end:
        if d.weekday() == 0 and d + dt.timedelta(days=4) <= end: weeks[d] = sum(d <= e <= d + dt.timedelta(days=4) for e in ex)
        d += dt.timedelta(days=1)
    return st.median(weeks.values()) if weeks else 0


def main():
    favs = open(sys.argv[1]).read().strip().split(",") if len(sys.argv) > 1 else []
    syms = sorted(set(HIS40) | set(favs) | {"TSEM"})
    out = {}
    for m in months():
        out[m.isoformat()[:7]] = [s for s in syms if per_week(s, m) >= 3]
        print(m.isoformat()[:7], len(out[m.isoformat()[:7]]), " ".join(out[m.isoformat()[:7]]), flush=True)
    json.dump(out, open(f"{B}/expiry_days.json", "w"), indent=1)


if __name__ == "__main__":
    main()
