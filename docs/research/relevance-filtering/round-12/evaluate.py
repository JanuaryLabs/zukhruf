"""Research round 12 of @zukhruf/relevance-filtering (#3383, step 1): does words + meaning
rank better than the frozen desc+kw ranker?

Implements selection-rule.json (sha256 5728b7ba...). Reuses, without editing:
- round 10's frozen evaluate.py (526b9c69...): probabilities() (product teaching + the frozen
  design's desc+kw probability and its fallbacks), average_precision(); through it round 9
  (fresh-3 loading), round 7 (collection/fresh/fresh-2 sets, part/whole/concat), round 6
  (rocchio) and round 2 (DESC, KEYWORDS, PROFILES, unit, topic_boot);
- round 3's frozen evaluate.py (7319aa28...): analyze() (lower-case, [a-z0-9]+, scikit-learn
  English stop words, nltk Porter stemmer) and its TfidfVectorizer settings.
Run from round-12/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 --with nltk==3.9.2 python -I evaluate.py [--smoke OUT.json]
Never reads the exam. Writes results.json. With --smoke, fresh-5 is not read at all:
fresh-4 stands in for the test slice and leaves the pool, every label list is random and
made in memory (fresh-4 rng 12, fresh-3 rng 9 via round 9, the others rng 7 via round 7;
p(relevant) 0.06, p(ambiguous) 0.02), and the output goes to OUT.json.

Implementation choices fixed before the real run (the rule leaves them open):
- Sets. fresh-4: items.json sorted by q, vectors.json (asserted sha256 476600d0...),
  articles.json (30e3ff52...), labels.json (8e62624c...). fresh-5 the same way; its hashes
  are recorded, its ids are asserted disjoint from every pool set and its labels must cover
  its q set. Labels: true relevant, null ambiguous, missing or false not relevant.
- Teaching pool, in this order for stable ties: collection, fresh, fresh-2, fresh-3,
  fresh-4 (round 7's and round 9's sets, every labelled article). Test stream: all of
  fresh-5. Product teaching for N_teach in {5, 10} is round 10's probabilities() teaching
  (top N by cos, top N narrow-keyword matches by cos; relevant / not relevant answers,
  ambiguous skipped); the shown lists are recomputed the same way for hybrid-rocchio.
- desc+kw order, as the package ranks (freeze-ranking/plan.json, src/relevance-filter.ts):
  with a calibrated probability (binormal or Platt, then keyword evidence): probability
  descending, then cos descending, then id. When the frozen design has no probability
  (no relevant answer, or no fit and no not-relevant answer): narrow matches first, newest
  first; then the others by cos descending; ties by id. (Round 10's research code ordered
  the matches of this case by cos; the frozen plan and the package say newest first.)
- Lexical query text q0 = profile title (profiles.json 'title', round 3's name) + ' ' +
  description + ' ' + the narrow keyword written as words: regex escapes such as \\b
  removed and every other non-alphanumeric character turned into a space
  ('\\bchips?\\b|semiconductor' -> 'chips semiconductor'). Article text = title + ' ' + lead.
  idf is fitted on the pool's texts; every article and q0 are transformed by that vectorizer
  (L2 rows, so lex = dot product = cosine); q0 is used as unit(q0) as round 3 did.
- z(.) standardises by the scored stream's mean and population sd (round 3's standardise;
  sd 0 gives 0). hybrid = z(cos(x, d)) + z(lex(x)), the same for both N_teach.
- hybrid-rocchio: q_dense = round 6's rocchio(d, P, N) (8 d + 16 mean P - 4 mean N, a term
  with no answers is 0, unit length); q_lex = unit(8 unit(q0) + 16 mean(P_lex) - 4 mean(N_lex)),
  a term with no answers is 0. Score = z(x . q_dense) + z(x_lex . q_lex).
- Hybrid ties: cos(x, d) descending, then id (code-unit order, ascending).
- Baselines as round 10: keywordNarrow / keywordBroad: matches first, then newest, then id;
  newest: newest then id.
- MAP: AP over the labelled stream articles (round 10's average_precision), mean over
  N_teach; scored profiles = >= 20 strict relevant test articles; macro mean.
- Daily (round 11, package eval/daily.ts): day = publishedAt[:10] (UTC). For each list,
  day and N_day in {3, 5, 10}, shown = the list's order restricted to the day, first N_day.
  Ranker lists show N_day (fewer only when the day has fewer articles); a keyword list shows
  the day's matches only, newest first, at most N_day; newest shows the day's newest.
  Ambiguous articles take a slot and count neither as relevant nor as wrong. Recall =
  relevant shown / relevant of the day, over days with a strict relevant article; per
  profile mean over those days, then over N_day and N_teach. Scored profiles = >= 20 days
  that hold a strict relevant test article; macro mean. Secondary, reported only: precision
  = relevant shown / shown non-ambiguous (days with such a shown article), empty-day share,
  missed-day share (days with a relevant article where none is shown).
- Bootstrap: r2.topic_boot(per_profile, scored, a, b, seed=31965), 2000 replicates, a fresh
  generator per call; MAP intervals over the MAP profiles, daily intervals over the daily
  profiles.
- Pass for each hybrid: MAP interval vs desc+kw lower bound > 0 and daily-recall interval vs
  desc+kw lower bound > -0.05. Both pass -> 'hybrid' unless its MAP interval against
  hybrid-rocchio lies entirely below 0 (upper bound < 0), then 'hybrid-rocchio'.
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
from sklearn.feature_extraction.text import TfidfVectorizer

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ROUND10 = ROOT / "round-10/evaluate.py"
ROUND3 = ROOT / "round-3/evaluate.py"
assert hashlib.sha256(ROUND10.read_bytes()).hexdigest().startswith("526b9c69"), "round-10 evaluate.py changed"
assert hashlib.sha256(ROUND3.read_bytes()).hexdigest().startswith("7319aa28"), "round-3 evaluate.py changed"
SMOKE = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--smoke" else None


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r10 = load("round10", ROUND10)  # reads sys.argv for --smoke itself (through rounds 9 and 7)
assert bool(r10.SMOKE) == bool(SMOKE)
r3 = load("round3", ROUND3)  # resets sys.argv; loaded second
r9, r7, r6, r2 = r10.r9, r10.r7, r10.r6, r10.r2

RANKERS = ["desc+kw", "hybrid", "hybrid-rocchio"]
HYBRIDS = ["hybrid", "hybrid-rocchio"]
BASES = ["keywordNarrow", "keywordBroad", "newest"]
NAMES = RANKERS + BASES
N_TEACH = [5, 10]
N_DAY = [3, 5, 10]
SEED = 31965
MIN_RELEVANT, MIN_DAYS = 20, 20
PROFILES = {p["id"]: p for p in r2.PROFILES}
PROFILE_IDS = list(PROFILES)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---------------------------------------------------------------- sets
def load_set(name, hashes, fake_seed=None):
    folder = ROOT / name
    for file, prefix in hashes.items():
        assert sha(folder / file).startswith(prefix), f"{name}/{file} changed"
    items = sorted(json.loads((folder / "items.json").read_text()), key=lambda i: i["q"])
    ids = [i["id"] for i in items]
    assert sorted(ids) == sorted(a["id"] for a in json.loads((folder / "articles.json").read_text()))
    vectors = {r["id"]: r["vector"] for r in json.loads((folder / "vectors.json").read_text())["rows"]}
    st = {"ids": ids, "x": r2.unit([vectors[i] for i in ids]), "text": [f"{i['title']} {i['lead']}" for i in items],
          "date": [i["publishedAt"] for i in items],
          "hashes": {f: sha(folder / f) for f in ("articles.json", "items.json", "vectors.json")}}
    if fake_seed is not None:
        fake = np.random.default_rng(fake_seed)
        st["labels"] = {}
        for p in PROFILE_IDS:
            u = fake.random(len(ids))
            st["labels"][p] = (u < 0.06, (u >= 0.06) & (u < 0.08))
        st["hashes"]["labels.json"] = None
    else:
        rows = {r["q"]: r["labels"] for r in json.loads((folder / "labels.json").read_text())}
        assert sorted(rows) == [i["q"] for i in items], f"{name} labels must cover {name} exactly"
        lab = [rows[i["q"]] for i in items]
        st["labels"] = {p: (np.array([l.get(p, False) is True for l in lab]),
                            np.array([l.get(p, False) is None for l in lab])) for p in PROFILE_IDS}
        st["hashes"]["labels.json"] = sha(folder / "labels.json")
    return st


FRESH4 = load_set("fresh-4", {"vectors.json": "476600d0", "articles.json": "30e3ff52",
                              **({} if SMOKE else {"labels.json": "8e62624c"})}, fake_seed=12 if SMOKE else None)
POOL_SETS = [r7.SETS["collection"], r7.SETS["fresh"], r7.SETS["fresh-2"], r9.FRESH3] + ([] if SMOKE else [FRESH4])
TEST = FRESH4 if SMOKE else load_set("fresh-5", {})
assert not {i for s in POOL_SETS for i in s["ids"]} & set(TEST["ids"]), "test slice overlaps the pool"
POOL = r7.concat([r7.whole(s) for s in POOL_SETS])
STREAM = {**r7.whole(TEST), "date": TEST["date"]}

# ---------------------------------------------------------------- lexical
VECTORIZER = TfidfVectorizer(analyzer=r3.analyze, sublinear_tf=True, smooth_idf=True, norm="l2")
VECTORIZER.fit(POOL["text"])
POOL_LEX = VECTORIZER.transform(POOL["text"]).tocsr()
STREAM_LEX = VECTORIZER.transform(STREAM["text"]).tocsr()


def keyword_words(regex):
    return re.sub(r"[^a-z0-9]+", " ", re.sub(r"\\[a-zA-Z]", " ", regex.lower())).strip()


def query_text(profile):
    p = PROFILES[profile]
    return f"{p['title']} {p['description']} {keyword_words(r2.KEYWORDS[profile]['narrow'])}"


Q0 = {p: r3.unit(VECTORIZER.transform([query_text(p)]).toarray()[0]) for p in PROFILE_IDS}


def z(v):
    sd = v.std()
    return np.zeros_like(v) if sd == 0 else (v - v.mean()) / sd


def taught(profile, n_show):
    """The relevant and not-relevant answers of product teaching (round 10's teaching)."""
    d = r2.DESC[profile]
    p_rel, p_amb = POOL["labels"][profile]
    p_cos = POOL["x"] @ d
    p_narrow = np.array([re.search(r2.KEYWORDS[profile]["narrow"], t, re.I) is not None for t in POOL["text"]])
    top = list(np.argsort(-p_cos, kind="stable")[:n_show])
    kw = np.where(p_narrow)[0]
    top_kw = list(kw[np.argsort(-p_cos[kw], kind="stable")][:n_show])
    shown = sorted(set(top) | set(top_kw))
    return [i for i in shown if p_rel[i]], [i for i in shown if not p_rel[i] and not p_amb[i]]


def mean_rows(M, rows):
    return np.asarray(M[rows].mean(0)).ravel() if rows else 0


# ---------------------------------------------------------------- orders
def orders(profile, n_show):
    d = r2.DESC[profile]
    cos = STREAM["x"] @ d
    ids = np.array(STREAM["ids"], dtype=object)
    id_rank = np.unique(ids, return_inverse=True)[1]
    date_rank = np.unique(np.array(STREAM["date"], dtype=object), return_inverse=True)[1]
    match = lambda rx: np.array([re.search(rx, t, re.I) is not None for t in STREAM["text"]])
    narrow, broad = match(r2.KEYWORDS[profile]["narrow"]), match(r2.KEYWORDS[profile]["broad"])

    _, probs, fallbacks, teach = r10.probabilities(profile, POOL, STREAM, n_show)
    if fallbacks.get("desc+kw", "").endswith(": keyword"):
        # KeywordFilter: matches first, newest first; others by cos; ties by id.
        second = np.where(narrow, -date_rank, -cos)
        desc_kw = np.lexsort((id_rank, second, ~narrow))
    else:
        desc_kw = np.lexsort((id_rank, -cos, -probs["desc+kw"]))

    hybrid = z(cos) + z(STREAM_LEX @ Q0[profile])
    pos, neg = taught(profile, n_show)
    q_dense = r6.rocchio(d, POOL["x"][pos], POOL["x"][neg])
    q_lex = r3.unit(8 * Q0[profile] + 16 * mean_rows(POOL_LEX, pos) - 4 * mean_rows(POOL_LEX, neg))
    rocchio = z(STREAM["x"] @ q_dense) + z(STREAM_LEX @ q_lex)
    assert (len(pos), len(neg)) == (teach["taughtRelevant"], teach["taughtNotRelevant"])
    out = {
        "desc+kw": desc_kw,
        "hybrid": np.lexsort((id_rank, -cos, -hybrid)),
        "hybrid-rocchio": np.lexsort((id_rank, -cos, -rocchio)),
        "keywordNarrow": np.lexsort((id_rank, -date_rank, ~narrow)),
        "keywordBroad": np.lexsort((id_rank, -date_rank, ~broad)),
        "newest": np.lexsort((id_rank, -date_rank)),
    }
    return out, {"keywordNarrow": narrow, "keywordBroad": broad}, {**teach, "desc+kwFallback": fallbacks.get("desc+kw", "none")}


# ---------------------------------------------------------------- daily
DAYS = np.array([d[:10] for d in STREAM["date"]], dtype=object)


def daily(order, rel, amb, available):
    """Round 11's dayScores for each N_day: recall, precision, empty and missed shares."""
    per_day = {}
    for i in order:
        if available[i]:
            per_day.setdefault(DAYS[i], []).append(i)
    all_days = sorted(set(DAYS))
    relevant_of = {day: 0 for day in all_days}
    for i in np.where(rel)[0]:
        relevant_of[DAYS[i]] += 1
    out = {}
    for n in N_DAY:
        recall, precision, empty, missed = [], [], 0, 0
        for day in all_days:
            shown = per_day.get(day, [])[:n]
            hits = int(rel[shown].sum()) if shown else 0
            judged = int((~amb[shown]).sum()) if shown else 0
            empty += not shown
            if judged:
                precision.append(hits / judged)
            if relevant_of[day]:
                recall.append(hits / relevant_of[day])
                missed += hits == 0
        out[n] = {"recall": float(np.mean(recall)) if recall else math.nan,
                  "precision": float(np.mean(precision)) if precision else math.nan,
                  "emptyDays": empty / len(all_days), "missedDays": missed / len(recall) if recall else math.nan}
    return out


# ---------------------------------------------------------------- run
def profile_run(profile):
    rel, amb = STREAM["labels"][profile]
    lab = ~amb
    every = np.ones(len(rel), bool)
    units = {}
    for n in N_TEACH:
        ordered, kw, teach = orders(profile, n)
        units[n] = {**teach,
                    "ap": {nm: r10.average_precision(ordered[nm], rel, lab) for nm in NAMES},
                    "daily": {nm: daily(ordered[nm], rel, amb, kw.get(nm, every)) for nm in NAMES}}
    mean_of = lambda f: float(np.nanmean([f(u) for u in units.values()]))
    rel_days = len({DAYS[i] for i in np.where(rel)[0]})
    return {
        "strictRelevant": int(rel.sum()), "relevantDays": rel_days,
        "ap": {nm: mean_of(lambda u: u["ap"][nm]) for nm in NAMES},
        "daily": {nm: {m: float(np.nanmean([u["daily"][nm][n][m] for u in units.values() for n in N_DAY]))
                       for m in ("recall", "precision", "emptyDays", "missedDays")} for nm in NAMES},
        "dailyByNDay": {nm: {str(n): float(np.mean([u["daily"][nm][n]["recall"] for u in units.values()])) for n in N_DAY}
                        for nm in NAMES},
        "units": units,
    }


def summary(results, scored, metric):
    per = {p: {nm: metric(results[p], nm) for nm in NAMES} for p in scored}
    macro = {nm: float(np.mean([per[p][nm] for p in scored])) for nm in NAMES}
    intervals = {h: {b: r2.topic_boot(per, scored, h, b, seed=SEED) for b in ["desc+kw"] + BASES} for h in HYBRIDS}
    intervals["desc+kw"] = {b: r2.topic_boot(per, scored, "desc+kw", b, seed=SEED) for b in BASES}
    return per, macro, intervals


if __name__ == "__main__":
    results = {p: profile_run(p) for p in PROFILE_IDS}
    map_scored = [p for p in PROFILE_IDS if results[p]["strictRelevant"] >= MIN_RELEVANT]
    day_scored = [p for p in PROFILE_IDS if results[p]["relevantDays"] >= MIN_DAYS]
    map_pp, map_macro, map_iv = summary(results, map_scored, lambda r, nm: r["ap"][nm])
    day_pp, day_macro, day_iv = summary(results, day_scored, lambda r, nm: r["daily"][nm]["recall"])
    secondary = {nm: {m: float(np.mean([results[p]["daily"][nm][m] for p in day_scored]))
                      for m in ("precision", "emptyDays", "missedDays")} for nm in NAMES}
    by_nday = {nm: {str(n): float(np.mean([results[p]["dailyByNDay"][nm][str(n)] for p in day_scored])) for n in N_DAY}
               for nm in NAMES}
    passes = {h: bool(map_iv[h]["desc+kw"][0] > 0 and day_iv[h]["desc+kw"][0] > -0.05) for h in HYBRIDS}
    hybrid_vs_rocchio = r2.topic_boot(map_pp, map_scored, "hybrid", "hybrid-rocchio", seed=SEED)
    if all(passes.values()):
        chosen = "hybrid-rocchio" if hybrid_vs_rocchio[1] < 0 else "hybrid"
    else:
        chosen = next((h for h in HYBRIDS if passes[h]), None)
    fallbacks = {}
    for r in results.values():
        for u in r["units"].values():
            fallbacks[u["desc+kwFallback"]] = fallbacks.get(u["desc+kwFallback"], 0) + 1
    out = {
        "rule": {"file": "selection-rule.json", "sha256": sha(HERE / "selection-rule.json")},
        "evaluate": {"sha256": sha(Path(__file__)), "round10": sha(ROUND10), "round3": sha(ROUND3)},
        "smoke": bool(SMOKE),
        "test": "fresh-4 (smoke stand-in)" if SMOKE else "fresh-5",
        "testHashes": TEST["hashes"],
        "poolLabels": {"collection": sha(ROOT / "labels.json"), "fresh": sha(ROOT / "fresh/labels.json"),
                       "fresh-2": sha(ROOT / "fresh-2/labels.json"), "fresh-3": r9.FRESH3["labelsSha256"],
                       "fresh-4": None if SMOKE else FRESH4["hashes"]["labels.json"]},
        "environment": {"python": sys.version, "numpy": np.__version__, "scipy": scipy.__version__,
                        "sklearn": __import__("sklearn").__version__, "nltk": __import__("nltk").__version__},
        "queryTexts": {p: query_text(p) for p in PROFILE_IDS},
        "pass": passes, "chosen": chosen, "hybridVsHybridRocchioMAP": hybrid_vs_rocchio,
        "map": {"scoredProfiles": map_scored, "macro": map_macro, "intervals": map_iv, "perProfile": map_pp},
        "daily": {"scoredProfiles": day_scored, "macroRecall": day_macro, "intervals": day_iv, "perProfile": day_pp,
                  "macroRecallByNDay": by_nday, "macroSecondary": secondary},
        "desc+kwFallbacks": fallbacks,
        "profiles": results,
    }
    json.dump(out, open(SMOKE or HERE / "results.json", "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("test", "pass", "chosen", "hybridVsHybridRocchioMAP", "desc+kwFallbacks")}
                     | {"map": {k: out["map"][k] for k in ("scoredProfiles", "macro", "intervals")},
                        "daily": {k: out["daily"][k] for k in ("scoredProfiles", "macroRecall", "intervals", "macroRecallByNDay")}},
                     indent=1))
