# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4", "scikit-learn==1.9.1"]
# ///
# Makes the fixture of the golden tests of ./classification with
# scikit-learn:
# uv run packages/evals/src/classification/fixtures/sklearn/generate.py
#
# expected.json holds:
# - multiclass: the true labels, the predicted labels and the sample weights
#   (or null) of each case, and what scikit-learn gave for them: the sorted
#   labels, accuracy_score, precision_recall_fscore_support with average=None,
#   "micro", "macro" and "weighted", with average="binary" for a case of two
#   labels or fewer, and confusion_matrix. The first 12 cases are the cases
#   of @zukhruf/mteb's fixtures/classification-metrics, with the same
#   random.Random(3243).
# - calls: one call of a metric with its keyword arguments (labels,
#   zero_division, beta, average, pos_label, sample_weight) and its value.
# - multilabel: label indicator rows and the same metrics, without
#   confusion_matrix. The first 3 cases are cases of @zukhruf/mteb's
#   fixtures/multilabel, and its 200-row cases draw the same rows, because
#   the script draws from random.Random(3243) in the order of that script.
#   The last case adds float sample weights.
# - brier: the true labels, the probabilities (of the positive label, or a
#   row for each answer with a column for each sorted label), the sample
#   weights (or null) and the pos_label (or null) of each case, and
#   brier_score_loss of them.
# - squared_error: the true labels (0 or 1) and the probabilities of the
#   label 1 of each case, and numpy's np.mean((p - y) ** 2) of them, the
#   Brier score of relevance-filtering's research evaluate.py.
# A float NaN is the string "NaN", because JSON has no NaN.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import math
import platform
import random
import sys
import warnings
from pathlib import Path

VERSIONS = {"numpy": "2.5.4", "scikit-learn": "1.9.1"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import numpy as np
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    confusion_matrix,
    fbeta_score,
    precision_recall_fscore_support,
    precision_score,
    recall_score,
)
from sklearn.utils.multiclass import unique_labels

HERE = Path(__file__).resolve().parent
rng = random.Random(3243)


def plain(value):
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, np.ndarray):
        return [plain(item) for item in value.tolist()]
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if isinstance(value, (np.integer, int)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, (np.floating, float)):
        value = float(value)
        return "NaN" if math.isnan(value) else value
    return value


def scores(y_true, y_pred, sample_weight, binary):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        result = {"accuracy": accuracy_score(y_true, y_pred, sample_weight=sample_weight)}
        for average in (None, "micro", "macro", "weighted"):
            precision, recall, f1, support = precision_recall_fscore_support(
                y_true, y_pred, average=average, sample_weight=sample_weight
            )
            result[str(average).lower()] = {"precision": precision, "recall": recall, "f1": f1}
            if average is None:
                result["none"]["support"] = support
        if binary is not None:
            precision, recall, f1, _ = precision_recall_fscore_support(
                y_true, y_pred, average="binary", pos_label=binary, sample_weight=sample_weight
            )
            result["binary"] = {"pos_label": binary, "precision": precision, "recall": recall, "f1": f1}
    return result


def multiclass(name, y_true, y_pred, sample_weight=None, binary=None):
    labels = unique_labels(y_true, y_pred)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        matrix = confusion_matrix(y_true, y_pred, sample_weight=sample_weight)
    return plain({
        "case": name, "y_true": y_true, "y_pred": y_pred, "sample_weight": sample_weight,
        "labels": labels, **scores(y_true, y_pred, sample_weight, binary),
        "confusion_matrix": matrix,
    })


def noisy(y_true, labels, share):
    return [rng.choice(labels) if rng.random() < share else label for label in y_true]


# The cases of @zukhruf/mteb's classification-metrics/generate.py, in its order.
banking = [rng.randrange(77) for _ in range(3080)]
binary = [rng.randrange(2) for _ in range(301)]
ten = [rng.randrange(10) for _ in range(500)]
multiclass_cases = [
    multiclass("all labels right", [0, 1, 2, 2, 1], [0, 1, 2, 2, 1]),
    multiclass("all labels wrong", [0, 1, 0, 1], [1, 0, 1, 0], binary=1),
    multiclass("one class in y_true and y_pred", [3, 3, 3], [3, 3, 3], binary=3),
    multiclass("one class in y_true, two in y_pred", [1, 1, 1, 1], [1, 0, 1, 1], binary=1),
    multiclass("a class of y_true missing from the predictions", [0, 1, 2, 2, 0], [0, 1, 1, 1, 0]),
    multiclass("a predicted class missing from y_true", [0, 0, 1, 1], [0, 2, 1, 2]),
    multiclass("labels that are not 0 to n - 1", [10, -3, 7, 7, 10, -3], [10, 7, 7, -3, 10, -3]),
    multiclass("string labels", ["neg", "pos", "neu", "pos"], ["pos", "pos", "neu", "neg"]),
    multiclass("one sample", [5], [4], binary=5),
    multiclass("301 binary labels", binary, noisy(binary, [0, 1], 0.3), binary=1),
    multiclass("500 labels of 10 classes", ten, noisy(ten, list(range(10)), 0.4)),
    multiclass("3080 labels of 77 classes", banking, noisy(banking, list(range(77)), 0.5)),
]

# New cases: string labels in code point order, and sample weights.
words = ["ä", "a", "Z", "😀", "￿", "b"]
word_true = [rng.choice(words) for _ in range(60)]
weighted_true = [rng.randrange(5) for _ in range(200)]
weighted_pred = noisy(weighted_true, list(range(5)), 0.4)
multiclass_cases += [
    multiclass("strings in code point order", word_true, noisy(word_true, words, 0.5)),
    multiclass("integer sample weights", weighted_true, weighted_pred,
               sample_weight=[rng.randrange(1, 6) for _ in weighted_true]),
    multiclass("float sample weights", weighted_true, weighted_pred,
               sample_weight=[rng.random() * 3 for _ in weighted_true]),
    multiclass("float sample weights of two labels", binary, noisy(binary, [0, 1], 0.3),
               sample_weight=[rng.random() for _ in binary], binary=0),
]


def call(name, metric, y_true, y_pred, **kwargs):
    function = {"precision": precision_score, "recall": recall_score, "fbeta": fbeta_score}[metric]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        value = function(y_true, y_pred, **kwargs)
    return plain({"case": name, "metric": metric, "y_true": y_true, "y_pred": y_pred,
                  "kwargs": kwargs, "value": value})


gaps_true = [0, 0, 1, 1, 2]
gaps_pred = [0, 3, 1, 1, 1]
calls = []
for zero_division in (0.0, 1.0, np.nan):
    for metric in ("precision", "recall"):
        for average in ("macro", "weighted", "micro", None):
            calls.append(call(f"zero_division {zero_division}", metric, gaps_true, gaps_pred,
                              average=average, zero_division=zero_division))
    for average in ("macro", "weighted", None):
        calls.append(call(f"zero_division {zero_division}", "fbeta", gaps_true, gaps_pred,
                          beta=1, average=average, zero_division=zero_division))
calls.append(call("no true and no predicted label of a class", "fbeta", [0, 0], [0, 0],
                  beta=1, average="macro", labels=[0, 5], zero_division=np.nan))
calls.append(call("every weight of the classes is 0", "precision", [0, 0], [1, 1],
                  average="weighted", labels=[1], zero_division=np.nan))
for labels in ([2, 0], [0, 1, 7], [3]):
    for average in ("macro", "micro", "weighted", None):
        calls.append(call(f"labels {labels}", "fbeta", gaps_true, gaps_pred, beta=1,
                          average=average, labels=labels))
for beta in (0.5, 0.3, 2.0):
    for average in ("macro", "micro", "weighted", None):
        calls.append(call(f"beta {beta}", "fbeta", ten, multiclass_cases[10]["y_pred"],
                          beta=beta, average=average))
    calls.append(call(f"beta {beta} of two labels", "fbeta", binary, multiclass_cases[9]["y_pred"],
                      beta=beta, average="binary", pos_label=1))
    calls.append(call(f"beta {beta} with float sample weights", "fbeta", weighted_true, weighted_pred,
                      beta=beta, average="macro", sample_weight=multiclass_cases[14]["sample_weight"]))

banking_weights = [rng.random() * 4 for _ in banking]
for metric in ("precision", "recall"):
    calls.append(call("77 classes with float sample weights", metric, banking, multiclass_cases[11]["y_pred"],
                      average="micro", sample_weight=banking_weights))
    calls.append(call("30 labels, 20 of them absent, zero_division NaN", metric, ten, multiclass_cases[10]["y_pred"],
                      average="macro", labels=list(range(-10, 20)), zero_division=np.nan))



# nanmean adds 0 in place of each NaN, so its pairwise sum can differ from the
# sum of the other scores alone; draw until a case shows it.
def compact_mean_differs(y_true, y_pred, labels):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        per = precision_score(y_true, y_pred, average=None, labels=labels, zero_division=np.nan)
        macro = precision_score(y_true, y_pred, average="macro", labels=labels, zero_division=np.nan)
    kept = per[~np.isnan(per)]
    return float(np.sum(kept)) / len(kept) != macro


while True:
    nan_true = [rng.randrange(28) for _ in range(58)]
    nan_pred = [rng.randrange(28) if rng.random() < 0.6 else label for label in nan_true]
    if compact_mean_differs(nan_true, nan_pred, list(range(-5, 33))):
        break
calls.append(call("38 labels, 10 of them absent, zero_division NaN, where the mean of the other scores alone differs",
                  "precision", nan_true, nan_pred, average="macro", labels=list(range(-5, 33)), zero_division=np.nan))


def multilabel(name, y_true, y_pred, sample_weight=None):
    true, pred = np.array(y_true), np.array(y_pred)
    return plain({"case": name, "y_true": y_true, "y_pred": y_pred, "sample_weight": sample_weight,
                  **scores(true, pred, sample_weight, None)})


# @zukhruf/mteb's fixtures/multilabel/generate.py draws from its own
# random.Random(3243) before its metrics cases; this replays those draws.
mteb = random.Random(3243)
for count, bound in ((300, 2000), (1500, 9000), (200, 10**9)):
    for _ in range(count):
        mteb.randrange(bound)


def label_sets(n, n_labels, max_size, empty_share=0.0):
    for _ in range(n):
        if mteb.random() < empty_share:
            continue
        mteb.sample(range(n_labels), mteb.randint(1, max_size))


label_sets(80, 9, 4, 0.05)
label_sets(30, 11, 3)
truth = [[1 if mteb.random() < 0.2 else 0 for _ in range(9)] for _ in range(200)]
multilabel_cases = [
    multilabel("all right", [[1, 0, 1], [0, 1, 0]], [[1, 0, 1], [0, 1, 0]]),
    multilabel("rows without labels and with all labels", [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 1]],
               [[0, 0, 0], [1, 0, 1], [0, 0, 0], [0, 1, 0]]),
    multilabel("a label that nothing predicts and nothing has", [[1, 0, 0], [1, 0, 1]], [[1, 0, 0], [0, 0, 1]]),
    multilabel("200 rows of 9 labels", truth,
               [[1 - value if mteb.random() < 0.25 else value for value in row] for row in truth]),
    multilabel("200 rows predicted all 0", truth, [[0] * 9 for _ in truth]),
]
# New cases, from the generator of this script.
multilabel_cases.append(multilabel(
    "200 rows of 9 labels with float sample weights", truth, multilabel_cases[3]["y_pred"],
    sample_weight=[rng.random() * 2 for _ in truth]))



def brier(name, y_true, y_proba, sample_weight=None, pos_label=None):
    value = brier_score_loss(y_true, y_proba, sample_weight=sample_weight, pos_label=pos_label)
    return plain({"case": name, "y_true": y_true, "y_proba": y_proba, "sample_weight": sample_weight,
                  "pos_label": pos_label, "value": value})


def distribution(k):
    row = [rng.random() for _ in range(k)]
    total = sum(row)
    return [value / total for value in row]


relevant = [rng.randrange(2) for _ in range(300)]
three = [rng.choice(["a", "b", "c"]) for _ in range(150)]
twelve = [rng.randrange(12) for _ in range(250)]
two_columns = [distribution(2) for _ in relevant]
brier_cases = [
    brier("one answer", [1], [0.3], pos_label=1),
    brier("one answer of the negative label, where 1 - (1 - p) is not p", [0], [0.1], pos_label=1),
    brier("300 answers of two labels, the probability of the positive label", relevant,
          [rng.random() for _ in relevant], pos_label=1),
    brier("the positive label 0", relevant, [rng.random() for _ in relevant], pos_label=0),
    brier("300 answers of two labels, a column for each label", relevant, two_columns),
    brier("150 answers of three string labels", three, [distribution(3) for _ in three]),
    brier("250 answers of 12 labels", twelve, [distribution(12) for _ in twelve]),
    brier("250 answers of 12 labels with float sample weights", twelve, [distribution(12) for _ in twelve],
          sample_weight=[rng.random() * 3 for _ in twelve]),
]

def squared_error(name, y_true, p):
    value = np.mean((np.array(p, np.float64) - np.array(y_true)) ** 2)
    return plain({"case": name, "y_true": y_true, "p": p, "value": value})


many = [rng.randrange(2) for _ in range(1000)]
squared_error_cases = [
    squared_error("one answer of the negative label, where 1 - (1 - p) is not p", [0], [0.1]),
    squared_error("300 answers", relevant, [rng.random() for _ in relevant]),
    squared_error("1000 answers, more than one block of numpy's pairwise sum", many,
                  [rng.random() ** 4 for _ in many]),
]

generator = f"generate.py: numpy {VERSIONS['numpy']}, scikit-learn {VERSIONS['scikit-learn']}, CPython {platform.python_version()}"
(HERE / "expected.json").write_text(
    json.dumps({"generator": generator, "multiclass": multiclass_cases, "calls": calls,
                "multilabel": multilabel_cases, "brier": brier_cases,
                "squared_error": squared_error_cases}, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(multiclass_cases)} multiclass cases, {len(calls)} calls, "
      f"{len(multilabel_cases)} multilabel cases, {len(brier_cases)} brier cases, "
      f"{len(squared_error_cases)} squared error cases", file=sys.stderr)
