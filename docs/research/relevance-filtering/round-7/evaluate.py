"""Research round 7 of @zukhruf/relevance-filtering (#3195): a binormal fit that models
how the taught answers were selected (Zhang & Callan, SIGIR 2001).

Implements selection-rule.json (sha256 c615b539...) with round 6's frozen evaluate.py
(sha256 a9204fd6..., product teaching, with_keyword, load_slice) and, through it, round 2's
frozen evaluate.py (sha256 67ef588a..., binormal, platt_prob, plugin_threshold, metric_row,
topic_boot, collection loading). Run from round-7/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 python -I evaluate.py [--smoke OUT.json]
Never reads the exam. Writes results.json. With --smoke, every label list is replaced in
memory by random labels and the output goes to OUT.json instead.

Implementation choices fixed before the real run (the rule leaves them open):
- Pool protocols. poolA's teaching pool is the union of every labelled article of the
  collection (all 4,654, both of its date ranges) and of fresh (1,675); poolB's is the
  collection and fresh-2. The sets share no id. The score of a pool article is
  cos(article, d) with the round-2 description vector. Pool order (for stable ties) is
  the collection in round-2 order, then the slice in queue order. The scored stream is
  all of the other slice (fresh-2 for poolA, fresh for poolB).
- Window protocol. As round 6: pool = the slice's first 14 days, scored stream = the rest.
- The stream of both binormal fits is the scored stream: its scores set the mean and sd
  that standardise every score, and they are the unlabelled mixture term.
- Shown lists. List "top" = the top N pool articles by score; list "keyword" = the top N
  pool articles that match keywords.json narrow, by score. A list's cut-off c is the lowest
  standardised score among all the articles that list showed, ambiguous ones included
  (they were shown; the reader skipped them). An answered article in both lists takes the
  lower of the two cut-offs. Ambiguous shown articles enter no likelihood term.
- log(1 - Phi(x)) = scipy.special.log_ndtr(-x). The optimiser gets the analytic gradient of
  the negative log-likelihood (checked against finite differences in the smoke run); the
  start point is clipped to the bounds by L-BFGS-B itself. "The optimiser fails" means
  result.success is False.
- Fallback order for both candidates, as round 6: no relevant answer -> keyword matches;
  binormal unusable (frozen: r2.binormal returns None; truncated: failure or mu1 <= mu0)
  -> Platt on the taught scores (r2.platt_prob) when there is a not-relevant answer,
  otherwise keyword matches.
- Keyword evidence and plug-in threshold: round 6's with_keyword and r2.plugin_threshold.
- Each topic bootstrap call starts numpy.random.default_rng(31959) afresh, as round 6 did
  with its seed (r2.topic_boot(..., seed=31959)).
- Package reproduction check (not part of the rule): for poolA the frozen candidate is
  also summarised over the rehearsal's profile set (eval/run.ts examProtocol: profiles with
  >= 3 strict relevant fresh-2 articles, biology apart), to compare with the package's
  rehearsal (macro T11F 0.376 vs keywordNarrow 0.524, Brier skill -0.019).
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
from scipy.special import log_ndtr

SMOKE = None
if len(sys.argv) > 2 and sys.argv[1] == "--smoke":
    SMOKE = Path(sys.argv[2])

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ROUND6 = ROOT / "round-6/evaluate.py"
assert hashlib.sha256(ROUND6.read_bytes()).hexdigest().startswith("a9204fd6"), "round-6 evaluate.py changed"
spec = importlib.util.spec_from_file_location("round6", ROUND6)
r6 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r6)  # loads round 2 (asserts its sha256) and both fresh slices
r2 = r6.r2

CANDS = ["frozen", "truncated"]
BASES = r2.BASES
CELLS = [5, 10]
SEED = 31959
PROFILE_IDS = [p["id"] for p in r2.PROFILES]
LOG_ROOT_TWO_PI = 0.5 * math.log(2 * math.pi)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---------------------------------------------------------------- sets
def collection_set():
    labels = {}
    for p in PROFILE_IDS:
        labels[p] = r2.labels_of(p)
    return {"ids": r2.IDS, "x": r2.X, "text": r2.TEXT, "labels": labels, "window": None}


def slice_set(name):
    s = r6.DATA[name]
    labels = {p: (np.array([l.get(p, False) is True for l in s["labels"]]),
                  np.array([l.get(p, False) is None for l in s["labels"]])) for p in PROFILE_IDS}
    return {"ids": s["ids"], "x": s["x"], "text": s["text"], "labels": labels, "window": s["window"]}


SETS = {"collection": collection_set(), "fresh": slice_set("fresh"), "fresh-2": slice_set("fresh-2")}

if SMOKE:
    fake = np.random.default_rng(7)
    for st in SETS.values():
        n = len(st["ids"])
        for p in PROFILE_IDS:
            u = fake.random(n)
            st["labels"][p] = (u < 0.06, (u >= 0.06) & (u < 0.08))


def part(st, mask):
    idx = np.where(mask)[0]
    return {"ids": [st["ids"][i] for i in idx], "x": st["x"][idx], "text": [st["text"][i] for i in idx],
            "labels": {p: (r[idx], a[idx]) for p, (r, a) in st["labels"].items()}}


def concat(sets):
    return {"ids": sum((s["ids"] for s in sets), []), "x": np.vstack([s["x"] for s in sets]),
            "text": sum((s["text"] for s in sets), []),
            "labels": {p: (np.concatenate([s["labels"][p][0] for s in sets]),
                           np.concatenate([s["labels"][p][1] for s in sets])) for p in PROFILE_IDS}}


def whole(st):
    return part(st, np.ones(len(st["ids"]), bool))


# ---------------------------------------------------------------- truncated binormal
def log_normal(x, mu, sd):
    return -0.5 * ((x - mu) / sd) ** 2 - np.log(sd) - LOG_ROOT_TWO_PI


def negative_loglik(theta, z, zs, cs, ys):
    """Negative log-likelihood and its gradient over theta = (mu1, s1, mu0, s0, pi)."""
    mu1, s1, mu0, s0, pi = theta
    a1 = math.log(pi) + log_normal(z, mu1, s1)
    a0 = math.log(1 - pi) + log_normal(z, mu0, s0)
    mix = np.logaddexp(a1, a0)
    r = np.exp(a1 - mix)
    ll = float(mix.sum())
    g = np.array([
        np.sum(r * (z - mu1)) / s1 ** 2,
        np.sum(r * ((z - mu1) ** 2 / s1 ** 3 - 1 / s1)),
        np.sum((1 - r) * (z - mu0)) / s0 ** 2,
        np.sum((1 - r) * ((z - mu0) ** 2 / s0 ** 3 - 1 / s0)),
        np.sum(r / pi - (1 - r) / (1 - pi)),
    ])
    for comp, (mu, s) in ((1, (mu1, s1)), (0, (mu0, s0))):
        m = ys == comp
        if not m.any():
            continue
        zi, ci = zs[m], cs[m]
        a = (ci - mu) / s
        tail = log_ndtr(-a)
        ll += float(np.sum(log_normal(zi, mu, s) - tail))
        h = np.exp(-0.5 * a ** 2 - LOG_ROOT_TWO_PI - tail)
        dmu = np.sum((zi - mu) / s ** 2 - h / s)
        ds = np.sum((zi - mu) ** 2 / s ** 3 - 1 / s - h * a / s)
        k = 0 if comp == 1 else 2
        g[k] += dmu
        g[k + 1] += ds
    return -ll, -g


def truncated_binormal(stream_raw, shown_raw, shown_cut_raw, ys):
    """Returns (posterior of component 1 on the stream, params) or (None, reason)."""
    mean, sd = stream_raw.mean(), stream_raw.std()
    if sd == 0:
        return None, {"reason": "stream sd 0"}
    z = (stream_raw - mean) / sd
    zs = (shown_raw - mean) / sd
    cs = (shown_cut_raw - mean) / sd
    n = len(z)
    zp = zs[ys == 1]
    x0 = np.array([zp.mean(), max(zp.std(), 0.05), 0.0, 1.0, 0.05])
    bounds = [(-10, 10), (0.05, 10), (-10, 10), (0.05, 10), (1 / n, 0.5)]
    res = minimize(negative_loglik, x0, args=(z, zs, cs, ys), jac=True, method="L-BFGS-B", bounds=bounds,
                   options={"gtol": 1e-10, "maxiter": 10000})
    mu1, s1, mu0, s0, pi = (float(v) for v in res.x)
    params = {"mu1": mu1, "s1": s1, "mu0": mu0, "s0": s0, "pi": pi, "success": bool(res.success),
              "message": str(res.message), "nit": int(res.nit), "loglik": float(-res.fun)}
    if not res.success:
        return None, {**params, "reason": "optimiser failed"}
    if mu1 <= mu0:
        return None, {**params, "reason": "mu1 <= mu0"}
    l1 = math.log(pi) + log_normal(z, mu1, s1)
    l0 = math.log(1 - pi) + log_normal(z, mu0, s0)
    return np.exp(l1 - np.logaddexp(l1, l0)), params


# ---------------------------------------------------------------- one unit
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
    for name in CANDS:
        if not pos:
            score(name, k_s.astype(float), k_s); fallbacks[name] = "no relevant answer: keyword"
            continue
        if name == "frozen":
            fit = r2.binormal(raw, taught, ty)
            p, fits[name] = (fit[0], fit[1]) if fit else (None, {"reason": "r2.binormal None"})
        else:
            cuts = np.array([cut_of(i) for i in answered])
            p, fits[name] = truncated_binormal(raw, taught, cuts, ty)
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
            "scoredRelevant": int(s_rel.sum()), "strictRelevantStreamLabelled": int(y.sum()),
            "rows": rows, "fallbacks": fallbacks, "fits": fits}


# ---------------------------------------------------------------- protocols
def protocol_units(protocol):
    out = {p: {} for p in PROFILE_IDS}
    if protocol == "window":
        for sl in ("fresh", "fresh-2"):
            st = SETS[sl]
            pool, stream = part(st, st["window"]), part(st, ~st["window"])
            for p in PROFILE_IDS:
                for n in CELLS:
                    out[p][f"{sl}|{n}"] = unit_run(p, pool, stream, n)
    else:
        pool_slice, stream_slice = ("fresh", "fresh-2") if protocol == "poolA" else ("fresh-2", "fresh")
        pool = concat([whole(SETS["collection"]), whole(SETS[pool_slice])])
        stream = whole(SETS[stream_slice])
        for p in PROFILE_IDS:
            for n in CELLS:
                out[p][f"{stream_slice}|{n}"] = unit_run(p, pool, stream, n)
    return out


def summarise(units, use):
    """use(profile, unit) -> bool; returns the per-profile, macro and interval tables."""
    per_profile, skill_pp = {}, {}
    for p, us in units.items():
        used = [u for u in us.values() if use(p, u)]
        if used:
            per_profile[p] = {nm: float(np.mean([u["rows"][nm]["strict"]["f05"] for u in used])) for nm in CANDS + BASES}
            skill_pp[p] = {nm: float(np.nanmean([u["rows"][nm]["strict"]["brierSkill"] for u in used])) for nm in CANDS}
    scored = list(per_profile)
    macro = {nm: float(np.mean([per_profile[p][nm] for p in scored])) for nm in CANDS + BASES}
    skill = {nm: float(np.mean([skill_pp[p][nm] for p in scored])) for nm in CANDS}
    return scored, per_profile, skill_pp, macro, skill


def protocol_result(protocol):
    units = protocol_units(protocol)
    scored, per_profile, skill_pp, macro, skill = summarise(units, lambda p, u: u["scoredRelevant"] >= 15)
    intervals = {nm: {b: r2.topic_boot(per_profile, scored, nm, b, seed=SEED) for b in BASES} for nm in CANDS}
    passes = {nm: bool(intervals[nm]["keywordNarrow"][0] > -0.05
                       and all(intervals[nm][b][0] > 0 for b in ("keywordBroad", "alwaysNo", "alwaysYes"))
                       and skill[nm] > 0) for nm in CANDS}
    fallback_counts = {nm: {} for nm in CANDS}
    for p, us in units.items():
        for u in us.values():
            for nm in CANDS:
                reason = u["fallbacks"].get(nm, "none")
                key = f"{'scored' if u['scoredRelevant'] >= 15 else 'unscored'}|{reason}"
                fallback_counts[nm][key] = fallback_counts[nm].get(key, 0) + 1
    truncated_reasons = {}
    for us in units.values():
        for u in us.values():
            f = u["fits"].get("truncated")
            if f and "reason" in f:
                k = f"{f['reason']}: {f.get('message', '')}"
                truncated_reasons[k] = truncated_reasons.get(k, 0) + 1
    result = {"scoredProfiles": scored, "perProfileT11F": per_profile, "perProfileBrierSkill": skill_pp,
              "macroT11F": macro, "macroBrierSkill": skill, "intervalsVsBaselines": intervals, "pass": passes,
              "fallbackCounts": fallback_counts, "truncatedFitFailures": truncated_reasons, "units": units}
    if protocol == "poolA":
        rehearsal = lambda p, u: p != "biology" and u["strictRelevantStreamLabelled"] >= 3
        rs, rpp, _, rmacro, rskill = summarise(units, rehearsal)
        result["packageRehearsalView"] = {"profiles": rs, "macroT11F": rmacro, "macroBrierSkill": rskill,
                                          "perProfileT11F": rpp}
    return result


def gradient_check():
    rng = np.random.default_rng(1)
    z = rng.normal(size=300)
    zs = np.r_[rng.normal(2.5, 0.5, 6), rng.normal(1.5, 0.3, 4)]
    cs = np.minimum(zs, 1.2)
    ys = np.r_[np.ones(6), np.zeros(4)]
    worst = 0.0
    for _ in range(20):
        th = np.array([rng.uniform(0.5, 3), rng.uniform(0.3, 2), rng.uniform(-1, 0.5), rng.uniform(0.5, 1.5), rng.uniform(0.01, 0.4)])
        _, g = negative_loglik(th, z, zs, cs, ys)
        num = np.array([(negative_loglik(th + e, z, zs, cs, ys)[0] - negative_loglik(th - e, z, zs, cs, ys)[0]) / 2e-6
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
        "evaluate": {"sha256": sha(Path(__file__))},
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
    print(json.dumps({"status": status, **{pr: {"macroT11F": v["macroT11F"], "macroBrierSkill": v["macroBrierSkill"],
                                                "vsKeywordNarrow": {nm: v["intervalsVsBaselines"][nm]["keywordNarrow"] for nm in CANDS},
                                                "pass": v["pass"], "truncatedFitFailures": v["truncatedFitFailures"]}
                                           for pr, v in protocols.items()},
                      "rehearsalView": protocols["poolA"]["packageRehearsalView"]["macroT11F"]}, indent=1))
