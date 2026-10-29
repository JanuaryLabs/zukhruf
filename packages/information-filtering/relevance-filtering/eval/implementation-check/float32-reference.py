# The implementation check of freeze/plan.json, computed by the frozen research
# code (round-6 evaluate.py, round-2 evaluate.py) on the vectors as a
# Collection of @zukhruf/embeddings stores them: each article vector is a unit
# vector rounded to float32. The query of a collection also rounds the unit
# description to float32; the taught scores use the description in float64,
# as the package does. Everything else is freeze/check.py.
# Usage: uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
#   python -I float32-reference.py <relevance-profiles folder> > float32-reference.json
import importlib.util, json, re, sys
from pathlib import Path
import numpy as np

root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("r6", root / "round-6/evaluate.py")
r6 = importlib.util.module_from_spec(spec)
sys.argv = sys.argv[:1]
spec.loader.exec_module(r6)
r2, s, profile, n_show = r6.r2, r6.DATA["fresh"], "security", 10

def stored(v):
    return (v / np.linalg.norm(v, axis=-1, keepdims=True)).astype(np.float32).astype(np.float64)

x = stored(s["x"])
d64 = r2.DESC[profile]
d32 = stored(d64)
rel = np.array([l.get(profile, False) is True for l in s["labels"]])
amb = np.array([l.get(profile, False) is None for l in s["labels"]])
narrow = np.array([re.search(r2.KEYWORDS[profile]["narrow"], t, re.I) is not None for t in s["text"]])
cos = x @ d32
win = np.where(s["window"])[0]
top = list(win[np.argsort(-cos[win], kind="stable")][:n_show])
kw = win[narrow[win]]
shown = sorted(set(top) | set(kw[np.argsort(-cos[kw], kind="stable")][:n_show]))
pos = [i for i in shown if rel[i]]
neg = [i for i in shown if not rel[i] and not amb[i]]
scored = np.where(~s["window"])[0]
raw = x[scored] @ d32
loo = np.r_[x[pos] @ d64, x[neg] @ d64]
ty = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
fit = r2.binormal(raw, loo, ty)
p = r6.with_keyword(fit[0], narrow[scored], narrow[pos])
dec, thr = r2.plugin_threshold(p)
json.dump({"profile": profile, "slice": "fresh", "nShow": n_show, "vectors": "float32 unit vectors, as a Collection stores them",
           "shownIds": [s["ids"][i] for i in shown],
           "taughtRelevant": [s["ids"][i] for i in pos], "taughtNotRelevant": [s["ids"][i] for i in neg],
           "binormal": fit[1], "threshold": thr, "accepted": int(dec.sum()),
           "articles": {s["ids"][scored[j]]: [float(p[j]), bool(dec[j])] for j in range(0, len(scored), 37)}},
          sys.stdout, indent=1)
