# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4"]
# ///
# Makes the fixture of random.golden.test.ts with CPython's random and
# numpy's legacy RandomState:
# uv run packages/mteb/src/dependencies/fixtures/random/generate.py
#
# expected.json holds, for each case, the calls and what they returned:
# - random.Random(seed): sample(range(n), k), choices(range(n), k=k),
#   random() and getrandbits(k), in the order of the calls;
# - numpy.random.RandomState(seed): randint, random_sample, uniform(size),
#   choice(n, size, p=p) with the float32 weights of scikit-learn, choice(n,
#   size, replace=False), choice(a, size) of the array a = 3 * arange(n) + 1,
#   permutation and shuffle of a list range(n), in the order of the calls;
# - numpy.random.default_rng(seed): shuffle of a list range(n) and
#   integers(low, high, size), in the order of the calls.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

assert importlib.metadata.version("numpy") == "2.5.4", importlib.metadata.version("numpy")
assert platform.python_version() == "3.12.9", platform.python_version()

import random

import numpy as np

HERE = Path(__file__).resolve().parent


def python_case(case, seed, calls):
    generator = random.Random(seed)
    results = []
    for call in calls:
        name = call[0]
        if name == "sample":
            results.append(generator.sample(range(call[1]), k=call[2]))
        elif name == "choices":
            results.append(generator.choices(range(call[1]), k=call[2]))
        elif name == "random":
            results.append([generator.random() for _ in range(call[1])])
        elif name == "getrandbits":
            results.append([generator.getrandbits(call[1]) for _ in range(call[2])])
    return {"case": case, "seed": seed, "calls": calls, "results": results}


def float32_weights(n):
    weights = np.ones(n, dtype=np.float32)
    return weights / weights.sum()


def numpy_case(case, seed, calls):
    generator = np.random.RandomState(seed)
    results = []
    for call in calls:
        name = call[0]
        if name == "randint":
            results.append(generator.randint(call[1], call[2], call[3]).tolist())
        elif name == "random_sample":
            results.append(generator.random_sample(call[1]).tolist())
        elif name == "uniform":
            results.append(generator.uniform(size=call[1]).tolist())
        elif name == "choice_p":
            results.append(generator.choice(call[1], call[2], p=float32_weights(call[1]), replace=True).tolist())
        elif name == "choice_no_replace":
            results.append(generator.choice(call[1], replace=False, size=call[2]).tolist())
        elif name == "choice":
            results.append(generator.choice(3 * np.arange(call[1]) + 1, call[2]).tolist())
        elif name == "permutation":
            results.append(generator.permutation(call[1]).tolist())
        elif name == "shuffle":
            values = list(range(call[1]))
            generator.shuffle(values)
            results.append(values)
    return {"case": case, "seed": seed, "calls": calls, "results": results}


def generator_case(case, seed, calls):
    generator = np.random.default_rng(seed)
    results = []
    for call in calls:
        name = call[0]
        if name == "shuffle":
            # MTEB shuffles a list of numpy integers: list(np.arange(n)).
            values = list(np.arange(call[1]))
            generator.shuffle(values)
            results.append([int(value) for value in values])
        elif name == "integers":
            results.append(generator.integers(call[1], call[2], call[3]).tolist())
    return {"case": case, "seed": seed, "calls": calls, "results": results}


# k * 3 = 63 gives a table of 4 ** 3 for the set of sample, 66 one of 4 ** 4:
# with n = 200, k = 21 selects by a set and k = 22 from a pool.
python_cases = [
    python_case("seed 42: a set, a pool, choices", 42, [["sample", 1000, 40], ["sample", 10, 10], ["choices", 40, 50], ["random", 3]]),
    python_case("k = 21 of 200 selects by a set", 7, [["sample", 200, 21]]),
    python_case("k = 22 of 200 selects from a pool", 7, [["sample", 200, 22]]),
    python_case("k = 5 of 27 selects by a set, k = 5 of 21 from a pool", 11, [["sample", 27, 5], ["sample", 21, 5]]),
    python_case("many rejections of selected indices", 3, [["sample", 5000, 1200]]),
    python_case("empty and whole samples", 0, [["sample", 5, 0], ["sample", 1, 1], ["sample", 6, 6]]),
    python_case("a negative seed uses its absolute value", -42, [["sample", 1000, 40]]),
    python_case("a seed above 2^32 has two key words", 2**40 + 5, [["sample", 300, 120], ["choices", 7, 30]]),
    python_case("seed 0", 0, [["random", 5], ["getrandbits", 1, 8], ["getrandbits", 5, 4], ["getrandbits", 32, 3]]),
    python_case("choices of one element and of many", 2026, [["choices", 1, 5], ["choices", 1675, 200], ["random", 2]]),
    python_case("more than 624 words: the state twists again", 9, [["random", 700], ["sample", 100000, 30]]),
]

numpy_cases = [
    numpy_case("seed 42: the draws of MiniBatchKMeans", 42, [
        ["randint", 0, 16384, 20], ["randint", 0, 16384, 5], ["random_sample", 1], ["uniform", 4],
        ["choice_p", 16384, 30], ["choice_no_replace", 512, 7],
    ]),
    numpy_case("seed 0: ranges of one, two and powers of two", 0, [
        ["randint", 0, 1, 3], ["randint", 0, 2, 10], ["randint", 0, 1024, 5], ["randint", 0, 1025, 5],
        ["randint", 5, 6, 2], ["randint", -3, 4, 6],
    ]),
    numpy_case("seed 2^32 - 1: the largest ranges", 2**32 - 1, [
        ["randint", 0, 2**31 + 5, 4], ["randint", 0, 2**32, 4], ["random_sample", 3],
    ]),
    numpy_case("permutations and choices without replacement", 7, [
        ["permutation", 1], ["permutation", 2], ["permutation", 10], ["choice_no_replace", 100, 100], ["choice_no_replace", 3, 0],
    ]),
    numpy_case("choice with p of 1536 and of 1", 2026, [["choice_p", 1536, 40], ["choice_p", 1, 3], ["uniform", 3]]),
    numpy_case("shuffles of lists, as MTEB's classification tasks undersample", 42, [
        ["shuffle", 0], ["shuffle", 1], ["shuffle", 2], ["shuffle", 30], ["shuffle", 1000], ["permutation", 5],
    ]),
    numpy_case("choices of one item from arrays, as the iterative stratification breaks ties", 42, [
        ["choice", 2, 1], ["choice", 2, 1], ["choice", 1, 1], ["choice", 3, 4], ["choice", 2, 30], ["choice", 5, 0],
    ]),
    numpy_case("more than 624 words: the state twists again", 1, [["random_sample", 400], ["randint", 0, 1000, 10]]),
]

generator_cases = [
    generator_case("seed 42: the shuffles of MTEB's multilabel undersampling", 42, [
        ["shuffle", 0], ["shuffle", 1], ["shuffle", 2], ["shuffle", 30], ["shuffle", 30], ["shuffle", 1000],
    ]),
    generator_case("shuffles and integers share the buffered half of a 64-bit draw", 7, [
        ["shuffle", 3], ["integers", 0, 10, 1], ["shuffle", 4], ["integers", 0, 1000, 3], ["shuffle", 70000],
    ]),
]

generator = f"generate.py: numpy {np.__version__}, CPython {platform.python_version()}"
(HERE / "expected.json").write_text(
    json.dumps({"generator": generator, "python": python_cases, "numpy": numpy_cases, "generator_cases": generator_cases}) + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(python_cases)} CPython cases, {len(numpy_cases)} numpy cases, {len(generator_cases)} Generator cases", file=sys.stderr)
