# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4"]
# ///
# Makes the fixture of quantile-method.golden.test.ts: numpy.quantile of each
# sorted array at each q, with the methods lower, higher, linear and
# inverted_cdf. The arrays hold one value, two values, ties and negative
# values, the 2000 values arange(2000) / 997, and random values of six orders
# of magnitude, where the linear method of NumPy and a + (b - a)t give other
# bits. Never edit expected.json by hand: run this script again.
# uv run packages/statistics/src/fixtures/generate.py
import json
import sys
from pathlib import Path

import numpy as np

assert sys.version.startswith("3.12.9"), sys.version
assert np.__version__ == "2.5.4", np.__version__

rng = np.random.default_rng(3819)
arrays = [
    [3.5],
    [1.0, 2.0],
    sorted([5.0, -1.0, 3.0, 3.0, 0.1]),
    (np.arange(2000) / 997).tolist(),
]
for size in rng.integers(2, 60, size=20):
    scale = 10.0 ** rng.integers(0, 6)
    arrays.append(sorted((rng.normal(size=int(size)) * scale).tolist()))
qs = [0.0, 0.025, 1 / 3, 0.5, 0.975, 1.0] + rng.random(5).tolist()
methods = ["lower", "higher", "linear", "inverted_cdf"]
expected = {
    method: [
        [float(np.quantile(np.array(values), q, method=method)) for q in qs]
        for values in arrays
    ]
    for method in methods
}
fixture = {
    "generator": f"generate.py: NumPy {np.__version__}, CPython {sys.version.split()[0]}",
    "arrays": arrays,
    "qs": qs,
    "expected": expected,
}
here = Path(__file__).parent
(here / "expected.json").write_text(json.dumps(fixture, indent=1) + "\n")
print(f"{len(arrays)} arrays, {len(qs)} quantiles, {len(methods)} methods")
