# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4", "scipy==1.18.1", "scikit-learn==1.9.1"]
# ///
# Makes the fixture of logistic-regression.golden.test.ts with scikit-learn:
# uv run packages/mteb/src/dependencies/fixtures/logistic-regression/generate.py
#
# expected.json holds, for each case, float32 train and test data made here
# and what LogisticRegression(max_iter=max_iter, random_state=42) gave, as
# MTEB's classification tasks call it: coef_, intercept_ and n_iter_ after
# fit, and decision_function and predict of the test data.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
import sys
import warnings
from pathlib import Path

VERSIONS = {"numpy": "2.5.4", "scipy": "1.18.1", "scikit-learn": "1.9.1"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import numpy as np
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression

HERE = Path(__file__).resolve().parent
rng = np.random.default_rng(3243)


def blobs(n_classes, per_class, dim, spread):
    centers = rng.normal(0, 1, size=(n_classes, dim))
    x = np.concatenate([centers[c] + rng.normal(0, spread, size=(per_class, dim)) for c in range(n_classes)])
    y = np.repeat(np.arange(n_classes), per_class)
    order = rng.permutation(len(y))
    return x[order].astype(np.float32), y[order]


def case(name, x, y, x_test, max_iter=100, labels=None):
    if labels is not None:
        y = np.asarray([labels[v] for v in y])
    model = LogisticRegression(max_iter=max_iter).set_params(random_state=42)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ConvergenceWarning)
        model.fit(x, y)
    assert model.coef_.dtype == np.float32
    return {
        "case": name,
        "max_iter": max_iter,
        "x": x.tolist(),
        "y": y.tolist(),
        "x_test": x_test.tolist(),
        "classes": model.classes_.tolist(),
        "coef": model.coef_.tolist(),
        "intercept": model.intercept_.tolist(),
        "n_iter": int(model.n_iter_[0]),
        "decision_function": np.atleast_2d(model.decision_function(x_test).T).T.tolist()
        if model.coef_.shape[0] > 1
        else [[v] for v in model.decision_function(x_test).tolist()],
        "predict": model.predict(x_test).tolist(),
    }


def split(x, y, n_train):
    return x[:n_train], y[:n_train], x[n_train:]


cases = []
x, y = blobs(2, 30, 4, 0.2)
cases.append(case("two separable classes", *split(x, y, 40)))
x, y = blobs(2, 40, 6, 1.5)
cases.append(case("two classes that overlap", *split(x, y, 60)))
x, y = blobs(3, 25, 5, 0.3)
cases.append(case("three separable classes", *split(x, y, 60)))
x, y = blobs(5, 30, 8, 1.2)
cases.append(case("five classes that overlap", *split(x, y, 120)))
x, y = blobs(5, 30, 8, 1.2)
cases.append(case("five classes stop at max_iter 5", *split(x, y, 120), max_iter=5))
x, y = blobs(77, 10, 16, 0.8)
cases.append(case("77 classes of 8 train samples, as Banking77 undersamples", *split(x, y, 616)))
x, y = blobs(3, 20, 4, 0.9)
cases.append(case("string labels", *split(x, y, 45), labels=["neg", "neu", "pos"]))
x, y = blobs(5, 30, 8, 1.2)
cases.append(case("five classes after one iteration", *split(x, y, 120), max_iter=1))
x, y = blobs(2, 40, 6, 1.5)
cases.append(case("two classes after one iteration", *split(x, y, 60), max_iter=1))
# The same inputs in each class: the gradient at 0 is 0, so the fit stays at
# 0 and every decision value is 0, a tie.
same = rng.normal(0, 1, size=(10, 3)).astype(np.float32)
cases.append(case("two classes with the same inputs: each decision value is 0", np.concatenate([same, same]), np.repeat([0, 1], 10), same[:4]))
cases.append(case("three classes with the same inputs: the classes tie", np.concatenate([same, same, same]), np.repeat([0, 1, 2], 10), same[:4]))

generator = f"generate.py: numpy {VERSIONS['numpy']}, scipy {VERSIONS['scipy']}, scikit-learn {VERSIONS['scikit-learn']}, CPython {platform.python_version()}"
(HERE / "expected.json").write_text(json.dumps({"generator": generator, "cases": cases}) + "\n", encoding="utf-8")
print(f"{generator}: {len(cases)} cases", file=sys.stderr)
for c in cases:
    print(c["case"], "n_iter", c["n_iter"], file=sys.stderr)
