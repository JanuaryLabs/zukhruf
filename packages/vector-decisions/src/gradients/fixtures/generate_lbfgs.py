# /// script
# requires-python = "==3.12.9"
# dependencies = [
#   "torch==2.15.0",
#   "numpy==2.5.4",
# ]
# ///
# Makes lbfgs.json, the golden of the LBFGS test, with PyTorch in float64:
# uv run --no-project packages/vector-decisions/src/gradients/fixtures/generate_lbfgs.py
#
# Each case runs one step of torch.optim.LBFGS with line_search_fn=
# "strong_wolfe", the case's max_iter and torch's other defaults, and records
# the parameters at each call of the closure and after the step. The functions are written with the same
# float64 operations, in the same order, as lbfgs.test.ts, so that the losses
# are equal bit for bit; autograd gives the gradients. Each case is there for
# the branches of LBFGS.step and _strong_wolfe that its path takes, found by
# trying starts against the port.
# Never edit lbfgs.json by hand: run this script again.
import importlib.metadata
import json
import platform
from pathlib import Path

VERSIONS = {"torch": "2.15.0", "numpy": "2.5.4"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import torch

HERE = Path(__file__).resolve().parent


# s * (x^4 - b x^3 - c x^2 + e x) at x = value / w: a quartic with one or two
# wells, scaled in loss by s and in position by w.
def quartic(values, s, b, c, e, w):
    x = values[0] / w
    return s * (x * x * x * x - b * x * x * x - c * x * x + e * x)


# s * u / (1 + u^2) + e * u^2 at u = value / w: a well at u = -1 beside a bump
# at u = 1 that flattens towards 0 far away.
def bump(values, s, e, w):
    u = values[0] / w
    q = 1 + u * u
    return s * u / q + e * u * u


# The chained Rosenbrock function of the values of all the parameters.
def rosenbrock(values):
    loss = 0
    for i in range(len(values) - 1):
        loss = loss + 100 * (values[i + 1] - values[i] * values[i]) * (values[i + 1] - values[i] * values[i]) + (1 - values[i]) * (1 - values[i])
    return loss


FUNCTIONS = {"quartic": quartic, "bump": bump, "rosenbrock": rosenbrock}


def case(name, function, coefficients, parameters, max_iter):
    trained = [torch.nn.Parameter(torch.tensor(rows, dtype=torch.float64)) for rows in parameters]
    optimizer = torch.optim.LBFGS(trained, max_iter=max_iter, line_search_fn="strong_wolfe")
    calls = []

    def closure():
        optimizer.zero_grad()
        values = torch.cat([parameter.reshape(-1) for parameter in trained])
        calls.append(values.detach().clone().tolist())
        loss = FUNCTIONS[function](values, *coefficients)
        loss.backward()
        return loss

    optimizer.step(closure)
    return {
        "name": name,
        "function": function,
        "coefficients": coefficients,
        "parameters": parameters,
        "maxIter": max_iter,
        "calls": calls,
        "final": torch.cat([parameter.detach().reshape(-1) for parameter in trained]).tolist(),
    }


expected = [
    case("a start whose gradient is within tolerance", "quartic", [1e-9, -2, 0, -3, 1], [[[-2.5]]], 20),
    case("a zoom that stalls, keeps and flips its bracket until the evaluations run out", "bump", [0.1, 0.001, 0.001], [[[0.001]]], 6),
    case("an extrapolation that turns uphill, then a bracket too narrow to zoom", "quartic", [1e-4, 1, 3, -3, 1e-7], [[[3e-7]]], 20),
    case("a zoom whose interpolation lands on the end of its bracket", "bump", [0.01, 0, 1e-6], [[[5e-6]]], 20),
    case("an extrapolation whose loss rises", "quartic", [1e-8, -1, 5, -1, 1e-3], [[[-5e-4]]], 20),
    case("a step with too little curvature to keep, then too little change of loss", "quartic", [1e-8, -2, 5, 2, 1e-5], [[[2.5e-6]]], 20),
    case("an extrapolation that runs out of evaluations", "quartic", [1e-8, -3, 0, 2, 1e-3], [[[1.5e-3]]], 6),
    case("Rosenbrock, cut at 12 iterations", "rosenbrock", [], [[[-1.2, 1]]], 12),
    case("Rosenbrock over a 1 x 1 and a 2 x 1 parameter, cut at 8 iterations", "rosenbrock", [], [[[-1.2]], [[1], [0.5]]], 8),
    case("a step shorter than the tolerance along its direction, which ends the iterations", "bump", [330, 0.92, 1.3e-6], [[[7.5e-6]]], 11),
    case("a first iteration whose loss changes by less than the tolerance", "quartic", [2e-7, 0.31, 0.25, 0.079, 0.0016], [[[9.3e-4]]], 7),
    case("a first extrapolation that meets both conditions with a loss above the step before, which bracketing keeps", "bump", [0.0059, 8.8e-4, 0.13], [[[-0.32]]], 20),
    case("a second extrapolation whose loss rises above the one before, which ends the bracketing", "bump", [1.1, 2.3e-4, 0.058], [[[0.06]]], 7),
    case("a zoom trial that fails sufficient decrease with a loss below the low end's, so the ends swap", "bump", [530, -1.7e-5, 0.0025], [[[5.1e-7]]], 3),
    case("a zoom trial whose loss falls by between 1e-4 and 2e-4 of the slope times its step", "bump", [260, 5.4e-6, 0.0045], [[[1.7e-6]]], 3),
]
(HERE / "lbfgs.json").write_text(json.dumps(expected, indent=2) + "\n")
