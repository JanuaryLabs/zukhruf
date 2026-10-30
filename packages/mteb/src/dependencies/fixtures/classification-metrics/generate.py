# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4", "scikit-learn==1.9.1"]
# ///
# Makes the fixture of classification-metrics.golden.test.ts with
# scikit-learn:
# uv run packages/mteb/src/dependencies/fixtures/classification-metrics/generate.py
#
# expected.json holds, for each case, the true and the predicted labels, and
# what accuracy_score, and f1_score, precision_score and recall_score with
# average="macro" and average="weighted", returned for them.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
import random
import sys
import warnings
from pathlib import Path

VERSIONS = {"numpy": "2.5.4", "scikit-learn": "1.9.1"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

from sklearn.exceptions import UndefinedMetricWarning
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score

HERE = Path(__file__).resolve().parent
rng = random.Random(3243)


def case(name, y_true, y_pred):
    scores = {"accuracy": accuracy_score(y_true, y_pred)}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UndefinedMetricWarning)
        for average in ("macro", "weighted"):
            scores[f"f1_{average}"] = f1_score(y_true, y_pred, average=average)
            scores[f"precision_{average}"] = precision_score(y_true, y_pred, average=average)
            scores[f"recall_{average}"] = recall_score(y_true, y_pred, average=average)
    return {"case": name, "y_true": y_true, "y_pred": y_pred, "scores": scores}


def noisy(y_true, labels, share):
    return [rng.choice(labels) if rng.random() < share else label for label in y_true]


banking = [rng.randrange(77) for _ in range(3080)]
binary = [rng.randrange(2) for _ in range(301)]
ten = [rng.randrange(10) for _ in range(500)]
cases = [
    case("all labels right", [0, 1, 2, 2, 1], [0, 1, 2, 2, 1]),
    case("all labels wrong", [0, 1, 0, 1], [1, 0, 1, 0]),
    case("one class in y_true and y_pred", [3, 3, 3], [3, 3, 3]),
    case("one class in y_true, two in y_pred", [1, 1, 1, 1], [1, 0, 1, 1]),
    case("a class of y_true missing from the predictions", [0, 1, 2, 2, 0], [0, 1, 1, 1, 0]),
    case("a predicted class missing from y_true", [0, 0, 1, 1], [0, 2, 1, 2]),
    case("labels that are not 0 to n - 1", [10, -3, 7, 7, 10, -3], [10, 7, 7, -3, 10, -3]),
    case("string labels", ["neg", "pos", "neu", "pos"], ["pos", "pos", "neu", "neg"]),
    case("one sample", [5], [4]),
    case("301 binary labels", binary, noisy(binary, [0, 1], 0.3)),
    case("500 labels of 10 classes", ten, noisy(ten, list(range(10)), 0.4)),
    case("3080 labels of 77 classes", banking, noisy(banking, list(range(77)), 0.5)),
]

generator = f"generate.py: numpy {VERSIONS['numpy']}, scikit-learn {VERSIONS['scikit-learn']}, CPython {platform.python_version()}"
(HERE / "expected.json").write_text(json.dumps({"generator": generator, "cases": cases}) + "\n", encoding="utf-8")
print(f"{generator}: {len(cases)} cases", file=sys.stderr)
