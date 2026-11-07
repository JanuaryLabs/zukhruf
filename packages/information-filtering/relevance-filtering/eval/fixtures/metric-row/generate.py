# /// script
# requires-python = "==3.13.*"
# dependencies = ["numpy==2.3.4"]
# ///
# Makes the fixture of the golden test of ../../metrics.ts with metric_row of
# the research oracle, round-2 evaluate.py, at its pinned numpy:
# uv run packages/information-filtering/relevance-filtering/eval/fixtures/metric-row/generate.py
#
# evaluate.py reads the collection when it loads, so this script runs only
# its functions counts, f05, t11su, ece and metric_row, as their source text,
# after it checks the sha256 of evaluate.py against evaluate.sha256.
# expected.json holds, for each stream, the decisions, the probabilities and
# the relevance of each article, and what metric_row gave for them. A float
# NaN is the string "NaN", because JSON has no NaN.
# Never edit expected.json by hand: run this script again.
import ast
import hashlib
import importlib.metadata
import json
import math
import platform
import random
import sys
from pathlib import Path

assert importlib.metadata.version("numpy") == "2.3.4", importlib.metadata.version("numpy")

import numpy as np

HERE = Path(__file__).resolve().parent
ORACLE = HERE.parents[5] / "docs/research/relevance-filtering/round-2"
source = (ORACLE / "evaluate.py").read_bytes()
assert hashlib.sha256(source).hexdigest() == (ORACLE / "evaluate.sha256").read_text().split()[0]

FUNCTIONS = ("counts", "f05", "t11su", "ece", "metric_row")
tree = ast.parse(source)
oracle = {"np": np}
exec(compile(ast.Module([node for node in tree.body if isinstance(node, ast.FunctionDef)
                         and node.name in FUNCTIONS], []), "evaluate.py", "exec"), oracle)
assert all(name in oracle for name in FUNCTIONS)

KEYS = ("f05", "precision", "recall", "brier", "brierSkill", "accepted", "tp", "fp", "fn")
rng = random.Random(3891)


def plain(value):
    value = float(value)
    return "NaN" if math.isnan(value) else value


def stream(name, accepted, probabilities, relevant):
    row = oracle["metric_row"](np.array(accepted, bool), np.array(probabilities, np.float64),
                               np.array(relevant, bool))
    return {"stream": name, "accepted": accepted, "probabilities": probabilities, "relevant": relevant,
            "metric_row": {key: plain(row[key]) for key in KEYS}}


def drawn(n, rate, scale):
    relevant = [rng.random() < rate for _ in range(n)]
    probabilities = [rng.random() ** scale for _ in range(n)]
    accepted = [p > 0.5 or (r and rng.random() < 0.5) for p, r in zip(probabilities, relevant)]
    return accepted, probabilities, relevant


streams = [
    stream("the four articles of the research metric_row", [True, True, False, False],
           [0.9, 0.6, 0.2, 0.1], [True, False, True, False]),
    stream("no relevant article", [True, False, False], [0.7, 0.1, 0.3], [False, False, False]),
    stream("only relevant articles", [True, False], [0.8, 0.4], [True, True]),
    stream("no hit, with false alarms and misses", [True, False, False], [0.6, 0.3, 0.1],
           [False, True, False]),
    stream("one article that is not relevant, where 1 - (1 - p) is not p", [False], [0.1], [False]),
    stream("1000 articles, a base rate of 0.3", *drawn(1000, 0.3, 1)),
    stream("3000 articles, a base rate of 0.02 and small probabilities", *drawn(3000, 0.02, 8)),
    stream("257 articles, a base rate of 0.5", *drawn(257, 0.5, 2)),
]

generator = f"generate.py: round-2 evaluate.py metric_row, numpy {np.__version__}, CPython {platform.python_version()}"
(HERE / "expected.json").write_text(json.dumps({"generator": generator, "streams": streams}) + "\n",
                                    encoding="utf-8")
print(f"{generator}: {len(streams)} streams", file=sys.stderr)
