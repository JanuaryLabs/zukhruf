"""Research round 16 of @zukhruf/relevance-filtering (#3523, after #3421): does a shrinkage
recalibration of d1-2B's probability from the reader's taught answers protect the yes/no
decisions of an interest whose boundary d1 draws in another place, without making the other
interests worse? The last recalibration round.

Implements selection-rule.json (sha256 ad38cb00..., its sha256 file checked). Loads round
15's frozen evaluate.py (sha256 c76aa252...) as a module in its real mode, as round 15 loads
round 13's: its test slice, fresh-6 (labels 9d8a3e8a..., d1 answers 89855665...), is round
16's teaching pool, and its pure helpers are reused: part, narrow_matches, logit and scores
(UtilityThreshold p >= 1/3 scored by T11SU, the reported metrics, MAP), and through it round 2
(platt_apply, topic_boot).
Run from round-16/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 --with nltk==3.9.2 python -I evaluate.py [--smoke OUT.json ANSWERS.json]
Without arguments: the test slice is fresh-7 (articles.json, labels.json and round-16's
d1-answers.json, each checked against its sha256 file), writes results.json. With --smoke
(a runnability check, not a result): fresh-4 stands in for the test slice with its frozen
labels, ANSWERS.json (round-15/collect.py's fresh-4 answers, collected under round 15's
rule, so the rule check of the answers is skipped) gives p_d1, the test slice is the
articles that ANSWERS.json holds, the window is 2025-04-01..2025-04-14, and the output goes
to OUT.json, which must be outside this research folder. Every other constant is the same.

Implementation choices fixed before the real run (the rule leaves them open):
- Test slice loading, ordering, UTC days, labels (true / null / false or missing), failed
  articles (p = 0) and the MAP check: exactly as round 15's evaluate.py.
- A profile's score of a calibrated condition is the mean over N_teach in {5, 10}; raw
  does not depend on N_teach. Bootstrap, pass and the triggered analysis use these means.
- Both MAP fits: Newton's method on the convex objective (prior + sum of log losses, hard
  targets) with a backtracking (Armijo) line search, from the prior's centre, until the
  gradient norm is below 1e-10 (at most 100 iterations). A unit with no taught answer keeps
  the prior's centre, which is raw.
- The point estimate of pass condition (3) is the macro mean of the calibration's T11SU
  minus the macro mean of raw's, over the scored profiles.
- Triggered: a profile is triggered for a calibration when, in at least one N_teach, the set
  of test articles with p >= 1/3 differs from raw's; all test articles count (ambiguous
  ones too), so the trigger reads no label. A protocol or a triggered set with no scored
  profile has no interval and passes nothing.
- The exploration draw is round 15's (from the teaching set's articles that the frozen arm
  does not show, in teaching-set order) with seed 31979.
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import scipy

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RULE = HERE / "selection-rule.json"
ROUND15 = ROOT / "round-15/evaluate.py"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def frozen(path):
    """The file's sha256, asserted equal to its <name>.sha256 file."""
    digest = sha(path)
    assert digest == path.with_suffix(".sha256").read_text().strip(), f"{path.relative_to(ROOT)} is not frozen"
    return digest


assert frozen(RULE).startswith("ad38cb00"), "round-16 selection-rule.json changed"
assert sha(ROUND15).startswith("c76aa252"), "round-15 evaluate.py changed"
if len(sys.argv) == 4 and sys.argv[1] == "--smoke":
    SMOKE, ANSWERS = Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
    assert ROOT not in SMOKE.parents, "smoke output must be written outside the research folder"
elif len(sys.argv) == 1:
    SMOKE, ANSWERS = None, HERE / "d1-answers.json"
else:
    sys.exit("usage: evaluate.py [--smoke OUT.json ANSWERS.json]")
sys.argv = sys.argv[:1]  # round 15 and the rounds under it read --smoke from argv: real mode
spec = importlib.util.spec_from_file_location("round15", ROUND15)
r15 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r15)
assert not r15.SMOKE
r2 = r15.r2

PROFILE_IDS = r15.PROFILE_IDS
ARMS = ["frozen", "exploration"]  # 'teaching.arms'
EXPLORATION_SEED = 31979  # 'teaching.arms'
N_TEACH = r15.N_TEACH  # 'teaching.arms': N_teach in {5, 10}
assert N_TEACH == [5, 10]
MIN_RELEVANT = r15.MIN_RELEVANT  # 'profiles'
assert MIN_RELEVANT == 20
SEED = 31978  # 'pass'
REPLICATES = 2000  # 'pass'
UTILITY_CUT = r15.UTILITY_CUT  # 'decisions.primary': p >= 1/3
assert UTILITY_CUT == 1 / 3
T11SU_MARGIN = 0.02  # 'pass' (1)
BRIER_MARGIN = 0.05  # 'pass' (2)
CALIBRATIONS = ["raw", "shift-map", "platt-map"]
PROTOCOLS = ["window", "pool"]
METRICS = r15.METRICS
TEST_NAME = "fresh-4" if SMOKE else "fresh-7"
WINDOW = ("2025-04-01", "2025-04-14") if SMOKE else ("2024-07-01", "2024-07-14")  # 'teaching.window'
assert sha(ROOT / "profiles.json").startswith("a5932290"), "profiles.json changed"

# ---------------------------------------------------------------- pool ('teaching.pool')
assert r15.TEST_NAME == "fresh-6"
assert r15.labels_sha.startswith("9d8a3e8a") and r15.answers_sha.startswith("89855665"), "the pool is not round 15's fresh-6"
POOL = r15.SLICE

# ---------------------------------------------------------------- test slice ('data.test', 'data.answers')
folder = ROOT / TEST_NAME
articles_sha, labels_sha = frozen(folder / "articles.json"), frozen(folder / "labels.json")
answers_sha = sha(ANSWERS) if SMOKE else frozen(ANSWERS)
answers_file = json.loads(ANSWERS.read_text())
assert answers_file["slice"] == TEST_NAME, answers_file["slice"]
assert answers_file["articlesSha256"] == articles_sha, "answers are for other articles"
assert answers_file["profilesSha256"] == sha(ROOT / "profiles.json"), "answers asked other profiles"
if not SMOKE:
    assert answers_file["rule"]["sha256"] == sha(RULE), "answers were collected under another rule"
articles = {a["id"]: a for a in json.loads((folder / "articles.json").read_text())}
label_rows = sorted(json.loads((folder / "labels.json").read_text()), key=lambda r: r["q"])
assert len({r["q"] for r in label_rows}) == len(label_rows)
assert sorted(r["id"] for r in label_rows) == sorted(articles), f"{TEST_NAME} labels must cover its articles exactly"
by_id = {r["id"]: r["answers"] for r in answers_file["rows"]}
if SMOKE:
    label_rows = [r for r in label_rows if r["id"] in by_id]
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


def protocol_sets(protocol):
    """'teaching.window' / 'teaching.pool': (teaching set, test part)."""
    if protocol == "window":
        return r15.part(SLICE, IN_WINDOW), r15.part(SLICE, ~IN_WINDOW)
    return POOL, SLICE


# ---------------------------------------------------------------- teaching ('teaching.arms')
def taught(profile, teach, n_show, arm, protocol):
    """Round 15's taught() with this round's exploration seed: the frozen arm shows the top N
    by p_d1 and the top N narrow-keyword matches by p_d1; the exploration arm adds N drawn
    uniformly without replacement from the other articles (teaching-set order),
    default_rng([31979, protocol, profile, n_teach]). Ambiguous answers are skipped."""
    p = teach["p"][profile]
    rel, amb = teach["labels"][profile]
    narrow = r15.narrow_matches(profile, teach["text"])
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
def map_fit(f, y, slope):
    """'calibrations.shift-map' (slope False: p = logistic(f + b), b ~ N(0, 1)) and
    'calibrations.platt-map' (slope True: p = logistic(a f + b), (a - 1, b) ~ N(0, I)): the
    maximum a posteriori parameters on hard targets, by Newton with a backtracking line search."""
    X = np.c_[f, np.ones_like(f)] if slope else np.ones((len(f), 1))
    centre = np.array([1.0, 0.0]) if slope else np.array([0.0])
    loss = lambda t: np.sum(np.logaddexp(0, X @ t) - y * (X @ t)) + 0.5 * np.sum((t - centre) ** 2)
    theta, cur = centre.copy(), loss(centre)
    for _ in range(100):
        s = 1 / (1 + np.exp(-(X @ theta)))
        g = X.T @ (s - y) + (theta - centre)
        if np.linalg.norm(g) < 1e-10:
            break
        H = X.T @ (X * (s * (1 - s))[:, None]) + np.eye(len(theta))
        d, step = -np.linalg.solve(H, g), 1.0
        while step > 1e-12:
            new = loss(theta + step * d)
            if new <= cur + 1e-4 * step * (g @ d):
                break
            step /= 2
        if step <= 1e-12:
            break
        theta, cur = theta + step * d, new
    return theta


def calibrate(profile, teach, test, n_show, arm, protocol):
    """The test part's p of each calibration, the fit and the trigger of each."""
    pos, neg, shown = taught(profile, teach, n_show, arm, protocol)
    raw = test["p"][profile]
    f = r15.logit(teach["p"][profile][pos + neg])
    y = np.r_[np.ones(len(pos)), np.zeros(len(neg))]
    f_test = r15.logit(raw)
    same = "all relevant" if pos and not neg else "all not relevant" if neg and not pos else "no answer" if not pos + neg else None
    info = {"shown": shown, "taughtRelevant": len(pos), "taughtNotRelevant": len(neg), "allSame": same}
    (b,) = map_fit(f, y, slope=False)
    out = {"raw": raw, "shift-map": r2.platt_apply(-1.0, -b, f_test)}
    info["shift-map"] = {"b": float(b), "fallback": None}
    a, b2 = map_fit(f, y, slope=True)
    if a <= 0:
        out["platt-map"], info["platt-map"] = raw, {"a": float(a), "b": float(b2), "fallback": "platt a <= 0"}
    else:
        out["platt-map"], info["platt-map"] = r2.platt_apply(-a, -b2, f_test), {"a": float(a), "b": float(b2), "fallback": None}
    for c in ("shift-map", "platt-map"):
        info[c]["changesDecisions"] = bool(np.any((out[c] >= UTILITY_CUT) != (raw >= UTILITY_CUT)))
    return out, info


# ---------------------------------------------------------------- per profile
def profile_run(profile, teach, test, arm, protocol):
    rel, amb = test["labels"][profile]
    lab = ~amb
    id_rank = np.unique(np.array(test["ids"], dtype=object), return_inverse=True)[1]
    narrow = r15.narrow_matches(profile, test["text"])
    kw_row = r2.metric_row(narrow[lab], narrow[lab].astype(float), rel[lab])
    by_n = {}
    for n in N_TEACH:
        probs, info = calibrate(profile, teach, test, n, arm, protocol)
        by_n[str(n)] = {"teaching": info, **{c: r15.scores(probs[c], rel, amb, id_rank) for c in CALIBRATIONS}}
    return {"testRelevant": int(rel.sum()), "testAmbiguous": int(amb.sum()), "testLabelled": int(lab.sum()),
            "baseRate": float(rel[lab].mean()),
            "keywordNarrow": {"t11su": kw_row["t11su"], "t11f": kw_row["f05"]},
            "mapRawD1": by_n[str(N_TEACH[0])]["raw"]["map"],
            "triggered": {c: any(by_n[str(n)]["teaching"][c]["changesDecisions"] for n in N_TEACH)
                          for c in ("shift-map", "platt-map")},
            "mean": {c: {m: float(np.mean([by_n[str(n)][c][m] for n in N_TEACH])) for m in METRICS} for c in CALIBRATIONS},
            "byNTeach": by_n}


# ---------------------------------------------------------------- protocol, macro, intervals, pass
def boot(per, profiles, a, b):
    """'pass': topic-level paired bootstrap, 2000 replicates, default_rng(31978) per call."""
    return r2.topic_boot(per, profiles, a, b, reps=REPLICATES, seed=SEED) if profiles else None


def macro(profiles, rows, c, m):
    return float(np.mean([rows[p]["mean"][c][m] for p in profiles])) if profiles else None


def protocol_result(protocol, arm):
    teach, test = protocol_sets(protocol)
    rows = {p: profile_run(p, teach, test, arm, protocol) for p in PROFILE_IDS}
    scored = [p for p in PROFILE_IDS if rows[p]["testRelevant"] >= MIN_RELEVANT]  # 'profiles'
    per = {m: {p: {c: rows[p]["mean"][c][m] for c in CALIBRATIONS} for p in scored} for m in ("t11su", "brierSkill")}
    macros = {"mean": {c: {m: macro(scored, rows, c, m) for m in METRICS} for c in CALIBRATIONS},
              "byNTeach": {str(n): {c: {m: (float(np.mean([rows[p]["byNTeach"][str(n)][c][m] for p in scored])) if scored else None)
                                        for m in METRICS} for c in CALIBRATIONS} for n in N_TEACH},
              "keywordNarrow": {m: (float(np.mean([rows[p]["keywordNarrow"][m] for p in scored])) if scored else None)
                                for m in ("t11su", "t11f")},
              "mapRawD1": (float(np.mean([rows[p]["mapRawD1"] for p in scored])) if scored else None)}
    intervals = {"t11su": {"shift-map-raw": boot(per["t11su"], scored, "shift-map", "raw"),
                           "platt-map-raw": boot(per["t11su"], scored, "platt-map", "raw"),
                           "platt-map-shift-map": boot(per["t11su"], scored, "platt-map", "shift-map")},
                 "brierSkill": {"shift-map-raw": boot(per["brierSkill"], scored, "shift-map", "raw"),
                                "platt-map-raw": boot(per["brierSkill"], scored, "platt-map", "raw")}}
    passes = {}
    for c in ("shift-map", "platt-map"):
        t, b = intervals["t11su"][f"{c}-raw"], intervals["brierSkill"][f"{c}-raw"]
        gain = macro(scored, rows, c, "t11su") - macro(scored, rows, "raw", "t11su") if scored else None
        passes[c] = {"t11suLowerAboveMinus0.02": bool(t and t[0] > -T11SU_MARGIN),
                     "brierSkillLowerAboveMinus0.05": bool(b and b[0] > -BRIER_MARGIN),
                     "t11suGain": gain, "t11suGainAboveZero": bool(gain is not None and gain > 0)}
        passes[c]["pass"] = all(passes[c][k] for k in ("t11suLowerAboveMinus0.02", "brierSkillLowerAboveMinus0.05",
                                                        "t11suGainAboveZero"))
    triggered = {}  # 'triggered': reported, not part of the pass rule
    for c in ("shift-map", "platt-map"):
        group = [p for p in scored if rows[p]["triggered"][c]]
        triggered[c] = {"profiles": group, "t11su": {"raw": macro(group, rows, "raw", "t11su"), c: macro(group, rows, c, "t11su")},
                        "interval": boot(per["t11su"], group, c, "raw")}
    all_same = {str(n): {"scored": {}, "all": {}} for n in N_TEACH}
    for p, r in rows.items():
        for n in N_TEACH:
            info = r["byNTeach"][str(n)]["teaching"]
            for reason in (info["allSame"], info["platt-map"]["fallback"]):
                if reason:
                    for group in ("scored", "all") if p in scored else ("all",):
                        all_same[str(n)][group][reason] = all_same[str(n)][group].get(reason, 0) + 1
    all_same["units"] = {"scored": len(scored), "all": len(PROFILE_IDS)}
    beats = intervals["t11su"]["platt-map-shift-map"]
    return {"teachArticles": len(teach["ids"]), "testArticles": len(test["ids"]),
            "testRelevant": {p: rows[p]["testRelevant"] for p in PROFILE_IDS},
            "scoredProfiles": scored, "macro": macros, "intervals": intervals, "pass": passes,
            "plattMapBeatsShiftMap": bool(beats and beats[0] > 0), "triggered": triggered,
            "unitCounts": all_same, "perProfile": rows}


def arm_verdict(protocols):
    """'pass' on one arm: all three conditions in both protocols; the simpler (shift-map) wins
    unless platt-map beats shift-map in both protocols."""
    passes = {c: all(protocols[pr]["pass"][c]["pass"] for pr in PROTOCOLS) for c in ("shift-map", "platt-map")}
    platt_beats_shift = all(protocols[pr]["plattMapBeatsShiftMap"] for pr in PROTOCOLS)
    if all(passes.values()):
        chosen = "platt-map" if platt_beats_shift else "shift-map"
    else:
        chosen = next((c for c in ("shift-map", "platt-map") if passes[c]), None)
    return passes, platt_beats_shift, chosen


if __name__ == "__main__":
    arms = {}
    for arm in ARMS:  # the frozen arm's verdict first
        protocols = {pr: protocol_result(pr, arm) for pr in PROTOCOLS}
        passes, platt_beats_shift, chosen = arm_verdict(protocols)
        arms[arm] = {"pass": passes, "plattMapBeatsShiftMapInBoth": platt_beats_shift, "chosen": chosen,
                     "protocols": protocols}
    rule = json.loads(RULE.read_text())
    frozen_chosen, exploration_chosen = arms["frozen"]["chosen"], arms["exploration"]["chosen"]
    verdict = ("frozen arm passes: " + rule["then"] if frozen_chosen else
               "only the exploration arm passes: " + rule["then"] if exploration_chosen else rule["noneEligible"])
    out = {
        "rule": {"file": "selection-rule.json", "sha256": sha(RULE)},
        "evaluate": {"sha256": sha(Path(__file__)), "round15": sha(ROUND15)},
        "smoke": bool(SMOKE),
        "test": {"slice": TEST_NAME, "articlesSha256": articles_sha, "labelsSha256": labels_sha,
                 "articles": len(ids), "window": list(WINDOW), "windowArticles": int(IN_WINDOW.sum()),
                 "answers": {"file": ANSWERS.name, "sha256": answers_sha, "model": answers_file["model"]["id"],
                             "server": answers_file.get("server"), "failedArticles": failed}},
        "pool": {"slice": "fresh-6", "labelsSha256": r15.labels_sha, "answersSha256": r15.answers_sha,
                 "failedArticles": r15.failed},
        "environment": {"python": sys.version, "numpy": np.__version__, "scipy": scipy.__version__},
        "constants": {"seed": SEED, "explorationSeed": EXPLORATION_SEED, "replicates": REPLICATES, "nTeach": N_TEACH,
                      "minRelevant": MIN_RELEVANT, "utilityCut": UTILITY_CUT, "t11suMargin": T11SU_MARGIN,
                      "brierMargin": BRIER_MARGIN, "clip": r15.CLIP},
        "chosen": {"frozen": frozen_chosen, "exploration": exploration_chosen},
        "verdict": verdict,
        "arms": arms,
    }
    json.dump(out, open(SMOKE or HERE / "results.json", "w"), indent=1)
    brief = {arm: {"pass": v["pass"], "chosen": v["chosen"],
                   **{pr: {"scoredProfiles": p["scoredProfiles"], "t11su": {c: p["macro"]["mean"][c]["t11su"] for c in CALIBRATIONS},
                           "brierSkill": {c: p["macro"]["mean"][c]["brierSkill"] for c in CALIBRATIONS},
                           "intervals": p["intervals"], "pass": p["pass"], "unitCounts": p["unitCounts"],
                           "triggered": p["triggered"]} for pr, p in v["protocols"].items()}}
             for arm, v in arms.items()}
    print(json.dumps({"smoke": out["smoke"], "test": out["test"], "chosen": out["chosen"], "verdict": verdict} | brief, indent=1))
