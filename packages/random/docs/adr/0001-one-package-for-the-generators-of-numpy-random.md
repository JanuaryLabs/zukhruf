# One package for the generators of numpy.random, reached through a workspace path

Status: Accepted (Ezz, 2026-11-06).

## Context

Two places port `numpy.random.default_rng` to draw the same numbers as a Python program (backlog #3411):

| Place                                                                     | Lines | What it ports                                                                                                                           |
| ------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/information-filtering/relevance-filtering/eval/numpy-random.ts` | 128   | `NumpyGenerator.integers`: SeedSequence, PCG64 (XSL-RR) with its buffered half, Lemire's method                                         |
| `packages/mteb/src/dependencies/numpy-random.ts`                          | 381   | the same core, byte for byte, and `shuffle`, `permutation`, `choiceWithoutReplacement` (Floyd's algorithm), and `RandomState` (MT19937) |

The two `numpy-random.test.ts` files are byte for byte the same. Inside mteb, `NumpyGenerator` and `RandomState` each have a copy of NumPy's `random_interval` (`#interval`, recorded in `packages/mteb/docs/ported-from-mteb.md:239`).

That is two places. Rule 2 of workspace ADR 0001 waits for the third place. On 2026-11-06, Ezz chose to extract at the second place ("Extract now"). This is the third recorded exception to rule 2, after the test helpers and the election. A search of all repositories under `~/Desktop/experiments` found no third port (2026-11-06).

Both copies have one bug: `new NumpyGenerator(-1)` gives the stream of `default_rng(4294967295)`, because `pool` reads `BigInt(-1) & MASK32`. NumPy 2.5.4 raises `ValueError: expected non-negative integer`. A seed is a `number`, so a seed above 2^53 cannot be given, and NumPy takes an int of any size. `NumpyGenerator.integers(5, 5, 1)` gives `[5]`, and NumPy raises `ValueError: low >= high`.

## Decision

`@zukhruf/random` holds the generators of `numpy.random` that the two places port: `SeedSequence`, the `BitGenerator` interface, `PCG64`, `MT19937`, `Generator`, `defaultRng` and `RandomState`. It holds all of mteb's file, not only the shared core. mteb's file is NumPy's own API, which the users import and do not copy. So its move is a question of cohesion (workspace ADR 0001, rule 3).

The layers are NumPy's layers (NEP 19, and the BitGenerator and SeedSequence pages of the NumPy documentation):

- A seed sequence gives the first state of a bit generator.
- A bit generator gives raw bits. PCG64 keeps its buffered half, as NumPy keeps it in the bit generator.
- A generator holds one bit generator and gives the draws. `random_interval` and Lemire's method are functions over a `BitGenerator`. So `random_interval` has one home, as it has in NumPy's `distributions.c`.
- `RandomState` keeps the stream of the legacy generator, as NEP 19 keeps it in NumPy.

These rules hold:

1. Each draw gives the numbers of NumPy 2.5.4, bit for bit. mteb's golden test proves it, and it moves here with the code.
2. A seed is a `number` or a `bigint`. A negative seed throws a `RangeError`. A `number` that is not an integer throws a `TypeError`. NumPy 2.5.4 raises a `ValueError` and a `TypeError` for these seeds (probed on 2026-11-06).
3. A call outside the proven paths throws a `RangeError`. The README lists each limit.
4. The package has no global generator. Each user holds its generator, as NEP 19 asks.
5. The classes keep NumPy's names. The package is named for what it gives, a random stream, as `numpy.random`, Python's `random`, Go's `math/rand`, Rust's `rand` and `@stdlib/random` are named.

### Why not @zukhruf/statistics

Rule 1 of workspace ADR 0001 says: "Two concepts that exist without each other are two packages." A generator exists without a bootstrap: mteb shuffles and splits datasets with it. A bootstrap exists without NumPy's generator: structured-eval and offers-evals draw with CPython's `random`. SciPy and arch give the same split. `scipy.stats.bootstrap` takes `rng`, and `arch.bootstrap.IIDBootstrap` takes `seed`, a NumPy `Generator`. Neither holds its generator. So `IidBootstrap` of `@zukhruf/statistics` keeps its `randomIndex` input, and statistics does not depend on this package.

### Why not @zukhruf/python

`@zukhruf/python` holds the results of CPython 3.12. NumPy is a library, not CPython. CPython's `random` is on npm as python-random 1.0.0, which is not ours.

### Why not @zukhruf/numpy

Rule 2 of `@zukhruf/evals` ADR 0001 names a family by what it does, never by its reference implementation, and the same rule names this package. A package named `numpy` would also invite each port of NumPy, such as the `linear` quantile, which is in `@zukhruf/statistics`.

### Why not an npm package

No npm package gives `default_rng` (measured on 2026-11-06 against NumPy 2.5.4 and mteb's golden fixture):

- numpy-ts 1.7.0 gives 29 of 33 cases. It cuts seeds of 2^32 or more to 32 bits, its `permutation` of an array differs, and it has no `RandomState`.
- `@stdlib/random-base-mt19937` 0.2.3 refuses the seed 0, and stdlib has no PCG64 and no `SeedSequence`. Its own draws, such as `discrete-uniform`, give 0 of 5 cases.
- mersenne-twister 1.1.0 gives the raw MT19937 stream, but it has no types, and its last release was on 2022-06-19.
- pcg64dxsm is the DXSM output, not XSL-RR. pcg, pcg-random and random-seedable have no `SeedSequence`.

A package could replace only the MT19937 core, about 40 of 381 lines. The rest stays ours. Rule 4 of workspace ADR 0001 applies: "A little copying is better than a little dependency." So the package keeps its own MT19937 core.

### Private

The package is private, and a workspace reaches it through its path, as `@zukhruf/python` and `@zukhruf/statistics` are reached. Ezz chose this on 2026-11-06 ("either works"). This breaks workspace ADR 0001, rule 8, in the same way as their ADR 0001. mteb is private and lists it as a dependency. relevance-filtering is public, but only its eval uses this package, and npm does not ship its eval. So it lists the package as a development dependency, which npm never installs for its users.

## Considered Options

- Keep the two copies. Ezz chose to extract now.
- Put the generators in `@zukhruf/statistics`. It mixes two concepts (above).
- Put the generators in `@zukhruf/python`. NumPy is not CPython.
- Use an npm package. None gives these results (above).
- Move only the shared core (`integers`). Then mteb keeps half of NumPy's API, and `random_interval` keeps two homes.
- One package for the generators of `numpy.random`, with NumPy's layers. This option was selected.

## Consequences

- The seed −1 throws, where both copies gave the stream of 4294967295. No user passes a negative seed today.
- A user can give a `bigint` seed above 2^53.
- `integers` with a range of 0 or less, or above 2^32, throws, where the copy gave wrong numbers.
- A new distribution or bit generator comes with its first user, and with a golden case from NumPy.
- The build adds this exception to the list of rule 2 in workspace ADR 0001.
- When the package must be used outside these repositories, publish it with the publish set of backlog #3865, and delete the exception.
