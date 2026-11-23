# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4"]
# ///
# Makes the fixture of std.golden.test.ts: numpy.std of 1-D float64 arrays,
# each with ddof 0 (the default of NumPy) and ddof 1, and four arrays with
# ddof 2 and 0.5. numpy.std (_var of numpy/_core/_methods.py) divides the
# pairwise sum by the number of values for the mean, squares each deviation
# from the mean, adds the squares with the pairwise sum and divides that sum
# by max(n - ddof, 0), then takes the square root. The lengths cover each
# branch of the pairwise sum (fewer than 8 values, 8 to 128 values, more than
# 128 values). The random values have nine orders of magnitude, and some
# arrays have a large mean (1e9) with small deviations, so a computation that
# adds from left to right gives other bits. The edge cases are: no values,
# one value, a ddof equal to the number of values or above it (a divisor of
# 0: 0/0 gives NaN, and a sum above 0 gives inf), and values of -0.0. JSON
# has no NaN or Infinity, so the fixture writes them as the strings "NaN" and
# "Infinity", which Number() of JavaScript reads. Never edit expected.json by
# hand: run this script again.
# uv run packages/statistics/src/fixtures/std/generate.py
import json
import math
import sys
import warnings
from functools import reduce
from pathlib import Path

import numpy as np

assert sys.version.startswith("3.12.9"), sys.version
assert np.__version__ == "2.5.4", np.__version__

rng = np.random.default_rng(3992)
lengths = [2, 7, 8, 9, 16, 17, 127, 128, 129, 255, 257, 1001, 2049]
arrays = [
    (rng.normal(size=n) * 10.0 ** rng.integers(-3, 6, size=n)).tolist()
    for n in lengths
]
arrays += [(1e9 + rng.normal(size=n) * 1e-3).tolist() for n in [9, 129, 1001]]


def left_to_right(values, ddof):
    total = reduce(lambda acc, value: acc + value, values, 0.0)
    average = total / len(values)
    squares = reduce(
        lambda acc, value: acc + (value - average) * (value - average), values, 0.0
    )
    return math.sqrt(squares / max(len(values) - ddof, 0))


order_matters = sum(
    float(np.std(np.array(values))) != left_to_right(values, 0) for values in arrays
)
assert order_matters == 11, order_matters

# (values, ddof)
cases = [(values, ddof) for values in arrays for ddof in (0, 1)]
# ddof 2 and 0.5 on one array for each branch of the pairwise sum (9, 129 and
# 2049 values) and on one array with a large mean (129 values).
cases += [(arrays[index], ddof) for index in (3, 8, 12, 14) for ddof in (2, 0.5)]
cases += [
    ([], 0),
    ([], 1),
    ([2.5], 0),
    ([2.5], 1),
    ([2.5, 2.5], 2),
    ([1.0, 3.0], 2),
    ([1.0, 3.0], 3),
    ([-0.0] * 8, 0),
    ([-0.0] * 200, 1),
]

ddof_matters = sum(
    float(np.std(np.array(values), ddof=0)) != float(np.std(np.array(values), ddof=1))
    for values in arrays
)
assert ddof_matters == len(arrays), ddof_matters


def as_json(value):
    if value != value:
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


with warnings.catch_warnings():
    warnings.simplefilter("ignore", RuntimeWarning)
    expected = [float(np.std(np.array(values), ddof=ddof)) for values, ddof in cases]

fixture = {
    "generator": f"generate.py: NumPy {np.__version__}, CPython {sys.version.split()[0]}",
    "cases": [
        {"values": values, "ddof": ddof, "std": as_json(std)}
        for (values, ddof), std in zip(cases, expected)
    ],
}
here = Path(__file__).parent
(here / "expected.json").write_text(json.dumps(fixture, indent=1, allow_nan=False) + "\n")
print(f"{len(cases)} cases, {order_matters} arrays whose std from left to right differs")
