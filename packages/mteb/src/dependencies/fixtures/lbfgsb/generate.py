# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4", "scipy==1.18.1"]
# ///
# Makes the fixture of lbfgsb.golden.test.ts with SciPy:
# uv run packages/mteb/src/dependencies/fixtures/lbfgsb/generate.py
#
# expected.json holds, for each case, the function, x0, the
# options of scipy.optimize.minimize(method="L-BFGS-B", jac=True) and what
# it returned: x, fun, jac, nit, nfev, status and message.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

VERSIONS = {"numpy": "2.5.4", "scipy": "1.18.1"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import numpy as np
from scipy.optimize import minimize

HERE = Path(__file__).resolve().parent


# The objective functions. Each adds in index order with plain floats, as
# lbfgsb.golden.test.ts does, so that f and g are the same in Python and
# TypeScript.
def quadratic(x):
    # sum a_i (x_i - c_i)^2 + 0.5 sum x_i x_{i+1}: convex, minimum inside.
    a = [1.0, 2.0, 3.0, 0.5, 4.0, 1.5]
    c = [1.0, -2.0, 0.5, 3.0, -1.0, 2.0]
    f = 0.0
    g = [0.0] * len(x)
    for i in range(len(x)):
        diff = x[i] - c[i]
        f += a[i] * diff * diff
        g[i] += 2.0 * a[i] * diff
    for i in range(len(x) - 1):
        f += 0.5 * x[i] * x[i + 1]
        g[i] += 0.5 * x[i + 1]
        g[i + 1] += 0.5 * x[i]
    return f, g


def rosenbrock(x):
    f = 0.0
    g = [0.0] * len(x)
    for i in range(len(x) - 1):
        t = x[i + 1] - x[i] * x[i]
        s = 1.0 - x[i]
        f += 100.0 * t * t + s * s
        g[i] += -400.0 * x[i] * t - 2.0 * s
        g[i + 1] += 200.0 * t
    return f, g


PROBLEMS = {"quadratic": quadratic, "rosenbrock": rosenbrock}

INF = float("inf")


def case(name, function, x0, options, bounds=None):
    result = minimize(
        lambda x: PROBLEMS[function]([float(v) for v in x]),
        np.asarray(x0, dtype=np.float64),
        method="L-BFGS-B",
        jac=True,
        bounds=bounds,
        options=options,
    )
    return {
        "case": name,
        "function": function,
        "x0": x0,
        "options": options,
        "bounds": None if bounds is None else [[str(lo) if lo in (INF, -INF) else lo, str(hi) if hi in (INF, -INF) else hi] for lo, hi in bounds],
        "result": {
            "x": result.x.tolist(),
            "fun": float(result.fun),
            "jac": np.asarray(result.jac).tolist(),
            "nit": int(result.nit),
            "nfev": int(result.nfev),
            "status": int(result.status),
            "message": result.message,
        },
    }


cases = [
    case("a quadratic from zero", "quadratic", [0.0] * 6, {}),
    case("a quadratic with the tolerances of LogisticRegression", "quadratic", [5.0, -5.0, 5.0, -5.0, 5.0, -5.0], {"maxiter": 100, "maxls": 50, "gtol": 1e-4, "ftol": 64 * np.finfo(float).eps}),
    case("Rosenbrock in 2 variables", "rosenbrock", [-1.2, 1.0], {}),
    case("Rosenbrock in 7 variables: more updates than maxcor 5", "rosenbrock", [-1.2, 1.0, -1.2, 1.0, -1.2, 1.0, -1.2], {"maxcor": 5}),
    case("Rosenbrock stops at maxiter", "rosenbrock", [-1.2, 1.0, -1.2, 1.0], {"maxiter": 7}),
    case("Rosenbrock stops at maxfun", "rosenbrock", [-1.2, 1.0, -1.2, 1.0], {"maxfun": 10}),
    case("a quadratic in a box: the minimum is on bounds", "quadratic", [0.0] * 6, {},
         bounds=[(0.0, 0.5), (-1.0, INF), (-INF, 0.2), (2.0, 2.0), (-INF, INF), (0.0, 1.0)]),
    case("Rosenbrock with lower, upper and two-sided bounds", "rosenbrock", [-1.2, 1.0, -1.2, 1.0, 0.3], {},
         bounds=[(-2.0, 0.5), (0.5, INF), (-INF, 0.8), (-1.0, 1.0), (0.0, 0.25)]),
    case("x0 outside the bounds is clipped", "rosenbrock", [3.0, -3.0, 3.0], {},
         bounds=[(-1.0, 1.0), (-1.0, 1.0), (-1.0, 1.0)]),
    case("a start at the minimum converges at once", "quadratic", [0.7, -0.9, 0.4, 2.8, -0.85, 1.3], {"gtol": 10.0}),
    case("a quadratic near its minimum with one-sided bounds: the first step stays below 1", "quadratic",
         [1.02, -1.97, 0.53, 2.96, -0.98, 1.97], {},
         bounds=[(1.01, INF), (-INF, -1.95), (0.0, INF), (-INF, 3.5), (-1.0, INF), (-INF, 1.99)]),
    case("Rosenbrock with upper bounds that the line search meets", "rosenbrock", [-1.2, 1.0, -1.2, 1.0, -1.2, 1.0], {},
         bounds=[(-INF, 0.6)] * 6),
    case("Rosenbrock with lower bounds that the line search meets", "rosenbrock", [2.5, 2.0, 2.5, 2.0, 2.5], {},
         bounds=[(1.3, INF), (-INF, INF), (1.3, INF), (-INF, INF), (1.1, INF)]),
    case("Rosenbrock in a box that holds the start only", "rosenbrock", [0.0, 0.0, 0.0, 0.0], {"maxcor": 3},
         bounds=[(-0.5, 0.4), (-0.5, 0.3), (-0.5, 0.5), (-0.5, 0.35)]),
]

generator = f"generate.py: numpy {VERSIONS['numpy']}, scipy {VERSIONS['scipy']}, CPython {platform.python_version()}"
(HERE / "expected.json").write_text(json.dumps({"generator": generator, "cases": cases}, indent=1) + "\n", encoding="utf-8")
print(f"{generator}: {len(cases)} cases", file=sys.stderr)
for c in cases:
    print(c["case"], c["result"]["nit"], c["result"]["nfev"], c["result"]["status"], c["result"]["message"], file=sys.stderr)
