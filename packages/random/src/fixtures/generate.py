# Makes the fixture of random.golden.test.ts with numpy.random of NumPy 2.5.4:
# uv run --no-project --with numpy==2.5.4 python -I packages/random/src/fixtures/generate.py
#
# expected.json holds, for each case, the calls and what they returned, in
# the order of the calls:
# - SeedSequence(seed).generate_state(n_words, dtype=np.uint32);
# - PCG64(seed).random_raw(n), each 64-bit output as its low and its high
#   32 bits, the order in which a 32-bit draw takes them;
# - MT19937 seeded by _legacy_seeding(seed): random_raw(n);
# - RandomState(seed): randint, random_sample, uniform(size), choice(n, size,
#   p=p) with the float32 weights of scikit-learn, choice(n, size,
#   replace=False), choice(a, size) of the array a = 3 * arange(n) + 1, the
#   same array with p and with replace=False, permutation and shuffle of a
#   list range(n);
# - default_rng(seed), and Generator(MT19937) of a legacy seed: shuffle of a
#   list, integers(low, high, size), permutation(n), permutation of the list
#   3 * range(n) + 1, and choice(arange(n), size, replace=False);
# - refusals: the calls for which NumPy raises, with the class and the
#   message of the error; a NaN weight is the string "NaN".
# A seed of 2^53 or more is a decimal string, which JSON.parse keeps exact.
# Never edit expected.json by hand: run this script again.
import json
import sys
from pathlib import Path

import numpy as np

assert np.__version__ == "2.5.4", np.__version__

HERE = Path(__file__).resolve().parent


def seed_json(seed):
    return seed if abs(seed) < 2**53 else str(seed)


def seed_sequence_case(case, seed, n_words):
    state = np.random.SeedSequence(seed).generate_state(n_words, dtype=np.uint32)
    return {"case": case, "seed": seed_json(seed), "n_words": n_words, "words": state.tolist()}


def pcg64_case(case, seed, n):
    words = []
    for output in np.random.PCG64(seed).random_raw(n).tolist():
        words += [output & 0xFFFFFFFF, output >> 32]
    return {"case": case, "seed": seed_json(seed), "words": words}


def legacy_mt19937(seed):
    bit_generator = np.random.MT19937()
    bit_generator._legacy_seeding(seed)
    return bit_generator


def mt19937_case(case, seed, n):
    return {"case": case, "seed": seed, "words": legacy_mt19937(seed).random_raw(n).tolist()}


def float32_weights(n):
    weights = np.ones(n, dtype=np.float32)
    return weights / weights.sum()


def array(n):
    return 3 * np.arange(n) + 1


def random_state_case(case, seed, calls):
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
            results.append(generator.choice(array(call[1]), call[2]).tolist())
        elif name == "choice_array_p":
            results.append(generator.choice(array(call[1]), call[2], p=float32_weights(call[1])).tolist())
        elif name == "choice_array_no_replace":
            results.append(generator.choice(array(call[1]), call[2], replace=False).tolist())
        elif name == "choice_weights32":
            weights = np.array(call[3:], dtype=np.float32)
            results.append(generator.choice(call[1], call[2], p=weights).tolist())
        elif name == "permutation":
            results.append(generator.permutation(call[1]).tolist())
        elif name == "shuffle":
            values = list(range(call[1]))
            generator.shuffle(values)
            results.append(values)
        else:
            raise ValueError(name)
    return {"case": case, "seed": seed, "calls": calls, "results": results}


def generator_case(case, bits, seed, calls):
    generator = np.random.default_rng(seed) if bits == "pcg64" else np.random.Generator(legacy_mt19937(seed))
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
        elif name == "permutation":
            results.append(generator.permutation(call[1]).tolist())
        elif name == "permutation_list":
            # The stratified split of datasets permutes a list of ints.
            results.append(generator.permutation([3 * value + 1 for value in range(call[1])]).tolist())
        elif name == "choice_no_replace":
            # The stratified split of datasets chooses among the indices of an
            # ndarray.
            results.append(generator.choice(np.arange(call[1]), size=call[2], replace=False).tolist())
        else:
            raise ValueError(name)
    return {"case": case, "bits": bits, "seed": seed_json(seed), "calls": calls, "results": results}


def number(value):
    return float("nan") if value == "NaN" else value


def refusal(case, make, seed, call=None):
    try:
        if make == "default_rng":
            generator = np.random.default_rng(seed)
        elif make == "RandomState":
            generator = np.random.RandomState(seed)
        elif make == "SeedSequence":
            generator = np.random.SeedSequence(seed)
        elif make == "PCG64":
            generator = np.random.PCG64(seed)
        elif make == "MT19937":
            generator = legacy_mt19937(seed)
        else:
            raise AssertionError(make)
        if call is not None:
            name = call[0]
            if name == "integers":
                generator.integers(call[1], call[2], call[3])
            elif name == "randint":
                generator.randint(call[1], call[2], call[3])
            elif name == "choice_no_replace" and make == "default_rng":
                generator.choice(np.arange(call[1]), size=call[2], replace=False)
            elif name == "choice_no_replace":
                generator.choice(call[1], size=call[2], replace=False)
            elif name == "choice":
                generator.choice(array(call[1]), call[2])
            elif name == "choice_n":
                generator.choice(call[1], call[2])
            elif name == "choice_weights":
                generator.choice(call[1], call[2], p=[number(weight) for weight in call[3:]])
            elif name == "choice_weights32":
                generator.choice(call[1], call[2], p=np.array(call[3:], dtype=np.float32))
            else:
                raise AssertionError(name)
    except (ValueError, TypeError) as error:
        return {"case": case, "make": make, "seed": seed_json(seed), "call": call, "raises": type(error).__name__, "message": str(error)}
    raise AssertionError(f"NumPy did not raise: {case}")


seed_sequence_cases = [
    seed_sequence_case("seed 0 is one word of entropy", 0, 8),
    seed_sequence_case("seed 42, fewer words than the pool", 42, 3),
    seed_sequence_case("seed 2^40 + 5, two words of entropy, more words than the pool", 2**40 + 5, 10),
    seed_sequence_case("seed 2^70 + 3, three words of entropy", 2**70 + 3, 8),
    seed_sequence_case("seed 2^200 + 7, more words of entropy than the pool", 2**200 + 7, 8),
]

pcg64_cases = [
    pcg64_case("seed 0", 0, 4),
    pcg64_case("seed 42", 42, 4),
    pcg64_case("seed 2^70 + 3", 2**70 + 3, 4),
]

mt19937_cases = [
    mt19937_case("seed 0", 0, 5),
    mt19937_case("seed 2^32 - 1", 2**32 - 1, 5),
    mt19937_case("seed 42: 700 words, more than the 624 of the state", 42, 700),
]

random_state_cases = [
    random_state_case("seed 42: the draws of MiniBatchKMeans", 42, [
        ["randint", 0, 16384, 20], ["randint", 0, 16384, 5], ["random_sample", 1], ["uniform", 4],
        ["choice_p", 16384, 30], ["choice_no_replace", 512, 7],
    ]),
    random_state_case("seed 0: ranges of one, two and powers of two", 0, [
        ["randint", 0, 1, 3], ["randint", 0, 2, 10], ["randint", 0, 1024, 5], ["randint", 0, 1025, 5],
        ["randint", 5, 6, 2], ["randint", -3, 4, 6],
    ]),
    random_state_case("seed 2^32 - 1: the largest ranges", 2**32 - 1, [
        ["randint", 0, 2**31 + 5, 4], ["randint", 0, 2**32, 4], ["random_sample", 3],
    ]),
    random_state_case("permutations and choices without replacement", 7, [
        ["permutation", 1], ["permutation", 2], ["permutation", 10], ["choice_no_replace", 100, 100], ["choice_no_replace", 3, 0],
    ]),
    random_state_case("choice with p of 1536 and of 1", 2026, [["choice_p", 1536, 40], ["choice_p", 1, 3], ["uniform", 3]]),
    random_state_case("shuffles of lists, as MTEB's classification tasks undersample", 42, [
        ["shuffle", 0], ["shuffle", 1], ["shuffle", 2], ["shuffle", 30], ["shuffle", 1000], ["permutation", 5],
    ]),
    random_state_case("choices of one item from arrays, as the iterative stratification breaks ties", 42, [
        ["choice", 2, 1], ["choice", 2, 1], ["choice", 1, 1], ["choice", 3, 4], ["choice", 2, 30], ["choice", 5, 0],
    ]),
    random_state_case("choices of the items of an array with p and without replacement", 11, [
        ["choice_array_p", 5, 8], ["choice_array_no_replace", 9, 4], ["choice_array_no_replace", 4, 4],
    ]),
    random_state_case("choice with float32 weights that sum to 1 + 3e-4, a zero weight, and a range that rejects often", 5, [
        ["choice_weights32", 4, 20000, 0.5, 0.0, 0.2503, 0.25], ["randint", 0, 3 * 2**30 + 1, 20],
    ]),
    random_state_case("more than 624 words: the state twists again", 1, [["random_sample", 400], ["randint", 0, 1000, 10]]),
]

generator_cases = [
    generator_case("seed 31957: integers of four ranges", "pcg64", 31957, [
        ["integers", 0, 10, 12], ["integers", 0, 3, 5], ["integers", 0, 1675, 6], ["integers", 0, 7, 4],
    ]),
    generator_case("seed 2^40 + 5, a number above 2^32", "pcg64", 2**40 + 5, [["integers", 0, 1000, 5]]),
    generator_case("seed 2^70 + 3, a bigint above 2^53", "pcg64", 2**70 + 3, [["integers", 0, 1000, 3]]),
    generator_case("ranges of one, of 2^32 - 1 and of 2^32, and a negative low", "pcg64", 5, [
        ["integers", 5, 6, 3], ["integers", 0, 2**32 - 1, 4], ["integers", 0, 2**32, 4], ["integers", -3, 4, 6],
        ["integers", 0, 3 * 2**30 + 1, 20],
    ]),
    generator_case("seed 42: the shuffles of MTEB's multilabel undersampling", "pcg64", 42, [
        ["shuffle", 0], ["shuffle", 1], ["shuffle", 2], ["shuffle", 30], ["shuffle", 30], ["shuffle", 1000],
    ]),
    generator_case("shuffles and integers share the buffered half of a 64-bit draw", "pcg64", 7, [
        ["shuffle", 3], ["integers", 0, 10, 1], ["shuffle", 4], ["integers", 0, 1000, 3], ["shuffle", 70000],
    ]),
    generator_case("permutations of n and of a list, as the stratified split of datasets draws", "pcg64", 42, [
        ["permutation", 0], ["permutation", 1], ["permutation", 2], ["permutation", 30], ["permutation_list", 0],
        ["permutation_list", 1], ["permutation_list", 25],
    ]),
    generator_case("choices without replacement: all of a population draws no last index, one of one draws nothing", "pcg64", 3, [
        ["choice_no_replace", 10, 10], ["choice_no_replace", 10, 3], ["choice_no_replace", 1, 1], ["choice_no_replace", 7, 0],
        ["choice_no_replace", 2, 2], ["choice_no_replace", 10, 9], ["choice_no_replace", 20000, 400],
        ["choice_no_replace", 10000, 250],
    ]),
    generator_case("choices and permutations share the buffered half with shuffles and integers", "pcg64", 2026, [
        ["integers", 0, 10, 1], ["choice_no_replace", 6, 4], ["shuffle", 5], ["permutation", 7], ["integers", 0, 7, 3],
        ["choice_no_replace", 3, 2], ["permutation_list", 9], ["choice_no_replace", 10, 1], ["integers", 0, 5, 1],
    ]),
    generator_case("a Generator over the legacy MT19937 draws from its 32-bit words", "mt19937_legacy", 42, [
        ["integers", 0, 10, 5], ["shuffle", 10], ["permutation", 6], ["choice_no_replace", 10, 3],
    ]),
]

refusals = [
    refusal("default_rng of a negative seed", "default_rng", -1),
    refusal("default_rng of a float seed", "default_rng", 1.5),
    refusal("SeedSequence of a negative seed above 2^53", "SeedSequence", -(2**70)),
    refusal("SeedSequence of a float seed", "SeedSequence", 1.5),
    refusal("PCG64 of a negative seed", "PCG64", -1),
    refusal("PCG64 of a float seed", "PCG64", 1.5),
    refusal("MT19937 legacy seeding of a negative seed", "MT19937", -1),
    refusal("MT19937 legacy seeding of a seed above 2^32 - 1", "MT19937", 2**32),
    refusal("MT19937 legacy seeding of a float seed", "MT19937", 1.5),
    refusal("integers with low = high", "default_rng", 0, ["integers", 5, 5, 1]),
    refusal("integers with low > high", "default_rng", 0, ["integers", 5, 4, 1]),
    refusal("Generator.choice of more items than the population", "default_rng", 0, ["choice_no_replace", 3, 4]),
    refusal("RandomState of a negative seed", "RandomState", -1),
    refusal("RandomState of a seed above 2^32 - 1", "RandomState", 2**32),
    refusal("RandomState of a float seed", "RandomState", 1.5),
    refusal("randint with low = high", "RandomState", 0, ["randint", 5, 5, 1]),
    refusal("RandomState.choice of more items than the population", "RandomState", 0, ["choice_no_replace", 3, 4]),
    refusal("RandomState.choice from an empty array", "RandomState", 0, ["choice", 0, 1]),
    refusal("RandomState.choice of 0 items", "RandomState", 0, ["choice_n", 0, 1]),
    refusal("RandomState.choice with fewer weights than items", "RandomState", 0, ["choice_weights", 3, 2, 0.5, 0.5]),
    refusal("RandomState.choice with a NaN weight", "RandomState", 0, ["choice_weights", 3, 2, 0.5, "NaN", 0.5]),
    refusal("RandomState.choice with a negative weight", "RandomState", 0, ["choice_weights", 3, 2, 0.5, -0.1, 0.6]),
    refusal("RandomState.choice with float64 weights that sum to 1 + 2e-4", "RandomState", 0, ["choice_weights", 3, 2, 0.5, 0.2502, 0.25]),
    refusal("RandomState.choice with float32 weights that sum to 1 + 4e-4", "RandomState", 0, ["choice_weights32", 3, 2, 0.5, 0.2504, 0.25]),
]

fixture = {
    "generator": f"generate.py: numpy {np.__version__}",
    "seed_sequence": seed_sequence_cases,
    "pcg64": pcg64_cases,
    "mt19937": mt19937_cases,
    "random_state": random_state_cases,
    "generator_cases": generator_cases,
    "refusals": refusals,
}
(HERE / "expected.json").write_text(json.dumps(fixture) + "\n", encoding="utf-8")
print(f"{fixture['generator']}: " + ", ".join(f"{len(value)} {key}" for key, value in fixture.items() if isinstance(value, list)), file=sys.stderr)
