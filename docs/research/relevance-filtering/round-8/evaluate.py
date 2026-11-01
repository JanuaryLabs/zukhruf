"""Research round 8 of @zukhruf/relevance-filtering (#3195): the truncated fit with ordered
components (McLachlan & Peel 2000, section 2.5) and three starts.

Implements selection-rule.json (sha256 6249268c...) on round 7's frozen evaluate.py
(sha256 8c5f7960..., data sets, pool and window protocols, truncated likelihood and its
gradient, truncated_binormal), which reuses round 6 (a9204fd6...) and round 2 (67ef588a...).
Run from round-8/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 python -I evaluate.py [--smoke OUT.json]
Never reads the exam. Writes results.json. --smoke is passed on to round 7's module, which
replaces every label list in memory by random labels (rng 7); the output goes to OUT.json.

Implementation choices fixed before the real run (the rule leaves them open):
- Everything round 7's docstring fixed holds: pools, scored stream as the binormal stream,
  list cut-offs (ambiguous shown articles count for a cut-off, an article in both lists
  takes the lower one), log(1 - Phi(x)) = log_ndtr(-x), success = result.success, round 6's
  with_keyword and r2.plugin_threshold, units >= 15 strict relevant.
- 'ordered' reuses round 7's negative log-likelihood unchanged, reparametrised:
  phi = (mu0, delta, s1, s0, pi), mu1 = mu0 + exp(delta). Gradient by the chain rule:
  dL/dmu0 = dL/dmu1 + dL/dmu0(old), dL/ddelta = dL/dmu1 * exp(delta). Checked against
  central differences in the new parameters before every run.
- Standardisation by the scored stream's mean and population sd, as round 7. The start
  delta_1 = log(max(mean(z of the relevant answers) - 0, 0.05)); L-BFGS-B clips any start
  outside the bounds itself. L-BFGS-B options as round 7 (gtol 1e-10, maxiter 10000).
- Starts are tried in the order 1, 2, 3 (log max(mean,0.05), log 1, log 3). Among the
  converged ones the highest log-likelihood wins; an exact tie keeps the earlier start.
- If no start converges: r2.binormal (round-2 EM, the frozen design's fit) on the same raw
  stream and taught scores; if that returns None: r2.platt_prob when there is a
  not-relevant answer, else the keyword matches (round 6's order). No relevant answer:
  keyword matches, as before.
- 'truncated' = round 7's code path exactly (r7.truncated_binormal, its fallbacks).
- Each topic bootstrap call starts numpy.random.default_rng(31960) afresh, as rounds 6-7.
"""
import hashlib
import importlib.util
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import scipy
from scipy.optimize import minimize

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ROUND7 = ROOT / "round-7/evaluate.py"
assert hashlib.sha256(ROUND7.read_bytes()).hexdigest().startswith("8c5f7960"), "round-7 evaluate.py changed"
SMOKE = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--smoke" else None
spec = importlib.util.spec_from_file_location("round7", ROUND7)
r7 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r7)  # reads sys.argv for --smoke itself
assert bool(r7.SMOKE) == bool(SMOKE)
r6, r2 = r7.r6, r7.r2

CANDS = ["ordered", "truncated"]
BASES = r2.BASES
CELLS = r7.CELLS
SEED = 31960
PROFILE_IDS = r7.PROFILE_IDS
DELTA_BOUNDS = (math.log(0.05), math.log(20))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---------------------------------------------------------------- ordered fit
def to_round7(phi):
    mu0, delta, s1, s0, pi = phi
    return np.array([mu0 + math.exp(delta), s1, mu0, s0, pi])


def ordered_negative_loglik(phi, z, zs, cs, ys):
    f, g = r7.negative_loglik(to_round7(phi), z, zs, cs, ys)
    g_mu1, g_s1, g_mu0, g_s0, g_pi = g
    return f, np.array([g_mu1 + g_mu0, g_mu1 * math.exp(phi[1]), g_s1, g_s0, g_pi])


def ordered_binormal(stream_raw, shown_raw, shown_cut_raw, ys):
    """Returns (posterior of component 1 or None, record of every start and the winner)."""
    mean, sd = stream_raw.mean(), stream_raw.std()
    if sd == 0:
        return None, {"reason": "stream sd 0"}
    z = (stream_raw - mean) / sd
    zs = (shown_raw - mean) / sd
    cs = (shown_cut_raw - mean) / sd
    n = len(z)
    zp = zs[ys == 1]
    s1 = max(zp.std(), 0.05)
    deltas = [math.log(max(zp.mean() - 0, 0.05)), math.log(1), math.log(3)]
    bounds = [(-10, 10), DELTA_BOUNDS, (0.05, 10), (0.05, 10), (1 / n, 0.5)]
    starts, best = [], None
    for k, delta in enumerate(deltas, 1):
        res = minimize(ordered_negative_loglik, np.array([0.0, delta, s1, 1.0, 0.05]), args=(z, zs, cs, ys),
                       jac=True, method="L-BFGS-B", bounds=bounds, options={"gtol": 1e-10, "maxiter": 10000})
        mu0, dl, s1h, s0h, pi = (float(v) for v in res.x)
        rec = {"start": k, "delta0": delta, "mu1": mu0 + math.exp(dl), "s1": s1h, "mu0": mu0, "s0": s0h, "pi": pi,
               "delta": dl, "success": bool(res.success), "message": str(res.message), "nit": int(res.nit),
               "loglik": float(-res.fun)}
        starts.append(rec)
        if rec["success"] and (best is None or rec["loglik"] > best["loglik"]):
            best = rec
    info = {"starts": starts, "winner": best["start"] if best else None}
    if best is None:
        return None, {**info, "reason": "no start converged"}
    l1 = math.log(best["pi"]) + r7.log_normal(z, best["mu1"], best["s1"])
    l0 = math.log(1 - best["pi"]) + r7.log_normal(z, best["mu0"], best["s0"])
    return np.exp(l1 - np.logaddexp(l1, l0)), info


# ---------------------------------------------------------------- one unit (round 7 unit_run with these candidates)
def unit_run(profile, pool, stream, n_show):
    d = r2.DESC[profile]
    narrow_re, broad_re = r2.KEYWORDS[profile]["narrow"], r2.KEYWORDS[profile]["broad"]
    match = lambda texts, rx: np.array([re.search(rx, t, re.I) is not None for t in texts])
    p_rel, p_amb = pool["labels"][profile]
    p_cos = pool["x"] @ d
    p_narrow = match(pool["text"], narrow_re)
    top = list(np.argsort(-p_cos, kind="stable")[:n_show])
    kw = np.where(p_narrow)[0]
    top_kw = list(kw[np.argsort(-p_cos[kw], kind="stable")][:n_show])
    shown = sorted(set(top) | set(top_kw))
    pos = [i for i in shown if p_rel[i]]
    neg = [i for i in shown if not p_rel[i] and not p_amb[i]]
    cut_top = p_cos[top].min()
    cut_kw = p_cos[top_kw].min() if top_kw else math.inf
    cut_of = lambda i: min(cut_top if i in top else math.inf, cut_kw if i in top_kw else math.inf)

    s_rel, s_amb = stream["labels"][profile]
    lab = ~s_amb
    y = s_rel[lab]
    yamb = s_rel | s_amb
    raw = stream["x"] @ d
    k_s = match(stream["text"], narrow_re)
    broad = match(stream["text"], broad_re)
    rows, fallbacks, fits = {}, {}, {}

    def score(name, p, dec):
        rows[name] = {"strict": r2.metric_row(dec[lab], p[lab], y), "ambiguousRelevant": r2.metric_row(dec, p, yamb)}

    m = len(raw)
    score("alwaysNo", np.zeros(m), np.zeros(m, bool))
    score("alwaysYes", np.ones(m), np.ones(m, bool))
    score("keywordNarrow", k_s.astype(float), k_s)
    score("keywordBroad", broad.astype(float), broad)
    answered = pos + neg
    ty = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
    taught = p_cos[answered]
    cuts = np.array([cut_of(i) for i in answered])
    for name in CANDS:
        if not pos:
            score(name, k_s.astype(float), k_s); fallbacks[name] = "no relevant answer: keyword"
            continue
        if name == "ordered":
            p, fits[name] = ordered_binormal(raw, taught, cuts, ty)
            if p is None:
                em = r2.binormal(raw, taught, ty)
                if em:
                    p, fallbacks[name] = em[0], "round-2 EM"
                    fits[name]["em"] = em[1]
        else:
            p, fits[name] = r7.truncated_binormal(raw, taught, cuts, ty)
        if p is None:
            if neg:
                p = r2.platt_prob(taught, ty, raw)[0]; fallbacks[name] = "platt"
            else:
                score(name, k_s.astype(float), k_s); fallbacks[name] = "no fit and no not-relevant answer: keyword"
                continue
        p = r6.with_keyword(p, k_s, p_narrow[pos])
        dec, _ = r2.plugin_threshold(p)
        score(name, p, dec)
    return {"shown": len(shown), "taughtRelevant": len(pos), "taughtNotRelevant": len(neg),
            "scoredRelevant": int(s_rel.sum()), "rows": rows, "fallbacks": fallbacks, "fits": fits}


# ---------------------------------------------------------------- protocols
def protocol_units(protocol):
    S = r7.SETS
    out = {p: {} for p in PROFILE_IDS}
    if protocol == "window":
        for sl in ("fresh", "fresh-2"):
            pool, stream = r7.part(S[sl], S[sl]["window"]), r7.part(S[sl], ~S[sl]["window"])
            for p in PROFILE_IDS:
                for n in CELLS:
                    out[p][f"{sl}|{n}"] = unit_run(p, pool, stream, n)
    else:
        pool_slice, stream_slice = ("fresh", "fresh-2") if protocol == "poolA" else ("fresh-2", "fresh")
        pool = r7.concat([r7.whole(S["collection"]), r7.whole(S[pool_slice])])
        stream = r7.whole(S[stream_slice])
        for p in PROFILE_IDS:
            for n in CELLS:
                out[p][f"{stream_slice}|{n}"] = unit_run(p, pool, stream, n)
    return out


def protocol_result(protocol):
    units = protocol_units(protocol)
    per_profile, skill_pp = {}, {}
    for p, us in units.items():
        used = [u for u in us.values() if u["scoredRelevant"] >= 15]
        if used:
            per_profile[p] = {nm: float(np.mean([u["rows"][nm]["strict"]["f05"] for u in used])) for nm in CANDS + BASES}
            skill_pp[p] = {nm: float(np.nanmean([u["rows"][nm]["strict"]["brierSkill"] for u in used])) for nm in CANDS}
    scored = list(per_profile)
    macro = {nm: float(np.mean([per_profile[p][nm] for p in scored])) for nm in CANDS + BASES}
    skill = {nm: float(np.mean([skill_pp[p][nm] for p in scored])) for nm in CANDS}
    intervals = {nm: {b: r2.topic_boot(per_profile, scored, nm, b, seed=SEED) for b in BASES} for nm in CANDS}
    passes = {nm: bool(intervals[nm]["keywordNarrow"][0] > -0.05
                       and all(intervals[nm][b][0] > 0 for b in ("keywordBroad", "alwaysNo", "alwaysYes"))
                       and skill[nm] > 0) for nm in CANDS}
    fallback_counts = {nm: {} for nm in CANDS}
    winners = {"scored": {}, "unscored": {}}
    for us in units.values():
        for u in us.values():
            group = "scored" if u["scoredRelevant"] >= 15 else "unscored"
            for nm in CANDS:
                key = f"{group}|{u['fallbacks'].get(nm, 'none')}"
                fallback_counts[nm][key] = fallback_counts[nm].get(key, 0) + 1
            f = u["fits"].get("ordered")
            if f and "starts" in f:
                w = str(f["winner"])
                winners[group][w] = winners[group].get(w, 0) + 1
    return {"scoredProfiles": scored, "perProfileT11F": per_profile, "perProfileBrierSkill": skill_pp,
            "macroT11F": macro, "macroBrierSkill": skill, "intervalsVsBaselines": intervals, "pass": passes,
            "fallbackCounts": fallback_counts, "orderedWinningStart": winners, "units": units}


def gradient_check():
    rng = np.random.default_rng(1)
    z = rng.normal(size=300)
    zs = np.r_[rng.normal(2.5, 0.5, 6), rng.normal(1.5, 0.3, 4)]
    cs = np.minimum(zs, 1.2)
    ys = np.r_[np.ones(6), np.zeros(4)]
    worst = 0.0
    for _ in range(20):
        phi = np.array([rng.uniform(-1, 0.5), rng.uniform(*DELTA_BOUNDS), rng.uniform(0.3, 2), rng.uniform(0.5, 1.5), rng.uniform(0.01, 0.4)])
        _, g = ordered_negative_loglik(phi, z, zs, cs, ys)
        num = np.array([(ordered_negative_loglik(phi + e, z, zs, cs, ys)[0] - ordered_negative_loglik(phi - e, z, zs, cs, ys)[0]) / 2e-6
                        for e in np.eye(5) * 1e-6])
        worst = max(worst, float(np.max(np.abs(num - g) / np.maximum(1, np.abs(g)))))
    return worst


if __name__ == "__main__":
    grad_err = gradient_check()
    assert grad_err < 1e-5, grad_err
    protocols = {}
    for pr in ("window", "poolA", "poolB"):
        protocols[pr] = protocol_result(pr)
        print(f"{pr} done", file=sys.stderr, flush=True)
    status = {nm: "PASS" if all(protocols[pr]["pass"][nm] for pr in protocols) else "FAIL" for nm in CANDS}
    out = {
        "rule": {"file": "selection-rule.json", "sha256": sha(HERE / "selection-rule.json")},
        "evaluate": {"sha256": sha(Path(__file__)), "round7": sha(ROUND7)},
        "smoke": bool(SMOKE),
        "labels": {"collection": sha(ROOT / "labels.json"), "fresh": sha(ROOT / "fresh/labels.json"),
                   "fresh-2": sha(ROOT / "fresh-2/labels.json")},
        "environment": {"python": sys.version, "numpy": np.__version__, "scipy": scipy.__version__,
                        "sklearn": __import__("sklearn").__version__},
        "gradientCheckMaxRelError": grad_err,
        "status": status,
        "protocols": protocols,
    }
    json.dump(out, open(SMOKE or HERE / "results.json", "w"), indent=1)
    print(json.dumps({"status": status, "gradientCheckMaxRelError": grad_err,
                      **{pr: {"macroT11F": v["macroT11F"], "macroBrierSkill": v["macroBrierSkill"],
                              "intervals": v["intervalsVsBaselines"], "pass": v["pass"],
                              "fallbackCounts": v["fallbackCounts"], "orderedWinningStart": v["orderedWinningStart"]}
                         for pr, v in protocols.items()}}, indent=1))
