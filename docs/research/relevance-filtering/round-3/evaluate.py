"""Research round 3 of @zukhruf/relevance-filtering (#3195).

Implements selection-rule.json (sha256 f846855f...) and inherits round 2's frozen
evaluate.py (sha256 67ef588a...) for data, draws, calibration and metrics. Run from round-3/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 --with nltk==3.9.2 python -I evaluate.py
Never reads the exam. Writes results.json.
"""
import hashlib
import importlib.util
import json
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from nltk.stem.porter import PorterStemmer
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer

HERE = Path(__file__).resolve().parent
ROUND2 = HERE.parent / "round-2/evaluate.py"
assert hashlib.sha256(ROUND2.read_bytes()).hexdigest().startswith("67ef588a"), "round-2 evaluate.py changed"
spec = importlib.util.spec_from_file_location("round2", ROUND2)
r2 = importlib.util.module_from_spec(spec)
sys.argv = sys.argv[:1]
spec.loader.exec_module(r2)

CANDS = ["lex-q0|binormal", "rocchio-q0|binormal", "lex-rocchio|binormal", "hybrid-q0|binormal", "hybrid-rocchio|binormal"]
RANK = {"lex-q0": 0, "rocchio-q0": 1, "lex-rocchio": 2, "hybrid-q0": 3, "hybrid-rocchio": 4}
BASES = r2.BASES

stemmer = PorterStemmer()
STOP = set(ENGLISH_STOP_WORDS)


def analyze(text):
    return [stemmer.stem(t) for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOP]


vectorizer = TfidfVectorizer(analyzer=analyze, sublinear_tf=True, smooth_idf=True, norm="l2")
vectorizer.fit([t for t, teach in zip(r2.TEXT, r2.TEACH) if teach])
XL = vectorizer.transform(r2.TEXT).tocsr()
extra = {a["id"]: a for a in json.loads((r2.BIOLOGY / "training-extra/articles.json").read_text())}
BIO_POS_L = vectorizer.transform([f"{extra[i]['title']} {extra[i].get('lead') or ''}" for i in r2.BIO_POS]).tocsr()
Q0 = {p["id"]: vectorizer.transform([f"{p['title']} {p['description']}"]).toarray()[0] for p in r2.PROFILES}


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def lex_rocchio(q0, P, N):
    return unit(8 * q0 + 16 * np.asarray(P.mean(0)).ravel() - 4 * np.asarray(N.mean(0)).ravel())


def standardise(stream, taught):
    sd = stream.std()
    if sd == 0:
        return np.zeros_like(stream), np.zeros_like(taught)
    return (stream - stream.mean()) / sd, (taught - stream.mean()) / sd


def scores(method, profile, Pd, Nd, Pl, Nl, Xd, XLt):
    """Stream scores and leave-one-out taught scores (relevant first, then not relevant)."""
    d, q0 = r2.DESC[profile], unit(Q0[profile])
    k = len(Pd) + len(Nd)
    if method == "rocchio-q0":
        return r2.fit_score("rocchio-q0", Pd, Nd, d)(Xd), r2.loo_scores("rocchio-q0", Pd, Nd, d)
    if method == "lex-q0":
        taught = np.r_[Pl @ q0, Nl @ q0]
        return XLt @ q0, taught
    if method == "lex-rocchio":
        loo = np.zeros(k)
        for j in range(k):
            keepP = [i for i in range(Pl.shape[0]) if i != j]
            keepN = [i for i in range(Nl.shape[0]) if i != j - Pl.shape[0]]
            x = Pl[j] if j < Pl.shape[0] else Nl[j - Pl.shape[0]]
            loo[j] = (x @ lex_rocchio(q0, Pl[keepP], Nl[keepN]))[0]
        return XLt @ lex_rocchio(q0, Pl, Nl), loo
    dense, lex = {"hybrid-q0": ("desc", "lex-q0"), "hybrid-rocchio": ("rocchio-q0", "lex-rocchio")}[method]
    if dense == "desc":
        ds, dt = Xd @ d, np.r_[Pd @ d, Nd @ d]
    else:
        ds, dt = scores(dense, profile, Pd, Nd, Pl, Nl, Xd, XLt)
    ls, lt = scores(lex, profile, Pd, Nd, Pl, Nl, Xd, XLt)
    zds, zdt = standardise(ds, dt)
    zls, zlt = standardise(ls, lt)
    return zds + zls, zdt + zlt


def run_profile(pi):
    profile = r2.PROFILES[pi]["id"]
    rel, amb = r2.labels_of(profile)
    broad = np.array([re.search(r2.KEYWORDS[profile]["broad"], t, re.I) is not None for t in r2.TEXT])
    narrow = np.array([re.search(r2.KEYWORDS[profile]["narrow"], t, re.I) is not None for t in r2.TEXT])
    test = np.where(~r2.TEACH)[0]
    lab = ~amb[test]
    y = rel[test][lab]
    yamb = rel[test] | amb[test]
    order_ids = np.argsort(np.array(r2.IDS, dtype=object), kind="stable")
    sorted_teach = [i for i in order_ids if r2.TEACH[i]]
    neg_teach = [i for i in sorted_teach if not rel[i] and not amb[i]]
    near_pool = np.array([i for i in neg_teach if broad[i]], int)
    plain_pool = np.array([i for i in neg_teach if not broad[i]], int)
    if profile == "biology":
        pos_d, pos_l, n_pos = r2.BIO_POS_X, BIO_POS_L, len(r2.BIO_POS)
    else:
        pos_idx = [i for i in sorted_teach if rel[i]]
        pos_d, pos_l, n_pos = r2.X[pos_idx], XL[pos_idx], len(pos_idx)
    Xd, XLt = r2.X[test], XL[test]
    names = CANDS + BASES
    rows = {(n, v): [] for n in names for v in ("strict", "ambiguousRelevant")}
    decisions = {n: np.zeros((len(r2.CELLS) * r2.DRAWS, len(test)), bool) for n in names}
    ap = {n: [] for n in CANDS}
    fallback = {n: 0 for n in CANDS}
    prior = {n: [] for n in CANDS}
    check = None

    def score(name, row_i, p, dec):
        decisions[name][row_i] = dec
        rows[(name, "strict")].append(r2.metric_row(dec[lab], p[lab], y))
        rows[(name, "ambiguousRelevant")].append(r2.metric_row(dec, p, yamb))

    for ci, (k_rel, k_non) in enumerate(r2.CELLS):
        if n_pos < k_rel:
            continue
        for dr in range(r2.DRAWS):
            row_i = ci * r2.DRAWS + dr
            pos_sel, neg_idx = r2.draw_taught(pi, profile, k_rel, k_non, dr, np.arange(n_pos), near_pool, plain_pool)
            Pd, Nd, Pl, Nl = pos_d[pos_sel], r2.X[neg_idx], pos_l[pos_sel], XL[neg_idx]
            ty = np.r_[np.ones(k_rel), np.zeros(k_non)]
            n = len(test)
            score("alwaysNo", row_i, np.zeros(n), np.zeros(n, bool))
            score("alwaysYes", row_i, np.ones(n), np.ones(n, bool))
            score("keywordNarrow", row_i, narrow[test].astype(float), narrow[test])
            score("keywordBroad", row_i, broad[test].astype(float), broad[test])
            for name in CANDS:
                method = name.split("|")[0]
                raw, loo = scores(method, profile, Pd, Nd, Pl, Nl, Xd, XLt)
                ap[name].append(r2.average_precision(raw[lab], y))
                fit = r2.binormal(raw, loo, ty)
                if fit:
                    p = fit[0]; prior[name].append(fit[1]["pi"])
                else:
                    p = r2.platt_prob(loo, ty, raw)[0]; fallback[name] += 1
                dec, thr = r2.plugin_threshold(p)
                score(name, row_i, p, dec)
                if profile == "security" and (k_rel, k_non) == r2.CHECK_CELL and dr == r2.CHECK_DRAW:
                    check = check or {"profile": profile, "cell": r2.CHECK_CELL, "draw": r2.CHECK_DRAW, "candidates": {},
                                      "taught": {"relevant": [r2.IDS[[i for i in sorted_teach if rel[i]][j]] for j in pos_sel],
                                                 "notRelevant": [r2.IDS[i] for i in neg_idx]}}
                    check["candidates"][name] = {"threshold": thr, "binormal": fit[1] if fit else None,
                                                 "articles": {r2.IDS[test[j]]: [float(p[j]), bool(dec[j])] for j in range(0, len(test), 97)}}
    out = {"profile": profile, "rows": {}, "check": check}
    for (name, v), rs in rows.items():
        if rs:
            out["rows"][f"{name}|{v}"] = {k: float(np.nanmean([r[k] for r in rs])) for k in rs[0]}
    out["ap"] = {n: float(np.nanmean(v)) if v else float("nan") for n, v in ap.items()}
    out["binormal"] = {n: {"fallback": fallback[n], "meanPrior": float(np.mean(prior[n])) if prior[n] else None} for n in CANDS}
    (HERE / "decisions").mkdir(exist_ok=True)
    np.savez_compressed(HERE / f"decisions/{profile}.npz", **{n.replace("|", "__"): np.packbits(decisions[n], axis=1) for n in names},
                        test=test, y=rel[test], amb=amb[test])
    print(f"{profile} done", file=sys.stderr, flush=True)
    return out


def complexity(name):
    return RANK[name.split("|")[0]]


if __name__ == "__main__":
    with ProcessPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(run_profile, range(len(r2.PROFILES))))
    by = {r["profile"]: r for r in results}
    round2 = json.loads((HERE.parent / "round-2/results.json").read_text())
    scored = round2["scoredProfiles"]
    per_profile = {p: {n: by[p]["rows"][f"{n}|strict"]["f05"] for n in CANDS + BASES} for p in scored}
    skill = {n: float(np.mean([by[p]["rows"][f"{n}|strict"]["brierSkill"] for p in scored])) for n in CANDS}
    macro = {n: float(np.mean([per_profile[p][n] for p in scored])) for n in CANDS + BASES}
    boot = lambda a, b: r2.topic_boot(per_profile, scored, a, b, seed=31954)
    intervals = {n: {b: boot(n, b) for b in BASES} for n in CANDS}
    eligible = [n for n in CANDS if all(iv[0] > 0 for iv in intervals[n].values()) and skill[n] > 0]
    best = max(eligible, key=lambda n: macro[n]) if eligible else None
    chosen, simpler = best, {}
    if best:
        simpler = {n: boot(n, best) for n in eligible if complexity(n) < complexity(best)}
        ok = [n for n, iv in simpler.items() if iv[0] <= 0 <= iv[1]]
        if ok:
            chosen = min(ok, key=complexity)
    json.dump({
        "rule": {"file": "selection-rule.json", "sha256": hashlib.sha256((HERE / "selection-rule.json").read_bytes()).hexdigest()},
        "environment": {"python": sys.version, "numpy": np.__version__, "sklearn": __import__("sklearn").__version__, "nltk": __import__("nltk").__version__},
        "vocabulary": len(vectorizer.vocabulary_),
        "scoredProfiles": scored, "macroF05": macro, "macroBrierSkill": skill, "intervalsVsBaselines": intervals,
        "eligible": eligible, "best": best, "simplerVsBest": simpler, "chosen": chosen, "profiles": by,
    }, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps({"eligible": eligible, "best": best, "chosen": chosen}))
