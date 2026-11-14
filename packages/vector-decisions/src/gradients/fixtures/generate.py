# /// script
# requires-python = "==3.12.9"
# dependencies = [
#   "torch==2.15.0",
#   "numpy==2.5.4",
# ]
# ///
# Makes expected.json, the golden of the gradients tests, with PyTorch in
# float64:
# uv run --no-project packages/vector-decisions/src/gradients/fixtures/generate.py
#
# - linear, gelu, lowRankBilinear, crossEntropy, attentionPooling, normalize:
#   the inputs, the parameters and the output of each module, written with
#   the PyTorch expressions that Venn 7b2042e trains with (venn/heads/family.py
#   and venn/heads/outcome.py). Venn is not installed: its package imports its
#   server, and these expressions need only torch.
# - adamw: torch.optim.AdamW with lr 1e-3 and each weight decay that Venn
#   uses (family.py WEIGHT_DECAYS, outcome.py weight_decay=0.01), for a few
#   steps of fixed gradients, and the parameters after each step. In step 3
#   the gradient of the second parameter is 0.
# - adamwDefaults: the same for torch.optim.AdamW with no options.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
from pathlib import Path

VERSIONS = {"torch": "2.15.0", "numpy": "2.5.4"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

HERE = Path(__file__).resolve().parent
rng = np.random.default_rng(20261114)


def tensor(shape, scale=1.0):
    return torch.tensor(rng.standard_normal(shape) * scale, dtype=torch.float64)


def set_weight(module, weight):
    with torch.no_grad():
        module.weight.copy_(weight)
    return module


def linear():
    module = nn.Linear(5, 3, dtype=torch.float64)
    with torch.no_grad():
        module.weight.copy_(tensor((3, 5)))
        module.bias.copy_(tensor(3))
    x = tensor((4, 5))
    return {
        "input": x.tolist(),
        "weight": module.weight.tolist(),
        "bias": [module.bias.tolist()],
        "output": module(x).tolist(),
    }


def gelu():
    x = torch.cat([torch.tensor([-8.0, -3.0, -1e-3, 0.0, 1e-3, 0.5, 3.0, 8.0], dtype=torch.float64), tensor(4, 2.0)])
    x = x.reshape(3, 4)
    return {"input": x.tolist(), "output": nn.GELU()(x).tolist()}


def low_rank_bilinear():
    # BilinearHead.forward without its bias (outcome.py:39): every state with
    # every option of one shared options matrix.
    left = set_weight(nn.Linear(6, 2, bias=False, dtype=torch.float64), tensor((2, 6)))
    right = set_weight(nn.Linear(5, 2, bias=False, dtype=torch.float64), tensor((2, 5)))
    states, options = tensor((4, 6)), tensor((3, 5))
    return {
        "states": states.tolist(),
        "options": options.tolist(),
        "left": left.weight.tolist(),
        "right": right.weight.tolist(),
        "output": (left(states) @ right(options).T).tolist(),
    }


def cross_entropy():
    # 4 option columns and "none"; each row keeps its first `size` options, and
    # the rest get -1e4, as FamilyScorer.forward masks them (family.py:209).
    options, none = tensor((4, 4), 3.0), tensor((4, 1), 3.0)
    sizes = torch.tensor([2, 4, 3, 1])
    mask = torch.arange(4)[None, :] < sizes[:, None]
    logits = torch.cat([options.masked_fill(~mask, -1e4), none], 1)
    targets = torch.tensor([1, 4, 2, 0])
    # Logits near 1000, whose exponentials overflow float64 unless the
    # softmax first subtracts the largest logit of the row.
    large = torch.tensor([[1000.0, 999.0, -1e4, -1e4, 998.5], [-1e4, 1000.0, 1001.0, -1e4, 0.0]], dtype=torch.float64)

    def weighted(logits, targets, weights):
        # fit_outcome_head's batch_loss (outcome.py:159-160), the weighted
        # loss of _train (family.py:319) with a floor on the sum.
        per_row = F.cross_entropy(logits, targets, reduction="none") * weights
        return float(per_row.sum() / weights.sum().clamp_min(1e-9))

    def case(name, logits, targets, weights, loss):
        return {"name": name, "logits": logits.tolist(), "targets": targets.tolist(), "weights": weights.tolist(), "loss": loss}

    weights = torch.tensor([0.5, 2.0, 1.0, 0.25], dtype=torch.float64)
    ones, zeros = torch.ones(4, dtype=torch.float64), torch.zeros(4, dtype=torch.float64)
    large_targets, large_weights = torch.tensor([1, 2]), torch.tensor([1.0, 3.0], dtype=torch.float64)
    return [
        case("weighted", logits, targets, weights, weighted(logits, targets, weights)),
        case("unweighted", logits, targets, ones, float(F.cross_entropy(logits, targets))),
        case("zero weights", logits, targets, zeros, weighted(logits, targets, zeros)),
        case("large logits", large, large_targets, large_weights, weighted(large, large_targets, large_weights)),
    ]


def attention_pooling():
    # FamilyScorer.pool before its F.normalize (family.py:188-189).
    query = set_weight(nn.Linear(4, 4, bias=False, dtype=torch.float64), tensor((4, 4)))
    fields, questions = tensor((2, 3, 4)), tensor((2, 4))
    attention = (fields * query(questions)[:, None]).sum(-1)
    pooled = (fields * attention.softmax(1)[:, :, None]).sum(1)
    return {
        "fields": fields.tolist(),
        "questions": questions.tolist(),
        "query": query.weight.tolist(),
        "output": pooled.tolist(),
    }


def normalize():
    # A zero row stays zero, and a row whose norm is below 1e-12 is divided
    # by 1e-12.
    x = torch.cat([tensor((2, 5)), torch.zeros(1, 5, dtype=torch.float64), tensor((1, 5), 1e-20)])
    return {"input": x.tolist(), "output": F.normalize(x, dim=-1).tolist()}


def adamw(steps=4, **options):
    # AdamW changes each number alone, so the parameters are matrices; the
    # 1 × 4 and 1 × 1 ones stand for a bias and a scalar.
    parameters = [nn.Parameter(tensor(shape)) for shape in ((3, 4), (1, 4), (1, 1))]
    initial = [parameter.detach().clone().tolist() for parameter in parameters]
    optimizer = torch.optim.AdamW(parameters, **options)
    gradients, after = [], []
    for step in range(steps):
        step_gradients = []
        for index, parameter in enumerate(parameters):
            shape = tuple(parameter.shape)
            if step == 2 and index == 1:
                gradient = torch.zeros(shape, dtype=torch.float64)
            else:
                gradient = torch.tensor(rng.standard_normal(shape) * 10.0 ** rng.uniform(-9, 1, shape), dtype=torch.float64)
            parameter.grad = gradient
            step_gradients.append(gradient.tolist())
        optimizer.step()
        gradients.append(step_gradients)
        after.append([parameter.detach().clone().tolist() for parameter in parameters])
    return {"parameters": initial, "gradients": gradients, "after": after}


expected = {
    "linear": linear(),
    "gelu": gelu(),
    "lowRankBilinear": low_rank_bilinear(),
    "crossEntropy": cross_entropy(),
    "attentionPooling": attention_pooling(),
    "normalize": normalize(),
    "adamw": [
        {"lr": 1e-3, "weightDecay": weight_decay, **adamw(lr=1e-3, weight_decay=weight_decay)}
        for weight_decay in (0.001, 0.01, 0.1)
    ],
    # torch.optim.AdamW with no options: lr 1e-3 and weight decay 0.01, which
    # fit_outcome_head passes on (outcome.py:134).
    "adamwDefaults": adamw(),
}
(HERE / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")
