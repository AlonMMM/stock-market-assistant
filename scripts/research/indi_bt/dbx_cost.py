"""What real option quotes for 2022-2023 would cost (the user, 2026-10-31: "check how much it cost to take the option data
for the relevant delta around the alerts"). Metadata calls only (free): nothing is bought.
  1. OPRA.PILLAR's available range
  2. $ per contract-day: get_cost on 10 sample days of our own 2024 list (indi_dbx_list.csv), cbbo-1m, the full session
  3. contracts per signal in 2024-25 (that list / the fair list's main + add signals) -> the 2022-23 estimate from sig22
  4. the chain definitions needed to pick strikes (definition schema, parent symbols), sampled and scaled
  node --env-file=.env <dir>/run.mjs dbx_cost.py
"""
import base64, collections, csv, glob, json, os, random, statistics as st, sys, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dbx_fetch import pad, utc
AUTH = "Basic " + base64.b64encode((os.environ["DATABENTO_API_KEY"] + ":").encode()).decode()
B = "data/local/x/bt"


def call(path, **q):
    data = urllib.parse.urlencode(q).encode()
    req = urllib.request.Request(f"https://hist.databento.com/v0/{path}", data=data, headers={"Authorization": AUTH})
    return json.loads(urllib.request.urlopen(req, timeout=300).read().decode())


def getq(path, **q):
    req = urllib.request.Request(f"https://hist.databento.com/v0/{path}?" + urllib.parse.urlencode(q), headers={"Authorization": AUTH})
    return json.loads(urllib.request.urlopen(req, timeout=300).read().decode())


def main():
    print("1. OPRA.PILLAR range:", getq("metadata.get_dataset_range", dataset="OPRA.PILLAR"), flush=True)
    try: print("   cbbo-1m range:", getq("metadata.get_dataset_range", dataset="OPRA.PILLAR").get("schema", {}).get("cbbo-1m"))
    except Exception as e: print("   (no per-schema range)", e)
    L = list(csv.DictReader(open(os.path.join(HERE, "indi_dbx_list.csv"))))
    by = collections.defaultdict(set)
    for r in L: by[r["date"]].add(r["contract"])
    random.seed(7); days = random.sample(sorted(d for d in by if d[:4] == "2024"), 10)
    per = []
    for d in days:
        syms = sorted(by[d])
        c = call("metadata.get_cost", dataset="OPRA.PILLAR", schema="cbbo-1m", stype_in="raw_symbol",
                 symbols=",".join(pad(s) for s in syms[:2000]), start=utc(d, 0), end=utc(d, 391))
        per.append(float(c) / min(len(syms), 2000))
        print(f"2. {d}: {len(syms)} contracts, ${float(c):.2f} -> ${per[-1]:.4f} a contract-day", flush=True)
    unit = st.median(per)
    total24 = sum(len(v) for v in by.values())
    print(f"   median ${unit:.4f} a contract-day; our 2024-26 list = {total24:,} contract-days ~ ${unit * total24:,.0f} at that rate")
    # 3. contracts per signal on the fair list (main + adds, every status), 2024-25
    sig = collections.Counter()
    for pre in ("sg_c12_15", "s_t18r15"):
        for f in glob.glob(f"{B}/{pre}_202[45].[0-9]_trades.csv"):
            for t in csv.DictReader(open(f)): sig[t["date"][:4]] += 1
    con = collections.Counter(r["date"][:4] for r in L)
    ratio = (con["2024"] + con["2025"]) / max(1, sig["2024"] + sig["2025"])
    print(f"3. 2024-25: {con['2024'] + con['2025']:,} contract-days for {sig['2024'] + sig['2025']:,} fair-list signals = {ratio:.2f} a signal")
    S = list(csv.DictReader(open(f"{B}/sig22_signals.csv")))
    for lab, F in (("his 40", lambda r: r["list"] == "his40"), ("all 75", lambda r: True)):
        n = collections.Counter(r["date"][:4] for r in S if F(r) and r["date"][:4] in ("2022", "2023"))
        # the adds (t >= 1.8 signals) roughly double the signal count on the fair list: use the 2024 share
        k = (sig["2024"] + sig["2025"]) / max(1, sum(1 for r in S if r["list"] == "his40" and r["date"][:4] in ("2024", "2025")))
        est = {y: n[y] * k * ratio for y in n}
        print(f"   {lab}: 2022-23 signals {dict(n)} -> ~{sum(est.values()):,.0f} contract-days -> ~${unit * sum(est.values()):,.0f}")
    # 4. definitions: one day of parent definitions for a few names, scaled to 75 names x 2 years of signal days
    names = ["TSLA", "NVDA", "AAPL", "AMD", "PLTR"]
    dd = []
    for d in ("2022-06-15", "2023-03-15"):
        c = call("metadata.get_cost", dataset="OPRA.PILLAR", schema="definition", stype_in="parent",
                 symbols=",".join(f"{s}.OPT" for s in names), start=f"{d}T00:00", end=f"{d}T23:59")
        dd.append(float(c) / len(names)); print(f"4. definitions {d}: ${float(c):.2f} for {len(names)} names", flush=True)
    sd = len({(r["sym"], r["date"]) for r in S if r["date"][:4] in ("2022", "2023")})
    print(f"   {sd:,} stock-days with a signal in 2022-23 x ${st.median(dd):.3f} = ~${sd * st.median(dd):,.0f} for the definitions")


if __name__ == "__main__":
    main()
