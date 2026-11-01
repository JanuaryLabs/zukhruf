"""Research round 4 of @zukhruf/relevance-filtering (#3195).

Implements selection-rule.json (sha256 ead2b9f6...) and inherits round 2's frozen
evaluate.py (sha256 67ef588a...). Teaches from the whole round-2 collection; scores on
the fresh stream. Run from round-4/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 python -I evaluate.py [fresh dir]
Never reads the exam. Writes results.json.

Implementation choices fixed before the fresh labels were read: draw order as round 2;
kwstrat strata are fitted with round 2's binormal steps (start pi 0.05, sd floor 0.05,
500 iterations), standardised inside the stratum.
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
ROUND2 = HERE.parent / "round-2/evaluate.py"
assert hashlib.sha256(ROUND2.read_bytes()).hexdigest().startswith("67ef588a"), "round-2 evaluate.py changed"
FRESH = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "fresh"
spec = importlib.util.spec_from_file_location("round2", ROUND2)
r2 = importlib.util.module_from_spec(spec)
sys.argv = sys.argv[:1]
spec.loader.exec_module(r2)

CANDS = ["desc|binormal", "rocchio-q0|binormal", "desc|binormal+kw", "rocchio-q0|binormal+kw", "rocchio-q0|kwstrat"]
BASES = r2.BASES

items = sorted(json.loads((FRESH / "items.json").read_text()), key=lambda i: i["q"])
fresh_vectors = {r["id"]: r["vector"] for r in json.loads((FRESH / "vectors.json").read_text())["rows"]}
XF = r2.unit([fresh_vectors[i["id"]] for i in items])
TEXT_F = [f"{i['title']} {i['lead']}" for i in items]
fresh_labels = {r["q"]: r for r in json.loads((FRESH / "labels.json").read_text())}
assert sorted(fresh_labels) == [i["q"] for i in items], "fresh labels must cover the fresh stream exactly"


def fresh_labels_of(profile):
    value = [fresh_labels[i["q"]]["labels"].get(profile, False) for i in items]
    return np.array([v is True for v in value]), np.array([v is None for v in value])


def draw_taught(pi, k_rel, k_non, d, n_pos, near_pool, plain_pool):
    rng = np.random.default_rng([3195, 4, pi, k_rel, k_non, d])
    pos = rng.choice(n_pos, k_rel, replace=False)
    a = min(math.ceil(k_non / 2), len(near_pool))
    b = min(k_non - a, len(plain_pool))
    a = k_non - b
    near = near_pool[rng.choice(len(near_pool), a, replace=False)]
    plain = plain_pool[rng.choice(len(plain_pool), b, replace=False)]
    return pos, np.r_[near, plain].astype(int)


def logit(p):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return np.log(p) - np.log1p(-p)


def with_keyword(p, k_stream, k_taught_pos):
    k_rel = (k_taught_pos.sum() + 1) / (len(k_taught_pos) + 2)
    k_non = (k_stream.sum() + 1) / (len(k_stream) + 2)
    llr = np.where(k_stream, math.log(k_rel / k_non), math.log((1 - k_rel) / (1 - k_non)))
    return 0.5 * (1 + np.tanh((logit(p) + llr) / 2))


def binormal_init(stream_raw, loo, y, init_pos):
    """Round 2's binormal steps; the relevant start comes from init_pos when the stratum has no taught relevant."""
    mean, sd = stream_raw.mean(), stream_raw.std()
    if sd == 0 or len(stream_raw) < 2:
        return None
    z, zt, zi = (stream_raw - mean) / sd, (loo - mean) / sd, (init_pos - mean) / sd
    zp, zn = zt[y == 1], zt[y == 0]
    n = len(z)
    lo, hi = 1 / n, 0.5
    pi = min(max(0.05, lo), hi)
    start = zp if len(zp) else zi
    mu1, s1 = start.mean(), max(start.std(), 0.05)
    mu0, s0 = z.mean(), max(z.std(), 0.05)
    if mu1 <= mu0:
        return None
    prev = -math.inf
    for _ in range(500):
        l1, l0 = r2.log_normal(z, mu1, s1), r2.log_normal(z, mu0, s0)
        r = 0.5 * (1 + np.tanh((math.log(pi) + l1 - math.log(1 - pi) - l0) / 2))
        ll = float(np.sum(np.logaddexp(math.log(pi) + l1, math.log(1 - pi) + l0))
                   + r2.log_normal(zp, mu1, s1).sum() + r2.log_normal(zn, mu0, s0).sum())
        if abs(ll - prev) < 1e-9:
            break
        prev = ll
        pi = min(max(float(r.mean()), lo), hi)
        w1, x1 = np.r_[r, np.ones(len(zp))], np.r_[z, zp]
        w0, x0 = np.r_[1 - r, np.ones(len(zn))], np.r_[z, zn]
        mu1 = float(np.sum(w1 * x1) / np.sum(w1)); s1 = max(math.sqrt(float(np.sum(w1 * (x1 - mu1) ** 2) / np.sum(w1))), 0.05)
        mu0 = float(np.sum(w0 * x0) / np.sum(w0)); s0 = max(math.sqrt(float(np.sum(w0 * (x0 - mu0) ** 2) / np.sum(w0))), 0.05)
        if mu1 <= mu0:
            return None
    l1, l0 = r2.log_normal(z, mu1, s1), r2.log_normal(z, mu0, s0)
    return 0.5 * (1 + np.tanh((math.log(pi) + l1 - math.log(1 - pi) - l0) / 2)), {"pi": pi}


def run_profile(pi):
    profile = r2.PROFILES[pi]["id"]
    rel_c, amb_c = r2.labels_of(profile)
    broad_c = np.array([re.search(r2.KEYWORDS[profile]["broad"], t, re.I) is not None for t in r2.TEXT])
    narrow_c = np.array([re.search(r2.KEYWORDS[profile]["narrow"], t, re.I) is not None for t in r2.TEXT])
    rel, amb = fresh_labels_of(profile)
    narrow = np.array([re.search(r2.KEYWORDS[profile]["narrow"], t, re.I) is not None for t in TEXT_F])
    broad = np.array([re.search(r2.KEYWORDS[profile]["broad"], t, re.I) is not None for t in TEXT_F])
    lab = ~amb
    y = rel[lab]
    yamb = rel | amb
    order_ids = np.argsort(np.array(r2.IDS, dtype=object), kind="stable")
    pos_idx = np.array([i for i in order_ids if rel_c[i]], int)
    neg = [i for i in order_ids if not rel_c[i] and not amb_c[i]]
    near_pool = np.array([i for i in neg if broad_c[i]], int)
    plain_pool = np.array([i for i in neg if not broad_c[i]], int)
    d = r2.DESC[profile]
    names = CANDS + BASES
    rows = {(n, v): [] for n in names for v in ("strict", "ambiguousRelevant")}
    decisions = {n: np.zeros((len(r2.CELLS) * r2.DRAWS, len(items)), bool) for n in names}
    ap = {m: [] for m in ("desc", "rocchio-q0")}
    notes = {"binormalFallback": {"desc": 0, "rocchio-q0": 0}, "kwstratFallbackStrata": 0}
    check = None

    def score(name, row_i, p, dec):
        decisions[name][row_i] = dec
        rows[(name, "strict")].append(r2.metric_row(dec[lab], p[lab], y))
        rows[(name, "ambiguousRelevant")].append(r2.metric_row(dec, p, yamb))

    for ci, (k_rel, k_non) in enumerate(r2.CELLS):
        if len(pos_idx) < k_rel:
            continue
        for dr in range(r2.DRAWS):
            row_i = ci * r2.DRAWS + dr
            pos_sel, neg_idx = draw_taught(pi, k_rel, k_non, dr, len(pos_idx), near_pool, plain_pool)
            taught_pos = pos_idx[pos_sel]
            P, N = r2.X[taught_pos], r2.X[neg_idx]
            ty = np.r_[np.ones(k_rel), np.zeros(k_non)]
            k_taught = np.r_[narrow_c[taught_pos], narrow_c[neg_idx]]
            n = len(items)
            score("alwaysNo", row_i, np.zeros(n), np.zeros(n, bool))
            score("alwaysYes", row_i, np.ones(n), np.ones(n, bool))
            score("keywordNarrow", row_i, narrow.astype(float), narrow)
            score("keywordBroad", row_i, broad.astype(float), broad)
            probs = {}
            for m in ("desc", "rocchio-q0"):
                raw = r2.fit_score(m, P, N, d)(XF)
                loo = r2.loo_scores(m, P, N, d)
                ap[m].append(r2.average_precision(raw[lab], y))
                fit = r2.binormal(raw, loo, ty)
                if fit:
                    p = fit[0]
                else:
                    p = r2.platt_prob(loo, ty, raw)[0]; notes["binormalFallback"][m] += 1
                probs[f"{m}|binormal"] = p
                probs[f"{m}|binormal+kw"] = with_keyword(p, narrow, narrow_c[taught_pos])
                if m == "rocchio-q0":
                    strat = probs["rocchio-q0|binormal+kw"].copy()
                    for value in (True, False):
                        s, t = narrow == value, k_taught == value
                        fit_s = binormal_init(raw[s], loo[t], ty[t], loo[:k_rel])
                        if fit_s:
                            strat[s] = fit_s[0]
                        else:
                            notes["kwstratFallbackStrata"] += 1
                    probs["rocchio-q0|kwstrat"] = strat
            for name in CANDS:
                p = probs[name]
                dec, thr = r2.plugin_threshold(p)
                score(name, row_i, p, dec)
                if profile == "security" and (k_rel, k_non) == r2.CHECK_CELL and dr == r2.CHECK_DRAW:
                    check = check or {"profile": profile, "cell": r2.CHECK_CELL, "draw": r2.CHECK_DRAW, "candidates": {},
                                      "taught": {"relevant": [r2.IDS[i] for i in taught_pos], "notRelevant": [r2.IDS[i] for i in neg_idx]}}
                    check["candidates"][name] = {"threshold": thr, "articles": {items[j]["id"]: [float(p[j]), bool(dec[j])] for j in range(0, n, 37)}}
    out = {"profile": profile, "rows": {}, "check": check, "notes": notes,
           "counts": {"teachRelevant": len(pos_idx), "freshRelevant": int(rel.sum()), "freshAmbiguous": int(amb.sum()), "freshLabelled": int(lab.sum())}}
    for (name, v), rs in rows.items():
        if rs:
            out["rows"][f"{name}|{v}"] = {k: float(np.nanmean([r[k] for r in rs])) for k in rs[0]}
    out["ap"] = {m: float(np.nanmean(v)) if v else float("nan") for m, v in ap.items()}
    (HERE / "decisions").mkdir(exist_ok=True)
    np.savez_compressed(HERE / f"decisions/{profile}.npz", **{nm.replace("|", "__"): np.packbits(decisions[nm], axis=1) for nm in names},
                        y=rel, amb=amb)
    print(f"{profile} done", file=sys.stderr, flush=True)
    return out


RANK = {name: i for i, name in enumerate(CANDS)}

if __name__ == "__main__":
    with ProcessPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(run_profile, range(len(r2.PROFILES))))
    by = {r["profile"]: r for r in results}
    scored = [p for p, r in by.items() if r["counts"]["teachRelevant"] >= 10 and r["counts"]["freshRelevant"] >= 20]
    per_profile = {p: {n: by[p]["rows"][f"{n}|strict"]["f05"] for n in CANDS + BASES} for p in scored}
    skill = {n: float(np.mean([by[p]["rows"][f"{n}|strict"]["brierSkill"] for p in scored])) for n in CANDS}
    macro = {n: float(np.mean([per_profile[p][n] for p in scored])) for n in CANDS + BASES}
    boot = lambda a, b: r2.topic_boot(per_profile, scored, a, b, seed=31955)
    intervals = {n: {b: boot(n, b) for b in BASES} for n in CANDS}
    eligible = [n for n in CANDS if all(iv[0] > 0 for iv in intervals[n].values()) and skill[n] > 0]
    best = max(eligible, key=lambda n: macro[n]) if eligible else None
    chosen, simpler = best, {}
    if best:
        simpler = {n: boot(n, best) for n in eligible if RANK[n] < RANK[best]}
        ok = [n for n, iv in simpler.items() if iv[0] <= 0 <= iv[1]]
        if ok:
            chosen = min(ok, key=lambda n: RANK[n])
    json.dump({
        "rule": {"file": "selection-rule.json", "sha256": hashlib.sha256((HERE / "selection-rule.json").read_bytes()).hexdigest()},
        "fresh": {"labels": hashlib.sha256((FRESH / "labels.json").read_bytes()).hexdigest(), "articles": len(items)},
        "environment": {"python": sys.version, "numpy": np.__version__},
        "scoredProfiles": scored, "macroF05": macro, "macroBrierSkill": skill, "intervalsVsBaselines": intervals,
        "eligible": eligible, "best": best, "simplerVsBest": simpler, "chosen": chosen, "profiles": by,
    }, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps({"scored": scored, "eligible": eligible, "best": best, "chosen": chosen}))
