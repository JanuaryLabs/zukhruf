"""Research round 14 of @zukhruf/relevance-filtering (#3383, limitation 16): does d1's lead
over desc+kw hold when a second AI family writes fresh-5's answer key?

Implements selection-rule.json (sha256 08e4956e...). Loads round 13's frozen evaluate.py
(sha256 3736b270...) as a module: its pool, stream, d1 answers and profile_run(), and through
it round 12's orders() and daily(). Only the test labels change. No order reads the test
labels (round 10's probabilities() and round 12's taught() read the pool's labels only), so
every list is round 13's list.
Run from round-14/:
  uv run --no-project --python 3.13 --with numpy==2.3.4 --with scikit-learn==1.7.2 \
    --with scipy==1.16.2 --with nltk==3.9.2 python -I evaluate.py [--claude OUT.json]
Without arguments: the GPT labels (labels-gpt.json, its sha256 file checked), seed 31967,
writes results.json. With --claude: fresh-5/labels.json and round 13's seed 31966; the output
must equal round-13/results.json, which is asserted, and goes to OUT.json.
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ROUND13 = ROOT / "round-13/evaluate.py"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


assert sha(ROUND13).startswith("3736b270"), "round-13 evaluate.py changed"
CHECK = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--claude" else None
sys.argv = sys.argv[:1]  # round 13 and the rounds under it read --smoke from argv
spec = importlib.util.spec_from_file_location("round13", ROUND13)
r13 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r13)
assert not r13.SMOKE
r12, r2 = r13.r12, r13.r2
SEED = r13.SEED if CHECK else 31967
PROFILE_IDS = r13.PROFILE_IDS
NAMES, D1, REFS, BASES = r13.NAMES, r13.D1, r13.REFS, r13.BASES

# ---------------------------------------------------------------- labels
items = sorted(json.loads((ROOT / "fresh-5/items.json").read_text()), key=lambda i: i["q"])
assert [i["id"] for i in items] == r13.STREAM["ids"], "stream order is not fresh-5's q order"
if CHECK:
    LABELS = ROOT / "fresh-5/labels.json"
else:
    LABELS = HERE / "labels-gpt.json"
    assert sha(LABELS) == (HERE / "labels-gpt.sha256").read_text().strip(), "labels-gpt.json not frozen"
rows = {r["q"]: r["labels"] for r in json.loads(LABELS.read_text())}
assert sorted(rows) == [i["q"] for i in items], "the labels must cover fresh-5 exactly"
lab = [rows[i["q"]] for i in items]
CLAUDE = dict(r13.STREAM["labels"])
r13.STREAM["labels"] = {p: (np.array([l.get(p, False) is True for l in lab]),
                            np.array([l.get(p, False) is None for l in lab])) for p in PROFILE_IDS}


def kappa(a, b):
    po = float(np.mean(a == b))
    pa, pb = a.mean(), b.mean()
    pe = pa * pb + (1 - pa) * (1 - pb)
    return float((po - pe) / (1 - pe)) if pe < 1 else float("nan")


def agreement(profile):
    (c_rel, c_amb), (g_rel, g_amb) = CLAUDE[profile], r13.STREAM["labels"][profile]
    c_any, g_any = c_rel | c_amb, g_rel | g_amb
    return {"claudeTrue": int(c_rel.sum()), "gptTrue": int(g_rel.sum()), "bothTrue": int((c_rel & g_rel).sum()),
            "trueVsNull": int(((c_rel & g_amb) | (c_amb & g_rel)).sum()),
            "trueVsFalse": int(((c_rel & ~g_any) | (~c_any & g_rel)).sum()),
            "kappaStrict": kappa(c_rel, g_rel), "kappaAmbiguousRelevant": kappa(c_any, g_any)}


# ---------------------------------------------------------------- run (round 13's main, seed above)
if __name__ == "__main__":
    results = {p: r13.profile_run(p) for p in PROFILE_IDS}
    map_scored = [p for p in PROFILE_IDS if results[p]["strictRelevant"] >= r12.MIN_RELEVANT]
    day_scored = [p for p in PROFILE_IDS if results[p]["relevantDays"] >= r12.MIN_DAYS]
    map_pp, map_macro = r13.per_and_macro(results, map_scored, lambda r, nm: r["ap"][nm], NAMES)
    day_pp, day_macro = r13.per_and_macro(results, day_scored, lambda r, nm: r["daily"][nm]["recall"], NAMES)
    boot = lambda per, scored, a, b: r2.topic_boot(per, scored, a, b, seed=SEED)
    map_iv = {r: {b: boot(map_pp, map_scored, r, b) for b in REFS + BASES} for r in D1}
    day_iv = {r: {b: boot(day_pp, day_scored, r, b) for b in REFS + BASES} for r in D1}
    holds = bool(map_iv["d1"]["desc+kw"][0] > 0 and day_iv["d1"]["desc+kw"][0] > -0.05)
    dec_pp = {p: {"d1>=0.5": results[p]["decision"]["d1>=0.5"]["f05"],
                  "keywordNarrow": results[p]["decision"]["keywordNarrow"]["f05"]} for p in map_scored}
    dec_macro = {k: float(np.mean([dec_pp[p][k] for p in map_scored])) for k in ("d1>=0.5", "keywordNarrow")}
    brier = {p: results[p]["decision"]["d1>=0.5"]["brierSkill"] for p in map_scored}
    decision = {"perProfileT11F": dec_pp, "macroT11F": dec_macro,
                "intervalVsKeywordNarrow": boot(dec_pp, map_scored, "d1>=0.5", "keywordNarrow"),
                "perProfileBrierSkill": brier, "macroBrierSkill": float(np.mean(list(brier.values())))}
    out = {
        "rule": {"file": "selection-rule.json", "sha256": sha(HERE / "selection-rule.json")},
        "evaluate": {"sha256": sha(Path(__file__)), "round13": sha(ROUND13)},
        "labels": {"file": str(LABELS.relative_to(ROOT)), "sha256": sha(LABELS)},
        "seed": SEED, "holds": holds,
        "map": {"scoredProfiles": map_scored, "macro": map_macro, "intervals": map_iv, "perProfile": map_pp},
        "daily": {"scoredProfiles": day_scored, "macroRecall": day_macro, "intervals": day_iv, "perProfile": day_pp},
        "decision": decision,
        "agreement": {p: agreement(p) for p in PROFILE_IDS},
    }
    if CHECK:
        frozen = json.loads((ROOT / "round-13/results.json").read_text())
        close = lambda a, b: (abs(a - b) <= 1e-12) if isinstance(a, float) else (
            len(a) == len(b) and all(close(x, y) for x, y in zip(a, b)) if isinstance(a, (list, tuple)) else
            all(close(a[k], b[k]) for k in a) if isinstance(a, dict) else a == b)
        for block, key in (("map", "macro"), ("map", "intervals"), ("daily", "macroRecall"), ("daily", "intervals")):
            assert close(out[block][key], frozen[block][key]), f"{block}.{key} differs from round 13"
        assert close(decision, {k: frozen["decision"][k] for k in decision}), "decision differs from round 13"
        assert all(a["trueVsNull"] == a["trueVsFalse"] == 0 for a in out["agreement"].values())
    json.dump(out, open(CHECK or HERE / "results.json", "w"), indent=1)
    print(json.dumps({"labels": out["labels"], "seed": SEED, "holds": holds,
                      "map": {"scoredProfiles": map_scored, "macro": map_macro,
                              "d1VsDesc+kw": map_iv["d1"]["desc+kw"]},
                      "daily": {"scoredProfiles": day_scored, "macroRecall": day_macro,
                                "d1VsDesc+kw": day_iv["d1"]["desc+kw"]},
                      "decision": {k: decision[k] for k in ("macroT11F", "intervalVsKeywordNarrow", "macroBrierSkill")},
                      "kappaStrict": {p: round(a["kappaStrict"], 3) for p, a in out["agreement"].items()}}, indent=1))
