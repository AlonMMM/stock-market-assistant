"""Raw cbbo-1s rows for one option between two session seconds: PQ_SYM=TSLA250912C00397500 PQ_DATE= PQ_A= PQ_Z="""
import csv, io, os
import leg_seconds as LS
import re
c = os.environ["PQ_SYM"]; m = re.match(r"^([A-Z.]+)(\d{6}[CP]\d{8})$", c)
text = LS.get("OPRA.PILLAR", "cbbo-1s", m.group(1).ljust(6) + m.group(2), os.environ["PQ_DATE"], int(os.environ["PQ_A"]), int(os.environ["PQ_Z"]))
for r in csv.DictReader(io.StringIO(text)): print(r["ts_recv"][11:19], r["bid_px_00"], r["ask_px_00"], r["bid_sz_00"], r["ask_sz_00"])
