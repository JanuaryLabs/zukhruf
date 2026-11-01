"""Research round 6 of @zukhruf/relevance-filtering (#3195): product-style teaching.

Implements selection-rule.json (sha256 0d145514...) with round 2's frozen evaluate.py
(sha256 67ef588a...) for calibration, thresholds and metrics. Run from round-6/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 python -I evaluate.py
Never reads the exam. Writes results.json.
"""
import hashlib
import importlib.util
import json
import math
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ROUND2 = ROOT / "round-2/evaluate.py"
assert hashlib.sha256(ROUND2.read_bytes()).hexdigest().startswith("67ef588a"), "round-2 evaluate.py changed"
spec = importlib.util.spec_from_file_location("round2", ROUND2)
r2 = importlib.util.module_from_spec(spec)
sys.argv = sys.argv[:1]
spec.loader.exec_module(r2)

CANDS = ["desc|binormal", "desc|binormal+kw", "rocchio-q0|binormal+kw"]
BASES = r2.BASES
RANK = {n: i for i, n in enumerate(CANDS)}
CELLS = [5, 10]
SLICES = {"fresh": "2026-01-01", "fresh-2": "2025-10-01"}


def load_slice(name, start):
    folder = ROOT / name
    items = sorted(json.loads((folder / "items.json").read_text()), key=lambda i: i["q"])
    vectors = {r["id"]: r["vector"] for r in json.loads((folder / "vectors.json").read_text())["rows"]}
    labels = {r["q"]: r["labels"] for r in json.loads((folder / "labels.json").read_text())}
    cut = (date.fromisoformat(start) + timedelta(days=14)).isoformat()
    return {"ids": [i["id"] for i in items], "x": r2.unit([vectors[i["id"]] for i in items]),
            "text": [f"{i['title']} {i['lead']}" for i in items], "labels": [labels[i["q"]] for i in items],
            "window": np.array([i["publishedAt"] < cut for i in items]),
            "labelsSha256": hashlib.sha256((folder / "labels.json").read_bytes()).hexdigest()}


DATA = {name: load_slice(name, start) for name, start in SLICES.items()}


def with_keyword(p, k_stream, k_taught_pos):
    k_rel = (k_taught_pos.sum() + 1) / (len(k_taught_pos) + 2)
    k_non = (k_stream.sum() + 1) / (len(k_stream) + 2)
    llr = np.where(k_stream, math.log(k_rel / k_non), math.log((1 - k_rel) / (1 - k_non)))
    q = np.clip(p, 1e-12, 1 - 1e-12)
    return 0.5 * (1 + np.tanh((np.log(q) - np.log1p(-q) + llr) / 2))


def rocchio(d, P, N):
    q = 8 * d + (16 * P.mean(0) if len(P) else 0) - (4 * N.mean(0) if len(N) else 0)
    return q / np.linalg.norm(q)


def unit_run(profile, s, n_show):
    rel = np.array([l.get(profile, False) is True for l in s["labels"]])
    amb = np.array([l.get(profile, False) is None for l in s["labels"]])
    narrow = np.array([re.search(r2.KEYWORDS[profile]["narrow"], t, re.I) is not None for t in s["text"]])
    broad = np.array([re.search(r2.KEYWORDS[profile]["broad"], t, re.I) is not None for t in s["text"]])
    d = r2.DESC[profile]
    cos = s["x"] @ d
    win = np.where(s["window"])[0]
    top = list(win[np.argsort(-cos[win], kind="stable")][:n_show])
    kw = win[narrow[win]]
    top_kw = list(kw[np.argsort(-cos[kw], kind="stable")][:n_show])
    shown = sorted(set(top) | set(top_kw))
    pos = [i for i in shown if rel[i]]
    neg = [i for i in shown if not rel[i] and not amb[i]]
    scored = np.where(~s["window"])[0]
    lab = ~amb[scored]
    y = rel[scored][lab]
    yamb = rel[scored] | amb[scored]
    Xs = s["x"][scored]
    k_s = narrow[scored]
    rows = {}

    def score(name, p, dec):
        rows[name] = {"strict": r2.metric_row(dec[lab], p[lab], y), "ambiguousRelevant": r2.metric_row(dec, p, yamb)}

    n = len(scored)
    score("alwaysNo", np.zeros(n), np.zeros(n, bool))
    score("alwaysYes", np.ones(n), np.ones(n, bool))
    score("keywordNarrow", k_s.astype(float), k_s)
    score("keywordBroad", broad[scored].astype(float), broad[scored])
    P, N = s["x"][pos], s["x"][neg]
    ty = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
    fallbacks = {}
    for name in CANDS:
        if not pos:
            score(name, k_s.astype(float), k_s); fallbacks[name] = "no relevant answer: keyword"
            continue
        if name.startswith("desc"):
            raw, loo = Xs @ d, np.r_[P @ d, N @ d]
        else:
            raw = Xs @ rocchio(d, P, N)
            loo = np.zeros(len(pos) + len(neg))
            for j in range(len(loo)):
                Pj = np.delete(P, j, 0) if j < len(pos) else P
                Nj = np.delete(N, j - len(pos), 0) if j >= len(pos) else N
                x = P[j] if j < len(pos) else N[j - len(pos)]
                loo[j] = x @ rocchio(d, Pj, Nj)
        fit = r2.binormal(raw, loo, ty)
        if fit:
            p = fit[0]
        elif len(neg):
            p = r2.platt_prob(loo, ty, raw)[0]; fallbacks[name] = "platt"
        else:
            score(name, k_s.astype(float), k_s); fallbacks[name] = "no fit and no not-relevant answer: keyword"
            continue
        if name.endswith("+kw"):
            p = with_keyword(p, k_s, narrow[pos])
        dec, _ = r2.plugin_threshold(p)
        score(name, p, dec)
    return {"shown": len(shown), "taughtRelevant": len(pos), "taughtNotRelevant": len(neg),
            "scoredRelevant": int(rel[scored].sum()), "rows": rows, "fallbacks": fallbacks}


if __name__ == "__main__":
    out = {}
    for p in [pr["id"] for pr in r2.PROFILES]:
        out[p] = {f"{sl}|{n}": unit_run(p, DATA[sl], n) for sl in SLICES for n in CELLS}
        print(f"{p} done", file=sys.stderr, flush=True)
    per_profile, skill_pp = {}, {}
    for p, units in out.items():
        used = [u for k, u in units.items() if u["scoredRelevant"] >= 15]
        if used:
            per_profile[p] = {nm: float(np.mean([u["rows"][nm]["strict"]["f05"] for u in used])) for nm in CANDS + BASES}
            skill_pp[p] = {nm: float(np.nanmean([u["rows"][nm]["strict"]["brierSkill"] for u in used])) for nm in CANDS}
    scored = list(per_profile)
    macro = {nm: float(np.mean([per_profile[p][nm] for p in scored])) for nm in CANDS + BASES}
    skill = {nm: float(np.mean([skill_pp[p][nm] for p in scored])) for nm in CANDS}
    boot = lambda a, b: r2.topic_boot(per_profile, scored, a, b, seed=31957)
    intervals = {nm: {b: boot(nm, b) for b in BASES} for nm in CANDS}
    eligible = [nm for nm in CANDS if all(iv[0] > 0 for iv in intervals[nm].values()) and skill[nm] > 0]
    best = max(eligible, key=lambda nm: macro[nm]) if eligible else None
    chosen, simpler = best, {}
    if best:
        simpler = {nm: boot(nm, best) for nm in eligible if RANK[nm] < RANK[best]}
        ok = [nm for nm, iv in simpler.items() if iv[0] <= 0 <= iv[1]]
        if ok:
            chosen = min(ok, key=lambda nm: RANK[nm])
    noninferior = {nm: intervals[nm]["keywordNarrow"][0] > -0.05 for nm in CANDS}
    json.dump({
        "rule": {"file": "selection-rule.json", "sha256": hashlib.sha256((HERE / "selection-rule.json").read_bytes()).hexdigest()},
        "slices": {k: v["labelsSha256"] for k, v in DATA.items()},
        "scoredProfiles": scored, "perProfileF05": per_profile, "macroF05": macro, "macroBrierSkill": skill,
        "intervalsVsBaselines": intervals, "eligible": eligible, "best": best, "simplerVsBest": simpler, "chosen": chosen,
        "nonInferiorMargin005": noninferior, "units": out,
    }, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps({"scored": scored, "eligible": eligible, "chosen": chosen, "nonInferior": noninferior}))
