#!/usr/bin/env python3
"""Run a SQL file with `snow sql --format json` and print each result set as a compact table."""
import json
import subprocess
import sys

path = sys.argv[1]
conn = sys.argv[2] if len(sys.argv) > 2 else "zelis_c2c"
out = subprocess.run(["snow", "sql", "-c", conn, "-f", path, "--format", "json"], capture_output=True, text=True)
raw = out.stdout
try:
    data = json.loads(raw[raw.find("["):])
except Exception:
    print(raw[-4000:], out.stderr[-2000:])
    sys.exit(1)
if out.returncode:
    print(out.stderr[-4000:])
    sys.exit(out.returncode)
if data and isinstance(data[0], dict):
    data = [data]
for res in data:
    if not res or (len(res) == 1 and set(res[0]) == {"status"}):
        continue
    cols = list(res[0].keys())
    width = {c: max(len(c), *(len(str(r.get(c))) for r in res)) for c in cols}
    width = {c: min(w, 48) for c, w in width.items()}
    print(" | ".join(c.ljust(width[c]) for c in cols))
    for r in res:
        print(" | ".join(str(r.get(c))[:48].ljust(width[c]) for c in cols))
    print()
