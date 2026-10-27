"""Load downloaded days (dbx_fetch.py) into the research database, with the greeks worked out per minute: the mid of
the real bid/ask, the stock's price then (the close of its last 1-minute bar before the book's time), and from those
the implied volatility (store.iv_delta, the backtest's Black-Scholes, rate sim.C["rate"]), then delta (signed: puts
negative), gamma, theta (a day) and vega (a 1-point volatility move). No mid or a mid outside the model: greeks empty.
Run through dbx_db.sh load <files> (it passes the database address as PGURL), from the app repo root.
"""
import csv, gzip, math, multiprocessing as mp, os, re, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BT_VARIANT", "v2")
import sim
from store import day, iv_delta, years_to_expiry

R = sim.C["rate"]
SCHEMA = """
CREATE TABLE IF NOT EXISTS option_quotes (date date NOT NULL, contract text NOT NULL, minute smallint NOT NULL,
  bid real, ask real, bid_sz integer, ask_sz integer, mid real, spot real, iv real, delta real, gamma real, theta real, vega real,
  PRIMARY KEY (date, contract, minute));
COMMENT ON TABLE option_quotes IS 'Best bid/ask per minute (Databento OPRA cbbo-1m) and greeks from its mid. minute: minutes from 09:30 New York, the book as that minute began. contract: OCC without spaces. spot: the stock then. iv/greeks: Black-Scholes on the mid; delta signed, theta a day, vega a 1-point move.';
CREATE TABLE IF NOT EXISTS option_oi (date date NOT NULL, contract text NOT NULL, oi integer NOT NULL, PRIMARY KEY (date, contract));
COMMENT ON TABLE option_oi IS 'Open interest at the start of the day (Databento OPRA statistics, stat_type 9).';
CREATE TABLE IF NOT EXISTS loaded_files (name text PRIMARY KEY, rows integer, at timestamptz DEFAULT now());
"""
OCC = re.compile(r"^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")
N = lambda x: math.exp(-x * x / 2) / math.sqrt(2 * math.pi)


def greeks(S, K, T, v, call):
    d1 = (math.log(S / K) + (R + v * v / 2) * T) / (v * math.sqrt(T))
    d2 = d1 - v * math.sqrt(T)
    cdf = lambda x: (1 + math.erf(x / math.sqrt(2))) / 2
    delta = cdf(d1) if call else cdf(d1) - 1
    gamma = N(d1) / (S * v * math.sqrt(T))
    carry = R * K * math.exp(-R * T) * (cdf(d2) if call else -cdf(-d2))
    theta = (-S * N(d1) * v / (2 * math.sqrt(T)) - carry) / 365
    return delta, gamma, theta, S * N(d1) * math.sqrt(T) / 100


def spots(sym, date):
    closes = {b[0]: b[4] for b in day(sym, date)}
    out, last = {}, None
    for m in range(-1, 400):
        if m in closes: last = closes[m]
        out[m + 1] = last
    return out


def rows_of(path):
    date = os.path.basename(path)[:10]
    S, out = {}, []
    for r in csv.DictReader(gzip.open(path, "rt")):
        c, m = r["contract"], int(r["minute"])
        x = OCC.match(c)
        if not x: continue
        sym, exp, right, K = x.group(1), f"20{x.group(2)}-{x.group(3)}-{x.group(4)}", x.group(5), int(x.group(6)) / 1000
        if sym not in S: S[sym] = spots(sym, date)
        bid, ask = float(r["bid"] or 0), float(r["ask"] or 0)
        mid = spot = iv = g = None
        if bid > 0 and ask > 0: mid = (bid + ask) / 2
        spot = S[sym].get(m)
        if mid and spot:
            T = years_to_expiry(date, m, exp)
            y = iv_delta(mid, spot, K, T, R, right == "C")
            if y:
                iv = y[0]; g = greeks(spot, K, T, iv, right == "C")
        fmt = lambda v, n: "" if v is None else f"{v:.{n}g}"
        out.append([date, c, m, r["bid"], r["ask"], r["bid_sz"], r["ask_sz"], fmt(mid, 6), fmt(spot, 7), fmt(iv, 5)] + [fmt(v, 5) for v in (g or (None,) * 4)])
    return out


def prep(path):
    rows = rows_of(path)
    tmp = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False)
    csv.writer(tmp).writerows(rows); tmp.close()
    oi = os.path.join(os.path.dirname(path), "oi", os.path.basename(path))
    return path, tmp.name, len(rows), oi if os.path.exists(oi) else None


def psql(*cmds, out=False):
    args = ["psql", "-q", "-v", "ON_ERROR_STOP=1", os.environ["PGURL"]] + [a for c in cmds for a in ("-c", c)]
    if out: args.insert(2, "-tA")
    return subprocess.run(args, check=True, capture_output=out, text=True).stdout


def name(path):
    return os.path.relpath(path, os.path.join(HERE, "dbx_cache")).removesuffix(".csv.gz")


def main():
    psql(SCHEMA)
    done = set(psql("SELECT name FROM loaded_files", out=True).split())
    todo = [p for p in sys.argv[1:] if name(p) not in done]
    with mp.Pool(8) as pool:
        for path, tmp, n, oi in pool.imap_unordered(prep, todo):
            date = os.path.basename(path)[:10]
            cmds = ["CREATE TEMP TABLE q (LIKE option_quotes)", f"\\copy q FROM '{tmp}' WITH (FORMAT csv)",
                    "INSERT INTO option_quotes SELECT * FROM q ON CONFLICT DO NOTHING"]
            if oi:
                cmds += ["CREATE TEMP TABLE o (contract text, oi integer)", f"\\copy o FROM PROGRAM 'gzip -dc {oi} | tail -n +2' WITH (FORMAT csv)",
                         f"INSERT INTO option_oi SELECT '{date}', contract, oi FROM o ON CONFLICT DO NOTHING"]
            psql(*cmds, f"INSERT INTO loaded_files VALUES ('{name(path)}', {n})")
            os.unlink(tmp)
            print(name(path), n, "rows", flush=True)


if __name__ == "__main__": main()
