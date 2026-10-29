"""The champion's baseline on the research Favorites (favorites.txt; the user, 2026-10-29: the 60 as the default list),
next to the 69 of 2026-10-26 (FAV_ALL=1 in a second run), and the fair list: retry_roll.py's champion (2.5 + IBIT down
to $0.10 + the pyramid, real quotes), tune AND check (split.py), 2% and 3%.
  node --env-file=.env <dir>/run.mjs fav_baseline.py      (from the app repo root)
"""
import collections, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import strength_exit as se
import fav_real as FR
import floor_exception as fe

se.VERSIONS.clear(); se.VERSIONS["champion"] = se.CHAMP


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    with mp.Pool(8) as pool: R = [r for r in pool.map(se.one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    tag = "the 69 (FAV_ALL=1)" if os.environ.get("FAV_ALL") == "1" else f"the {len(FR.FAV)} (favorites.txt)"
    print(f"Favorites = {tag}; stocks with a trade: {len({r['sym'] for r in R if r['src'] == 'fav' and r['kind'] == 'main'})}")
    print("| Size | List | Tune | Check | Without best 5 (tune / check) | Trades (tune / check) |\n|---|---|---|---|---|---|")
    for size in se.SIZES:
        for src, a, name in (("fair", "", "fair list"), ("fav", FR.A24, "Favorites 24m")):
            t = se.rr.stats(se.entries(R, adds, src, "champion", "tune", size, a), size)
            c = se.rr.stats(se.entries(R, adds, src, "champion", "check", size, a), size)
            print(f"| {size:.0%} | {name} | ${t['acct']:,} / {t['dd']:.0%} | ${c['acct']:,} / {c['dd']:.0%} | ${t['no5']:,} / ${c['no5']:,} | {t['trades']} / {c['trades']} |", flush=True)


if __name__ == "__main__":
    main()
