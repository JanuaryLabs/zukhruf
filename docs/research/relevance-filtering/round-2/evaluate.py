"""Research round 2 of @zukhruf/relevance-filtering (#3195).

Implements selection-rule.json (sha256 d4913ede...) word for word. Run from round-2/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 python -I evaluate.py [labels.json]
Reads the collection, its labels, the reused article vectors and descriptions.json.
Never reads the exam. Writes results.json.

Implementation choices fixed before any label was read (the rule leaves them open):
- Draw order per (profile, cell, draw): relevant first, then near misses, then plain
  negatives, each rng.choice(len(pool), k, replace=False) on the id-sorted pool.
- binormal starts with pi = 0.05.
- Average precision ranks labelled stream articles by the method's raw score, ties by
  collection order.
"""
import hashlib
import json
import math
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BIOLOGY = ROOT.parent / "relevance-biology"
LABELS = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "labels.json"

CELLS = [(3, 3), (3, 10), (10, 3), (10, 10)]
DRAWS = 50
METHODS = ["desc", "rocchio", "rocchio-q0", "knn", "probe"]
CALIBS = ["platt", "platt+em", "binormal"]
CANDS = [f"{m}|{c}" for m in METHODS for c in CALIBS if (m, c) != ("knn", "binormal")]
BASES = ["alwaysNo", "alwaysYes", "keywordNarrow", "keywordBroad"]
C_GRID = [0.01, 0.1, 1, 10, 100, 1000]
CHECK_CELL, CHECK_DRAW = (10, 3), 0


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def unit(rows):
    v = np.array(rows, dtype=np.float64)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


# ---------------------------------------------------------------- data
rule = json.loads((HERE / "selection-rule.json").read_text())
PROFILES = json.loads((ROOT / "profiles.json").read_text())["profiles"]
KEYWORDS = json.loads((ROOT / "keywords.json").read_text())["baselines"]
ITEMS = json.loads((ROOT / "collection/items.json").read_text())
ITEMS.sort(key=lambda i: i["q"])
IDS = [i["id"] for i in ITEMS]
TEACH = np.array([i["publishedAt"] < "2026-06-01" for i in ITEMS])
TEXT = [f"{i['title']} {i['lead']}" for i in ITEMS]

vectors = {r["id"]: r["vector"] for r in json.loads((BIOLOGY / "pooled/vectors.json").read_text())["rows"]}
round1 = json.loads((BIOLOGY / "round-1/vectors.json").read_text())["rows"]
for r in round1:
    if r["set"] in ("realistic", "enriched"):
        assert r["id"] not in vectors or r["set"] == "enriched", r["id"]
        vectors.setdefault(r["id"], r["vector"])
missing = [i for i in IDS if i not in vectors]
assert not missing, f"{len(missing)} collection articles have no vector"
X = unit([vectors[i] for i in IDS])
DESC = {r["id"]: unit(r["vector"]) for r in json.loads((HERE / "descriptions.json").read_text())["rows"]}

extra_labels = json.loads((BIOLOGY / "training-extra/labels.json").read_text())
assert sha(BIOLOGY / "training-extra/labels.json").startswith("7c89b068")
enriched = {r["id"]: r["vector"] for r in round1 if r["set"] == "enriched"}
BIO_POS = sorted(r["id"] for r in extra_labels if r["relevant"] is True)
BIO_POS_X = unit([enriched[i] for i in BIO_POS])

label_rows = {r["q"]: r for r in json.loads(LABELS.read_text())}
assert sorted(label_rows) == [i["q"] for i in ITEMS], "labels must cover the collection exactly"


def labels_of(profile):
    value = [label_rows[i["q"]]["labels"].get(profile, False) for i in ITEMS]
    return np.array([v is True for v in value]), np.array([v is None for v in value])


# ---------------------------------------------------------------- round-1 code, verbatim
def platt_fit(f, y):
    """Platt (1999) with smoothed targets; Newton with line search (Lin, Lin & Weng 2007)."""
    n_pos, n_neg = y.sum(), (1 - y).sum()
    t = np.where(y == 1, (n_pos + 1) / (n_pos + 2), 1 / (n_neg + 2))
    A, B_ = 0.0, math.log((n_neg + 1) / (n_pos + 1))

    def loss(A, B_):
        z = A * f + B_
        return np.sum(t * np.logaddexp(0, z) + (1 - t) * np.logaddexp(0, -z))
    cur = loss(A, B_)
    for _ in range(1000):
        z = A * f + B_
        p = 1 / (1 + np.exp(z))
        d1 = t - p
        gA, gB = np.sum(d1 * f), np.sum(d1)
        if math.hypot(gA, gB) < 1e-12:
            break
        h = p * (1 - p) + 1e-12
        H = np.array([[np.sum(h * f * f) + 1e-12, np.sum(h * f)], [np.sum(h * f), np.sum(h) + 1e-12]])
        dA, dB = np.linalg.solve(H, -np.array([gA, gB]))
        step = 1.0
        while step > 1e-12:
            nA, nB = A + step * dA, B_ + step * dB
            new = loss(nA, nB)
            if new < cur + 1e-4 * step * (gA * dA + gB * dB):
                break
            step /= 2
        if step <= 1e-12:
            break
        A, B_, cur = nA, nB, new
    return A, B_


def platt_apply(A, B_, f):
    return 1 / (1 + np.exp(A * f + B_))


def saerens(p, pi_t):
    pi = pi_t
    for _ in range(10000):
        a = (pi / pi_t) * p
        q = a / (a + ((1 - pi) / (1 - pi_t)) * (1 - p))
        new = q.mean()
        if abs(new - pi) < 1e-9:
            pi = new
            break
        pi = new
    a = (pi / pi_t) * p
    return a / (a + ((1 - pi) / (1 - pi_t)) * (1 - p)), pi


def plugin_threshold(p):
    """Accept mask maximising expected F0.5 over the probabilities themselves."""
    order = np.sort(p)[::-1]
    cum = np.cumsum(order)
    m = np.arange(1, len(p) + 1)
    ef = 1.25 * cum / (0.25 * order.sum() + m)
    best = int(np.argmax(ef))
    if ef[best] <= 0:
        return np.zeros(len(p), bool), 1.0
    thr = order[best]
    return p >= thr, float(thr)


def counts(dec, y):
    tp = float((dec & y).sum()); fp = float((dec & ~y).sum()); fn = float((~dec & y).sum())
    return tp, fp, fn


def f05(tp, fp, fn):
    return 0.0 if tp == 0 else 1.25 * tp / (1.25 * tp + 0.25 * fn + fp)


def t11su(tp, fp, fn):
    if tp + fn == 0:
        return float("nan")
    nu = (2 * tp - fp) / (2 * (tp + fn))
    return (max(nu, -0.5) + 0.5) / 1.5


def ece(p, y, bins=10):
    idx = np.minimum((p * bins).astype(int), bins - 1)
    e = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return e


def metric_row(dec, p, y):
    tp, fp, fn = counts(dec, y)
    yf = y.astype(float)
    clim = yf.mean() * (1 - yf.mean())
    brier = float(np.mean((p - yf) ** 2))
    return {
        "f05": f05(tp, fp, fn), "t11su": t11su(tp, fp, fn),
        "precision": tp / (tp + fp) if tp + fp else 0.0, "recall": tp / (tp + fn) if tp + fn else 0.0,
        "brier": brier, "brierSkill": 1 - brier / clim if clim > 0 else float("nan"),
        "ece": ece(p, yf), "accepted": int(dec.sum()), "tp": int(tp), "fp": int(fp), "fn": int(fn),
    }


# ---------------------------------------------------------------- round-2 methods
def fit_score(method, pos, neg, d):
    """Train on taught vectors (+ d); return the raw score function."""
    if method == "desc":
        return lambda Z: Z @ d
    if method == "rocchio":
        q = pos.mean(0) - 0.25 * neg.mean(0)
        q = q / np.linalg.norm(q)
        return lambda Z: Z @ q
    if method == "rocchio-q0":
        q = 8 * d + 16 * pos.mean(0) - 4 * neg.mean(0)
        q = q / np.linalg.norm(q)
        return lambda Z: Z @ q
    if method == "knn":
        T = np.vstack([pos, d[None], neg])
        y = np.r_[np.ones(len(pos) + 1), np.zeros(len(neg))]

        def raw(Z):
            S = Z @ T.T
            k = min(3, T.shape[0])
            top = np.argsort(-S, axis=1, kind="stable")[:, :k]
            s = np.maximum(np.take_along_axis(S, top, 1), 0)
            num = (s * y[top]).sum(1)
            den = s.sum(1)
            return np.where(den > 0, num / np.where(den > 0, den, 1), 0.0)
        return raw
    raise ValueError(method)


def probe_fit(pos, neg, d, C):
    T = np.vstack([pos, d[None], neg])
    y = np.r_[np.ones(len(pos) + 1), np.zeros(len(neg))]
    m = LogisticRegression(C=C, solver="lbfgs", max_iter=10000, tol=1e-10).fit(T, y)
    w, b = m.coef_[0], m.intercept_[0]
    return lambda Z: Z @ w + b


def loo_scores(method, pos, neg, d, C=None):
    """Score of each taught article by the method trained on the other taught articles plus d."""
    out = np.zeros(len(pos) + len(neg))
    for j in range(len(out)):
        P = np.delete(pos, j, 0) if j < len(pos) else pos
        N = np.delete(neg, j - len(pos), 0) if j >= len(pos) else neg
        x = pos[j] if j < len(pos) else neg[j - len(pos)]
        f = probe_fit(P, N, d, C) if method == "probe" else fit_score(method, P, N, d)
        out[j] = f(x[None])[0]
    return out


def probe_choose(pos, neg, d):
    """C by the lowest leave-one-out log loss on the taught set (ties: smaller C)."""
    y = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
    best = None
    for C in C_GRID:
        f = loo_scores("probe", pos, neg, d, C)
        loss = float(np.mean(y * np.logaddexp(0, -f) + (1 - y) * np.logaddexp(0, f)))
        if best is None or loss < best[1] - 1e-15:
            best = (C, loss, f)
    return best


def auc(f, y):
    a, b = f[y == 1], f[y == 0]
    return float(np.mean([(u > v) + 0.5 * (u == v) for u in a for v in b]))


def platt_prob(loo, y, stream_raw):
    if auc(loo, y) <= 0.5:
        n_pos, n_neg = y.sum(), (1 - y).sum()
        t = np.where(y == 1, (n_pos + 1) / (n_pos + 2), 1 / (n_neg + 2))
        return np.full(len(stream_raw), t.mean()), None
    A, B_ = platt_fit(loo, y)
    return platt_apply(A, B_, stream_raw), (A, B_)


def log_normal(x, mu, sd):
    return -0.5 * ((x - mu) / sd) ** 2 - math.log(sd) - 0.5 * math.log(2 * math.pi)


def binormal(stream_raw, loo, y):
    """Semi-supervised two-normal EM; None when the fit cannot hold (falls back to platt)."""
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
        l1, l0 = log_normal(z, mu1, s1), log_normal(z, mu0, s0)
        logit = math.log(pi) + l1 - math.log(1 - pi) - l0
        r = 0.5 * (1 + np.tanh(logit / 2))
        ll = float(np.sum(np.logaddexp(math.log(pi) + l1, math.log(1 - pi) + l0))
                   + log_normal(zp, mu1, s1).sum() + log_normal(zn, mu0, s0).sum())
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
    l1, l0 = log_normal(z, mu1, s1), log_normal(z, mu0, s0)
    return 0.5 * (1 + np.tanh((math.log(pi) + l1 - math.log(1 - pi) - l0) / 2)), {"pi": pi, "mu1": mu1, "s1": s1, "mu0": mu0, "s0": s0}


def average_precision(score, y):
    order = np.argsort(-score, kind="stable")
    hits = y[order]
    if hits.sum() == 0:
        return float("nan")
    precision = np.cumsum(hits) / np.arange(1, len(hits) + 1)
    return float(precision[hits].mean())


# ---------------------------------------------------------------- one profile
def draw_taught(pi, profile, k_rel, k_non, d, pos_pool, near_pool, plain_pool):
    rng = np.random.default_rng([3195, 2, pi, k_rel, k_non, d])
    pos = pos_pool[rng.choice(len(pos_pool), k_rel, replace=False)]
    a = min(math.ceil(k_non / 2), len(near_pool))
    b = min(k_non - a, len(plain_pool))
    a = k_non - b
    near = near_pool[rng.choice(len(near_pool), a, replace=False)]
    plain = plain_pool[rng.choice(len(plain_pool), b, replace=False)]
    return pos, np.r_[near, plain].astype(int)


def run_profile(pi):
    profile = PROFILES[pi]["id"]
    rel, amb = labels_of(profile)
    narrow = np.array([re.search(KEYWORDS[profile]["narrow"], t, re.I) is not None for t in TEXT])
    broad = np.array([re.search(KEYWORDS[profile]["broad"], t, re.I) is not None for t in TEXT])
    d = DESC[profile]
    test = np.where(~TEACH)[0]
    lab = ~amb[test]
    y = rel[test][lab]
    yamb = rel[test] | amb[test]
    order_ids = np.argsort(np.array(IDS, dtype=object), kind="stable")
    sorted_teach = [i for i in order_ids if TEACH[i]]
    neg_teach = [i for i in sorted_teach if not rel[i] and not amb[i]]
    near_pool = np.array([i for i in neg_teach if broad[i]], int)
    plain_pool = np.array([i for i in neg_teach if not broad[i]], int)
    if profile == "biology":
        pos_pool_x = BIO_POS_X
        pos_ids = BIO_POS
    else:
        pos_idx = [i for i in sorted_teach if rel[i]]
        pos_pool_x = X[pos_idx] if pos_idx else np.zeros((0, X.shape[1]))
        pos_ids = [IDS[i] for i in pos_idx]
    counts_info = {
        "teachRelevant": int(rel[TEACH].sum()), "teachAmbiguous": int(amb[TEACH].sum()),
        "testRelevant": int(rel[~TEACH].sum()), "testAmbiguous": int(amb[~TEACH].sum()),
        "testLabelled": int(lab.sum()), "relevantPool": len(pos_ids),
        "nearMisses": len(near_pool), "plainNegatives": len(plain_pool),
    }
    out = {"profile": profile, "counts": counts_info, "rows": {}, "reliability": {}, "cv": {}, "check": None}
    names = CANDS + BASES
    decisions = {n: np.zeros((len(CELLS) * DRAWS, len(test)), bool) for n in names}
    rows = {(n, v): [] for n in names for v in ("strict", "ambiguousRelevant")}
    ap = {m: [] for m in METHODS}
    sens = {n: [] for n in CANDS}
    reliab = {n: np.zeros((10, 3)) for n in CANDS}
    cv = {n: {"fallback": 0, "platt-flat": 0, "C": [], "prior": []} for n in CANDS}
    climatology = float(y.mean())

    def score(name, row_i, p, dec):
        decisions[name][row_i] = dec
        rows[(name, "strict")].append(metric_row(dec[lab], p[lab], y))
        rows[(name, "ambiguousRelevant")].append(metric_row(dec, p, yamb))

    Xtest = X[test]
    for ci, (k_rel, k_non) in enumerate(CELLS):
        if len(pos_ids) < k_rel:
            continue
        for dr in range(DRAWS):
            row_i = ci * DRAWS + dr
            pos_sel, neg_idx = draw_taught(pi, profile, k_rel, k_non, dr, np.arange(len(pos_ids)), near_pool, plain_pool)
            P, N = pos_pool_x[pos_sel], X[neg_idx]
            ty = np.r_[np.ones(k_rel), np.zeros(k_non)]
            n = len(test)
            score("alwaysNo", row_i, np.zeros(n), np.zeros(n, bool))
            score("alwaysYes", row_i, np.ones(n), np.ones(n, bool))
            score("keywordNarrow", row_i, narrow[test].astype(float), narrow[test])
            score("keywordBroad", row_i, broad[test].astype(float), broad[test])
            pi_t = (k_rel + 1) / (k_rel + k_non + 1)
            for m in METHODS:
                if m == "probe":
                    C, _, loo = probe_choose(P, N, d)
                    raw = probe_fit(P, N, d, C)(Xtest)
                else:
                    C, loo = None, loo_scores(m, P, N, d)
                    raw = fit_score(m, P, N, d)(Xtest)
                ap[m].append(average_precision(raw[lab], y))
                platt_p, platt_ab = platt_prob(loo, ty, raw)
                em_p, pi_hat = saerens(platt_p, pi_t)
                probs = {"platt": platt_p, "platt+em": em_p}
                fit = binormal(raw, loo, ty) if m != "knn" else None
                if m != "knn":
                    probs["binormal"] = fit[0] if fit else platt_p
                for c in CALIBS:
                    name = f"{m}|{c}"
                    if name not in CANDS:
                        continue
                    p = probs[c]
                    dec, thr = plugin_threshold(p)
                    score(name, row_i, p, dec)
                    sens[name].append(f05(*counts((p >= 0.5)[lab], y)))
                    idx = np.minimum((p[lab] * 10).astype(int), 9)
                    for b in range(10):
                        mb = idx == b
                        reliab[name][b] += [p[lab][mb].sum(), y[mb].sum(), mb.sum()]
                    cv[name]["platt-flat"] += platt_ab is None
                    cv[name]["prior"].append(float(pi_hat) if c == "platt+em" else (fit[1]["pi"] if c == "binormal" and fit else None))
                    if c == "binormal" and not fit:
                        cv[name]["fallback"] += 1
                    if C is not None:
                        cv[name]["C"].append(C)
                    if (k_rel, k_non) == CHECK_CELL and dr == CHECK_DRAW and profile == "security":
                        out["check"] = out["check"] or {"profile": profile, "cell": CHECK_CELL, "draw": CHECK_DRAW,
                                                        "taught": {"relevant": [pos_ids[i] for i in pos_sel], "notRelevant": [IDS[i] for i in neg_idx]},
                                                        "candidates": {}}
                        out["check"]["candidates"][name] = {
                            "threshold": thr, "C": C, "platt": platt_ab, "binormal": fit[1] if (c == "binormal" and fit) else None,
                            "articles": {IDS[test[j]]: [float(p[j]), bool(dec[j])] for j in range(0, len(test), 97)},
                        }
    for (name, v), rs in rows.items():
        if rs:
            out["rows"][f"{name}|{v}"] = {k: float(np.nanmean([r[k] for r in rs])) for k in rs[0]}
    out["f05PerDraw"] = {n: [r["f05"] for r in rows[(n, "strict")]] for n in names}
    out["ap"] = {m: float(np.nanmean(v)) if v else float("nan") for m, v in ap.items()}
    out["sensitivityBayes05"] = {n: float(np.mean(v)) if v else float("nan") for n, v in sens.items()}
    out["reliability"] = {n: r.tolist() for n, r in reliab.items()}
    out["cv"] = {n: {"fallback": c["fallback"], "plattFlat": c["platt-flat"],
                     "C": {str(k): c["C"].count(k) for k in C_GRID} if c["C"] else None,
                     "meanPrior": float(np.mean([x for x in c["prior"] if x is not None])) if any(x is not None for x in c["prior"]) else None}
                 for n, c in cv.items()}
    out["climatology"] = climatology
    np.savez_compressed(HERE / f"decisions/{profile}.npz", **{n.replace("|", "__"): np.packbits(decisions[n], axis=1) for n in names},
                        test=test, y=rel[test], amb=amb[test])
    print(f"{profile} done", file=sys.stderr, flush=True)
    return out


# ---------------------------------------------------------------- choice
def topic_boot(per_profile, scored, a, b, reps=2000, seed=31952):
    rng = np.random.default_rng(seed)
    diff = np.array([per_profile[p][a] - per_profile[p][b] for p in scored])
    stats = [diff[rng.integers(0, len(diff), len(diff))].mean() for _ in range(reps)]
    return [float(np.percentile(stats, 2.5)), float(np.percentile(stats, 97.5))]


def complexity(name):
    m, c = name.split("|")
    return (METHODS.index(m) + CALIBS.index(c), METHODS.index(m))


if __name__ == "__main__":
    (HERE / "decisions").mkdir(exist_ok=True)
    with ProcessPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(run_profile, range(len(PROFILES))))
    by = {r["profile"]: r for r in results}
    scored = [r["profile"] for r in results
              if r["counts"]["teachRelevant"] >= 10 and r["counts"]["testRelevant"] >= 20 and r["profile"] != "biology"]
    per_profile = {p: {n: by[p]["rows"][f"{n}|strict"]["f05"] for n in CANDS + BASES} for p in scored}
    skill = {n: float(np.mean([by[p]["rows"][f"{n}|strict"]["brierSkill"] for p in scored])) for n in CANDS}
    macro = {n: float(np.mean([per_profile[p][n] for p in scored])) for n in CANDS + BASES} if scored else {}
    eligible, intervals = [], {}
    for n in CANDS:
        intervals[n] = {b: topic_boot(per_profile, scored, n, b) for b in BASES} if len(scored) > 1 else {}
        if intervals[n] and all(iv[0] > 0 for iv in intervals[n].values()) and skill[n] > 0:
            eligible.append(n)
    best = max(eligible, key=lambda n: macro[n]) if eligible else None
    chosen, simpler = best, {}
    if best:
        for n in eligible:
            if complexity(n) < complexity(best):
                iv = topic_boot(per_profile, scored, n, best)
                simpler[n] = iv
        ok = [n for n, iv in simpler.items() if iv[0] <= 0 <= iv[1]]
        if ok:
            chosen = min(ok, key=complexity)
    json.dump({
        "rule": {"file": "selection-rule.json", "sha256": sha(HERE / "selection-rule.json")},
        "labels": {"file": str(LABELS), "sha256": sha(LABELS)},
        "environment": {"python": sys.version, "numpy": np.__version__, "sklearn": __import__("sklearn").__version__},
        "scoredProfiles": scored, "macroF05": macro, "macroBrierSkill": skill,
        "intervalsVsBaselines": intervals, "eligible": eligible, "best": best,
        "simplerVsBest": simpler, "chosen": chosen, "profiles": by,
    }, open(HERE / "results.json", "w"), indent=1)
    print(json.dumps({"scored": scored, "eligible": eligible, "best": best, "chosen": chosen}))
