# Computes the implementationCheck for the frozen design with round 6's code:
# profile security, fresh slice, product teaching N=10. Probabilities and decisions
# of every 37th scored article, which the package must reproduce.
import hashlib, importlib.util, json, sys
from pathlib import Path
import numpy as np
R6 = Path(sys.argv[1]) / "round-6/evaluate.py"
spec = importlib.util.spec_from_file_location("r6", R6); r6 = importlib.util.module_from_spec(spec)
sys.argv = sys.argv[:1]; spec.loader.exec_module(r6)
r2, s, profile, n_show = r6.r2, r6.DATA["fresh"], "security", 10
import re
rel = np.array([l.get(profile, False) is True for l in s["labels"]]); amb = np.array([l.get(profile, False) is None for l in s["labels"]])
narrow = np.array([re.search(r2.KEYWORDS[profile]["narrow"], t, re.I) is not None for t in s["text"]])
d = r2.DESC[profile]; cos = s["x"] @ d; win = np.where(s["window"])[0]
top = list(win[np.argsort(-cos[win], kind="stable")][:n_show]); kw = win[narrow[win]]
shown = sorted(set(top) | set(kw[np.argsort(-cos[kw], kind="stable")][:n_show]))
pos = [i for i in shown if rel[i]]; neg = [i for i in shown if not rel[i] and not amb[i]]
scored = np.where(~s["window"])[0]
raw = s["x"][scored] @ d; loo = np.r_[s["x"][pos] @ d, s["x"][neg] @ d]; ty = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
fit = r2.binormal(raw, loo, ty)
p = r6.with_keyword(fit[0], narrow[scored], narrow[pos]); dec, thr = r2.plugin_threshold(p)
json.dump({"profile": profile, "slice": "fresh", "nShow": n_show, "shownIds": [s["ids"][i] for i in shown],
           "taughtRelevant": [s["ids"][i] for i in pos], "taughtNotRelevant": [s["ids"][i] for i in neg],
           "binormal": fit[1], "threshold": thr, "accepted": int(dec.sum()),
           "articles": {s["ids"][scored[j]]: [float(p[j]), bool(dec[j])] for j in range(0, len(scored), 37)}},
          open(Path(R6).parent.parent / "freeze/implementation-check.json", "w"), indent=1)
print("check written", len(pos), "relevant taught", len(neg), "not relevant;", int(dec.sum()), "accepted")
