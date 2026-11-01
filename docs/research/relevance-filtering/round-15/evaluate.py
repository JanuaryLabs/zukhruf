"""Research round 15 of @zukhruf/relevance-filtering (#3421): does a per-profile recalibration
of d1-2B's probability from the reader's taught answers make better yes/no decisions than
d1's own probability?

Implements selection-rule.json (sha256 3c622f79..., its sha256 file checked). Loads round
13's frozen evaluate.py (sha256 3736b270...) as a module, as round 14 does, in its real mode:
its pool is round 15's teaching pool (fresh-5 in q order, labels 187918bd..., round 13's
frozen d1 answers a86a1235..., p = 0 for a failed or missing article), and through it
round 12 (N_TEACH, MIN_RELEVANT), round 10 (average_precision) and round 2 (PROFILES,
KEYWORDS, platt_fit, platt_apply, plugin_threshold, metric_row with t11su / f05 / Brier
skill / ece, topic_boot).
Run from round-15/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 --with nltk==3.9.2 python -I evaluate.py [--smoke OUT.json ANSWERS.json]
Without arguments: the test slice is fresh-6 (articles.json, labels.json and round-15's
d1-answers.json, each checked against its sha256 file), writes results.json. With --smoke
(a runnability check, not a result): fresh-4 stands in for the test slice with its frozen
labels, ANSWERS.json (round-15/collect.py's format, for fresh-4) gives p_d1, the test
slice is the articles that ANSWERS.json holds (collect.py --limit), the window is the
first 14 UTC days of fresh-4's period (2025-04-01..2025-04-14), and the output goes to
OUT.json, which must be outside this research folder. Every other constant is the same.

Implementation choices fixed before the real run (the rule leaves them open):
- Test slice order: labels.json rows sorted by q (as round 12 sorts items by q); text =
  title + ' ' + lead and publishedAt from articles.json; labels true = relevant, null =
  ambiguous, false or missing = not relevant (round 12's load_set rule). The labels must
  cover articles.json exactly, and the slice must not share an id with the pool. In the
  real mode the answers must cover the slice exactly; a failed article (answers null) has
  p = 0 for every profile ('answers').
- UTC publish day = publishedAt[:10]; every publishedAt ends with 'Z' (asserted).
- Teaching set order (stable ties of the shown lists): q order of the teaching set.
- The per-profile score of a calibrated condition is the mean over N_teach in {5, 10}
  (rounds 10, 12, 13: a profile's score is the mean over its units); raw does not depend
  on N_teach. Bootstrap and pass use these means; macros are reported per N_teach too.
- ExpectedFThreshold cuts on the probabilities of every test article (the reader does not
  know which are ambiguous); every decision is scored on the labelled test articles.
- MAP check: order by p descending, then id (fresh-6 has no embeddings, so round 13's cos
  tie-break does not exist); average precision over the labelled test articles. Reported
  for every calibration; clipping can tie extreme raw probabilities, so equality is not
  asserted.
- Platt's (a, b) in the rule's form p = logistic(a f + b) is (-A, -B) of round 2's
  platt_fit, which fits p = 1 / (1 + exp(A f + B)).
- A protocol with no scored profile has no interval and passes nothing.

exploration-arm.json (sha256 6915da70..., its sha256 file checked) adds a second teaching arm.
The frozen arm's fields stay at the top level of results.json and its verdict is computed
first; the exploration arm sits under 'exploration' with the same fields. Its draw is from
the teaching set's articles that the frozen arm does not show, taken in teaching-set order
(q order), so the draw depends only on the seed and that order.
"""
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

import numpy as np
import scipy

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RULE = HERE / "selection-rule.json"
ADDENDUM = HERE / "exploration-arm.json"
ROUND13 = ROOT / "round-13/evaluate.py"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def frozen(path):
    """The file's sha256, asserted equal to its <name>.sha256 file."""
    digest = sha(path)
    assert digest == path.with_suffix(".sha256").read_text().strip(), f"{path.relative_to(ROOT)} is not frozen"
    return digest


assert frozen(RULE).startswith("3c622f79"), "round-15 selection-rule.json changed"
assert frozen(ADDENDUM).startswith("6915da70"), "round-15 exploration-arm.json changed"
assert sha(ROUND13).startswith("3736b270"), "round-13 evaluate.py changed"
if len(sys.argv) == 4 and sys.argv[1] == "--smoke":
    SMOKE, ANSWERS = Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
    assert ROOT not in SMOKE.parents, "smoke output must be written outside the research folder"
elif len(sys.argv) == 1:
    SMOKE, ANSWERS = None, HERE / "d1-answers.json"
else:
    sys.exit("usage: evaluate.py [--smoke OUT.json ANSWERS.json]")
sys.argv = sys.argv[:1]  # round 13 and the rounds under it read --smoke from argv: real mode
spec = importlib.util.spec_from_file_location("round13", ROUND13)
r13 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r13)
assert not r13.SMOKE
r12, r10, r2 = r13.r12, r13.r10, r13.r2

PROFILE_IDS = r13.PROFILE_IDS
assert PROFILE_IDS == [p["id"] for p in json.loads((ROOT / "profiles.json").read_text())["profiles"]]
ARMS = ["frozen", "exploration"]  # selection-rule.json 'teaching.protocol'; exploration-arm.json 'arm'
EXPLORATION_SEED = 31969  # exploration-arm.json 'arm.shown'
N_TEACH = r12.N_TEACH  # 'teaching.protocol': N_teach in {5, 10}
assert N_TEACH == [5, 10]
MIN_RELEVANT = r12.MIN_RELEVANT  # 'profiles': at least 20 strict relevant test articles
assert MIN_RELEVANT == 20
SEED = 31968  # 'pass'
REPLICATES = 2000  # 'pass': r2.topic_boot's default reps
CLIP = 1e-6  # 'calibrations.shift' / 'platt'
UTILITY_CUT = 1 / (1 + 2)  # 'decisions.primary': UtilityThreshold(falseAlarm 1, miss 2)
CALIBRATIONS = ["raw", "shift", "platt"]
PROTOCOLS = ["window", "pool"]
METRICS = ["t11su", "t11fExpectedF", "t11fHalf", "brierSkill", "ece", "map"]
TEST_NAME = "fresh-4" if SMOKE else "fresh-6"
WINDOW = ("2025-04-01", "2025-04-14") if SMOKE else ("2024-10-01", "2024-10-14")  # 'teaching.window'
assert sha(ROOT / "profiles.json").startswith("a5932290"), "profiles.json changed"
frozen(ROOT / "keywords.json")


def narrow_matches(profile, texts):
    return np.array([re.search(r2.KEYWORDS[profile]["narrow"], t, re.I) is not None for t in texts])


# ---------------------------------------------------------------- pool ('teaching.pool')
assert r12.TEST["hashes"]["labels.json"] == frozen(ROOT / "fresh-5/labels.json"), "round 13's pool labels differ"
assert r12.TEST["hashes"]["labels.json"].startswith("187918bd")
assert r13.ANSWERS == ROOT / "round-13/d1-answers.json" and frozen(r13.ANSWERS).startswith("a86a1235")
POOL = {"ids": r13.STREAM["ids"], "text": r13.STREAM["text"], "labels": r13.STREAM["labels"], "p": r13.P_D1}

# ---------------------------------------------------------------- test slice ('data.test', 'data.answers')
folder = ROOT / TEST_NAME
articles_sha, labels_sha = frozen(folder / "articles.json"), frozen(folder / "labels.json")
answers_sha = sha(ANSWERS) if SMOKE else frozen(ANSWERS)
answers_file = json.loads(ANSWERS.read_text())
assert answers_file["slice"] == TEST_NAME, answers_file["slice"]
assert answers_file["articlesSha256"] == articles_sha, "answers are for other articles"
assert answers_file["profilesSha256"] == sha(ROOT / "profiles.json"), "answers asked other profiles"
assert answers_file["rule"]["sha256"] == sha(RULE), "answers were collected under another rule"
articles = {a["id"]: a for a in json.loads((folder / "articles.json").read_text())}
label_rows = sorted(json.loads((folder / "labels.json").read_text()), key=lambda r: r["q"])
assert len({r["q"] for r in label_rows}) == len(label_rows)
assert sorted(r["id"] for r in label_rows) == sorted(articles), f"{TEST_NAME} labels must cover its articles exactly"
by_id = {r["id"]: r["answers"] for r in answers_file["rows"]}
if SMOKE:
    label_rows = [r for r in label_rows if r["id"] in by_id]  # collect.py --limit answered only these
else:
    assert sorted(by_id) == sorted(articles), "d1 must answer every test article"
failed = [r["id"] for r in label_rows if by_id[r["id"]] is None]
ids = [r["id"] for r in label_rows]
assert not set(ids) & set(POOL["ids"]), "the test slice overlaps the pool"
assert all(articles[i]["publishedAt"].endswith("Z") for i in ids), "publishedAt is not UTC"
DAY = np.array([articles[i]["publishedAt"][:10] for i in ids], dtype=object)
SLICE = {"ids": ids, "text": [f"{articles[i]['title']} {articles[i]['lead']}" for i in ids],
         "labels": {p: (np.array([r["labels"].get(p, False) is True for r in label_rows]),
                        np.array([r["labels"].get(p, False) is None for r in label_rows])) for p in PROFILE_IDS},
         "p": {p: np.array([(by_id[i] or {}).get(p, 0.0) for i in ids]) for p in PROFILE_IDS}}
IN_WINDOW = (DAY >= WINDOW[0]) & (DAY <= WINDOW[1])
assert IN_WINDOW.any() and (~IN_WINDOW).any(), "the window must split the test slice"


def part(st, mask):
    idx = np.where(mask)[0]
    return {"ids": [st["ids"][i] for i in idx], "text": [st["text"][i] for i in idx],
            "labels": {p: (r[idx], a[idx]) for p, (r, a) in st["labels"].items()},
            "p": {p: v[idx] for p, v in st["p"].items()}}


def protocol_sets(protocol):
    """'teaching.window' / 'teaching.pool': (teaching set, test part)."""
    if protocol == "window":
        return part(SLICE, IN_WINDOW), part(SLICE, ~IN_WINDOW)
    return POOL, SLICE


# ---------------------------------------------------------------- teaching ('teaching.protocol')
def taught(profile, teach, n_show, arm, protocol):
    """frozen arm: round 10's product teaching (probabilities(): top N by score, top N
    narrow-keyword matches by score, relevant / not-relevant answers, ambiguous skipped) with
    p_d1 as the score in place of cos. exploration arm (exploration-arm.json 'arm.shown'):
    those articles plus N drawn uniformly without replacement from the teaching set's other
    articles (in teaching-set order), default_rng([31969, protocol, profile, n_teach]); all
    of them when fewer than N exist."""
    p = teach["p"][profile]
    rel, amb = teach["labels"][profile]
    narrow = narrow_matches(profile, teach["text"])
    top = list(np.argsort(-p, kind="stable")[:n_show])
    kw = np.where(narrow)[0]
    top_kw = list(kw[np.argsort(-p[kw], kind="stable")][:n_show])
    shown = sorted(set(top) | set(top_kw))
    if arm == "exploration":
        rng = np.random.default_rng([EXPLORATION_SEED, PROTOCOLS.index(protocol), PROFILE_IDS.index(profile), n_show])
        others = np.setdiff1d(np.arange(len(p)), shown)
        drawn = rng.choice(others, size=min(n_show, len(others)), replace=False)
        shown = sorted(set(shown) | {int(i) for i in drawn})
    pos = [i for i in shown if rel[i]]
    neg = [i for i in shown if not rel[i] and not amb[i]]
    return pos, neg, len(shown)


# ---------------------------------------------------------------- calibrations ('calibrations')
def logit(p):
    """'calibrations.shift': p_d1 clipped to [1e-6, 1 - 1e-6] before logit."""
    q = np.clip(p, CLIP, 1 - CLIP)
    return np.log(q) - np.log1p(-q)


def smoothed_targets(y):
    """Platt's smoothed targets: (n_rel + 1) / (n_rel + 2) for relevant, 1 / (n_not + 2) for not."""
    n_rel, n_not = y.sum(), (1 - y).sum()
    return np.where(y == 1, (n_rel + 1) / (n_rel + 2), 1 / (n_not + 2))


def shift_fit(f, y):
    """'calibrations.shift': the intercept b of p = logistic(f + b) by maximum likelihood on
    the smoothed targets; Newton with a backtracking (Armijo) line search, as platt_fit."""
    t = smoothed_targets(y)
    loss = lambda b: np.sum(t * np.logaddexp(0, -(f + b)) + (1 - t) * np.logaddexp(0, f + b))
    b, cur = 0.0, loss(0.0)
    for _ in range(1000):
        s = 1 / (1 + np.exp(-(f + b)))
        g, h = np.sum(s - t), np.sum(s * (1 - s)) + 1e-12
        if abs(g) < 1e-12:
            break
        d, step = -g / h, 1.0
        while step > 1e-12:
            new = loss(b + step * d)
            if new < cur + 1e-4 * step * g * d:
                break
            step /= 2
        if step <= 1e-12:
            break
        b, cur = b + step * d, new
    return b


def calibrate(profile, teach, test, n_show, arm, protocol):
    """'calibrations' and 'calibrations.fallback': the test part's p of each calibration; the
    fallback reasons are exploration-arm.json 'reported''s three."""
    pos, neg, shown = taught(profile, teach, n_show, arm, protocol)
    raw = test["p"][profile]
    out = {"raw": raw}
    info = {"shown": shown, "taughtRelevant": len(pos), "taughtNotRelevant": len(neg)}
    if not pos or not neg:
        reason = " and ".join(r for r, missing in (("no relevant answer", not pos), ("no not-relevant answer", not neg))
                              if missing)
        out["shift"] = out["platt"] = raw
        info["shift"] = info["platt"] = {"fallback": reason}
        return out, info
    f = logit(teach["p"][profile][pos + neg])
    y = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
    f_test = logit(raw)
    b = shift_fit(f, y)
    out["shift"], info["shift"] = r2.platt_apply(-1.0, -b, f_test), {"b": float(b), "fallback": None}
    A, B = r2.platt_fit(f, y)  # Platt 1999 with smoothed targets, Newton + line search (Lin, Lin and Weng 2007)
    a, b = -A, -B
    if a <= 0:
        out["platt"], info["platt"] = raw, {"a": float(a), "b": float(b), "fallback": "platt a <= 0"}
    else:
        out["platt"], info["platt"] = r2.platt_apply(A, B, f_test), {"a": float(a), "b": float(b), "fallback": None}
    return out, info


# ---------------------------------------------------------------- decisions ('decisions')
def scores(p, rel, amb, id_rank):
    """'decisions.primary' (UtilityThreshold p >= 1/3 scored by T11SU) and 'decisions.reported'
    (T11F of ExpectedFThreshold(beta 0.5) and of p >= 0.5, Brier skill against the test base
    rate, ECE with 10 equal-width bins, MAP as a check), over the labelled test articles."""
    lab = ~amb
    y = rel[lab]
    utility = r2.metric_row((p >= UTILITY_CUT)[lab], p[lab], y)  # round 2's t11su: TREC-11, T11NU floor -0.5
    ef_accept, ef_cut = r2.plugin_threshold(p)  # = the package's ExpectedFThreshold({beta: 0.5})
    expected_f = r2.metric_row(ef_accept[lab], p[lab], y)
    half = r2.metric_row((p >= 0.5)[lab], p[lab], y)
    return {"t11su": utility["t11su"], "t11fExpectedF": expected_f["f05"], "t11fHalf": half["f05"],
            "brierSkill": utility["brierSkill"], "ece": utility["ece"],
            "map": r10.average_precision(np.lexsort((id_rank, -p)), rel, lab),
            "expectedFCut": ef_cut, "accepted": {"utility": utility["accepted"], "expectedF": expected_f["accepted"],
                                                 "half": half["accepted"]}}


def profile_run(profile, teach, test, arm, protocol):
    rel, amb = test["labels"][profile]
    lab = ~amb
    id_rank = np.unique(np.array(test["ids"], dtype=object), return_inverse=True)[1]
    narrow = narrow_matches(profile, test["text"])
    kw_row = r2.metric_row(narrow[lab], narrow[lab].astype(float), rel[lab])
    by_n = {}
    for n in N_TEACH:
        probs, info = calibrate(profile, teach, test, n, arm, protocol)
        by_n[str(n)] = {"teaching": info, **{c: scores(probs[c], rel, amb, id_rank) for c in CALIBRATIONS}}
    return {"testRelevant": int(rel.sum()), "testAmbiguous": int(amb.sum()), "testLabelled": int(lab.sum()),
            "baseRate": float(rel[lab].mean()),
            "keywordNarrow": {"t11su": kw_row["t11su"], "t11f": kw_row["f05"]},
            "mapRawD1": by_n[str(N_TEACH[0])]["raw"]["map"],
            "mean": {c: {m: float(np.mean([by_n[str(n)][c][m] for n in N_TEACH])) for m in METRICS} for c in CALIBRATIONS},
            "byNTeach": by_n}


# ---------------------------------------------------------------- protocol, macro, intervals
def boot(per, scored, a, b):
    """'pass': topic-level paired bootstrap, 2000 replicates, default_rng(31968) per call."""
    return r2.topic_boot(per, scored, a, b, reps=REPLICATES, seed=SEED) if scored else None


def protocol_result(protocol, arm):
    teach, test = protocol_sets(protocol)
    profiles = {p: profile_run(p, teach, test, arm, protocol) for p in PROFILE_IDS}
    scored = [p for p in PROFILE_IDS if profiles[p]["testRelevant"] >= MIN_RELEVANT]  # 'profiles'
    macro_of = lambda f: float(np.mean([f(profiles[p]) for p in scored])) if scored else None
    macro = {"mean": {c: {m: macro_of(lambda r: r["mean"][c][m]) for m in METRICS} for c in CALIBRATIONS},
             "byNTeach": {str(n): {c: {m: macro_of(lambda r: r["byNTeach"][str(n)][c][m]) for m in METRICS}
                                   for c in CALIBRATIONS} for n in N_TEACH},
             "keywordNarrow": {m: macro_of(lambda r: r["keywordNarrow"][m]) for m in ("t11su", "t11f")},
             "mapRawD1": macro_of(lambda r: r["mapRawD1"])}
    per = {m: {p: {c: profiles[p]["mean"][c][m] for c in CALIBRATIONS} for p in scored} for m in ("t11su", "brierSkill")}
    intervals = {"t11su": {"shift-raw": boot(per["t11su"], scored, "shift", "raw"),
                           "platt-raw": boot(per["t11su"], scored, "platt", "raw"),
                           "platt-shift": boot(per["t11su"], scored, "platt", "shift")},
                 "brierSkill": {"shift-raw": boot(per["brierSkill"], scored, "shift", "raw"),
                                "platt-raw": boot(per["brierSkill"], scored, "platt", "raw")}}
    passes = {}
    for c in ("shift", "platt"):
        t, b = intervals["t11su"][f"{c}-raw"], intervals["brierSkill"][f"{c}-raw"]
        passes[c] = {"t11suAboveZero": bool(t and t[0] > 0), "brierSkillLowerAboveMinus0.05": bool(b and b[0] > -0.05)}
        passes[c]["pass"] = passes[c]["t11suAboveZero"] and passes[c]["brierSkillLowerAboveMinus0.05"]
    # exploration-arm.json 'reported': per N_teach, units whose shift or platt fell back, by
    # reason, over the scored profiles and over all profiles.
    fallbacks = {str(n): {"scored": {}, "all": {}} for n in N_TEACH}
    for p, r in profiles.items():
        for n in N_TEACH:
            for c in ("shift", "platt"):
                reason = r["byNTeach"][str(n)]["teaching"][c]["fallback"]
                if reason:
                    for group in ("scored", "all") if p in scored else ("all",):
                        counts = fallbacks[str(n)][group]
                        counts[f"{c}|{reason}"] = counts.get(f"{c}|{reason}", 0) + 1
    fallbacks["units"] = {"scored": len(scored), "all": len(PROFILE_IDS)}
    return {"teachArticles": len(teach["ids"]), "testArticles": len(test["ids"]),
            "testRelevant": {p: profiles[p]["testRelevant"] for p in PROFILE_IDS},
            "scoredProfiles": scored, "macro": macro, "intervals": intervals, "pass": passes,
            "plattBeatsShift": bool(intervals["t11su"]["platt-shift"] and intervals["t11su"]["platt-shift"][0] > 0),
            "fallbackCounts": fallbacks, "perProfile": profiles}


def arm_verdict(protocols):
    """'pass' on one arm: both conditions in both protocols; the simpler (shift) wins unless
    platt beats shift in both protocols."""
    passes = {c: all(protocols[pr]["pass"][c]["pass"] for pr in PROTOCOLS) for c in ("shift", "platt")}
    platt_beats_shift = all(protocols[pr]["plattBeatsShift"] for pr in PROTOCOLS)
    if all(passes.values()):
        chosen = "platt" if platt_beats_shift else "shift"
    else:
        chosen = next((c for c in ("shift", "platt") if passes[c]), None)
    return passes, platt_beats_shift, chosen


if __name__ == "__main__":
    protocols = {pr: protocol_result(pr, "frozen") for pr in PROTOCOLS}
    passes, platt_beats_shift, chosen = arm_verdict(protocols)  # the frozen arm's verdict first
    exploration = {pr: protocol_result(pr, "exploration") for pr in PROTOCOLS}  # exploration-arm.json 'pass'
    x_passes, x_platt_beats_shift, x_chosen = arm_verdict(exploration)
    rule, addendum = json.loads(RULE.read_text()), json.loads(ADDENDUM.read_text())
    out = {
        "rule": {"file": "selection-rule.json", "sha256": sha(RULE)},
        "evaluate": {"sha256": sha(Path(__file__)), "round13": sha(ROUND13)},
        "smoke": bool(SMOKE),
        "test": {"slice": TEST_NAME, "articlesSha256": articles_sha, "labelsSha256": labels_sha,
                 "articles": len(ids), "window": list(WINDOW), "windowArticles": int(IN_WINDOW.sum()),
                 "answers": {"file": ANSWERS.name, "sha256": answers_sha, "model": answers_file["model"]["id"],
                             "server": answers_file.get("server"), "failedArticles": failed}},
        "pool": {"slice": "fresh-5", "labelsSha256": r12.TEST["hashes"]["labels.json"], "answersSha256": sha(r13.ANSWERS),
                 "failedArticles": r13.failed, "missingArticles": r13.missing},
        "environment": {"python": sys.version, "numpy": np.__version__, "scipy": scipy.__version__},
        "constants": {"seed": SEED, "replicates": REPLICATES, "nTeach": N_TEACH, "minRelevant": MIN_RELEVANT,
                      "utilityCut": UTILITY_CUT, "clip": CLIP},
        "pass": passes, "plattBeatsShiftInBoth": platt_beats_shift, "chosen": chosen,
        "verdict": rule["then"] if chosen else rule["noneEligible"],
        "protocols": protocols,
        "exploration": {
            "addendum": {"file": "exploration-arm.json", "sha256": sha(ADDENDUM)}, "seed": EXPLORATION_SEED,
            "pass": x_passes, "plattBeatsShiftInBoth": x_platt_beats_shift, "chosen": x_chosen,
            "onlyExplorationPasses": bool(x_chosen and not chosen),
            "verdict": addendum["then"] if x_chosen and not chosen else None,
            "protocols": exploration},
    }
    json.dump(out, open(SMOKE or HERE / "results.json", "w"), indent=1)
    brief = lambda arm: {pr: {k: v[k] for k in ("teachArticles", "testArticles", "testRelevant", "scoredProfiles",
                                                 "intervals", "pass", "fallbackCounts")}
                               | {"macroMean": v["macro"]["mean"], "keywordNarrow": v["macro"]["keywordNarrow"]}
                         for pr, v in arm.items()}
    print(json.dumps({k: out[k] for k in ("smoke", "test", "pass", "plattBeatsShiftInBoth", "chosen")} | brief(protocols)
                     | {"exploration": {k: out["exploration"][k] for k in ("pass", "plattBeatsShiftInBoth", "chosen")}
                        | brief(exploration)}, indent=1))
