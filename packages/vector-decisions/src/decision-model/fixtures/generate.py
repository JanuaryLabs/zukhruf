# /// script
# requires-python = "==3.12.9"
# dependencies = [
#   "venn-vdm @ git+https://github.com/markrussinovich/venn-vdm@7b2042e84608fbdd143ac21dea7c83d5ae2ec723",
#   "torch==2.15.0",
#   "numpy==2.5.4",
# ]
# ///
# Makes the fixture of the decision model tests with Venn's own Decisions API,
# venn.decisions.decide, over a DecisionService with a supplied embedder and
# the venn-1 head, at the commit that the package ports:
# uv run --no-project packages/vector-decisions/src/decision-model/fixtures/generate.py
#
# Each case is a call of the AI SDK's experimental_decide: a state and
# questions. venn_request gives the request of Venn's Decisions API that the
# decision model asks for that call (ADR 0005): the type boolean is Venn's
# noul, and a state of parts is the text of each part, with "\n" between
# them. Venn's decide does the rest, also the abstention of a null criterion.
#
# expected.json holds the raw vector that the embedder gave for each text that
# Venn embedded, the answered calls with the answers in the form of the AI SDK
# and Venn's none_probability of each question, and the refused calls with the
# code and the status of Venn's ContractError.
# Never edit expected.json by hand: run this script again.
import hashlib
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
from venn.decisions import decide, text
from venn.errors import ContractError
from venn.server import DecisionService

HERE = Path(__file__).resolve().parent
# Two texts with one vector, so that two criteria have one probability.
SAME = {"Sign-in problems": "Login problems"}
raw = {}


def embed(batch):
    """The raw vector of each text, drawn from the SHA-256 of the text, and recorded in raw."""
    for text_ in batch:
        source = SAME.get(text_, text_)
        seed = int.from_bytes(hashlib.sha256(source.encode()).digest()[:8], "big")
        raw[text_] = (np.random.default_rng(seed).standard_normal(768) * 0.05).tolist()
    return np.array([raw[text_] for text_ in batch])


state = Path(tempfile.mkdtemp(prefix="venn-state-"))
service = DecisionService(
    embed=embed,
    cache_path=state / "cache.sqlite",
    registry_path=state / "calibrations.json",
    model_dir=download_head(),
)
ticket = "The checkout page is broken and my card was charged twice"
sign_in = "I cannot sign in with my password"
team = {"type": "choice", "instructions": "Who owns this ticket?", "criteria": {
    "login": "Login problems", "checkout": "Checkout and payments", "shipping": "Shipping and delivery",
}}
urgency = {"type": "score", "instructions": "How urgent is it?", "criteria": ["Can wait", "Should be fixed soon", "Blocking"]}
defect = {"type": "boolean", "instructions": "Is the software broken?"}
described = {"true": "The software is broken", "false": "A request or a question"}
answered = {
    "kinds": {"state": ticket, "questions": {"team": team, "urgency": urgency, "defect": defect}},
    "boolean criteria": {"state": sign_in, "questions": {"defect": {**defect, "criteria": described}}},
    "null criterion": {"state": ticket, "questions": {"team": {**team, "criteria": {
        "login": "Login problems", "checkout": None, "shipping": "Shipping and delivery",
    }}}},
    "abstention named none": {"state": sign_in, "questions": {"team": {**team, "criteria": {
        "none": None, "login": "Login problems", "checkout": "Checkout and payments",
    }}}},
    "tie": {"state": sign_in, "questions": {"team": {**team, "criteria": {
        "login": "Login problems", "signIn": "Sign-in problems", "shipping": "Shipping and delivery",
    }}}},
    # Python sorts keys by code point: U+E000 before U+1F600, which UTF-16
    # sorts the other way. Python writes a float under 1e-4 as 5e-05, and
    # 1e-4 itself as 0.0001.
    "json": {
        "state": {
            "ticket": {"subject": "Charged twice", "body": 'The checkout page is broken.\nMy card was charged "twice".',
                       "amount": 12.5, "refund": 0.00005, "fee": 0.0001, "items": 3},
            "customer": "Zoë", "": 1, "\U0001f600": [True, None, 1.5e-07],
        },
        "questions": {
            "team": {**team, "instructions": {"ask": "Who owns this ticket?", "teams": 3}, "criteria": {
                "login": {"includes": ["Passwords", "Sign-in"]}, "checkout": ["Payments", "Refunds"],
                "shipping": "Shipping and delivery",
            }},
            "urgency": {**urgency, "criteria": ["Can wait", {"level": "soon", "within": 0.5}, "Blocking"]},
        },
    },
    "text parts": {"state": [{"type": "text", "text": "Ticket 42"}, {"type": "text", "text": ticket}], "questions": {"team": team}},
    "parts": {"state": [
        {"type": "text", "text": "Ticket 42"},
        {"type": "json", "value": {"subject": "Charged twice", "amount": 12.5}},
        {"type": "json", "value": 0.00005},
        {"type": "json", "value": "from the web form"},
        {"type": "json", "value": True},
        {"type": "text", "text": ticket},
    ], "questions": {"team": team}},
    # Venn answers these with its own labels option-0, option-1 and so on;
    # the package has no port of DecisionService.vector yet (ADR 0005).
    "none text": {"state": ticket, "questions": {"team": {**team, "criteria": {"login": "Login problems", "other": "none"}}}},
    "one text": {"state": ticket, "questions": {"team": {**team, "criteria": {"login": "Login problems", "signIn": "Login problems"}}}},
}
refused = [
    {"state": ticket, "questions": {"team": {"type": "choice", "criteria": team["criteria"]}}},
    {"state": ticket, "questions": {"team": {**team, "instructions": None}}},
    {"state": ticket, "questions": {"team": {**team, "criteria": {"login": "Login problems", "checkout": None, "shipping": None}}}},
    {"state": ticket, "questions": {"team": {**team, "criteria": {"checkout": None}}}},
    {"state": ticket, "questions": {"urgency": {"type": "score", "criteria": urgency["criteria"]}}},
    {"state": ticket, "questions": {"defect": {"type": "boolean", "criteria": described}}},
    {"state": ticket, "questions": {"defect": {**defect, "criteria": {"true": described["true"]}}}},
    {"state": ticket, "questions": {"defect": {**defect, "criteria": {"true": described["true"], "false": None}}}},
    {"state": ticket, "questions": {"defect": {**defect, "criteria": {}}}},
    {"state": ticket, "questions": {"urgency": {**urgency, "criteria": ["Can wait", None, "Blocking"]}}},
    {"state": ticket, "questions": {f"q{i}": team for i in range(33)}},
]


def venn_text(value):
    """Venn's text of a JSON value: a string, an object or an array as decisions.text writes it, else JSON."""
    return text(value) if isinstance(value, (str, dict, list)) else json.dumps(value)


def venn_question(question):
    """The question of Venn's Decisions API for a question of the AI SDK."""
    return {**question, "type": "noul"} if question["type"] == "boolean" else question


def venn_request(call):
    """The request of Venn's Decisions API for a call of experimental_decide."""
    state_ = call["state"]
    if isinstance(state_, list):
        state_ = "\n".join(part["text"] if part["type"] == "text" else venn_text(part["value"]) for part in state_)
    return {"model": "venn-1", "state": state_,
            "questions": {name: venn_question(question) for name, question in call["questions"].items()}}


def sdk_answer(answer):
    """Venn's answer in the form of the AI SDK."""
    match answer["type"]:
        case "choice":
            return {"type": "choice", "choice": answer["choice"], "probabilities": answer["probabilities"]}
        case "score":
            return {"type": "score", "score": answer["score"], "probabilities": answer["probabilities"]}
        case "noul":
            return {"type": "boolean", "probability": answer["noul"]}


def whole_floats(value):
    """The floats of a value that are whole numbers: JavaScript sends 2.0 as 2, which Python reads as an int."""
    if isinstance(value, dict):
        return [found for item in value.values() for found in whole_floats(item)]
    if isinstance(value, list):
        return [found for item in value for found in whole_floats(item)]
    return [value] if isinstance(value, float) and value.is_integer() else []


cases = {"answered": {}, "refused": []}
for name, call in answered.items():
    assert not whole_floats(call), name
    response = decide(service, venn_request(call))
    cases["answered"][name] = {
        "call": call,
        "answers": {question: sdk_answer(answer) for question, answer in response["answers"].items()},
        "noneProbability": {question: answer["venn"]["none_probability"] for question, answer in response["answers"].items()},
    }
got = {name: case["answers"] for name, case in cases["answered"].items()}
assert [answer["type"] for answer in got["kinds"].values()] == ["choice", "score", "boolean"]
# The abstention comes after the criteria with a description.
assert list(got["null criterion"]["team"]["probabilities"]) == ["login", "shipping", "checkout"]
assert list(got["abstention named none"]["team"]["probabilities"]) == ["login", "checkout", "none"]
for name in ("tie", "one text"):
    probabilities = got[name]["team"]["probabilities"]
    assert got[name]["team"]["choice"] == "login" and probabilities["login"] == probabilities["signIn"], probabilities
for answers in got.values():
    for answer in answers.values():
        if "probabilities" in answer:
            assert math.isclose(sum(answer["probabilities"].values()), 1, abs_tol=1e-12), answer
for call in refused:
    try:
        decide(service, venn_request(call))
        raise AssertionError(f"Venn answered {call}")
    except ContractError as error:
        cases["refused"].append({"call": call, "code": error.code, "status": error.status})
(HERE / "expected.json").write_text(json.dumps({"raw": raw, **cases}, allow_nan=False, ensure_ascii=False, separators=(",", ":")) + "\n")
