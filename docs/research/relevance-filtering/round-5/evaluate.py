"""Research round 5 of @zukhruf/relevance-filtering (#3195): replication on a second fresh slice.

Implements selection-rule.json (sha256 11faab82...) and inherits round 2's frozen
evaluate.py (sha256 67ef588a...). Teaches from the collection and the first fresh slice;
scores on fresh-2. Run from round-5/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 python -I evaluate.py
Never reads the exam. Writes results.json.
"""
import hashlib
import importlib.util
import json
import math
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ROUND2 = ROOT / "round-2/evaluate.py"
assert hashlib.sha256(ROUND2.read_bytes()).hexdigest().startswith("67ef588a"), "round-2 evaluate.py changed"
TEST = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "fresh-2"
spec = importlib.util.spec_from_file_location("round2", ROUND2)
r2 = importlib.util.module_from_spec(spec)
sys.argv = sys.argv[:1]
spec.loader.exec_module(r2)

CANDS = ["desc|binormal+kw", "desc|binormal-w+kw"]
BASES = r2.BASES
RANK = {n: i for i, n in enumerate(CANDS)}


def load_slice(folder):
    items = sorted(json.loads((folder / "items.json").read_text()), key=lambda i: i["q"])
    vectors = {r["id"]: r["vector"] for r in json.loads((folder / "vectors.json").read_text())["rows"]}
    labels = {r["q"]: r for r in json.loads((folder / "labels.json").read_text())}
    assert sorted(labels) == [i["q"] for i in items], f"labels must cover {folder}"
    return ([i["id"] for i in items], r2.unit([vectors[i["id"]] for i in items]),
            [f"{i['title']} {i['lead']}" for i in items], [labels[i["q"]]["labels"] for i in items])


# Teaching pool: the collection and the first fresh slice.
f1_ids, f1_x, f1_text, f1_labels = load_slice(ROOT / "fresh")
T_IDS = r2.IDS + f1_ids
T_X = np.vstack([r2.X, f1_x])
T_TEXT = r2.TEXT + f1_text
T_LABELS = [r2.label_rows[i["q"]]["labels"] for i in r2.ITEMS] + f1_labels
S_IDS, S_X, S_TEXT, S_LABELS = load_slice(TEST)


def labels_of(rows, profile):
    value = [r.get(profile, False) for r in rows]
    return np.array([v is True for v in value]), np.array([v is None for v in value])


def draw_taught(pi, k_rel, k_non, d, n_pos, near_pool, plain_pool):
    rng = np.random.default_rng([3195, 5, pi, k_rel, k_non, d])
    pos = rng.choice(n_pos, k_rel, replace=False)
    a = min(math.ceil(k_non / 2), len(near_pool))
    b = min(k_non - a, len(plain_pool))
    a = k_non - b
    near = near_pool[rng.choice(len(near_pool), a, replace=False)]
    plain = plain_pool[rng.choice(len(plain_pool), b, replace=False)]
    return pos, np.r_[near, plain].astype(int)


def with_keyword(p, k_stream, k_taught_pos):
    k_rel = (k_taught_pos.sum() + 1) / (len(k_taught_pos) + 2)
    k_non = (k_stream.sum() + 1) / (len(k_stream) + 2)
    llr = np.where(k_stream, math.log(k_rel / k_non), math.log((1 - k_rel) / (1 - k_non)))
    q = np.clip(p, 1e-12, 1 - 1e-12)
    return 0.5 * (1 + np.tanh((np.log(q) - np.log1p(-q) + llr) / 2))


def binormal_weighted(stream_raw, loo, y, lam):
    """Round 2's binormal with each stream article counting lam in the component means and sds (EM-lambda)."""
    mean, sd = stream_raw.mean(), stream_raw.std()
    if sd == 0:
        return None
    z, zt = (stream_raw - mean) / sd, (loo - mean) / sd
    zp, zn = zt[y == 1], zt[y == 0]
    n = len(z)
    lo, hi = 1 / n, 0.5
    pi = min(max(0.05, lo), hi)
    mu1, s1 = zp.mean(), max(zp.std(), 0.05)
    mu0, s0 = z.mean(), max(z.std(), 0.05)
    if mu1 <= mu0:
        return None
    prev = -math.inf
    for _ in range(500):
        l1, l0 = r2.log_normal(z, mu1, s1), r2.log_normal(z, mu0, s0)
        r = 0.5 * (1 + np.tanh((math.log(pi) + l1 - math.log(1 - pi) - l0) / 2))
        ll = float(lam * np.sum(np.logaddexp(math.log(pi) + l1, math.log(1 - pi) + l0))
                   + r2.log_normal(zp, mu1, s1).sum() + r2.log_normal(zn, mu0, s0).sum())
        if abs(ll - prev) < 1e-9:
            break
        prev = ll
        pi = min(max(float(r.mean()), lo), hi)
        w1, x1 = np.r_[lam * r, np.ones(len(zp))], np.r_[z, zp]
        w0, x0 = np.r_[lam * (1 - r), np.ones(len(zn))], np.r_[z, zn]
        mu1 = float(np.sum(w1 * x1) / np.sum(w1)); s1 = max(math.sqrt(float(np.sum(w1 * (x1 - mu1) ** 2) / np.sum(w1))), 0.05)
        mu0 = float(np.sum(w0 * x0) / np.sum(w0)); s0 = max(math.sqrt(float(np.sum(w0 * (x0 - mu0) ** 2) / np.sum(w0))), 0.05)
        if mu1 <= mu0:
            return None
    l1, l0 = r2.log_normal(z, mu1, s1), r2.log_normal(z, mu0, s0)
    return 0.5 * (1 + np.tanh((math.log(pi) + l1 - math.log(1 - pi) - l0) / 2)), {"pi": pi}


def run_profile(pi):
    profile = r2.PROFILES[pi]["id"]
    rel_t, amb_t = labels_of(T_LABELS, profile)
    rel, amb = labels_of(S_LABELS, profile)
    narrow_re, broad_re = r2.KEYWORDS[profile]["narrow"], r2.KEYWORDS[profile]["broad"]
    narrow_t = np.array([re.search(narrow_re, t, re.I) is not None for t in T_TEXT])
    broad_t = np.array([re.search(broad_re, t, re.I) is not None for t in T_TEXT])
    narrow = np.array([re.search(narrow_re, t, re.I) is not None for t in S_TEXT])
    broad = np.array([re.search(broad_re, t, re.I) is not None for t in S_TEXT])
    lab = ~amb
    y = rel[lab]
    yamb = rel | amb
    order = np.argsort(np.array(T_IDS, dtype=object), kind="stable")
    pos_idx = np.array([i for i in order if rel_t[i]], int)
    neg = [i for i in order if not rel_t[i] and not amb_t[i]]
    near_pool = np.array([i for i in neg if broad_t[i]], int)
    plain_pool = np.array([i for i in neg if not broad_t[i]], int)
    d = r2.DESC[profile]
    names = CANDS + BASES
    rows = {(nm, v): [] for nm in names for v in ("strict", "ambiguousRelevant")}
    notes = {"fallback": {n: 0 for n in CANDS}, "meanPrior": {n: [] for n in CANDS}}
    check = None
    n = len(S_IDS)
    raw = S_X @ d

    def score(name, p, dec):
        rows[(name, "strict")].append(r2.metric_row(dec[lab], p[lab], y))
        rows[(name, "ambiguousRelevant")].append(r2.metric_row(dec, p, yamb))

    for ci, (k_rel, k_non) in enumerate(r2.CELLS):
        if len(pos_idx) < k_rel:
            continue
        for dr in range(r2.DRAWS):
            pos_sel, neg_idx = draw_taught(pi, k_rel, k_non, dr, len(pos_idx), near_pool, plain_pool)
            taught_pos = pos_idx[pos_sel]
            loo = np.r_[T_X[taught_pos] @ d, T_X[neg_idx] @ d]
            ty = np.r_[np.ones(k_rel), np.zeros(k_non)]
            score("alwaysNo", np.zeros(n), np.zeros(n, bool))
            score("alwaysYes", np.ones(n), np.ones(n, bool))
            score("keywordNarrow", narrow.astype(float), narrow)
            score("keywordBroad", broad.astype(float), broad)
            fits = {"desc|binormal+kw": r2.binormal(raw, loo, ty),
                    "desc|binormal-w+kw": binormal_weighted(raw, loo, ty, (k_rel + k_non) / n)}
            for name, fit in fits.items():
                if fit:
                    p = fit[0]; notes["meanPrior"][name].append(fit[1]["pi"])
                else:
                    p = r2.platt_prob(loo, ty, raw)[0]; notes["fallback"][name] += 1
                p = with_keyword(p, narrow, narrow_t[taught_pos])
                dec, thr = r2.plugin_threshold(p)
                score(name, p, dec)
                if profile == "security" and (k_rel, k_non) == r2.CHECK_CELL and dr == r2.CHECK_DRAW:
                    check = check or {"profile": profile, "cell": r2.CHECK_CELL, "draw": r2.CHECK_DRAW, "candidates": {},
                                      "taught": {"relevant": [T_IDS[i] for i in taught_pos], "notRelevant": [T_IDS[i] for i in neg_idx]}}
                    check["candidates"][name] = {"threshold": thr, "articles": {S_IDS[j]: [float(p[j]), bool(dec[j])] for j in range(0, n, 37)}}
    out = {"profile": profile, "rows": {}, "check": check,
           "counts": {"teachRelevant": len(pos_idx), "testRelevant": int(rel.sum()), "testAmbiguous": int(amb.sum()), "testLabelled": int(lab.sum())},
           "notes": {"fallback": notes["fallback"], "meanPrior": {k: float(np.mean(v)) if v else None for k, v in notes["meanPrior"].items()}}}
    for (name, v), rs in rows.items():
        if rs:
            out["rows"][f"{name}|{v}"] = {k: float(np.nanmean([r[k] for r in rs])) for k in rs[0]}
    print(f"{profile} done", file=sys.stderr, flush=True)
    return out


if __name__ == "__main__":
    with ProcessPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(run_profile, range(len(r2.PROFILES))))
    by = {r["profile"]: r for r in results}
    scored = [p for p, r in by.items() if r["counts"]["teachRelevant"] >= 10 and r["counts"]["testRelevant"] >= 20]
    per_profile = {p: {nm: by[p]["rows"][f"{nm}|strict"]["f05"] for nm in CANDS + BASES} for p in scored}
    skill = {nm: float(np.mean([by[p]["rows"][f"{nm}|strict"]["brierSkill"] for p in scored])) for nm in CANDS}
    macro = {nm: float(np.mean([per_profile[p][nm] for p in scored])) for nm in CANDS + BASES}
    boot = lambda a, b: r2.topic_boot(per_profile, scored, a, b, seed=31956)
    intervals = {nm: {b: boot(nm, b) for b in BASES} for nm in CANDS}
    eligible = [nm for nm in CANDS if all(iv[0] > 0 for iv in intervals[nm].values()) and skill[nm] > 0]
    best = max(eligible, key=lambda nm: macro[nm]) if eligible else None
    chosen, simpler = best, {}
    if best:
        simpler = {nm: boot(nm, best) for nm in eligible if RANK[nm] < RANK[best]}
        ok = [nm for nm, iv in simpler.items() if iv[0] <= 0 <= iv[1]]
        if ok:
            chosen = min(ok, key=lambda nm: RANK[nm])
    json.dump({
        "rule": {"file": "selection-rule.json", "sha256": hashlib.sha256((HERE / "selection-rule.json").read_bytes()).hexdigest()},
        "test": {"folder": str(TEST), "labels": hashlib.sha256((TEST / "labels.json").read_bytes()).hexdigest(), "articles": len(S_IDS)},
        "scoredProfiles": scored, "macroF05": macro, "macroBrierSkill": skill, "intervalsVsBaselines": intervals,
        "eligible": eligible, "best": best, "simplerVsBest": simpler, "chosen": chosen, "profiles": by,
    }, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps({"scored": scored, "eligible": eligible, "best": best, "chosen": chosen}))
