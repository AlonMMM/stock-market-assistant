"""The champion's entries (retry_roll.py base: 2.5 + IBIT $0.10 + the pyramid, real quotes) per list, half and size, for
scripts that add a strategy beside it (indi_close.py). -> data/local/x/bt/champ_entries.json {"src|half|size": [(date,
minute, weight, ret, over), ...]}. Favorites = favorites.txt.
  node --env-file=.env <dir>/run.mjs champ_entries.py      (from the app repo root)"""
import collections, json, multiprocessing as mp, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import strength_exit as se
import fav_real as FR
import floor_exception as fe
se.VERSIONS.clear(); se.VERSIONS["champion"] = se.CHAMP   # at import: every worker walks the champion only


def main():
    jobs = [("fair", "main", t) for t in fe.fair_signals("sg_c12_15")] + [("fair", "add", t) for t in fe.fair_signals("s_t18r15")]
    jobs += [("fav", "main", t) for t in FR.signals("25")] + [("fav", "add", t) for t in FR.signals("24")]
    with mp.Pool(8) as pool: R = [r for r in pool.map(se.one, jobs, chunksize=4) if r]
    adds = collections.defaultdict(list)
    for r in R:
        if r["kind"] == "add": adds[(r["src"], r["date"], r["sym"], r["right"])].append(r)
    out = {f"{src}|{part}|{size}": se.entries(R, adds, src, "champion", part, size, a)
           for src, a in (("fair", ""), ("fav", FR.A24)) for part in ("tune", "check") for size in se.SIZES}
    json.dump(out, open("data/local/x/bt/champ_entries.json", "w"))
    print({k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
