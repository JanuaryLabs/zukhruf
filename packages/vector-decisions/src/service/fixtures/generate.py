# /// script
# requires-python = "==3.12.9"
# dependencies = [
#   "venn-vdm @ git+https://github.com/markrussinovich/venn-vdm@7b2042e84608fbdd143ac21dea7c83d5ae2ec723",
#   "torch==2.15.0",
#   "numpy==2.5.4",
# ]
# ///
# Makes the fixture of the DecisionService tests with Venn's own
# DecisionService.decide and the venn-1 head, at the commit that the package
# ports:
# uv run --no-project packages/vector-decisions/src/service/fixtures/generate.py
#
# expected.json holds the raw vector that a reader gives for each text (the
# supplied embedder of the service), the requests that Venn answers, by a
# name, with its "answers" and "vector" (the state's vector when the service
# embedded it, else null), and the requests that Venn refuses, with the code
# and the status of its ContractError. The requests and the answers have the
# names of the package: Venn's instructions_vec, expected_score and
# score_conditioned_on_not_none are in camelCase. JSON has no NaN, so a NaN
# of a request is the string "NaN".
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import math
import os
import platform
import tempfile
from pathlib import Path

VERSIONS = {"venn-vdm": "0.1.0", "torch": "2.15.0", "numpy": "2.5.4"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()
os.environ["VENN_HOME"] = tempfile.mkdtemp(prefix="venn-home-")

import numpy as np

from venn.cli import download_head
from venn.errors import ContractError
from venn.server import DecisionService

HERE = Path(__file__).resolve().parent
rng = np.random.default_rng(20261115)
TEXTS = [
    "The checkout page is broken and my card was charged twice",
    "I cannot sign in with my password",
    "Who owns this ticket?",
    "Login problems",
    "Checkout and payments",
    "Shipping and delivery",
    "How urgent is it?",
    "Can wait",
    "Should be fixed soon",
    "Blocking",
    "Is the software broken?",
    "A request or a question",
    "The software is broken",
    "What is the topic?",
]
raw = {text: (rng.standard_normal(768) * 0.05).tolist() for text in TEXTS}
state = Path(tempfile.mkdtemp(prefix="venn-state-"))
service = DecisionService(
    embed=lambda batch: np.array([raw[text] for text in batch]),
    cache_path=state / "cache.sqlite",
    registry_path=state / "calibrations.json",
    model_dir=download_head(),
)
ticket, sign_in = TEXTS[0], TEXTS[1]
team = {"type": "Choice", "instructions": "Who owns this ticket?",
        "options": ["Login problems", "Checkout and payments", "Shipping and delivery"]}
urgency = {"type": "Score", "instructions": "How urgent is it?", "options": ["Can wait", "Should be fixed soon", "Blocking"]}
defect = {"type": "Noul", "instructions": "Is the software broken?", "options": ["A request or a question", "The software is broken"]}
given = (rng.standard_normal(768) * 3).tolist()
login, shipping = raw["Login problems"], raw["Shipping and delivery"]
answered = {
    "kinds": {"state": ticket, "questions": {"team": team, "urgency": urgency, "defect": defect}},
    "thresholds": {"state": {"text": sign_in}, "questions": {"team": {**team, "threshold": 0.9}, "defect": {**defect, "threshold": 0.2}}},
    "scores": {"state": ticket, "questions": {"urgency": {**urgency, "scores": [0, 5, 10]}}},
    "score threshold": {"state": ticket, "questions": {"urgency": {**urgency, "threshold": 0.9}}},
    "defaults": {"state": ticket, "questions": {"topic": {"options": ["Login problems", "Checkout and payments"]}}},
    "given": {"state": {"vector": given}, "questions": {"team": {
        "type": "Choice", "instructions_vec": raw["Who owns this ticket?"],
        "options": [{"label": "login", "vector": login}, {"label": "checkout", "vector": raw["Checkout and payments"]}],
    }}},
    # Two options with the same vector have the same probability.
    "tie": {"state": {"vector": login}, "questions": {"team": {**team, "options": [
        {"label": "login", "vector": login}, {"label": "sign-in", "vector": login}, {"label": "shipping", "vector": shipping},
    ]}}},
    "labels": {"state": ticket, "questions": {"team": {**team, "options": [{"label": option} for option in team["options"]]}}},
}
refused = [
    {"state": ticket, "questions": {}},
    {"state": ticket, "questions": {f"q{i}": team for i in range(33)}},
    {"state": ticket, "questions": {"team": {**team, "options": []}}},
    {"state": ticket, "questions": {"team": {**team, "options": ["Can wait"] * 257}}},
    {"state": ticket, "questions": {"team": {**team, "options": ["Login problems", "Login problems"]}}},
    {"state": ticket, "questions": {"team": {**team, "options": [{"label": "none", "vector": login}]}}},
    {"state": ticket, "questions": {"team": {**team, "threshold": 1.5}}},
    {"state": ticket, "questions": {"team": {**team, "threshold": -0.1}}},
    {"state": ticket, "questions": {"team": {**team, "threshold": float("nan")}}},
    {"state": ticket, "questions": {"urgency": {**urgency, "scores": [0, 5]}}},
    {"state": ticket, "questions": {"urgency": {**urgency, "scores": [0, float("nan"), 10]}}},
    {"state": "", "questions": {"team": team}},
    {"state": "x" * 32769, "questions": {"team": team}},
    {"state": {"vector": given[:100]}, "questions": {"team": team}},
    {"state": {"vector": [float("nan")] + given[1:]}, "questions": {"team": team}},
    {"state": {"vector": [0.0] * 768}, "questions": {"team": team}},
    {"state": {"texts": [ticket, sign_in]}, "questions": {"team": team}},
    {"state": ticket, "questions": {"team": {**team, "type": "Ranking"}}},
]
RENAMES = {
    "instructions_vec": "instructionsVec",
    "expected_score": "expectedScore",
    "score_conditioned_on_not_none": "scoreConditionedOnNotNone",
}


def port(value):
    """The value with the names of the package, and each NaN as "NaN"."""
    if isinstance(value, dict):
        return {RENAMES.get(key, key): port(item) for key, item in value.items()}
    if isinstance(value, list):
        return [port(item) for item in value]
    if isinstance(value, float) and math.isnan(value):
        return "NaN"
    return value


# A Noul question without a threshold answers "none" from a probability of
# 0.5. The search draws state vectors until it finds one with a probability
# of "none" in (0.2, 0.5) and one in [0.5, 0.9).
search = np.random.default_rng(20261116)
bounds = {"noul in scope": (0.2, 0.5), "noul none": (0.5, 0.9)}
for _ in range(10_000):
    if all(name in answered for name in bounds):
        break
    request = {"state": {"vector": (search.standard_normal(768)).tolist()}, "questions": {"defect": defect}}
    none = service.decide(request)["answers"]["defect"]["probabilities"]["none"]
    for name, (low, high) in bounds.items():
        if name not in answered and (low < none < high if name == "noul in scope" else low <= none < high):
            answered[name] = request
assert all(name in answered for name in bounds), answered.keys()

cases = {"answered": {}, "refused": []}
for name, request in answered.items():
    response = service.decide(request)
    cases["answered"][name] = {"request": request, "answers": response["answers"], "vector": response["vector"]}
tie = cases["answered"]["tie"]["answers"]["team"]
assert tie["answer"] == "login" and tie["probabilities"]["login"] == tie["probabilities"]["sign-in"] == tie["confidence"], tie
assert cases["answered"]["labels"]["answers"]["team"] == cases["answered"]["kinds"]["answers"]["team"]
assert cases["answered"]["noul in scope"]["answers"]["defect"]["answer"] == "in_scope"
assert cases["answered"]["noul none"]["answers"]["defect"]["answer"] == "none"
for request in refused:
    try:
        service.decide(request)
        raise AssertionError(f"Venn answered {request}")
    except ContractError as error:
        cases["refused"].append({"request": request, "code": error.code, "status": error.status})
(HERE / "expected.json").write_text(json.dumps(port({"raw": raw, **cases}), allow_nan=False) + "\n")
