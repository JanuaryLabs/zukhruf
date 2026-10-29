# The ranking check of freeze-ranking/plan.json: the order of desc+kw for one unit
# (profile security, pool protocol, N = 10) from the frozen research code of round 10
# (round-10/evaluate.py: probabilities and orders). It writes two orders:
# - float64: round 10 as it ran, on float64 unit vectors.
# - float32: the same code path on the vectors as a Collection of @zukhruf/embeddings
#   stores them (float32 unit vectors). The query of a collection rounds the unit
#   description to float32 too; the taught scores use the description in float64, as the
#   package does.
# Usage: uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
#   --with scipy==1.16.2 python -I ranking-reference.py <relevance-profiles folder> > ranking-reference.json
import importlib.util, json, re, sys
from pathlib import Path
import numpy as np

root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("r10", root / "round-10/evaluate.py")
r10 = importlib.util.module_from_spec(spec)
sys.argv = sys.argv[:1]
spec.loader.exec_module(r10)
r9, r7, r6, r2 = r10.r9, r10.r7, r10.r6, r10.r2
profile, n_show = "security", 10

pool = r7.concat([r7.whole(r7.SETS[s]) for s in ("collection", "fresh", "fresh-2")])
stream = r10.stream_part(np.ones(len(r10.FRESH3["ids"]), bool))
_, probs, fallbacks, teach = r10.probabilities(profile, pool, stream, n_show)
raw = stream["x"] @ r2.DESC[profile]
order64, _ = r10.orders(profile, stream, raw, probs)

def stored(v):
    return (v / np.linalg.norm(v, axis=-1, keepdims=True)).astype(np.float32).astype(np.float64)

# round-10 probabilities() with the stored vectors, d32 for ranking and stream scores,
# d64 for the taught scores.
d64 = r2.DESC[profile]
d32 = stored(d64)
rx = r2.KEYWORDS[profile]["narrow"]
match = lambda texts: np.array([re.search(rx, t, re.I) is not None for t in texts])
px, sx = stored(pool["x"]), stored(stream["x"])
p_rel, p_amb = pool["labels"][profile]
p_cos = px @ d32
p_narrow = match(pool["text"])
top = list(np.argsort(-p_cos, kind="stable")[:n_show])
kw = np.where(p_narrow)[0]
top_kw = list(kw[np.argsort(-p_cos[kw], kind="stable")][:n_show])
shown = sorted(set(top) | set(top_kw))
pos = [i for i in shown if p_rel[i]]
neg = [i for i in shown if not p_rel[i] and not p_amb[i]]
raw32 = sx @ d32
taught = px[pos + neg] @ d64
ty = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
fit = r2.binormal(raw32, taught, ty)
p = r6.with_keyword(fit[0], match(stream["text"]), p_narrow[pos])
order32, _ = r10.orders(profile, stream, raw32, {"desc+kw": p, "truncated+kw": p})

ids = lambda order: [stream["ids"][i] for i in order]
json.dump({"profile": profile, "protocol": "pool", "nShow": n_show, "ranker": "desc+kw",
           "taughtRelevant": teach["taughtRelevant"], "taughtNotRelevant": teach["taughtNotRelevant"],
           "fallback": fallbacks.get("desc+kw"),
           "float64": ids(order64["desc+kw"]), "float32": ids(order32["desc+kw"])}, sys.stdout, indent=1)
