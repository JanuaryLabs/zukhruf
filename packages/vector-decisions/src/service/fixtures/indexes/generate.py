# /// script
# requires-python = "==3.12.9"
# dependencies = [
#   "venn-vdm @ git+https://github.com/markrussinovich/venn-vdm@7b2042e84608fbdd143ac21dea7c83d5ae2ec723",
#   "torch==2.15.0",
#   "numpy==2.5.4",
# ]
# ///
# Makes the fixture of the tests of registered indexes with Venn's own
# DecisionService.register_index, index, decide and stream_index, with a
# supplied embedder and the venn-1 head, at the commit that the package ports:
# uv run --no-project packages/vector-decisions/src/service/fixtures/indexes/generate.py
#
# expected.json holds:
# - "raw": the raw vector that the reader gives for each text.
# - "pool": raw vectors that are not unit vectors. The rows of an index are
#   places in the pool, so an index of 600 rows stays small in JSON.
# - "indexes": the indexes that register_index registers, by a name: their
#   rows, ids and outcomes, the handle that Venn gives, and for "small" the
#   unit float32 vectors that Venn's index(handle) gives.
# - "handles": pairs of registrations, and if Venn gives them the same handle.
# - "refused indexes": the registrations that Venn refuses, with the code and
#   the status of its ContractError.
# - "calibrations": the calls of register_calibration before the decisions,
#   each with the temperature that Venn fits.
# - "answered" and "refused": requests of decide, as in the fixture of
#   src/service. An "indexRef" names an index of "indexes", and a
#   "questionRef" a question of "registered": each side replaces the name with
#   its own handle.
# - "streamed" and "refused streams": calls of stream_index, by the name of
#   the index, with the lines that Venn yields (each parsed from its NDJSON),
#   or the code and the status of its ContractError.
# - "refused registrations": the questions that register_question refuses.
# The requests and the answers have the names of the package: Venn's
# snake_case names are in camelCase. JSON has no NaN, so a NaN of a request is
# the string "NaN".
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
rng = np.random.default_rng(20261118)
TEXTS = [
    "The checkout page is broken and my card was charged twice",
    "I cannot sign in with my password",
    "Who owns this ticket?",
    "Login problems",
    "Checkout and payments",
    "Shipping and delivery",
]
raw = {text: (rng.standard_normal(768) * 0.05).tolist() for text in TEXTS}
# Rows of several sizes, none a unit vector.
pool = [(rng.standard_normal(768) * scale).tolist() for scale in [0.05, 3, 0.4, 1.7, 0.02, 9, 0.6, 2.2, 0.08, 5, 0.3, 1.1]]
# Rows near the vector of each option, which the head answers with the
# option, so that a threshold turns some of them into "none". A generator of
# their own leaves the draws above as they were.
near = np.random.default_rng(20261115)
pool += [(np.array(raw[option]) + near.standard_normal(768) * scale).tolist()
         for scale in [0.1, 0.2, 0.3] for option in ["Login problems", "Checkout and payments", "Shipping and delivery"]]
state = Path(tempfile.mkdtemp(prefix="venn-state-"))
service = DecisionService(
    embed=lambda batch: np.array([raw[text] for text in batch]),
    cache_path=state / "cache.sqlite",
    registry_path=state / "calibrations.json",
    model_dir=download_head(),
)
ticket, sign_in = TEXTS[0], TEXTS[1]
team = {"instructions": "Who owns this ticket?", "options": ["Login problems", "Checkout and payments", "Shipping and delivery"]}
indexed = {"type": "IndexApply", **team}
LABELS = ["login", "checkout", "shipping"]
indexes = {
    "small": {"rows": [0, 1, 2, 3], "ids": ["a", "b", "c", "d"], "outcomes": None},
    "labelled": {"rows": list(range(10)), "ids": [f"t{i}" for i in range(10)], "outcomes": [LABELS[i % 3] for i in range(10)]},
    # Python's json.dumps escapes each character outside printable ASCII, a
    # character above U+FFFF as two surrogates.
    "unicode": {"rows": [4, 5, 6], "ids": ["café", "日本", "😀 \"q\" \\ \x7f\n\t\x01"], "outcomes": ["é", "ü", "😀"]},
    # Integer ids and outcomes, as Venn's demos.py registers ids; a label is
    # str() of its outcome.
    "integers": {"rows": [7, 8, 9, 10], "ids": [1, 2, "c", 4], "outcomes": [10, 2, 10, 2]},
    # Two rows twice, under two labels: the scores of the labels tie, and so
    # do the scores of the rows.
    "ties": {"rows": [0, 0, 1, 1, 2], "ids": ["p", "q", "r", "s", "u"], "outcomes": ["b", "a", "a", "b", "c"]},
    # The same ties under whole numbers, which np.unique sorts by value, and
    # under a character above U+FFFF, which it sorts by code point after
    # U+FF5E, where UTF-16 would put it before.
    "integer ties": {"rows": [0, 0, 1, 1, 2], "ids": ["p", "q", "r", "s", "u"], "outcomes": [10, 2, 2, 10, 3]},
    "astral ties": {"rows": [0, 0, 1, 1, 2], "ids": ["p", "q", "r", "s", "u"], "outcomes": ["\U0001F600", "\uFF5E", "\uFF5E", "\U0001F600", "a"]},
    "near the options": {"rows": list(range(12, 21)), "ids": [f"n{i}" for i in range(9)], "outcomes": None},
    "one label": {"rows": [0, 1, 2], "ids": ["x", "y", "z"], "outcomes": ["same", "same", "same"]},
    # np.asarray([1, "1"]) is the strings ["1", "1"]: one label.
    "one mixed label": {"rows": [0, 1], "ids": ["x", "y"], "outcomes": [1, "1"]},
    "over decide": {"rows": [i % 12 for i in range(513)], "ids": [f"o{i}" for i in range(513)], "outcomes": None},
    "wide": {"rows": [i % 12 for i in range(600)], "ids": [f"r{i}" for i in range(600)], "outcomes": None},
}


def vectors(rows):
    return [pool[row] for row in rows]


handles = {name: service.register_index(vectors(spec["rows"]), spec["ids"], spec["outcomes"]) for name, spec in indexes.items()}
for name, spec in indexes.items():
    spec["handle"] = handles[name]
small = service.index(handles["small"])
indexes["small"]["vectors"] = small["vectors"].tolist()
assert small["ids"] == indexes["small"]["ids"] and small["outcomes"] is None

doubled = [[2 * value for value in row] for row in vectors([0, 1, 2, 3])]
pairs = {
    "the same index": ((vectors([0, 1]), ["a", "b"], None), (vectors([0, 1]), ["a", "b"], None), True),
    # Twice a row is the same unit vector, bit for bit.
    "the rows times two": ((vectors([0, 1, 2, 3]), ["a", "b", "c", "d"], None), (doubled, ["a", "b", "c", "d"], None), True),
    "other ids": ((vectors([0, 1]), ["a", "b"], None), (vectors([0, 1]), ["a", "c"], None), False),
    "outcomes": ((vectors([0, 1]), ["a", "b"], None), (vectors([0, 1]), ["a", "b"], ["p", "q"]), False),
    "other rows": ((vectors([0, 1]), ["a", "b"], None), (vectors([0, 2]), ["a", "b"], None), False),
    "integer ids against strings": ((vectors([0, 1]), [1, 2], None), (vectors([0, 1]), ["1", "2"], None), False),
}
cases = {"raw": raw, "pool": pool, "indexes": indexes, "handles": [], "refused indexes": []}
for name, (first, second, same) in pairs.items():
    assert (service.register_index(*first) == service.register_index(*second)) == same, name
    cases["handles"].append({"name": name, "indexes": [
        {"vectors": vectors_, "ids": ids, "outcomes": outcomes} for vectors_, ids, outcomes in (first, second)
    ], "same": same})
row = pool[0]
refused_indexes = [
    {"vectors": [row, row[:100]], "ids": ["a", "b"], "outcomes": None},
    {"vectors": [row, [float("nan")] + row[1:]], "ids": ["a", "b"], "outcomes": None},
    # A finite float64 that is infinite in float32.
    {"vectors": [row, [1e39] + row[1:]], "ids": ["a", "b"], "outcomes": None},
    {"vectors": [], "ids": [], "outcomes": None},
    {"vectors": [row, [0.0] * 768], "ids": ["a", "b"], "outcomes": None},
    # The vectors are checked before the ids.
    {"vectors": [row, [0.0] * 768], "ids": ["a"], "outcomes": None},
    {"vectors": [row, row[:100]], "ids": ["a"], "outcomes": None},
    {"vectors": [row, [float("nan")] + row[1:]], "ids": ["a", "a"], "outcomes": None},
    {"vectors": [row, pool[1]], "ids": ["a"], "outcomes": None},
    {"vectors": [row, pool[1]], "ids": ["a", "b", "c"], "outcomes": None},
    {"vectors": [row, pool[1]], "ids": ["a", "a"], "outcomes": None},
    # Python's str() of 1 is "1".
    {"vectors": [row, pool[1]], "ids": [1, "1"], "outcomes": None},
    {"vectors": [row, pool[1]], "ids": ["a", "b"], "outcomes": ["p"]},
    {"vectors": [row, pool[1]], "ids": ["a", "a"], "outcomes": ["p"]},
]
for spec in refused_indexes:
    try:
        service.register_index(spec["vectors"], spec["ids"], spec["outcomes"])
        raise AssertionError(f"Venn registered {spec}")
    except ContractError as error:
        cases["refused indexes"].append({**spec, "code": error.code, "status": error.status})
# Over decide's 512 rows, an index takes the rows that it can stream.
assert service.index(handles["over decide"])["vectors"].shape == (513, 768)
try:
    service.index("unregistered")
    raise AssertionError("Venn gave an unregistered index")
except ContractError as error:
    cases["unknown index"] = {"code": error.code, "status": error.status}

# The calibrations that the decisions read: of NearestReference and of
# Choice in the family "tickets".
calibrations = []
for kind, columns, scale in [("NearestReference", 2, 0.7), ("Choice", 4, 2.5)]:
    logits = (rng.standard_normal((300, columns)) * scale)
    targets = rng.integers(0, columns, 300)
    logits[np.arange(300), targets] += 1.0
    logits, targets = np.round(logits, 4).tolist(), targets.tolist()
    temperature = service.register_calibration("tickets", logits, targets, kind)
    calibrations.append({"family": "tickets", "kind": kind, "logits": logits, "targets": targets, "temperature": temperature})
cases["calibrations"] = calibrations

nearest = {"type": "NearestReference", "index_ref": "labelled"}
given = (rng.standard_normal(768) * 3).tolist()
registered = {"rows": {**indexed, "row_cap": 4}}
question_handles = {name: service.register_question(name, question) for name, question in registered.items()}
answered = {
    "index rows": {"state": {"index_ref": "labelled"}, "questions": {"rows": indexed}},
    "index row cap": {"state": {"index_ref": "labelled"}, "questions": {
        "first": {**indexed, "row_cap": 3, "batch_size": 2}, "threshold": {**indexed, "threshold": 0.9},
    }},
    "index reference": {"state": {"index_ref": "labelled"}, "questions": {"rows": {"question_ref": "rows", "batch_size": 3}}},
    "index row cap 512": {"state": {"index_ref": "over decide"}, "questions": {"rows": {**indexed, "row_cap": 512}}},
    "nearest": {"state": ticket, "questions": {"nearest": nearest}},
    "nearest vector": {"state": {"vector": given}, "questions": {
        "one": {**nearest, "k": 1}, "all": {**nearest, "k": 100}, "unicode": {**nearest, "index_ref": "unicode"},
        "integers": {**nearest, "index_ref": "integers"},
    }},
    # numpy sorts 16 values or fewer by insertion, which is stable, so the
    # order of a tie is defined.
    "nearest ties": {"state": {"vector": pool[0]}, "questions": {
        name: {**nearest, "index_ref": name, "k": 5} for name in ["ties", "integer ties", "astral ties"]
    }},
    # The request's family takes the calibration of tickets/NearestReference;
    # the Choice question has a calibration of its own, tickets/Choice.
    "nearest family": {"state": sign_in, "family": "tickets", "questions": {"nearest": nearest, "team": team}},
    "nearest own family": {"state": sign_in, "questions": {"nearest": {**nearest, "family": "tickets"}, "plain": nearest}},
}


def referenced(request):
    """The request with each index_ref and question_ref replaced by Venn's handle."""
    state = request["state"]
    if isinstance(state, dict) and "index_ref" in state:
        state = {**state, "index_ref": handles.get(state["index_ref"], state["index_ref"])}
    return {**request, "state": state, "questions": {
        name: {**question, **({"index_ref": handles.get(question["index_ref"], question["index_ref"])} if "index_ref" in question else {}),
               **({"question_ref": question_handles.get(question["question_ref"], question["question_ref"])} if "question_ref" in question else {})}
        for name, question in request["questions"].items()
    }}


# Thresholds on both sides of the probability of "nearest".
probability = service.decide(referenced(answered["nearest"]))["answers"]["nearest"]["confidence"]
answered["nearest threshold"] = {"state": ticket, "questions": {
    "kept": {**nearest, "threshold": round(probability - 0.01, 4)},
    "none": {**nearest, "threshold": round(probability + 0.01, 4)},
}}
# A threshold between the confidences of rows that the head answers with an
# option, also of the first 4, which the registered question "rows" answers,
# so that it turns some of those rows into "none" and leaves the others.
streamed_rows = [row for line in service.stream_index(handles["near the options"], indexed) for row in json.loads(line)["rows"]]
assert all(row["answer"] != "none" for row in streamed_rows[:4]), streamed_rows
first = sorted(row["confidence"] for row in streamed_rows[:4])
low = round((first[1] + first[2]) / 2, 4)
assert min(abs(low - row["confidence"]) for row in streamed_rows) > 1e-4, (low, streamed_rows)
answered["index low threshold"] = {"state": {"index_ref": "near the options"}, "questions": {
    "rows": {**indexed, "threshold": low}, "reference": {"question_ref": "rows", "threshold": low},
}}
cases["answered"] = {}
for name, request in answered.items():
    response = service.decide(referenced(request))
    cases["answered"][name] = {"request": request, "answers": response["answers"], "vector": response["vector"]}
got = {name: case["answers"] for name, case in cases["answered"].items()}
assert [row["id"] for row in got["index rows"]["rows"]["rows"]] == indexes["labelled"]["ids"]
for answer in got["index low threshold"].values():
    assert {row["answer"] == "none" for row in answer["rows"]} == {True, False}, answer
assert got["nearest threshold"]["kept"]["answer"] != "none" and got["nearest threshold"]["none"]["answer"] == "none"
assert len(got["nearest vector"]["one"]["evidence_ids"]) == 1 and len(got["nearest vector"]["all"]["evidence_ids"]) == 10
assert got["nearest own family"]["nearest"] != got["nearest own family"]["plain"]
# The ordering of evidence and labels has no tie: numpy's argsort is not
# stable, and the package sorts stably.
for request_name, answers in got.items():
    for answer in answers.values():
        if "evidence_ids" in answer:
            assert request_name == "nearest ties" or abs(answer["margin"]) > 1e-4, (request_name, answer)
for name, label in [("ties", "b"), ("integer ties", "10"), ("astral ties", "\U0001F600")]:
    ties = got["nearest ties"][name]
    assert ties["answer"] == label and ties["margin"] == 0 and ties["evidence_ids"][:4] == ["q", "p", "s", "r"], ties

nearest_refused = [
    {**nearest, "threshold": 1.5, "index_ref": "unregistered"},
    {**nearest, "index_ref": "unregistered"},
    {"type": "NearestReference"},
    {**nearest, "index_ref": "small"},
    {**nearest, "index_ref": "one label"},
    {**nearest, "index_ref": "one mixed label"},
    {**nearest, "index_ref": "small", "k": 0},
    {**nearest, "k": 0}, {**nearest, "k": 101}, {**nearest, "k": 1.5},
]
refused = [
    {"state": {"index_ref": "unregistered"}, "questions": {}},
    {"state": {"index_ref": "unregistered"}, "questions": {"rows": indexed}},
    *({"state": {"index_ref": "labelled"}, "questions": {"team": {**team, "type": kind}}} for kind in ["Choice", "Score", "Noul"]),
    {"state": {"index_ref": "over decide"}, "questions": {"rows": indexed}},
    {"state": {"index_ref": "labelled"}, "questions": {"rows": {"question_ref": "rows", "threshold": 1.5}}},
    {"state": {"index_ref": "labelled"}, "questions": {"rows": {**indexed, "row_cap": 513}}},
    *({"state": ticket, "questions": {"nearest": question}} for question in nearest_refused),
    {"state": {"texts": [ticket, sign_in]}, "questions": {"nearest": nearest}},
    {"state": {"vectors": [given, pool[0]]}, "questions": {"nearest": nearest}},
    {"state": {"index_ref": "labelled"}, "questions": {"nearest": nearest}},
]
cases["refused"] = []
for request in refused:
    try:
        service.decide(referenced(request))
        raise AssertionError(f"Venn answered {request}")
    except ContractError as error:
        cases["refused"].append({"request": request, "code": error.code, "status": error.status})

streamed = {
    "batches": ("labelled", {**indexed, "batch_size": 4}),
    "one batch": ("labelled", indexed),
    "wide": ("wide", {**indexed, "batch_size": 256}),
    "wide row cap": ("wide", {**indexed, "row_cap": 530, "batch_size": 200}),
    "row cap past the rows": ("labelled", {**indexed, "row_cap": 1_000_000, "batch_size": 3}),
    "row cap 0": ("labelled", {**indexed, "row_cap": 0}),
    "threshold": ("labelled", {**indexed, "threshold": 0.9, "batch_size": 5}),
    "low threshold": ("near the options", {**indexed, "threshold": low, "batch_size": 5}),
    "batch size 65536": ("labelled", {**indexed, "batch_size": 65536}),
    "family": ("labelled", {**indexed, "family": "tickets"}),
    "reference": ("labelled", {"type": "IndexApply", "question_ref": "rows"}),
    "reference overrides": ("labelled", {"type": "IndexApply", "question_ref": "rows", "row_cap": 7, "batch_size": 2, "threshold": 0.9}),
    # stream_index merges each key of the question over the registered one.
    "reference family": ("labelled", {"type": "IndexApply", "question_ref": "rows", "family": "tickets"}),
    "reference low threshold": ("near the options", {"type": "IndexApply", "question_ref": "rows", "threshold": low}),
}
refused_streams = [
    ("unregistered", {"type": "IndexApply", "question_ref": "unregistered"}),
    ("labelled", {"type": "IndexApply", "question_ref": "unregistered", "row_cap": -1}),
    *(("labelled", {**indexed, **limit, "threshold": 1.5}) for limit in [
        {"row_cap": -1}, {"row_cap": 1_000_001}, {"row_cap": 1.5},
        {"batch_size": 0}, {"batch_size": 65_537}, {"batch_size": 2.5},
    ]),
    ("labelled", {**indexed, "threshold": 1.5, "options": []}),
    ("labelled", {**indexed, "threshold": float("nan")}),
    ("labelled", {**indexed, "options": []}),
    ("labelled", {**indexed, "options": ["Login problems", "Login problems"]}),
    ("labelled", {**indexed, "instructions": ""}),
    ("labelled", {"type": "IndexApply", "question_ref": "rows", "threshold": 1.5}),
]


def stream_question(question):
    if "question_ref" in question:
        return {**question, "question_ref": question_handles.get(question["question_ref"], question["question_ref"])}
    return question


cases["streamed"] = {}
for name, (index, question) in streamed.items():
    lines = [json.loads(line) for line in service.stream_index(handles[index], stream_question(question))]
    cases["streamed"][name] = {"index": index, "question": question, "lines": lines}
lines = {name: case["lines"] for name, case in cases["streamed"].items()}
assert [line["offset"] for line in lines["batches"]] == [0, 4, 8] and len(lines["batches"][-1]["rows"]) == 2
assert sum(len(line["rows"]) for line in lines["wide"]) == 600
assert sum(len(line["rows"]) for line in lines["wide row cap"]) == 530
assert lines["row cap 0"] == []
for name in ["low threshold", "reference low threshold"]:
    assert {row["answer"] == "none" for line in lines[name] for row in line["rows"]} == {True, False}, name
assert sum(len(line["rows"]) for line in lines["reference"]) == 4
cases["refused streams"] = []
for index, question in refused_streams:
    try:
        list(service.stream_index(handles.get(index, index), stream_question(question)))
        raise AssertionError(f"Venn streamed {question}")
    except ContractError as error:
        cases["refused streams"].append({"index": index, "question": question, "code": error.code, "status": error.status})
cases["registered"] = registered
cases["refused registrations"] = []
for question in [nearest]:
    try:
        service.register_question("refused", question)
        raise AssertionError(f"Venn registered {question}")
    except ContractError as error:
        cases["refused registrations"].append({"question": question, "code": error.code, "status": error.status})

RENAMES = {
    "instructions_vec": "instructionsVec",
    "question_ref": "questionRef",
    "index_ref": "indexRef",
    "row_cap": "rowCap",
    "batch_size": "batchSize",
    "evidence_ids": "evidenceIds",
    "none_semantics": "noneSemantics",
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


(HERE / "expected.json").write_text(json.dumps(port(cases), allow_nan=False, separators=(",", ":")) + "\n")
