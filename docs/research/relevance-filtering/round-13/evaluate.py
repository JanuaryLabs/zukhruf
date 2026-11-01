"""Research round 13 of @zukhruf/relevance-filtering (#3383, judge step): Liquid AI's
d1-2B decision model as a scorer.

Implements selection-rule.json (sha256 d9e0d341...) on round 12's frozen evaluate.py
(sha256 d4537eb0...: pool, test stream, product teaching, orders of desc+kw / hybrid /
hybrid-rocchio / keywordNarrow / keywordBroad / newest, daily(), and through it round 10's
average_precision and round 6's with_keyword, round 2's metric_row and topic_boot).
Run from round-13/ after round 12's real run:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 --with nltk==3.9.2 python -I evaluate.py [--smoke OUT.json ANSWERS.json]
Never reads the exam. Reads d1-answers.json (collect.py, frozen before fresh-5's labels).
With --smoke, round 12's module runs its own smoke mode (fresh-4 stands in for the test
slice, random in-memory labels), the answers come from ANSWERS.json, and the output goes
to OUT.json.

Implementation choices fixed before the real run (the rule leaves them open):
- p_d1 of an article = its answers[profile] from d1-answers.json; an article whose call
  failed after its retries (answers null), or that is missing from the file, has p = 0
  for every profile. The answers file must name the test slice and its articles.json
  sha256 must equal the test slice's (fresh-5) one.
- d1: order by p_d1 descending, then cos(x, d) descending, then id. The same for both
  N_teach (no teaching).
- d1+kw: round 6's with_keyword(p_d1, narrow matches of the stream, narrow matches of the
  taught relevant answers of product teaching for that N_teach) - the frozen ranker's
  evidence formula, with its Laplace smoothing also when there is no relevant answer
  (P(k|rel) = 1/2 then). p_d1 is clipped to [1e-12, 1 - 1e-12] by with_keyword. Same ties.
- References and baselines come from round 12's orders(profile, N_teach) on the same pool
  and stream, so their MAP and daily recall equal round 12's results.json (checked in the
  real run: macro MAP and daily recall of desc+kw and hybrid to 1e-12).
- The ranker to beat = round-12/results.json 'chosen' (frozen, its sha256 file checked),
  or desc+kw when round 12 chose nothing. In smoke mode: desc+kw.
- MAP and daily recall: round 12's definitions and profile rules (>= 20 strict relevant
  test articles for MAP; >= 20 days holding a strict relevant article for daily recall),
  mean over N_teach and N_day.
- Decision metrics, over the MAP profiles: T11F (F0.5) of p_d1 >= 0.5 and of keywordNarrow
  over the labelled test articles (round 2's metric_row), and the Brier skill of p_d1
  against the profile's base rate on those articles; macro means; interval of
  T11F(d1 >= 0.5) - T11F(keywordNarrow).
- Bootstrap: r2.topic_boot(..., seed=31966), a fresh generator per call.
- Ranker pass: MAP interval vs the ranker to beat lower bound > 0 and daily-recall
  interval lower bound > -0.05. Both d1 rankers pass -> d1 unless its MAP interval against
  d1+kw has upper bound < 0. Decision 'reported': T11F interval lower bound > 0 and macro
  Brier skill > 0.
"""
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ROUND12 = ROOT / "round-12/evaluate.py"
assert hashlib.sha256(ROUND12.read_bytes()).hexdigest().startswith("d4537eb0"), "round-12 evaluate.py changed"
SMOKE = Path(sys.argv[2]) if len(sys.argv) > 3 and sys.argv[1] == "--smoke" else None
ANSWERS = Path(sys.argv[3]) if SMOKE else HERE / "d1-answers.json"
sys.argv = sys.argv[:3]  # round 12's module reads --smoke OUT from argv
spec = importlib.util.spec_from_file_location("round12", ROUND12)
r12 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r12)
assert bool(r12.SMOKE) == bool(SMOKE)
r10, r6, r2 = r12.r10, r12.r6, r12.r2

D1 = ["d1", "d1+kw"]
REFS = ["desc+kw", "hybrid", "hybrid-rocchio"]
BASES = r12.BASES
NAMES = D1 + REFS + BASES
SEED = 31966
PROFILE_IDS = r12.PROFILE_IDS
STREAM = r12.STREAM


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---------------------------------------------------------------- answers
answers_file = json.loads(ANSWERS.read_text())
test_name = "fresh-4" if SMOKE else "fresh-5"
assert answers_file["slice"] == test_name, answers_file["slice"]
assert answers_file["articlesSha256"] == sha(ROOT / test_name / "articles.json"), "answers are for other articles"
by_id = {r["id"]: r["answers"] for r in answers_file["rows"]}
missing = [i for i in STREAM["ids"] if i not in by_id]
failed = [i for i in STREAM["ids"] if i in by_id and by_id[i] is None]
P_D1 = {p: np.array([(by_id.get(i) or {}).get(p, 0.0) for i in STREAM["ids"]]) for p in PROFILE_IDS}

if SMOKE:
    TO_BEAT, ROUND12_RESULTS = "desc+kw", None
else:
    results12 = ROOT / "round-12/results.json"
    assert sha(results12) == (ROOT / "round-12/results.sha256").read_text().strip(), "round-12 results.json not frozen"
    ROUND12_RESULTS = json.loads(results12.read_text())
    TO_BEAT = ROUND12_RESULTS["chosen"] or "desc+kw"


# ---------------------------------------------------------------- one profile
def profile_run(profile):
    rel, amb = STREAM["labels"][profile]
    lab = ~amb
    every = np.ones(len(rel), bool)
    d = r2.DESC[profile]
    cos = STREAM["x"] @ d
    id_rank = np.unique(np.array(STREAM["ids"], dtype=object), return_inverse=True)[1]
    p = P_D1[profile]
    units = {}
    for n in r12.N_TEACH:
        ordered, kw, teach = r12.orders(profile, n)
        pos, _ = r12.taught(profile, n)
        p_narrow = kw["keywordNarrow"]
        pool_narrow = np.array([re.search(r2.KEYWORDS[profile]["narrow"], r12.POOL["text"][i], re.I) is not None for i in pos], bool)
        p_kw = r6.with_keyword(p, p_narrow, pool_narrow)
        ordered["d1"] = np.lexsort((id_rank, -cos, -p))
        ordered["d1+kw"] = np.lexsort((id_rank, -cos, -p_kw))
        units[n] = {**teach,
                    "ap": {nm: r10.average_precision(ordered[nm], rel, lab) for nm in NAMES},
                    "daily": {nm: r12.daily(ordered[nm], rel, amb, kw.get(nm, every)) for nm in NAMES}}
    y = rel[lab]
    dec = p >= 0.5
    d1_row = r2.metric_row(dec[lab], p[lab], y)
    kw_row = r2.metric_row(kw["keywordNarrow"][lab], kw["keywordNarrow"][lab].astype(float), y)
    mean_of = lambda f: float(np.nanmean([f(u) for u in units.values()]))
    return {
        "strictRelevant": int(rel.sum()), "relevantDays": len({r12.DAYS[i] for i in np.where(rel)[0]}),
        "ap": {nm: mean_of(lambda u: u["ap"][nm]) for nm in NAMES},
        "daily": {nm: {m: float(np.nanmean([u["daily"][nm][k][m] for u in units.values() for k in r12.N_DAY]))
                       for m in ("recall", "precision", "emptyDays", "missedDays")} for nm in NAMES},
        "decision": {"d1>=0.5": d1_row, "keywordNarrow": kw_row},
        "units": units,
    }


def per_and_macro(results, scored, metric, names):
    per = {p: {nm: metric(results[p], nm) for nm in names} for p in scored}
    return per, {nm: float(np.mean([per[p][nm] for p in scored])) for nm in names}


if __name__ == "__main__":
    results = {p: profile_run(p) for p in PROFILE_IDS}
    map_scored = [p for p in PROFILE_IDS if results[p]["strictRelevant"] >= r12.MIN_RELEVANT]
    day_scored = [p for p in PROFILE_IDS if results[p]["relevantDays"] >= r12.MIN_DAYS]
    map_pp, map_macro = per_and_macro(results, map_scored, lambda r, nm: r["ap"][nm], NAMES)
    day_pp, day_macro = per_and_macro(results, day_scored, lambda r, nm: r["daily"][nm]["recall"], NAMES)
    boot = lambda per, scored, a, b: r2.topic_boot(per, scored, a, b, seed=SEED)
    map_iv = {r: {b: boot(map_pp, map_scored, r, b) for b in REFS + BASES} for r in D1}
    day_iv = {r: {b: boot(day_pp, day_scored, r, b) for b in REFS + BASES} for r in D1}
    passes = {r: bool(map_iv[r][TO_BEAT][0] > 0 and day_iv[r][TO_BEAT][0] > -0.05) for r in D1}
    d1_vs_kw = boot(map_pp, map_scored, "d1", "d1+kw")
    if all(passes.values()):
        chosen = "d1+kw" if d1_vs_kw[1] < 0 else "d1"
    else:
        chosen = next((r for r in D1 if passes[r]), None)
    dec_pp = {p: {"d1>=0.5": results[p]["decision"]["d1>=0.5"]["f05"], "keywordNarrow": results[p]["decision"]["keywordNarrow"]["f05"]}
              for p in map_scored}
    dec_macro = {k: float(np.mean([dec_pp[p][k] for p in map_scored])) for k in ("d1>=0.5", "keywordNarrow")}
    brier = {p: results[p]["decision"]["d1>=0.5"]["brierSkill"] for p in map_scored}
    decision = {"perProfileT11F": dec_pp, "macroT11F": dec_macro,
                "intervalVsKeywordNarrow": boot(dec_pp, map_scored, "d1>=0.5", "keywordNarrow"),
                "perProfileBrierSkill": brier, "macroBrierSkill": float(np.mean(list(brier.values())))}
    decision["yesNoAllowed"] = bool(decision["intervalVsKeywordNarrow"][0] > 0 and decision["macroBrierSkill"] > 0)
    reproduction = None
    if ROUND12_RESULTS:
        reproduction = {nm: {"map": abs(map_macro[nm] - ROUND12_RESULTS["map"]["macro"][nm]),
                             "dailyRecall": abs(day_macro[nm] - ROUND12_RESULTS["daily"]["macroRecall"][nm])}
                        for nm in REFS + BASES}
        assert all(v <= 1e-12 for r in reproduction.values() for v in r.values()), reproduction
    out = {
        "rule": {"file": "selection-rule.json", "sha256": sha(HERE / "selection-rule.json")},
        "evaluate": {"sha256": sha(Path(__file__)), "round12": sha(ROUND12)},
        "smoke": bool(SMOKE), "test": test_name,
        "answers": {"file": str(ANSWERS.name), "sha256": sha(ANSWERS), "model": answers_file["model"]["id"],
                    "server": answers_file.get("server"), "failedArticles": failed, "missingArticles": missing},
        "testLabels": r12.TEST["hashes"].get("labels.json"),
        "toBeat": TO_BEAT, "pass": passes, "chosen": chosen, "d1VsD1kwMAP": d1_vs_kw,
        "map": {"scoredProfiles": map_scored, "macro": map_macro, "intervals": map_iv, "perProfile": map_pp},
        "daily": {"scoredProfiles": day_scored, "macroRecall": day_macro, "intervals": day_iv, "perProfile": day_pp,
                  "macroSecondary": {nm: {m: float(np.mean([results[p]["daily"][nm][m] for p in day_scored]))
                                          for m in ("precision", "emptyDays", "missedDays")} for nm in NAMES}},
        "decision": decision, "round12Reproduction": reproduction, "profiles": results,
    }
    json.dump(out, open(SMOKE or HERE / "results.json", "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("test", "toBeat", "pass", "chosen", "d1VsD1kwMAP", "round12Reproduction")}
                     | {"map": {k: out["map"][k] for k in ("scoredProfiles", "macro", "intervals")},
                        "daily": {k: out["daily"][k] for k in ("scoredProfiles", "macroRecall", "intervals")},
                        "decision": {k: decision[k] for k in ("macroT11F", "intervalVsKeywordNarrow", "macroBrierSkill", "yesNoAllowed")},
                        "failed": len(failed), "missing": len(missing)}, indent=1))
