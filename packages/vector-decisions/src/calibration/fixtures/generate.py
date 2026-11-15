# /// script
# requires-python = "==3.12.9"
# dependencies = [
#   "venn-vdm @ git+https://github.com/markrussinovich/venn-vdm@7b2042e84608fbdd143ac21dea7c83d5ae2ec723",
#   "torch==2.15.0",
#   "numpy==2.5.4",
# ]
# ///
# Makes the fixture of the calibration tests with Venn's own
# DecisionService.register_calibration, delete_calibration and decide, with a
# supplied embedder and the venn-1 head, at the commit that the package ports:
# uv run --no-project packages/vector-decisions/src/calibration/fixtures/generate.py
#
# expected.json holds:
# - "fits": labelled logits and the temperature that register_calibration
#   fits to them (fit_temperature, venn/heads/calibration.py). The logits have
#   4 decimals, so most are not float32 numbers: Venn rounds them to float32
#   before the fit.
# - "refused": the registrations that Venn refuses, with the code and the
#   status of its ContractError.
# - "registrations", "deletions": the calls that make a registry, in order,
#   each with the temperature that Venn returns, and the text of
#   calibrations.json after the registrations ("registry") and after the
#   deletions ("registry after deletions").
# - "raw": the raw vector that the reader gives for each text.
# - "answered": requests that Venn answers with the registry, and
#   "answered after deletions": requests that Venn answers after the
#   deletions. "registered" holds the questions that register_question
#   prepares: a questionRef names one of them, and each side replaces the name
#   with its own handle.
# - "past the bound": logits for which a step of Venn's fit goes past
#   log T = -5 and the fit stops there ("venn temperature", e^-5), and the
#   temperature that the fit finds when its clamp passes the gradient
#   ("temperature", ADR 0006).
# The requests and the answers have the names of the package: Venn's
# snake_case names are in camelCase. JSON has no NaN and no infinity, so the
# fixture writes them as "NaN", "Infinity" and "-Infinity".
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
import torch
from torch.nn import functional as F

from venn.cli import download_head
from venn.errors import ContractError
from venn.server import DecisionService

HERE = Path(__file__).resolve().parent
rng = np.random.default_rng(20261117)
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
]
raw = {text: (rng.standard_normal(768) * 0.05).tolist() for text in TEXTS}
head = download_head()


def service():
    """A DecisionService with its own empty registry."""
    state = Path(tempfile.mkdtemp(prefix="venn-state-"))
    return DecisionService(
        embed=lambda batch: np.array([raw[text] for text in batch]),
        cache_path=state / "cache.sqlite",
        registry_path=state / "calibrations.json",
        model_dir=head,
    ), state / "calibrations.json"


def labelled(rows, classes, signal, scale, noise=1.0):
    """Logits of a head: noise, and `signal` more for the target of each row, times `scale`, with 4 decimals."""
    targets = rng.integers(0, classes, rows)
    logits = rng.standard_normal((rows, classes)) * noise
    logits[np.arange(rows), targets] += signal
    return np.round(logits * scale, 4), targets


fits_service, _ = service()
fit_inputs = {
    "a head that is too sure": labelled(1000, 4, 1.5, 4.0),
    "a head that is not sure enough": labelled(1000, 4, 2.0, 0.3),
    "the fewest rows: 200, of two classes": labelled(200, 2, 1.0, 1.0),
    "the most rows: 10000": labelled(10000, 3, 1.2, 2.0),
    "50 classes": labelled(300, 50, 3.0, 1.0),
    "logits so small that the fit stops at the smallest temperature": labelled(500, 4, 2.0, 1e-4),
    # Larger temperatures always fit better, so the fit stops at the largest.
    "logits against the targets": (lambda logits, targets: (-logits, targets))(*labelled(500, 4, 1.0, 1.0)),
    "equal logits: the gradient is 0 at the start": (np.zeros((300, 5)), rng.integers(0, 5, 300)),
    # The loss is flat at small temperatures: the fit stops on a tolerance of
    # PyTorch's LBFGS, far from its infimum.
    "separable rows": labelled(400, 3, 6.0, 1.0, noise=0.5),
    **{f"a random head {i}": labelled(int(rng.integers(200, 1500)), int(rng.integers(2, 9)), float(rng.uniform(0, 3)),
                                      float(rng.uniform(0.2, 6))) for i in range(6)},
}
fits = []
for name, (logits, targets) in fit_inputs.items():
    temperature = fits_service.register_calibration(name, logits.tolist(), targets.tolist())
    fits.append({"name": name, "logits": logits.tolist(), "targets": targets.tolist(), "temperature": temperature})

valid, valid_targets = labelled(300, 3, 1.0, 1.0)
valid, valid_targets = valid.tolist(), valid_targets.tolist()


def replaced(rows, row, column, value):
    """The rows with one value replaced."""
    return [[value if (i, j) == (row, column) else x for j, x in enumerate(r)] for i, r in enumerate(rows)]


refused_inputs = [
    (valid[:199], valid_targets[:199]),
    ([[0.0]] * 10001, [0] * 10001),
    (valid, valid_targets[:299]),
    # Venn checks the count of rows before the values.
    (replaced(valid[:199], 0, 0, float("nan")), valid_targets[:199]),
    (replaced(valid, 5, 1, float("nan")), valid_targets),
    (replaced(valid, 5, 1, float("inf")), valid_targets),
    (replaced(valid, 5, 1, float("-inf")), valid_targets),
    # A finite float64 number that float32 cannot hold.
    (replaced(valid, 5, 1, 1e39), valid_targets),
    (valid, [1.5] + valid_targets[1:]),
    (valid, [-1] + valid_targets[1:]),
    (valid, [3] + valid_targets[1:]),
    (valid, [float("nan")] + valid_targets[1:]),
    ([[] for _ in range(300)], [0] * 300),
]
refused = []
for logits, targets in refused_inputs:
    try:
        fits_service.register_calibration("refused", logits, targets)
        raise AssertionError(f"Venn registered {len(logits)} rows")
    except ContractError as error:
        refused.append({"logits": logits, "targets": targets, "code": error.code, "status": error.status})

registry_service, registry_path = service()
registrations = []
for family, kind in [("", "Choice"), ("tickets", "Choice"), ("tickets", "Score"), ("tickets", "Noul"), ("orders", "Choice"),
                     ("tickets", "Choice")]:
    logits, targets = labelled(int(rng.integers(200, 600)), 3, float(rng.uniform(0.5, 2)), float(rng.uniform(0.5, 6)))
    temperature = registry_service.register_calibration(family, logits.tolist(), targets.tolist(), kind)
    registrations.append({"family": family, "kind": kind, "logits": logits.tolist(), "targets": targets.tolist(),
                          "temperature": temperature})
registry = registry_path.read_text()
generic = registry_service.generic
calibrations = json.loads(registry)
assert all(abs(t - generic) > 0.05 for t in calibrations.values()), (calibrations, generic)
assert list(calibrations) == ["/Choice", "tickets/Choice", "tickets/Score", "tickets/Noul", "orders/Choice"], calibrations

ticket, sign_in = TEXTS[0], TEXTS[1]
team = {"type": "Choice", "instructions": "Who owns this ticket?",
        "options": ["Login problems", "Checkout and payments", "Shipping and delivery"]}
urgency = {"type": "Score", "instructions": "How urgent is it?", "options": ["Can wait", "Should be fixed soon", "Blocking"]}
defect = {"type": "Noul", "instructions": "Is the software broken?", "options": ["A request or a question", "The software is broken"]}
indexed = {**team, "type": "IndexApply"}
tickets = {"family": "tickets"}
registered = {"team": {**team, **tickets}, "plain team": team}
answered = {
    "no family": {"state": ticket, "questions": {"team": team}},
    "a family": {"state": ticket, "questions": {"team": {**team, **tickets}}},
    "a question without a type takes the Choice temperature":
        {"state": ticket, "questions": {"team": {**{k: v for k, v in team.items() if k != "type"}, **tickets}}},
    "the family of the request": {"state": ticket, "family": "tickets", "questions": {"team": team}},
    "the family of the question before the request's": {"state": ticket, "family": "tickets", "questions": {
        "team": {**team, "family": "orders"}, "uncalibrated": {**team, "family": "billing"},
    }},
    "a Score": {"state": ticket, "questions": {"urgency": {**urgency, **tickets}, "default": urgency}},
    "a Noul": {"state": sign_in, "questions": {"defect": {**defect, **tickets}, "default": defect}},
    "an IndexApply takes the Choice temperature": {"state": {"texts": [ticket, sign_in]}, "questions": {
        "rows": {**indexed, **tickets}, "default": indexed,
    }},
    "a questionRef": {"state": ticket, "questions": {"team": {"question_ref": "team"}}},
    "a questionRef and the family of the request": {"state": ticket, "family": "orders", "questions": {
        "team": {"question_ref": "team"}, "plain": {"question_ref": "plain team"},
    }},
}
handles = {name: registry_service.register_question(name, question) for name, question in registered.items()}


def referenced(request):
    """The request with each question_ref replaced by Venn's handle."""
    return {**request, "questions": {
        name: {**question, "question_ref": handles[question["question_ref"]]} if "question_ref" in question else question
        for name, question in request["questions"].items()
    }}


def decide(requests):
    return {name: {"request": request, "answers": registry_service.decide(referenced(request))["answers"]}
            for name, request in requests.items()}


before = decide(answered)
deletions = [("tickets", "Choice"), ("tickets", "Noul"), ("missing", "Choice")]
for family, kind in deletions:
    registry_service.delete_calibration(family, kind)
registry_after = registry_path.read_text()
assert list(json.loads(registry_after)) == ["/Choice", "tickets/Score", "orders/Choice"], registry_after
after = decide({name: answered[name] for name in ["a family", "a Noul", "a Score"]})
got = {name: case["answers"] for name, case in before.items()}
assert got["no family"]["team"] != got["a family"]["team"]
assert got["a question without a type takes the Choice temperature"]["team"] == got["a family"]["team"]
assert len({calibrations["tickets/Choice"], calibrations["tickets/Score"], calibrations["tickets/Noul"]}) == 3, calibrations
assert got["a family"]["team"] == got["the family of the request"]["team"] == got["a questionRef"]["team"]
assert got["a questionRef and the family of the request"]["team"] == got["a family"]["team"]
assert got["a questionRef and the family of the request"]["plain"] != got["no family"]["team"]
assert after["a Score"]["answers"] == before["a Score"]["answers"]
assert after["a family"]["answers"]["team"] != got["a family"]["team"]

RENAMES = {
    "expected_score": "expectedScore",
    "score_conditioned_on_not_none": "scoreConditionedOnNotNone",
    "question_ref": "questionRef",
}


def port(value):
    """The value with the names of the package, and each NaN or infinity as a string."""
    if isinstance(value, dict):
        return {RENAMES.get(key, key): port(item) for key, item in value.items()}
    if isinstance(value, list):
        return [port(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    return value


def fixed_temperature(logits, targets):
    """Venn's fit_temperature of the float32 logits, with a clamp that passes its gradient.

    Venn's clamp passes no gradient outside [-5, 5] (venn/heads/calibration.py:19), so a step past -5 meets a
    gradient of 0 and the fit stops at e^-5 far from the best temperature. The port passes it (ADR 0006).
    """
    values = torch.as_tensor(np.asarray(logits, dtype=np.float32), dtype=torch.float64)
    labels = torch.as_tensor(targets, dtype=torch.long)
    log_t = torch.zeros((), dtype=torch.float64, requires_grad=True)
    optimizer = torch.optim.LBFGS([log_t], max_iter=100, line_search_fn="strong_wolfe")

    def closure():
        optimizer.zero_grad()
        passed = log_t + (log_t.clamp(-5, 5) - log_t).detach()
        loss = F.cross_entropy(values / passed.exp(), labels)
        loss.backward()
        return loss

    optimizer.step(closure)
    return float(log_t.detach().clamp(-5, 5).exp())


for case in fits + registrations:
    assert fixed_temperature(case["logits"], case["targets"]) == case["temperature"], case.get("name", case["family"])

# Its own generator, after every other draw, so the rest of the fixture stays as it was.
past = np.random.default_rng(0)
past_targets = past.integers(0, 4, 300)
past_logits = past.standard_normal((300, 4))
past_logits[np.arange(300), past_targets] += 2.5
past_logits = np.round(past_logits * 0.1, 4)
venn_past = fits_service.register_calibration("past the bound", past_logits.tolist(), past_targets.tolist())
assert venn_past == math.exp(-5), venn_past
past_the_bound = {"logits": past_logits.tolist(), "targets": past_targets.tolist(), "venn temperature": venn_past,
                  "temperature": fixed_temperature(past_logits, past_targets)}
assert -5 < math.log(past_the_bound["temperature"]) < 5, past_the_bound

fixture = {
    "raw": raw, "fits": fits, "refused": refused, "registrations": registrations, "registry": registry,
    "deletions": [{"family": family, "kind": kind} for family, kind in deletions], "registry after deletions": registry_after,
    "registered": registered, "answered": before, "answered after deletions": after, "past the bound": past_the_bound,
}
(HERE / "expected.json").write_text(json.dumps(port(fixture), allow_nan=False, separators=(",", ":")) + "\n")
print({case["name"]: case["temperature"] for case in fits}, generic)
