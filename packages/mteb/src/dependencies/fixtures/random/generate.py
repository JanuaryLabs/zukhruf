# /// script
# requires-python = "==3.12.9"
# dependencies = []
# ///
# Makes the fixture of random.golden.test.ts with CPython's random:
# uv run packages/mteb/src/dependencies/fixtures/random/generate.py
#
# expected.json holds, for each case, the calls of random.Random(seed):
# sample(range(n), k) and choices(range(n), k=k), and what they returned, in
# the order of the calls. The fixture of @zukhruf/random holds the cases of
# NumPy.
# Never edit expected.json by hand: run this script again.
import json
import platform
import sys
from pathlib import Path

assert platform.python_version() == "3.12.9", platform.python_version()

import random

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
    return {"case": case, "seed": seed, "calls": calls, "results": results}


# k * 3 = 63 gives a table of 4 ** 3 for the set of sample, 66 one of 4 ** 4:
# with n = 200, k = 21 selects by a set and k = 22 from a pool.
python_cases = [
    python_case("seed 42: a set, a pool, choices", 42, [["sample", 1000, 40], ["sample", 10, 10], ["choices", 40, 50], ["sample", 1000, 3]]),
    python_case("k = 21 of 200 selects by a set", 7, [["sample", 200, 21]]),
    python_case("k = 22 of 200 selects from a pool", 7, [["sample", 200, 22]]),
    python_case("k = 5 of 27 selects by a set, k = 5 of 21 from a pool", 11, [["sample", 27, 5], ["sample", 21, 5]]),
    python_case("many rejections of selected indices", 3, [["sample", 5000, 1200]]),
    python_case("empty and whole samples", 0, [["sample", 5, 0], ["sample", 1, 1], ["sample", 6, 6]]),
    python_case("a negative seed uses its absolute value", -42, [["sample", 1000, 40]]),
    python_case("a seed above 2^32 has two key words", 2**40 + 5, [["sample", 300, 120], ["choices", 7, 30]]),
    python_case("choices of one element and of many", 2026, [["choices", 1, 5], ["choices", 1675, 200], ["sample", 1000, 3]]),
    # sample(range(1000), k=700) draws 933 words of 32 bits: more than the 624
    # words of the state.
    python_case("more than 624 words: the state twists again", 9, [["sample", 1000, 700], ["sample", 100000, 30]]),
]

generator = f"generate.py: CPython {platform.python_version()}"
(HERE / "expected.json").write_text(
    json.dumps({"generator": generator, "python": python_cases}) + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(python_cases)} CPython cases", file=sys.stderr)
