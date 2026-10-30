# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "scikit-learn==1.9.1", "scipy==1.18.1"]
# ///
# Makes the fixture of multilabel.golden.test.ts with CPython, scikit-learn
# and MTEB:
# uv run packages/mteb/src/dependencies/fixtures/multilabel/generate.py
#
# expected.json holds:
# - set_order: lists of numpy int64 values and list(set(values));
# - set_order_large: list(set(i * 3 for i in range(count))) as the sha256 of
#   its JSON text without spaces. At 629145 values the table of 2^20 slots
#   is 3/5 full to the slot, and it grows;
# - binarizer: label sets, MultiLabelBinarizer().fit_transform of them, its
#   classes_, and transform of other label sets with unknown labels;
# - metrics: label indicator matrices y_true and y_pred, and accuracy_score,
#   f1_score(average="macro"), label_ranking_average_precision_score and
#   MTEB's hamming_score of them;
# - lrap: y_true and float scores with ties, and
#   label_ranking_average_precision_score of them;
# - stratification: label sets, a test size and a seed, and the train and
#   test indices of MTEB's _iterative_train_test_split of their binarized
#   labels; and the rows that _multilabel_subsampling keeps;
# - knn: float32 training rows with a label indicator matrix and test rows,
#   and what KNeighborsClassifier(n_neighbors=5), or 4 in one case, gave:
#   kneighbors (the distances and the indices), predict and score. The rows
#   have 20 features, so scikit-learn finds the neighbours by brute force. A
#   case of 600 training rows and 4 test rows splits the training rows among
#   the threads (parallel_on_Y), so its ties depend on the thread count.
#   scikit-learn takes OMP_NUM_THREADS when it is set; else the smaller of
#   OpenMP's count and the physical cores, under a cgroup CPU quota
#   (_openmp_effective_n_threads). This script ran with 14 threads. The 600
#   rows are 3 chunks of 256, so 3 threads take one chunk each, and the case
#   holds for 3 threads or more. Each case records the smallest gap between
#   the last neighbour's distance and the next distance of a test row.
# Never edit expected.json by hand: run this script again.
import hashlib
import importlib.metadata
import json
import platform
import random
import sys
import warnings
from pathlib import Path

VERSIONS = {"mteb": "2.26.28", "numpy": "2.5.4", "scikit-learn": "1.9.1", "scipy": "1.18.1"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import numpy as np
from datasets import Dataset, DatasetDict
from sklearn.metrics import accuracy_score, f1_score, label_ranking_average_precision_score
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import MultiLabelBinarizer

from mteb._evaluators.classification_metrics import hamming_score
from mteb.abstasks._stratification import _iterative_train_test_split
from mteb.abstasks.abstask import _multilabel_subsampling

HERE = Path(__file__).resolve().parent
rng = random.Random(3243)


def label_sets(n, n_labels, max_size, empty_share=0.0):
    sets = []
    for _ in range(n):
        if rng.random() < empty_share:
            sets.append([])
            continue
        size = rng.randint(1, max_size)
        sets.append(sorted(rng.sample(range(n_labels), size)))
    return sets


def indicator(n, n_labels, share):
    return [[1 if rng.random() < share else 0 for _ in range(n_labels)] for _ in range(n)]


def noisy(matrix, share):
    return [[1 - value if rng.random() < share else value for value in row] for row in matrix]


def set_case(name, values):
    # MTEB's indices are numpy int64 values, whose hash is the hash of the int.
    return {"case": name, "values": values, "order": [int(v) for v in set(np.int64(v) for v in values)]}


set_order = [
    set_case("8 values below the table size", [5, 3, 7, 0, 1]),
    set_case("values above the first table", [100, 3, 64, 8, 16, 9, 72]),
    set_case("duplicates", [4, 4, 12, 4, 20, 12, 28]),
    set_case("300 values of range(2000)", [rng.randrange(2000) for _ in range(300)]),
    set_case("1500 values of range(9000), as 10 experiments of 150 rows", [rng.randrange(9000) for _ in range(1500)]),
    set_case("values that collide in a small table", [8 * k for k in range(40)] + [8 * k + 1 for k in range(40)]),
    set_case("large values that perturb the probes", [rng.randrange(10**9) for _ in range(200)]),
]
LARGE_COUNT = 629145
assert LARGE_COUNT * 5 == ((1 << 20) - 1) * 3
large_order = list(set(i * 3 for i in range(LARGE_COUNT)))
set_order_large = {"count": LARGE_COUNT, "step": 3,
                   "sha256": hashlib.sha256(json.dumps(large_order, separators=(",", ":")).encode()).hexdigest()}


def binarizer_case(name, fit, other):
    binarizer = MultiLabelBinarizer()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fitted = binarizer.fit_transform(fit).tolist()
        transformed = binarizer.transform(other).tolist()
    return {"case": name, "fit": fit, "other": other, "classes": binarizer.classes_.tolist(),
            "fit_transform": fitted, "transform": transformed}


binarizer = [
    binarizer_case("ints with an empty set and a repeat", [[3, 1], [], [7], [1, 1, 9]], [[9, 2], [5], [], [3, 7]]),
    binarizer_case("strings", [["b", "a"], ["c"], ["a"]], [["c", "z"], ["a", "b", "c"]]),
    binarizer_case("80 sets of 9 labels", label_sets(80, 9, 4, 0.05), label_sets(30, 11, 3)),
]


def metrics_case(name, y_true, y_pred):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return {"case": name, "y_true": y_true, "y_pred": y_pred,
                "accuracy": accuracy_score(np.array(y_true), np.array(y_pred)),
                "f1": f1_score(np.array(y_true), np.array(y_pred), average="macro"),
                "lrap": label_ranking_average_precision_score(np.array(y_true), np.array(y_pred)),
                "hamming": hamming_score(np.array(y_true), np.array(y_pred))}


truth = indicator(200, 9, 0.2)
metrics = [
    metrics_case("all right", [[1, 0, 1], [0, 1, 0]], [[1, 0, 1], [0, 1, 0]]),
    metrics_case("rows without labels and with all labels", [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 1]], [[0, 0, 0], [1, 0, 1], [0, 0, 0], [0, 1, 0]]),
    metrics_case("a label that nothing predicts and nothing has", [[1, 0, 0], [1, 0, 1]], [[1, 0, 0], [0, 0, 1]]),
    metrics_case("200 rows of 9 labels", truth, noisy(truth, 0.25)),
    metrics_case("200 rows predicted all 0", truth, [[0] * 9 for _ in truth]),
]


def lrap_case(name, y_true, y_score):
    return {"case": name, "y_true": y_true, "y_score": y_score,
            "lrap": label_ranking_average_precision_score(np.array(y_true), np.array(y_score))}


lrap_truth = indicator(60, 7, 0.3)
lrap = [
    lrap_case("scores with ties", [[1, 0, 0, 1], [0, 1, 1, 0], [1, 1, 0, 0]], [[0.5, 0.5, 0.1, 0.5], [0.2, 0.9, 0.2, 0.9], [0.3, 0.3, 0.3, 0.3]]),
    lrap_case("one column", [[1], [0], [1]], [[0.2], [0.4], [0.9]]),
    lrap_case("60 rows of rounded scores", lrap_truth, [[round(rng.random(), 1) for _ in range(7)] for _ in lrap_truth]),
]


def stratification_case(name, sets, n_samples, seed):
    labels = MultiLabelBinarizer().fit_transform(sets)
    x = np.arange(len(sets)).reshape((-1, 1))
    train, test = _iterative_train_test_split(x, labels, test_size=n_samples / len(sets), random_state=seed)
    dataset = Dataset.from_dict({"text": [f"row {i}" for i in range(len(sets))], "label": sets})
    kept = _multilabel_subsampling(DatasetDict({"test": dataset}), seed=seed, splits=["test"], label="label", n_samples=n_samples)["test"]
    return {"case": name, "label_sets": sets, "n_samples": n_samples, "seed": seed,
            "train": train.tolist(), "test": test.tolist(), "subsampled_texts": list(kept["text"])}


stratification = [
    stratification_case("12 rows of 3 labels", [[0], [1], [0, 1], [2], [0, 2], [1], [0], [2], [1, 2], [0], [], [1]], 5, 42),
    stratification_case("rows without labels go last", [[0], [], [1], [], [0, 1], [], [1], [0]], 4, 7),
    # A later combination of more labels replaces the chosen one only with
    # fewer samples: here the pair (1, 2) has more samples, then as many.
    stratification_case("a pair with more samples than the first label", [[0], [1, 2], [1, 2], [1, 2], [0], [3]], 3, 42),
    stratification_case("a pair with as many samples as the first label", [[0], [0], [1, 2], [1, 2], [3], [2]], 3, 7),
    stratification_case("300 rows of 8 labels", label_sets(300, 8, 3, 0.1), 100, 42),
    stratification_case("1000 rows of 15 labels, a third kept", label_sets(1000, 15, 4, 0.02), 333, 2026),
]


def knn_case(name, n_neighbors, x_train, y_train, x_test, y_test):
    x_train = np.array(x_train, dtype=np.float32)
    x_test = np.array(x_test, dtype=np.float32)
    model = KNeighborsClassifier(n_neighbors=n_neighbors).fit(x_train, np.array(y_train))
    assert model._fit_method == "brute", model._fit_method
    distances, indices = model.kneighbors(x_test)
    y_pred = model.predict(x_test)
    full = np.sort(np.sqrt(np.maximum(((x_test.astype(np.float64)[:, None, :] - x_train.astype(np.float64)[None, :, :]) ** 2).sum(-1), 0)), axis=1)
    gap = float((full[:, n_neighbors] - full[:, n_neighbors - 1]).min())
    return {"case": name, "n_neighbors": n_neighbors, "x_train": x_train.tolist(), "y_train": y_train, "x_test": x_test.tolist(),
            "distances": distances.tolist(), "indices": indices.tolist(), "predict": y_pred.tolist(),
            "y_test": y_test, "score": model.score(x_test, np.array(y_test)),
            "min_gap": gap}


def blobs(n, dims, n_labels):
    centers = [[rng.uniform(-1, 1) for _ in range(dims)] for _ in range(n_labels)]
    rows, labels = [], []
    for _ in range(n):
        label_set = sorted(rng.sample(range(n_labels), rng.randint(1, 2)))
        row = [sum(centers[label][k] for label in label_set) / len(label_set) + rng.uniform(-0.4, 0.4) for k in range(dims)]
        rows.append(row)
        labels.append([1 if label in label_set else 0 for label in range(n_labels)])
    return rows, labels


train_rows, train_labels = blobs(60, 20, 4)
test_rows, test_labels = blobs(25, 20, 4)
duplicate_rows = [train_rows[3], train_rows[3], train_rows[3]] + train_rows[:9]
duplicate_labels = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] + [row[:3] for row in train_labels[:9]]
many_rows, many_labels = blobs(600, 20, 4)
for copy_from, copy_to in [(5, 270), (5, 520), (5, 599), (300, 10), (300, 590)]:
    many_rows[copy_to] = many_rows[copy_from]
# 8 copies of a row among 20 rows, so 8 rows share each distance to a query.
tie_rows = [train_rows[40] if position in (2, 5, 7, 11, 13, 15, 17, 19) else row for position, row in enumerate(train_rows[:20])]
tie_labels = [row[:3] for row in train_labels[:20]]
knn = [
    knn_case("60 training rows of 4 labels, 25 test rows", 5, train_rows, train_labels, test_rows, test_labels),
    knn_case("exact ties: three copies of a row with other labels", 5, duplicate_rows, duplicate_labels, [train_rows[3], test_rows[0]], [[1, 0, 0], test_labels[0][:3]]),
    knn_case("600 training rows in 3 chunks of 256 with copies across chunks, 4 test rows", 5,
             many_rows, many_labels, [many_rows[5], many_rows[300], test_rows[1], test_rows[2]], test_labels[:4]),
    knn_case("8 copies of one row at the 5th distance: the heap keeps the first ones it saw, 25 test rows", 5,
             tie_rows, tie_labels, [tie_rows[2]] + test_rows[:24], [[1, 0, 1]] + [row[:3] for row in test_labels[:24]]),
    knn_case("a label that no training row has", 5, train_rows[:12], [row[:3] + [0] for row in train_labels[:12]], test_rows[:6], test_labels[:6]),
    knn_case("4 neighbours: 2 votes against 2 give the first class, 25 test rows", 4, train_rows, train_labels, test_rows, test_labels),
]
# np.argmax in predict gives the first of two equal counts. The case of 4
# neighbours needs a label of a test row with 2 votes for each class.
even = knn[-1]
assert any(sum(even["y_train"][i][k] for i in row) == 2 for row in even["indices"] for k in range(len(even["y_train"][0])))

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, scikit-learn {VERSIONS['scikit-learn']}, "
    f"scipy {VERSIONS['scipy']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps({"generator": generator, "set_order": set_order, "set_order_large": set_order_large, "binarizer": binarizer, "metrics": metrics,
                "lrap": lrap, "stratification": stratification, "knn": knn}) + "\n",
    encoding="utf-8",
)
print(generator, file=sys.stderr)
print("knn min gaps", [case["min_gap"] for case in knn], file=sys.stderr)
