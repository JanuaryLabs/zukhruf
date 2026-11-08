# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4"]
# ///
# Makes the fixture of paired-bootstrap.golden.test.ts with NumPy:
# uv run packages/evals/src/scoring/fixtures/paired-bootstrap/generate.py
#
# expected.json holds cases of two runs on the same tests. Each case has the
# adds of the baseline run and of the change run, in the order of the adds:
# [test id, {name: [part, whole]}, weight]. The baseline adds epoch by epoch,
# and the change adds in a shuffled order, so the join must follow the
# baseline. A scorecard without the name holds only "other". Each case also
# has the paired bootstrap of the README of @zukhruf/evals ("Compare two
# runs"), as this script computes it:
# - the mean of the epochs of each test: Ratio(sum parts / k, sum wholes / k);
# - the statistic: the ratio of sums of the change minus that of the baseline,
#   each ratio times its weight. The sums are the built-in sum() of CPython,
#   which Totals gives (RatioOfSums);
# - the resamples: numpy.random.default_rng(seed).integers(0, n, n) for each
#   resample, in the order of the baseline's first adds;
# - the interval: numpy.quantile(..., [0.025, 0.975], method="linear");
# - p: min(1, 2 * min(share <= 0, share >= 0)), as mteb's pairedBootstrapTest;
# - the counts by the sign of (change value - baseline value), with the
#   direction.
# Never edit expected.json by hand: run this script again.
import json
import platform
import sys
from pathlib import Path

import numpy as np

assert platform.python_version() == "3.12.9", platform.python_version()
assert np.__version__ == "2.5.4", np.__version__

HERE = Path(__file__).resolve().parent
N_RESAMPLES = 2000
data = np.random.default_rng(3870)


def value(part, whole):
    return 0.0 if whole == 0 else part / whole


def reduce(epochs, name):
    ratios = [scorecard.get(name, [0.0, 0.0]) for scorecard in epochs]
    k = len(ratios)
    return sum(part for part, _ in ratios) / k, sum(whole for _, whole in ratios) / k


def ratio_of_sums(ratios):
    return value(sum(part for part, _ in ratios), sum(whole for _, whole in ratios))


def statistic(pairs):
    change = ratio_of_sums([(part * weight, whole * weight) for _, (part, whole), weight in pairs])
    baseline = ratio_of_sums([(part * weight, whole * weight) for (part, whole), _, weight in pairs])
    return change - baseline


def verdict(case, baseline_adds, change_adds, name, higher_is_better, seed):
    order = list(dict.fromkeys(test_id for test_id, _, _ in baseline_adds))
    weights = {test_id: weight for test_id, _, weight in baseline_adds}

    def epochs(adds):
        grouped = {}
        for test_id, scorecard, _ in adds:
            grouped.setdefault(test_id, []).append(scorecard)
        return grouped

    baseline, change = epochs(baseline_adds), epochs(change_adds)
    pairs = [(reduce(baseline[test_id], name), reduce(change[test_id], name), weights[test_id])
             for test_id in order]
    n = len(pairs)
    rng = np.random.default_rng(seed)
    distribution = []
    for _ in range(N_RESAMPLES):
        indices = rng.integers(0, n, n)
        distribution.append(statistic([pairs[int(index)] for index in indices]))
    low, high = np.quantile(np.array(distribution), [0.025, 0.975], method="linear")
    low, high = float(low), float(high)
    share_at_or_below = sum(1 for item in distribution if item <= 0) / N_RESAMPLES
    share_at_or_above = sum(1 for item in distribution if item >= 0) / N_RESAMPLES
    p = min(1.0, 2 * min(share_at_or_below, share_at_or_above))
    above, below = low > 0, high < 0
    better, worse = (above, below) if higher_is_better else (below, above)
    signs = [(value(*c) - value(*b)) * (1 if higher_is_better else -1) for b, c, _ in pairs]
    return {
        "case": case,
        "name": name,
        "higherIsBetter": higher_is_better,
        "seed": seed,
        "nResamples": N_RESAMPLES,
        "baseline": baseline_adds,
        "change": change_adds,
        "verdict": {
            "name": name,
            "result": "better" if better else "worse" if worse else "inconclusive",
            "difference": {"observed": statistic(pairs), "low": low, "high": high},
            "p": p,
            "improvements": sum(1 for sign in signs if sign > 0),
            "regressions": sum(1 for sign in signs if sign < 0),
            "ties": sum(1 for sign in signs if sign == 0),
            "tests": n,
        },
    }


def adds(tests, epochs, scorecard, weight):
    # Epoch by epoch, as a harness that runs its tests k times adds them.
    return [[test_id, scorecard(test_id, epoch), weight(test_id)]
            for epoch in range(epochs) for test_id in tests]


def shuffled(items):
    return [items[int(index)] for index in data.permutation(len(items))]


cases = []

# Page kinds: 121 pages, 3 epochs, each epoch right (1) or wrong (0).
pages = [f"page-{index}" for index in range(121)]
right = {"baseline": 0.92, "change": 0.97}
kinds = {run: {(page, epoch): float(data.random() < chance) for page in pages for epoch in range(3)}
         for run, chance in right.items()}
cases.append(verdict(
    "page kinds: 121 pages, 3 epochs of 0/1, weight 1",
    adds(pages, 3, lambda page, epoch: {"kind": [kinds["baseline"][page, epoch], 1.0]}, lambda _: 1.0),
    shuffled(adds(pages, 3, lambda page, epoch: {"kind": [kinds["change"][page, epoch], 1.0]}, lambda _: 1.0)),
    "kind", True, 31957,
))

# Recall: wholes from 0 to 6, weights other than 1, some scorecards without
# the name.
records = [f"record-{index}" for index in range(80)]
expected = {record: float(data.integers(0, 7)) for record in records}
weight = {record: float(data.choice([0.5, 1.0, 2.0, 3.0])) for record in records}


def recall(chance):
    def scorecard(record, _):
        if data.random() < 0.1:
            return {"other": [1.0, 1.0]}
        whole = expected[record]
        return {"recall": [float(data.binomial(int(whole), chance)), whole]}
    return scorecard


cases.append(verdict(
    "recall: wholes from 0 to 6, weights 0.5 to 3, scorecards without the name",
    adds(records, 1, recall(0.8), weight.get),
    shuffled(adds(records, 1, recall(0.6), weight.get)),
    "recall", True, 3870,
))

# Brier: lower is better, 3 epochs, float weights.
items = [f"item-{index}" for index in range(60)]
float_weight = {item: float(data.random() * 2 + 0.1) for item in items}


def brier(scale):
    return lambda _, __: {"brier": [float(data.random() ** 2 * scale), 1.0]}


cases.append(verdict(
    "brier: lower is better, 3 epochs, float weights",
    adds(items, 3, brier(0.5), float_weight.get),
    shuffled(adds(items, 3, brier(0.3), float_weight.get)),
    "brier", False, 2024,
))

# A change that is the baseline with 2 pages right and 3 pages wrong that the
# baseline had the other way: inconclusive.
close = {page: float(data.random() < 0.9) for page in pages}
order = shuffled(pages)
flipped = {*[page for page in order if close[page] == 0.0][:2], *[page for page in order if close[page] == 1.0][:3]}
cases.append(verdict(
    "page kinds: 5 pages of 121 change, 1 epoch",
    adds(pages, 1, lambda page, _: {"kind": [close[page], 1.0]}, lambda _: 1.0),
    shuffled(adds(pages, 1, lambda page, _: {"kind": [1.0 - close[page] if page in flipped else close[page], 1.0]},
                  lambda _: 1.0)),
    "kind", True, 7,
))

# Brier again, with a change that is worse: lower is better, so the interval
# above 0 is worse.
cases.append(verdict(
    "brier: lower is better and the change is worse, 1 epoch",
    adds(items, 1, brier(0.1), float_weight.get),
    shuffled(adds(items, 1, brier(0.6), float_weight.get)),
    "brier", False, 99,
))

# A change with the answers of the baseline: each difference is 0, so the
# interval is [0, 0], which is neither above nor below 0.
same = {page: float(data.random() < 0.9) for page in pages}
cases.append(verdict(
    "page kinds: the change has the answers of the baseline",
    adds(pages, 1, lambda page, _: {"kind": [same[page], 1.0]}, lambda _: 1.0),
    shuffled(adds(pages, 1, lambda page, _: {"kind": [same[page], 1.0]}, lambda _: 1.0)),
    "kind", True, 5,
))

generator = f"generate.py: numpy {np.__version__}, CPython {platform.python_version()}"
(HERE / "expected.json").write_text(
    json.dumps({"generator": generator, "cases": cases}) + "\n", encoding="utf-8",
)
for case in cases:
    print(case["case"], {key: value for key, value in case["verdict"].items()}, file=sys.stderr)
