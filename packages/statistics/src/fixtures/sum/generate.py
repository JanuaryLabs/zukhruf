# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4"]
# ///
# Makes the fixture of sum.golden.test.ts: numpy.sum and numpy.mean of 1-D
# float64 arrays, and numpy.nanmean of 1-D float64 arrays with NaN values. The lengths cover each branch of numpy's pairwise_sum
# (loops_utils.h): fewer than 8 values, 8 to 128 values (8 accumulators), and
# more than 128 values (two halves, the first cut down to a multiple of 8,
# such as 129 = 64 + 65 and 1001 = 496 + 505). The random values have nine
# orders of magnitude, so a sum from left to right gives other bits, and
# arrays of -0.0 show that numpy.sum starts from the identity 0.0.
# numpy.nanmean sets each NaN to 0.0, adds all the values and divides by the
# number of values that are not NaN. The NaN values of its arrays move the
# number of the other values over a branch (8 to 7, 129 to 128) or move the
# cut of the halves, so a mean of only the other values gives other bits.
# Arrays of -0.0 with no NaN show that numpy.nanmean also starts from 0.0. JSON
# has no NaN, so the fixture writes NaN as null. Never edit
# expected.json by hand: run this script again.
# uv run packages/statistics/src/fixtures/sum/generate.py
import json
import sys
import warnings
from functools import reduce
from pathlib import Path

import numpy as np

assert sys.version.startswith("3.12.9"), sys.version
assert np.__version__ == "2.5.4", np.__version__

rng = np.random.default_rng(3969)
lengths = [1, 2, 7, 8, 9, 15, 16, 17, 127, 128, 129, 130, 255, 256, 257, 1001, 2049]
arrays = [
    (rng.normal(size=n) * 10.0 ** rng.integers(-3, 6, size=n)).tolist()
    for n in lengths
]
left_to_right = [reduce(lambda total, value: total + value, values, 0.0) for values in arrays]
order_matters = sum(
    float(np.sum(np.array(values))) != total
    for values, total in zip(arrays, left_to_right)
)
assert order_matters >= 10, order_matters
arrays += [[-0.0] * n for n in [1, 7, 8, 200]]

nan_rng = np.random.default_rng(3991)
# (length, number of NaN values)
with_nan = [(8, 1), (9, 2), (17, 0), (129, 1), (136, 8), (257, 1), (1001, 10), (2049, 100)]
nan_arrays = []
for n, nans in with_nan:
    values = nan_rng.normal(size=n) * 10.0 ** nan_rng.integers(-3, 6, size=n)
    values[nan_rng.choice(n, size=nans, replace=False)] = np.nan
    nan_arrays.append(values.tolist())
nan_arrays += [[float("nan")] * n for n in [1, 200]]
nan_arrays += [[], [-0.0] * 7 + [float("nan")], [-0.0, float("nan")], [-0.0], [-0.0] * 8]
with warnings.catch_warnings():
    warnings.simplefilter("ignore", RuntimeWarning)
    nanmeans = [float(np.nanmean(np.array(values))) for values in nan_arrays]
    kept_means = [
        float(np.mean(np.array([value for value in values if value == value])))
        for values in nan_arrays
    ]
kept_differs = sum(
    nanmean != kept for nanmean, kept in zip(nanmeans, kept_means) if nanmean == nanmean
)
assert kept_differs >= 3, kept_differs


def nan_as_null(values):
    return [None if value != value else value for value in values]


fixture = {
    "generator": f"generate.py: NumPy {np.__version__}, CPython {sys.version.split()[0]}",
    "arrays": arrays,
    "sum": [float(np.sum(np.array(values))) for values in arrays],
    "mean": [float(np.mean(np.array(values))) for values in arrays],
    "nanArrays": [nan_as_null(values) for values in nan_arrays],
    "nanmean": nan_as_null(nanmeans),
}
here = Path(__file__).parent
(here / "expected.json").write_text(json.dumps(fixture, indent=1) + "\n")
print(f"{len(arrays)} arrays, {order_matters} whose sum from left to right differs")
print(f"{len(nan_arrays)} arrays with NaN, {kept_differs} whose mean of the other values differs")
