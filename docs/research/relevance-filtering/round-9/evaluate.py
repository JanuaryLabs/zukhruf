"""Research round 9 of @zukhruf/relevance-filtering (#3195): confirm round 7's truncated
design on a third fresh slice (fresh-3, 2025-07-01..2025-09-30).

Implements selection-rule.json (sha256 6909823c...) on round 7's frozen evaluate.py
(sha256 8c5f7960...: sets, part/concat/whole, truncated_binormal), which reuses round 6
(a9204fd6...: with_keyword) and round 2 (67ef588a...: binormal, platt_prob,
plugin_threshold, metric_row, topic_boot). Run from round-9/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 python -I evaluate.py [--smoke OUT.json]
Never reads the exam. Writes results.json. With --smoke, fresh-3/labels.json is not read:
fresh-3 gets random labels made in memory (rng 9, p(relevant) 0.06, p(ambiguous) 0.02),
--smoke is passed on to round 7's module (random labels for the other sets, rng 7), and the
output goes to OUT.json.

Implementation choices fixed before the real run (the rule leaves them open):
- fresh-3 is read from items.json (titles, leads, dates, q) and vectors.json (asserted
  sha256 3067aa5e...); the item ids are asserted equal to articles.json (sha256 1d824357...).
  Sorted by q, as round 6's load_slice. Labels: fresh-3/labels.json, same format as
  fresh-2 (q, labels{profile: true|false|null}, a missing profile is false); its q set must
  equal the items' q set. Its sha256 is recorded in results.json.
- Window protocol: pool = fresh-3 articles published before 2025-07-15T00:00 (first 14
  days, string compare on publishedAt as round 6), scored stream = the rest of fresh-3.
- Pool protocol: pool = every article of collection, then fresh, then fresh-2 (round 7's
  sets, in that order for stable ties); scored stream = all of fresh-3. fresh-3 shares no
  id with them (checked at load).
- Everything else as round 7's docstring: scored stream as the binormal stream, list
  cut-offs (ambiguous shown articles count, an article in both lists takes the lower
  cut-off), log_ndtr, success = result.success, with_keyword, plug-in threshold.
- Candidates and fallbacks (no relevant answer -> keyword matches for all three):
  frozen: r2.binormal; None -> Platt if a not-relevant answer, else keyword.
  truncated: r7.truncated_binormal; failure or mu1 <= mu0 -> Platt if a not-relevant
    answer, else keyword (round 7 exactly).
  truncated-guard: r7.truncated_binormal; failure or mu1 <= mu0 -> r2.binormal; None ->
    Platt if a not-relevant answer, else keyword.
- Units: a (profile, stream) unit is scored when its stream has >= 15 strict relevant
  articles; profile score = mean over its units (both N); macro over scored profiles.
- Each topic bootstrap call starts numpy.random.default_rng(31961) afresh, as rounds 6-8.
- Choice: candidates passing both protocols; if both truncated candidates pass,
  'truncated' (simpler). 'frozen' is a reference and is reported, not chosen.
- unit_run is a third copy of round 7's (round 8 has the second); frozen files cannot be
  edited, so it is copied, not extracted.
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

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ROUND7 = ROOT / "round-7/evaluate.py"
F3 = ROOT / "fresh-3"
assert hashlib.sha256(ROUND7.read_bytes()).hexdigest().startswith("8c5f7960"), "round-7 evaluate.py changed"
SMOKE = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--smoke" else None
spec = importlib.util.spec_from_file_location("round7", ROUND7)
r7 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r7)  # reads sys.argv for --smoke itself
assert bool(r7.SMOKE) == bool(SMOKE)
r6, r2 = r7.r6, r7.r2

CANDS = ["truncated", "truncated-guard", "frozen"]
CHOOSABLE = ["truncated", "truncated-guard"]
BASES = r2.BASES
CELLS = r7.CELLS
SEED = 31961
PROFILE_IDS = r7.PROFILE_IDS
WINDOW_CUT = "2025-07-15"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---------------------------------------------------------------- fresh-3
def fresh3_set():
    assert sha(F3 / "vectors.json").startswith("3067aa5e"), "fresh-3 vectors changed"
    assert sha(F3 / "articles.json").startswith("1d824357"), "fresh-3 articles changed"
    items = sorted(json.loads((F3 / "items.json").read_text()), key=lambda i: i["q"])
    ids = [i["id"] for i in items]
    assert sorted(ids) == sorted(a["id"] for a in json.loads((F3 / "articles.json").read_text()))
    others = {i for name in ("collection", "fresh", "fresh-2") for i in r7.SETS[name]["ids"]}
    assert not others & set(ids), "fresh-3 overlaps an earlier set"
    vectors = {r["id"]: r["vector"] for r in json.loads((F3 / "vectors.json").read_text())["rows"]}
    st = {"ids": ids, "x": r2.unit([vectors[i] for i in ids]), "text": [f"{i['title']} {i['lead']}" for i in items],
          "window": np.array([i["publishedAt"] < WINDOW_CUT for i in items])}
    if SMOKE:
        fake = np.random.default_rng(9)
        st["labels"] = {}
        for p in PROFILE_IDS:
            u = fake.random(len(ids))
            st["labels"][p] = (u < 0.06, (u >= 0.06) & (u < 0.08))
        st["labelsSha256"] = None
    else:
        rows = {r["q"]: r["labels"] for r in json.loads((F3 / "labels.json").read_text())}
        assert sorted(rows) == [i["q"] for i in items], "fresh-3 labels must cover fresh-3 exactly"
        lab = [rows[i["q"]] for i in items]
        st["labels"] = {p: (np.array([l.get(p, False) is True for l in lab]),
                            np.array([l.get(p, False) is None for l in lab])) for p in PROFILE_IDS}
        st["labelsSha256"] = sha(F3 / "labels.json")
    return st


FRESH3 = fresh3_set()


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
    cuts = np.array([cut_of(i) for i in answered])
    truncated_fit = r7.truncated_binormal(raw, taught, cuts, ty) if pos else (None, {})
    em_fit = r2.binormal(raw, taught, ty) if pos else None
    for name in CANDS:
        if not pos:
            score(name, k_s.astype(float), k_s); fallbacks[name] = "no relevant answer: keyword"
            continue
        if name == "frozen":
            p = em_fit[0] if em_fit else None
            fits[name] = em_fit[1] if em_fit else {"reason": "r2.binormal None"}
        else:
            p, fits[name] = truncated_fit
            if p is None and name == "truncated-guard" and em_fit:
                p, fallbacks[name] = em_fit[0], "round-2 EM"
                fits[name] = {**fits[name], "em": em_fit[1]}
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
    out = {p: {} for p in PROFILE_IDS}
    if protocol == "window":
        pool, stream = r7.part(FRESH3, FRESH3["window"]), r7.part(FRESH3, ~FRESH3["window"])
    else:
        pool = r7.concat([r7.whole(r7.SETS[s]) for s in ("collection", "fresh", "fresh-2")])
        stream = r7.whole(FRESH3)
    for p in PROFILE_IDS:
        for n in CELLS:
            out[p][f"fresh-3|{n}"] = unit_run(p, pool, stream, n)
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
    for us in units.values():
        for u in us.values():
            group = "scored" if u["scoredRelevant"] >= 15 else "unscored"
            for nm in CANDS:
                key = f"{group}|{u['fallbacks'].get(nm, 'none')}"
                fallback_counts[nm][key] = fallback_counts[nm].get(key, 0) + 1
    return {"scoredProfiles": scored, "perProfileT11F": per_profile, "perProfileBrierSkill": skill_pp,
            "macroT11F": macro, "macroBrierSkill": skill, "intervalsVsBaselines": intervals, "pass": passes,
            "fallbackCounts": fallback_counts, "units": units}


if __name__ == "__main__":
    protocols = {}
    for pr in ("window", "pool"):
        protocols[pr] = protocol_result(pr)
        print(f"{pr} done", file=sys.stderr, flush=True)
    status = {nm: "PASS" if all(protocols[pr]["pass"][nm] for pr in protocols) else "FAIL" for nm in CANDS}
    passing = [nm for nm in CHOOSABLE if status[nm] == "PASS"]
    chosen = "truncated" if "truncated" in passing else (passing[0] if passing else None)
    out = {
        "rule": {"file": "selection-rule.json", "sha256": sha(HERE / "selection-rule.json")},
        "evaluate": {"sha256": sha(Path(__file__)), "round7": sha(ROUND7)},
        "smoke": bool(SMOKE),
        "labels": {"collection": sha(ROOT / "labels.json"), "fresh": sha(ROOT / "fresh/labels.json"),
                   "fresh-2": sha(ROOT / "fresh-2/labels.json"), "fresh-3": FRESH3["labelsSha256"]},
        "fresh3": {"articles": sha(F3 / "articles.json"), "items": sha(F3 / "items.json"), "vectors": sha(F3 / "vectors.json"),
                   "windowArticles": int(FRESH3["window"].sum()), "streamArticles": int((~FRESH3["window"]).sum())},
        "environment": {"python": sys.version, "numpy": np.__version__, "scipy": scipy.__version__,
                        "sklearn": __import__("sklearn").__version__},
        "status": status,
        "chosen": chosen,
        "protocols": protocols,
    }
    json.dump(out, open(SMOKE or HERE / "results.json", "w"), indent=1)
    print(json.dumps({"status": status, "chosen": chosen,
                      **{pr: {"scored": v["scoredProfiles"], "macroT11F": v["macroT11F"], "macroBrierSkill": v["macroBrierSkill"],
                              "intervals": v["intervalsVsBaselines"], "pass": v["pass"], "fallbackCounts": v["fallbackCounts"]}
                         for pr, v in protocols.items()}}, indent=1))
