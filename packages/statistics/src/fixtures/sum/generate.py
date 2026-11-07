# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4"]
# ///
# Makes the fixture of sum.golden.test.ts: numpy.sum and numpy.mean of 1-D
# float64 arrays. The lengths cover each branch of numpy's pairwise_sum
# (loops_utils.h): fewer than 8 values, 8 to 128 values (8 accumulators), and
# more than 128 values (two halves, the first cut down to a multiple of 8,
# such as 129 = 64 + 65 and 1001 = 496 + 505). The random values have nine
# orders of magnitude, so a sum from left to right gives other bits, and
# arrays of -0.0 show that numpy.sum starts from the identity 0.0. Never edit
# expected.json by hand: run this script again.
# uv run packages/statistics/src/fixtures/sum/generate.py
import json
import sys
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
fixture = {
    "generator": f"generate.py: NumPy {np.__version__}, CPython {sys.version.split()[0]}",
    "arrays": arrays,
    "sum": [float(np.sum(np.array(values))) for values in arrays],
    "mean": [float(np.mean(np.array(values))) for values in arrays],
}
here = Path(__file__).parent
(here / "expected.json").write_text(json.dumps(fixture, indent=1) + "\n")
print(f"{len(arrays)} arrays, {order_matters} whose sum from left to right differs")
