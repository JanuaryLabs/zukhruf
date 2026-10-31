# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4", "scipy==1.18.1"]
# ///
# Makes the fixture of gammaln.golden.test.ts with SciPy:
# uv run packages/mteb/src/dependencies/fixtures/gammaln/generate.py
#
# expected.json holds scipy.special.gammaln(x) for each integer x from 1 to
# 4097 and for larger x. The AMI of scikit-learn calls gammaln for integers
# from 1 to the number of samples plus 1. These x reach each branch of the lgam
# of Cephes: the recurrence below 13, Stirling's series from 13, its short form
# from 1000 and q only above 1e8.
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

from scipy.special import gammaln

xs = [float(x) for x in range(1, 4098)] + [1e4, 123456.0, 999999.0, 1e8, 1e8 + 1, 1e9, 2.0**53]
generator = f"generate.py: scipy {VERSIONS['scipy']}, numpy {VERSIONS['numpy']}, CPython {platform.python_version()}, {platform.system()} {platform.machine()}"
(Path(__file__).resolve().parent / "expected.json").write_text(
    json.dumps({"generator": generator, "gammaln": [[x, float(gammaln(x))] for x in xs]}) + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(xs)} values", file=sys.stderr)
