"""The final monthly lists: the cleaned market-data 80 + names 2+ outlets called hot in the 90 days before the month."""
import sys, csv, json, collections, datetime as dt
sys.argv = ["x"]; sys.path.insert(0, "/Users/alonmo/Desktop/Personal/sma-indi-backtest/scripts/research/indi_bt")
import hot_scan as H
S = "/private/tmp/claude-501/-Users-alonmo-Desktop-Personal-stock-market-assistant/c3ddee47-1a60-4930-9d81-4f9675b82296/scratchpad"
JUNK = {"FB", "IVV", "VOO", "GOOG", "TLT", "HYG", "LQD", "EFA", "EEM", "VTI", "SPLG", "BND", "AGG", "IEF", "SHY", "IEFA", "VEA", "VWO", "SCHD", "BIL", "SGOV", "JNK", "EMB"}
ALIAS = {"FB": "META", "SQ": "XYZ"}
by, cal = H.load(); M = H.months(cal)
TR = [r for r in csv.DictReader(open(f"{S}/wayback/trending.csv"))
     if r["source"] in ("yahoo", "stocktwits", "apewisdom", "finviz_mostactive", "finviz_mostvolatile", "finviz_unusualvolume")
     and (r["source"] != "apewisdom" or (r["rank"] and int(r["rank"]) <= 20))]
A = [r for r in csv.DictReader(open(f"{S}/articles/hot_articles.csv")) if r["theme"] != "megacap"]
out, src = {}, {}
for m in M:
    if not ("2022-01" <= m[:7] <= "2023-12"): continue
    F = {s: f for s, f in H.features(by, cal, m).items() if s not in JUNK}
    base = H.pick(F, H.VARIANTS["h50_rng_400"], 80)
    lo = (dt.date.fromisoformat(m) - dt.timedelta(days=90)).isoformat()
    outlets = collections.defaultdict(set)
    for r in A:
        if lo <= r["date"] < m: outlets[ALIAS.get(r["ticker"], r["ticker"])].add(r["source"].split()[0].lower())
    art = sorted(t for t, o in outlets.items() if len(o) >= 2 and t not in base)
    # trending pages of the month before (Wayback): snapshot-days on yahoo / stocktwits / apewisdom top 20 / finviz
    # most active, most volatile, unusual volume; at least 2 sources and 3 days; a tradable stock (F: >= $5, >= $20M)
    pm = (dt.date.fromisoformat(m) - dt.timedelta(days=1)).isoformat()[:7]
    dd, ss = collections.defaultdict(set), collections.defaultdict(set)
    for r in TR:
        if r["date"][:7] == pm: dd[r["ticker"]].add(r["date"]); ss[r["ticker"]].add(r["source"].split("_")[0])
    have = set(base) | set(art)
    tr = [t for t in sorted(dd, key=lambda t: -len(dd[t])) if len(ss[t]) >= 2 and len(dd[t]) >= 3 and t in F and t not in have][:15]
    out[m[:7]] = base + art + tr
    src[m[:7]] = dict(core=base[:40], movers=base[40:], articles=art, trending=tr)
json.dump(out, open("data/local/x/bt/hot_final_2022_2023.json", "w"), indent=0)
json.dump(src, open("data/local/x/bt/hot_final_2022_2023_src.json", "w"), indent=0)
for y in ("2022", "2023"):
    ms = [k for k in src if k[:4] == y]
    allc = collections.Counter(s for k in ms for s in out[k])
    core = collections.Counter(s for k in ms for s in src[k]["core"])
    mov = collections.Counter(s for k in ms for s in src[k]["movers"])
    art = collections.Counter(s for k in ms for s in src[k]["articles"])
    print(f"\n## {y}: {len(allc)} names; {sum(len(out[k]) for k in ms) / len(ms):.0f} a month")
    print("CORE:", ", ".join(f"{s} {n}" for s, n in core.most_common()))
    print("MOVERS:", ", ".join(f"{s} {n}" for s, n in mov.most_common() if core[s] < n))
    print("ARTICLES:", ", ".join(f"{s} {n}" for s, n in art.most_common()))
    trc = collections.Counter(x for k in ms for x in src[k]["trending"])
    print("TRENDING:", ", ".join(f"{x} {n}" for x, n in trc.most_common()))
    print("BY MONTH (trending added):", "; ".join(f"{k[5:]}: {' '.join(src[k]['trending']) or '-'}" for k in ms))
    print("BY MONTH (articles added):", "; ".join(f"{k[5:]}: {' '.join(src[k]['articles']) or '-'}" for k in ms))

# his 2023 opens: the share on the month's list, before and after the additions
HO = [(d, x) for d, x in H.his_opens() if d[:4] == "2023"]
for name, f in (("market data 80", lambda k: set(src[k]["core"] + src[k]["movers"])), ("+ articles", lambda k: set(src[k]["core"] + src[k]["movers"] + src[k]["articles"])), ("+ articles + trending", lambda k: set(out[k]))):
    print(f"his 2023 opens on the list, {name}: {sum(x in f(d[:7]) for d, x in HO) / len(HO):.0%}")
