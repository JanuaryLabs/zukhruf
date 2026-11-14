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
# and the status of its ContractError. "registered" holds the questions that
# register_question prepares, by a name: a questionRef of a request names
# one of them, and each side replaces the name with its own handle. "handles"
# says if two questions get the same handle, and "refused registrations" holds
# the questions that register_question refuses. The requests and the answers
# have the names of the package: Venn's snake_case names are in camelCase.
# JSON has no NaN, so a NaN of a request is the string "NaN".
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
indexed = {"type": "IndexApply", "instructions": team["instructions"], "options": team["options"]}
rows = [ticket, sign_in, "Login problems", "Shipping and delivery"]
plural = [given, login, shipping, (rng.standard_normal(768) * 0.05).tolist(), raw["Checkout and payments"]]
answered |= {
    "index texts": {"state": {"texts": rows}, "questions": {"rows": indexed}},
    "index row cap": {"state": {"vectors": plural}, "questions": {
        "first": {**indexed, "row_cap": 3, "batch_size": 2}, "none": {**indexed, "row_cap": 0},
    }},
    "index threshold": {"state": {"vectors": plural}, "questions": {"rows": {**indexed, "threshold": 0.9}}},
    # The threshold that "team" was registered with is not part of the question.
    "reference": {"state": {"text": sign_in}, "questions": {"team": {"question_ref": "team"}}},
    "reference rows": {"state": {"texts": rows}, "questions": {"rows": {"question_ref": "rows"}}},
    "reference overrides": {"state": {"text": sign_in}, "questions": {"team": {"question_ref": "team", "threshold": 0.9}}},
    "reference rows overrides": {"state": {"texts": rows}, "questions": {
        "rows": {"question_ref": "rows", "threshold": 0.9, "row_cap": 3, "batch_size": 2},
    }},
    "reference kinds": {"state": ticket, "questions": {
        "urgency": {"question_ref": "urgency"}, "defect": {"question_ref": "defect", "threshold": 0.2},
    }},
    # Given vectors that are not unit vectors.
    "reference rows vectors": {"state": {"vectors": plural}, "questions": {"rows": {"question_ref": "rows", "row_cap": 5}}},
}
registered = {
    "team": {**team, "threshold": 0.9}, "rows": {**indexed, "row_cap": 1},
    "urgency": {**urgency, "scores": [0, 5, 10]}, "defect": defect,
}
pairs = {
    "the same question": (team, json.loads(json.dumps(team)), True),
    "the keys in another order": (team, dict(reversed(team.items())), True),
    "another threshold": ({**team, "threshold": 0.2}, {**team, "threshold": 0.9}, True),
    "another option": (team, {**team, "options": team["options"][:2]}, False),
    "another type": (team, {**team, "type": "IndexApply"}, False),
    "another row cap": (indexed, {**indexed, "row_cap": 1}, False),
}
unregistrable = [
    {**team, "type": "Ranking"},
    {**team, "options": []},
    {**team, "options": ["Login problems", "Login problems"]},
    {**team, "instructions": ""},
    {"instructions_vec": given[:100], "options": team["options"]},
]
# The smallest 768 numbers in JSON.
one_hot = [1] + [0] * 767
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
    {"state": {"vectors": [given, login]}, "questions": {"team": team}},
    {"state": {"vectors": []}, "questions": {"rows": indexed}},
    {"state": {"vectors": [given, given[:100]]}, "questions": {"rows": indexed}},
    {"state": {"vectors": [given, [float("nan")] + given[1:]]}, "questions": {"rows": indexed}},
    {"state": {"vectors": [given, [0.0] * 768]}, "questions": {"rows": indexed}},
    {"state": {"texts": [ticket, ""]}, "questions": {"rows": indexed}},
    {"state": {"texts": []}, "questions": {"rows": indexed}},
    {"state": {"texts": [ticket] * 513}, "questions": {"rows": indexed}},
    # Venn counts the texts before it checks the kinds of the state.
    {"state": {"texts": [], "vector": given}, "questions": {"rows": indexed}},
    {"state": {"vectors": [one_hot] * 513}, "questions": {"rows": indexed}},
    {"state": {"texts": [ticket], "vector": given}, "questions": {"rows": indexed}},
    {"state": {"texts": [ticket], "vectors": [given]}, "questions": {"rows": indexed}},
    {"state": {"texts": [ticket], "text": sign_in}, "questions": {"rows": indexed}},
    # With a text, Venn does not count the texts.
    {"state": {"texts": [], "text": sign_in}, "questions": {"rows": indexed}},
    {"state": ticket, "questions": {"rows": indexed}},
    {"state": {"vector": given}, "questions": {"rows": indexed}},
    *({"state": {"vectors": [one_hot, one_hot]}, "questions": {"rows": {**indexed, **limit}}} for limit in [
        {"row_cap": -1}, {"row_cap": 1_000_001}, {"row_cap": 1.5},
        {"batch_size": 0}, {"batch_size": 65_537}, {"batch_size": 2.5},
        {"row_cap": 513}, {"row_cap": 1_000_000},
    ]),
    {"state": ticket, "questions": {"team": {"question_ref": "unregistered"}}},
    *({"state": ticket, "questions": {"team": {"question_ref": "team", **override}}} for override in [
        {"options": team["options"][:2]}, {"instructions": "How urgent is it?"}, {"type": "Score"},
    ]),
]
RENAMES = {
    "instructions_vec": "instructionsVec",
    "expected_score": "expectedScore",
    "score_conditioned_on_not_none": "scoreConditionedOnNotNone",
    "question_ref": "questionRef",
    "row_cap": "rowCap",
    "batch_size": "batchSize",
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

handles = {name: service.register_question(name, question) for name, question in registered.items()}


def referenced(request):
    """The request with each question_ref that names a registered question replaced by Venn's handle."""
    return {**request, "questions": {
        name: {**question, "question_ref": handles.get(question["question_ref"], question["question_ref"])}
        if "question_ref" in question else question
        for name, question in request["questions"].items()
    }}


cases = {"answered": {}, "refused": [], "registered": registered, "handles": [], "refused registrations": []}
for name, request in answered.items():
    response = service.decide(referenced(request))
    cases["answered"][name] = {"request": request, "answers": response["answers"], "vector": response["vector"]}
got = {name: case["answers"] for name, case in cases["answered"].items()}
tie = got["tie"]["team"]
assert tie["answer"] == "login" and tie["probabilities"]["login"] == tie["probabilities"]["sign-in"] == tie["confidence"], tie
assert got["labels"]["team"] == got["kinds"]["team"]
assert got["noul in scope"]["defect"]["answer"] == "in_scope"
assert got["noul none"]["defect"]["answer"] == "none"
assert [row["id"] for row in got["index texts"]["rows"]["rows"]] == list(range(len(rows)))
assert (len(got["index row cap"]["first"]["rows"]), got["index row cap"]["first"]["batches"]) == (3, 2)
assert got["index row cap"]["none"] == {"rows": [], "batches": 0}
thresholded = [row["answer"] for row in got["index threshold"]["rows"]["rows"]]
assert "none" in thresholded and any(answer != "none" for answer in thresholded), thresholded
assert got["reference"]["team"]["answer"] != "none" and got["reference overrides"]["team"]["answer"] == "none"
assert len(got["reference rows"]["rows"]["rows"]) == 1
assert got["reference kinds"]["urgency"] == got["scores"]["urgency"]
assert len(got["reference rows vectors"]["rows"]["rows"]) == len(plural)
for request in refused:
    try:
        service.decide(referenced(request))
        raise AssertionError(f"Venn answered {request}")
    except ContractError as error:
        cases["refused"].append({"request": request, "code": error.code, "status": error.status})
for name, (first, second, same) in pairs.items():
    assert (service.register_question(name, first) == service.register_question(name, second)) == same, name
    cases["handles"].append({"name": name, "questions": [first, second], "same": same})
for question in unregistrable:
    try:
        service.register_question("refused", question)
        raise AssertionError(f"Venn registered {question}")
    except ContractError as error:
        cases["refused registrations"].append({"question": question, "code": error.code, "status": error.status})
(HERE / "expected.json").write_text(json.dumps(port({"raw": raw, **cases}), allow_nan=False, separators=(",", ":")) + "\n")
