"""Research round 10 of @zukhruf/relevance-filtering (#3195): a ranked reader (TREC routing),
best N a day, no yes/no threshold.

Implements selection-rule.json (sha256 37952976...) on round 9's frozen evaluate.py
(sha256 75bacc12...: fresh-3 loading, protocols), and through it round 7 (8c5f7960...:
sets, truncated_binormal), round 6 (with_keyword) and round 2 (binormal, platt_prob,
topic_boot). Run from round-10/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 python -I evaluate.py [--smoke OUT.json]
Never reads the exam. Writes results.json. --smoke is passed on to round 9's module
(random in-memory labels: fresh-3 rng 9, other sets rng 7; fresh-3/labels.json unread);
the output goes to OUT.json.

Implementation choices fixed before the real run (the rule leaves them open):
- Protocols, pools, streams, product teaching and units are round 9's: window = fresh-3's
  first 14 days teach, the rest is scored; pool = collection + fresh + fresh-2 teach, all
  fresh-3 is scored. A unit (profile, N) is scored when its stream has >= 15 strict
  relevant articles; N in {5, 10}.
- Probabilities. desc+kw = round 9's 'frozen' path exactly: no relevant answer -> keyword
  matches (p 1/0); else r2.binormal, if None Platt (r2.platt_prob) when there is a
  not-relevant answer, else keyword matches; then round 6's with_keyword (not after a
  keyword fallback). truncated+kw = round 7's 'truncated' path exactly: r7.truncated_binormal,
  on failure or mu1 <= mu0 Platt / keyword as above, then with_keyword. The teaching code
  (shown lists, cut-offs) is copied from round 9's unit_run (frozen; cannot be refactored).
- Orders (np.lexsort, ids compared as strings, ascending):
  desc: -cos, then id. desc+kw / truncated+kw: -p, then -cos, then id (exactly equal
  floats tie, e.g. p saturated at 1.0). keywordNarrow / keywordBroad: matches first, then
  publishedAt descending (ISO string), then id. newest: publishedAt descending, then id.
- AP over the scored stream's labelled articles: the ranking restricted to non-ambiguous
  articles; AP = mean over relevant articles of precision at their rank. A profile's score
  = mean over its scored units (both N); macro = mean over scored profiles (MAP). Baselines
  do not depend on N; they are averaged over the same units.
- Product metric (reported only). Day = publishedAt[:10] (UTC). Per day, the day's
  labelled articles (ambiguous left out, as in AP) in the list's order; the list shows the
  top min(N_day, available) articles, where 'available' is every labelled article of the
  day for rankers and newest, and only the day's keyword matches for a keyword list.
  Precision = relevant shown / shown. A day where a list shows nothing (no labelled
  keyword match that day) is left out of that list's mean, and the number of such days is
  reported. Mean over days, then over units and profiles as AP.
- Bootstrap: r2.topic_boot(..., seed=31962), each call from a fresh generator.
- Pass per ranker: in window and in pool separately, interval vs keywordNarrow lower
  bound > -0.05 and intervals vs keywordBroad and newest lower bounds > 0.
- simplerWins (the rule does not say which protocol): best = passing ranker with the
  highest mean of its two protocol MAPs; a simpler passing ranker wins when its interval
  against best includes 0 in both protocols; the simplest such wins (order desc <
  desc+kw < truncated+kw).
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
ROUND9 = ROOT / "round-9/evaluate.py"
assert hashlib.sha256(ROUND9.read_bytes()).hexdigest().startswith("75bacc12"), "round-9 evaluate.py changed"
SMOKE = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--smoke" else None
spec = importlib.util.spec_from_file_location("round9", ROUND9)
r9 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r9)  # reads sys.argv for --smoke itself
assert bool(r9.SMOKE) == bool(SMOKE)
r7, r6, r2 = r9.r7, r9.r6, r9.r2

RANKERS = ["desc", "desc+kw", "truncated+kw"]
BASES = ["keywordNarrow", "keywordBroad", "newest"]
NAMES = RANKERS + BASES
CELLS = r9.CELLS
DAY_N = [3, 5, 10]
SEED = 31962
PROFILE_IDS = r9.PROFILE_IDS

ITEMS3 = {i["id"]: i for i in json.loads((r9.F3 / "items.json").read_text())}
FRESH3 = r9.FRESH3
FRESH3["date"] = [ITEMS3[i]["publishedAt"] for i in FRESH3["ids"]]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stream_part(mask):
    st = r7.part(FRESH3, mask)
    idx = np.where(mask)[0]
    st["date"] = [FRESH3["date"][i] for i in idx]
    return st


# ---------------------------------------------------------------- probabilities
def probabilities(profile, pool, stream, n_show):
    """cos and the two probability vectors on the stream; teaching as round 9's unit_run."""
    d = r2.DESC[profile]
    narrow_re = r2.KEYWORDS[profile]["narrow"]
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

    raw = stream["x"] @ d
    k_s = match(stream["text"], narrow_re)
    answered = pos + neg
    ty = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
    taught = p_cos[answered]
    cuts = np.array([cut_of(i) for i in answered])
    probs, fallbacks = {}, {}
    for name in ("desc+kw", "truncated+kw"):
        if not pos:
            probs[name], fallbacks[name] = k_s.astype(float), "no relevant answer: keyword"
            continue
        if name == "desc+kw":
            fit = r2.binormal(raw, taught, ty)
            p = fit[0] if fit else None
        else:
            p = r7.truncated_binormal(raw, taught, cuts, ty)[0]
        if p is None:
            if neg:
                p = r2.platt_prob(taught, ty, raw)[0]; fallbacks[name] = "platt"
            else:
                probs[name], fallbacks[name] = k_s.astype(float), "no fit and no not-relevant answer: keyword"
                continue
        probs[name] = r6.with_keyword(p, k_s, p_narrow[pos])
    return raw, probs, fallbacks, {"shown": len(shown), "taughtRelevant": len(pos), "taughtNotRelevant": len(neg)}


# ---------------------------------------------------------------- orders and metrics
def orders(profile, stream, raw, probs):
    ids = np.array(stream["ids"], dtype=object)
    date = np.array(stream["date"], dtype=object)
    match = lambda rx: np.array([re.search(rx, t, re.I) is not None for t in stream["text"]])
    narrow, broad = match(r2.KEYWORDS[profile]["narrow"]), match(r2.KEYWORDS[profile]["broad"])
    # lexsort sorts by the last key first; strings sort ascending, so newest first uses a
    # descending rank of the date strings.
    date_rank = np.unique(date, return_inverse=True)[1]
    id_rank = np.unique(ids, return_inverse=True)[1]
    out = {
        "desc": np.lexsort((id_rank, -raw)),
        "desc+kw": np.lexsort((id_rank, -raw, -probs["desc+kw"])),
        "truncated+kw": np.lexsort((id_rank, -raw, -probs["truncated+kw"])),
        "keywordNarrow": np.lexsort((id_rank, -date_rank, ~narrow)),
        "keywordBroad": np.lexsort((id_rank, -date_rank, ~broad)),
        "newest": np.lexsort((id_rank, -date_rank)),
    }
    return out, {"keywordNarrow": narrow, "keywordBroad": broad}


def average_precision(order, rel, lab):
    o = order[lab[order]]
    hits = rel[o]
    if hits.sum() == 0:
        return float("nan")
    prec = np.cumsum(hits) / np.arange(1, len(hits) + 1)
    return float(prec[hits].mean())


def daily_precision(order, rel, lab, dates, available):
    buckets = {}
    for i in order:
        if lab[i] and available[i]:
            buckets.setdefault(dates[i][:10], []).append(i)
    days = {d[:10] for d in dates}
    out = {}
    for n in DAY_N:
        values = [float(rel[buckets[day][:n]].mean()) for day in sorted(buckets)]
        out[n] = {"precision": float(np.mean(values)) if values else float("nan"), "emptyDays": len(days) - len(buckets)}
    return out


def unit_run(profile, pool, stream, n_show):
    raw, probs, fallbacks, teach = probabilities(profile, pool, stream, n_show)
    rel, amb = stream["labels"][profile]
    lab = ~amb
    ordered, kw_match = orders(profile, stream, raw, probs)
    every = np.ones(len(raw), bool)
    ap = {nm: average_precision(ordered[nm], rel, lab) for nm in NAMES}
    daily = {nm: daily_precision(ordered[nm], rel, lab, stream["date"], kw_match.get(nm, every)) for nm in NAMES}
    return {**teach, "scoredRelevant": int(rel.sum()), "ap": ap, "daily": daily, "fallbacks": fallbacks}


# ---------------------------------------------------------------- protocols
def protocol_units(protocol):
    if protocol == "window":
        pool, stream = r7.part(FRESH3, FRESH3["window"]), stream_part(~FRESH3["window"])
    else:
        pool = r7.concat([r7.whole(r7.SETS[s]) for s in ("collection", "fresh", "fresh-2")])
        stream = stream_part(np.ones(len(FRESH3["ids"]), bool))
    return {p: {f"fresh-3|{n}": unit_run(p, pool, stream, n) for n in CELLS} for p in PROFILE_IDS}


def protocol_result(protocol):
    units = protocol_units(protocol)
    per_profile, daily_pp = {}, {}
    for p, us in units.items():
        used = [u for u in us.values() if u["scoredRelevant"] >= 15]
        if used:
            per_profile[p] = {nm: float(np.mean([u["ap"][nm] for u in used])) for nm in NAMES}
            daily_pp[p] = {nm: {str(n): float(np.nanmean([u["daily"][nm][n]["precision"] for u in used])) for n in DAY_N} for nm in NAMES}
    scored = list(per_profile)
    macro = {nm: float(np.mean([per_profile[p][nm] for p in scored])) for nm in NAMES}
    daily_macro = {nm: {str(n): float(np.mean([daily_pp[p][nm][str(n)] for p in scored])) for n in DAY_N} for nm in NAMES}
    intervals = {nm: {b: r2.topic_boot(per_profile, scored, nm, b, seed=SEED) for b in BASES} for nm in RANKERS}
    passes = {nm: bool(intervals[nm]["keywordNarrow"][0] > -0.05 and intervals[nm]["keywordBroad"][0] > 0
                       and intervals[nm]["newest"][0] > 0) for nm in RANKERS}
    fallback_counts = {nm: {} for nm in ("desc+kw", "truncated+kw")}
    empty_days = {}
    for p, us in units.items():
        for u in us.values():
            group = "scored" if u["scoredRelevant"] >= 15 else "unscored"
            for nm in fallback_counts:
                key = f"{group}|{u['fallbacks'].get(nm, 'none')}"
                fallback_counts[nm][key] = fallback_counts[nm].get(key, 0) + 1
            if group == "scored":
                for nm in ("keywordNarrow", "keywordBroad"):
                    for n in DAY_N:
                        k = f"{nm}|{n}"
                        empty_days[k] = empty_days.get(k, 0) + u["daily"][nm][n]["emptyDays"]
    return {"scoredProfiles": scored, "perProfileAP": per_profile, "MAP": macro, "intervals": intervals,
            "pass": passes, "dailyPrecision": daily_macro, "perProfileDailyPrecision": daily_pp,
            "keywordEmptyDaysSummedOverScoredUnits": empty_days, "fallbackCounts": fallback_counts, "units": units}


def order_check():
    """The tie rules on a hand-made stream."""
    st = {"ids": ["b", "a", "c", "d"], "date": ["2025-07-02T00", "2025-07-02T00", "2025-07-03T00", "2025-07-01T00"],
          "text": ["x", "x", "y", "x"]}
    raw = np.array([0.5, 0.5, 0.9, 0.1])
    probs = {"desc+kw": np.array([1.0, 1.0, 0.2, 1.0]), "truncated+kw": np.array([0.3, 0.3, 0.3, 0.3])}
    r2.KEYWORDS["_check"] = {"narrow": "x", "broad": "y"}
    try:
        o, _ = orders("_check", st, raw, probs)
    finally:
        del r2.KEYWORDS["_check"]
    ids = lambda nm: [st["ids"][i] for i in o[nm]]
    assert ids("desc") == ["c", "a", "b", "d"], ids("desc")
    assert ids("desc+kw") == ["a", "b", "d", "c"], ids("desc+kw")
    assert ids("truncated+kw") == ["c", "a", "b", "d"], ids("truncated+kw")
    assert ids("keywordNarrow") == ["a", "b", "d", "c"], ids("keywordNarrow")
    assert ids("keywordBroad") == ["c", "a", "b", "d"], ids("keywordBroad")
    assert ids("newest") == ["c", "a", "b", "d"], ids("newest")


if __name__ == "__main__":
    order_check()
    protocols = {pr: protocol_result(pr) for pr in ("window", "pool")}
    status = {nm: "PASS" if all(protocols[pr]["pass"][nm] for pr in protocols) else "FAIL" for nm in RANKERS}
    passing = [nm for nm in RANKERS if status[nm] == "PASS"]
    best = max(passing, key=lambda nm: np.mean([protocols[pr]["MAP"][nm] for pr in protocols])) if passing else None
    chosen, simpler = best, {}
    if best:
        for nm in passing:
            if RANKERS.index(nm) < RANKERS.index(best):
                simpler[nm] = {pr: r2.topic_boot(protocols[pr]["perProfileAP"], protocols[pr]["scoredProfiles"], nm, best, seed=SEED)
                               for pr in protocols}
        ok = [nm for nm, ivs in simpler.items() if all(iv[0] <= 0 <= iv[1] for iv in ivs.values())]
        if ok:
            chosen = min(ok, key=RANKERS.index)
    out = {
        "rule": {"file": "selection-rule.json", "sha256": sha(HERE / "selection-rule.json")},
        "evaluate": {"sha256": sha(Path(__file__)), "round9": sha(ROUND9)},
        "smoke": bool(SMOKE),
        "labels": {"collection": sha(ROOT / "labels.json"), "fresh": sha(ROOT / "fresh/labels.json"),
                   "fresh-2": sha(ROOT / "fresh-2/labels.json"), "fresh-3": FRESH3["labelsSha256"]},
        "environment": {"python": sys.version, "numpy": np.__version__, "scipy": scipy.__version__},
        "status": status, "best": best, "simplerVsBest": simpler, "chosen": chosen,
        "protocols": protocols,
    }
    json.dump(out, open(SMOKE or HERE / "results.json", "w"), indent=1)
    print(json.dumps({"status": status, "best": best, "chosen": chosen,
                      **{pr: {"scored": v["scoredProfiles"], "MAP": v["MAP"], "intervals": v["intervals"], "pass": v["pass"],
                              "dailyPrecision": v["dailyPrecision"], "fallbackCounts": v["fallbackCounts"]}
                         for pr, v in protocols.items()}}, indent=1))
