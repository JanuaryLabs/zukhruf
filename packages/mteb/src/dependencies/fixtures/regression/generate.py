# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4", "scipy==1.18.1", "scikit-learn==1.9.1", "pandas==3.1.0", "datasets==5.1.0"]
# ///
# Makes the fixture of regression.golden.test.ts with the libraries that
# MTEB's regression tasks call:
# uv run packages/mteb/src/dependencies/fixtures/regression/generate.py
#
# expected.json holds, for each case, its inputs and what came back:
# - kendalltau: scipy.stats.kendalltau(x, y).statistic, x float64 and y
#   float32, as MTEB passes the true values and the predictions. The values of
#   the largest case are "generated": x is default_rng(4).integers(0, 300), y
#   is default_rng(5).integers(0, 100000) minus 50000, over 1000, as float32;
# - metrics: mean_squared_error, mean_absolute_error, r2_score and
#   np.sqrt(mean_squared_error) with y_true a datasets Column and y_pred a
#   float32 array;
# - qcut: pd.qcut(x, 10, labels=False, duplicates="drop");
# - train_test_split: the train and test indices of
#   Dataset.train_test_split(test_size, seed, stratify_by_column) over a
#   ClassLabel column, in their order, or its error;
# - linear_regression: LinearRegression().fit on float32 data: coef_,
#   intercept_, rank_, singular_ and predict of the test data. Each case has
#   full rank, but one with a copied column, which loses exactly one rank. The data of a
#   case is inline, or "generated": default_rng(seed).integers(0, 1000)
#   values minus 500, over 100, as float32, so that the test makes the same
#   data without a large file.
# NaN is null. Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
import sys
import warnings
from pathlib import Path

VERSIONS = {
    "numpy": "2.5.4",
    "scipy": "1.18.1",
    "scikit-learn": "1.9.1",
    "pandas": "3.1.0",
    "datasets": "5.1.0",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import datasets
import numpy as np
import pandas as pd
from scipy.stats import kendalltau
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

datasets.disable_progress_bars()
warnings.simplefilter("ignore")
HERE = Path(__file__).resolve().parent
rng = np.random.default_rng(3243)
f32 = np.float32


def nan_to_none(values):
    return [None if np.isnan(value) else float(value) for value in values]


def column(values):
    return datasets.Dataset.from_dict({"v": list(values)})["v"]


# kendalltau
def kendall_case(name, x, y):
    x = [float(value) for value in x]
    y = np.asarray(y, dtype=f32)
    statistic = float(kendalltau(x, y).statistic)
    return {"case": name, "x": nan_to_none(x), "y": nan_to_none(y), "statistic": None if np.isnan(statistic) else statistic}


ties = rng.integers(0, 40, 2000)
kendall = [
    kendall_case("no ties, 20 values", rng.normal(size=20), rng.normal(size=20)),
    kendall_case("no ties, 50 values", rng.normal(size=50), rng.normal(size=50)),
    kendall_case("ties in x", rng.integers(0, 5, 30), rng.normal(size=30)),
    kendall_case("ties in y", rng.normal(size=30), rng.integers(0, 5, 30)),
    kendall_case("joint ties", [1, 1, 1, 2, 2, 3, 3, 3, 4, 5], [1, 1, 2, 2, 2, 3, 3, 4, 4, 4]),
    kendall_case("x constant", [3] * 8, rng.normal(size=8)),
    kendall_case("y constant", rng.normal(size=8), [3] * 8),
    kendall_case("empty", [], []),
    kendall_case("one value", [1], [2]),
    kendall_case("a NaN", [1, 2, float("nan"), 4], [4, 3, 2, 1]),
    kendall_case("two values", [1, 2], [5, 3]),
    kendall_case("three identical values: the clip to 1", [1, 2, 3], [1, 2, 3]),
    kendall_case("x not rounded to float32", [1, 1 + 2**-30, 2, 3], [1, 2, 3, 4]),
    kendall_case("0.0 and -0.0 are equal", [0.0, -0.0, 1.0, 2.0], [-0.0, 0.0, 1.0, 1.0]),
    kendall_case("2000 values with ties", ties, ties + rng.integers(0, 10, 2000)),
    {
        **kendall_case(
            "18227 values, the size of a test split",
            np.random.default_rng(4).integers(0, 300, 18227),
            (np.random.default_rng(5).integers(0, 100000, 18227) - 50000) / 1000,
        ),
        "x": None,
        "y": None,
        "generated": {"x": [4, 300, 18227], "y": [5, 100000, 18227]},
    },
]


# The metrics
def metrics_case(name, y_true, y_pred):
    y_pred = np.asarray(y_pred, dtype=f32)
    y_true = list(y_true)
    mse = mean_squared_error(column(y_true), y_pred)
    r2 = r2_score(column(y_true), y_pred)
    return {
        "case": name,
        "y_true": y_true,
        "y_pred": [float(value) for value in y_pred],
        "mse": float(mse),
        "mae": float(mean_absolute_error(column(y_true), y_pred)),
        "r2": None if np.isnan(r2) else float(r2),
        "rmse": float(np.sqrt(mse)),
    }


def noisy(n, scale=1.0):
    y_true = [float(value) for value in rng.normal(size=n) * scale]
    return y_true, np.asarray(y_true) + rng.normal(size=n) * 0.3 * scale


metrics = [metrics_case(f"{n} values", *noisy(n)) for n in (1, 2, 7, 8, 9, 128, 129, 300, 4097)]
perfect = [float(value) for value in f32(rng.normal(size=20))]
years = [int(value) for value in rng.integers(1990, 2024, 200)]
metrics += [
    metrics_case("perfect predictions", perfect, perfect),
    metrics_case("constant y_true, wrong predictions", [2.5] * 10, rng.normal(size=10)),
    metrics_case("constant y_true, right predictions", [2.5] * 10, [2.5] * 10),
    metrics_case("years: y_true rounds to float32", [value + 0.3 for value in years], np.asarray(years) + rng.normal(size=200)),
    metrics_case("int y_true", years, np.asarray(years) + rng.normal(size=200) * 3),
    metrics_case("values of very different sizes", [1e-3, 2e-3, 1000.0, 3000.0, 5e-4, 2000.0], [0.0, 1.0, 999.0, 3001.0, 0.0, 1999.5]),
    # Each deviation from the mean rounds to float32 before its square: r2
    # differs in its last bit otherwise.
    metrics_case(
        "deviations that float32 rounds",
        [533.4773507013176, 0.00012681474835733465, 0.0008063489347063569, 730.4781360842476],
        [305.3915710449219, 26.09494400024414, -109.91110229492188, 789.6978149414062],
    ),
]


# qcut
def qcut_case(name, x):
    x = list(x)
    ids = pd.qcut(x, q=10, labels=False, duplicates="drop")
    return {"case": name, "x": x, "ids": nan_to_none(np.asarray(ids, dtype=float))}


qcuts = [
    qcut_case("normal", [float(value) for value in rng.normal(size=200)]),
    qcut_case("ints 0 to 6", [int(value) for value in rng.integers(0, 7, 150)]),
    qcut_case("floor of an exponential: many zeros", [int(value) for value in np.floor(rng.exponential(2, 300))]),
    qcut_case("fewer than 10 values", [3.0, 1.0, 4.0, 1.5, 9.0, 2.0]),
    qcut_case("11 values", list(range(11))),
    qcut_case("negative values", [float(value) for value in rng.normal(-50, 10, 40)]),
    qcut_case("values on the edges of the quantiles", list(range(101))),
    qcut_case("two values: ids 0 and 3 of 2 bins", [0, 0, 10, 10]),
    qcut_case("a constant", [7] * 12),
    qcut_case("an edge that the next float up moves past equal values", [5, 4, 5, 4, 3, 3]),
]


# train_test_split
def split_case(name, labels, test_size, seed):
    labels = [int(value) for value in labels]
    names = [str(value) for value in range(max(labels) + 1)]
    dataset = datasets.Dataset.from_dict({"label": labels}).cast_column("label", datasets.ClassLabel(names=names))
    case = {"case": name, "labels": labels, "test_size": test_size, "seed": seed}
    try:
        split = dataset.add_column("i", list(range(len(labels)))).train_test_split(
            test_size=test_size, seed=seed, stratify_by_column="label"
        )
        case["train"] = list(split["train"]["i"])
        case["test"] = list(split["test"]["i"])
    except ValueError as error:
        case["error"] = str(error)
    return case


def binned(values, bins):
    return pd.qcut(values, q=bins, labels=False, duplicates="drop").tolist()


splits = [
    split_case("normal values in 10 bins", binned(rng.normal(size=300), 10), 100, 42),
    split_case("ints in 5 bins", binned(rng.integers(0, 50, 200), 5), 60, 43),
    split_case("heavy ties in 5 bins", binned(np.floor(rng.exponential(1, 250)), 5), 70, 44),
    split_case("2048 of 2100", binned(rng.normal(size=2100), 10), 2048, 45),
    split_case("floor of an exponential in 6 bins", binned(np.floor(rng.exponential(3, 400)), 6), 120, 46),
    split_case("as many test rows as classes", binned(rng.normal(size=50), 5), 5, 47),
    split_case("a class of 2 rows", [0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2], 4, 48),
    split_case("a class of 1 row", [0, 1, 1, 1, 2, 2, 2], 3, 49),
    split_case("fewer train rows than classes", binned(rng.normal(size=105), 10), 100, 50),
    split_case("fewer test rows than classes", binned(rng.normal(size=60), 10), 5, 51),
]


# LinearRegression
def generated(seed, n, d):
    return ((np.random.default_rng(seed).integers(0, 1000, n * d) - 500) / 100).astype(f32).reshape(n, d)


def regression_case(name, x, y, x_test, data, rank=None):
    x = np.asarray(x, dtype=f32)
    x_test = np.asarray(x_test, dtype=f32)
    model = LinearRegression().fit(x, y)
    singular = model.singular_
    rank = x.shape[1] if rank is None else rank
    assert model.rank_ == rank, (name, model.rank_)
    assert singular[rank - 1] / singular[0] > 1e-4, (name, singular[rank - 1] / singular[0])
    return {
        "case": name,
        **data,
        "coef": [float(value) for value in model.coef_],
        "intercept": float(model.intercept_),
        "rank": int(model.rank_),
        "singular": [float(value) for value in singular],
        "predictions": [float(value) for value in model.predict(x_test)],
    }


def inline(name, x, y, x_test, rank=None):
    x = np.asarray(x, dtype=f32)
    x_test = np.asarray(x_test, dtype=f32)
    data = {"x": x.tolist(), "y": list(y), "x_test": x_test.tolist()}
    return regression_case(name, x, y, x_test, data, rank)


def floats(values):
    return [float(value) for value in values]


x = rng.normal(size=(60, 20)).astype(f32)
w = rng.normal(size=20)
overdetermined = inline("60 x 20", x, floats(x @ w + rng.normal(size=60)), rng.normal(size=(30, 20)))
counts = rng.integers(0, 20, (300, 32)).astype(f32)
counts_like = inline("300 x 32 counts", counts, floats(counts @ rng.normal(size=32) + rng.normal(size=300) * 5), rng.integers(0, 20, (80, 32)))
twice = rng.normal(size=(30, 8)).astype(f32)
duplicated = inline("duplicated rows", np.vstack([twice, twice]), floats(rng.normal(size=60)), rng.normal(size=(20, 8)))
single = rng.normal(size=(50, 1)).astype(f32)
one_feature = inline("one feature", single, floats(3 * single[:, 0] + rng.normal(size=50)), rng.normal(size=(15, 1)))
int_x = rng.normal(size=(80, 5)).astype(f32)
int_y = inline("int y", int_x, [int(value) for value in np.round(int_x @ rng.normal(size=5) * 10)], rng.normal(size=(20, 5)))
year_x = rng.normal(size=(100, 6)).astype(f32)
year_y = inline("y near 2015", year_x, [int(value) for value in 2015 + np.round(year_x @ rng.normal(size=6) * 3)], rng.normal(size=(30, 6)))
big_x = generated(1, 2048, 256)
big_test = generated(2, 300, 256)
big_y = floats(big_x @ np.random.default_rng(3).normal(size=256))
big = regression_case(
    "2048 x 256",
    big_x,
    big_y,
    big_test,
    {"generated": {"x": [1, 2048, 256], "x_test": [2, 300, 256]}, "y": big_y},
)
# A copy of a column: the centred rows lose exactly one rank, and the singular
# value of the copy is 0 up to rounding, far below the cut of lstsq.
copied = rng.normal(size=(40, 5)).astype(f32)
copied[:, 4] = copied[:, 3]
copied_test = rng.normal(size=(15, 5)).astype(f32)
copied_test[:, 4] = copied_test[:, 3]
copied_column = inline("a copied column", copied, floats(copied @ rng.normal(size=5) + rng.normal(size=40)), copied_test, rank=4)
linear_regressions = [overdetermined, counts_like, big, duplicated, one_feature, int_y, year_y, copied_column]

generator = (
    f"generate.py: numpy {VERSIONS['numpy']}, scipy {VERSIONS['scipy']}, "
    f"scikit-learn {VERSIONS['scikit-learn']}, pandas {VERSIONS['pandas']}, datasets {VERSIONS['datasets']}, "
    f"CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "kendalltau": kendall,
            "metrics": metrics,
            "qcut": qcuts,
            "train_test_split": splits,
            "linear_regression": linear_regressions,
        },
        allow_nan=False,
    )
    + "\n",
    encoding="utf-8",
)
print(generator, file=sys.stderr)
for case in splits:
    print(case["case"], case["error"] if "error" in case else "ok", file=sys.stderr)
