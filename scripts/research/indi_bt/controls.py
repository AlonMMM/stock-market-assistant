"""Control runs for the backtest (same exits as the bot, different entries).

  random  for every bot signal: one random minute after the signal, up to last_minute, on the same
          stock, day and direction (seed 7) -> is the entry signal better than chance? (A minute before
          the signal would trade a direction the day had not shown yet.)
  his     his own main-account entries on universe stocks (2024+): his contract, entered on the bar after
          his minute -> are the bot's exits as good as his?

  python3 controls.py random <signals.csv> <out.csv>
  python3 controls.py his <first date> <last date> <out.csv>
"""
import csv, random, sys
from store import P, day



def write(rows, path):
    with open(path, "w") as f:
        w = csv.DictWriter(f, fieldnames=list(dict.fromkeys(k for r in rows for k in r))); w.writeheader(); w.writerows(rows)
    print(len(rows), "->", path)


def rand(src, out):
    rng = random.Random(7)
    E = P["entry"]
    rows = []
    for s in csv.DictReader(open(src)):
        if int(s["minute"]) >= E["last_minute"]: continue
        m = rng.randint(int(s["minute"]) + 1, E["last_minute"])
        b = [x for x in day(s["sym"], s["date"]) if x[0] <= m]
        if not b: continue
        rows.append(dict(date=s["date"], sym=s["sym"], right=s["right"], minute=m,
                         time=f"{(570 + m) // 60:02d}:{(570 + m) % 60:02d}", price=b[-1][4]))
    write(rows, out)


def his(a, b, out):
    rows, seen = [], set()
    for y in range(int(a[:4]), int(b[:4]) + 1):
        for r in csv.DictReader(open(f"data/local/x/ultrawavetrader-{y}/actions.csv")):
            if r["account"] != "silexx" or r["action"] != "open" or r["trade"] in seen or not r["time_from"]: continue
            seen.add(r["trade"])
            und, exp, sr = r["contract"].rsplit(" ", 2)
            if und not in P["universe"] or sr.endswith("S") or not (a <= r["date"] <= b): continue
            hh, mm = map(int, r["time_from"][:5].split(":"))
            m = hh * 60 + mm - 570
            if not 0 <= m < 389: continue
            k = float(sr[:-1])
            occ = f"{und}{exp[2:4]}{exp[5:7]}{exp[8:10]}{sr[-1]}{round(k * 1000):08d}"
            rows.append(dict(date=r["date"], sym=und, right=sr[-1], minute=m, time=r["time_from"][:5],
                             price="", contract=occ, expiry=exp, his_trade=r["trade"]))
    write(rows, out)


if __name__ == "__main__":
    if sys.argv[1] == "random": rand(sys.argv[2], sys.argv[3])
    else: his(sys.argv[2], sys.argv[3], sys.argv[4])
