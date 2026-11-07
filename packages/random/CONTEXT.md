# Random

> This glossary goes with [README.md](README.md).

A Python program that seeds NumPy draws the same numbers on each run. A TypeScript port of that program gives the same results only when it draws the same numbers. This context holds the generators of `numpy.random` that do this.

## Language

**Seed**:
An integer from 0 up that a user gives to start a stream. Here it is a `number` or a `bigint`.
_Avoid_: entropy (the word of `SeedSequence` for its input, which NumPy also takes as a list)

**Stream**:
The numbers that one generator gives, in order, from one seed. Two generators with the same seed give the same stream.

**Draw**:
One call that takes numbers from a stream, such as `integers(0, 10, 5)`. Each draw takes the next numbers. So the order of the draws changes the results.
_Avoid_: sample (a sample is the result of a draw from a population)

**Seed sequence**:
The rule that mixes a seed into the first state of a bit generator, as NumPy's `SeedSequence` does. A small seed and a large seed both give a full state.

**Bit generator**:
The object that gives the raw bits of a stream: 32 bits for each call. PCG64 and MT19937 are bit generators. A bit generator gives no integers in a range and no floats of a distribution.
_Avoid_: RNG, PRNG (they do not separate the bits from the draws)

**Generator**:
The object that turns the bits of one bit generator into draws: integers in a range, shuffles, permutations and choices. NumPy's `default_rng(seed)` gives a generator over PCG64.

**Legacy generator**:
NumPy's `RandomState`: MT19937 with its own seeding and its own draws. NumPy keeps its stream the same in each version (NEP 19). scikit-learn uses it.
_Avoid_: old generator

**Buffered half**:
The high 32 bits of the last 64-bit output of PCG64. The next 32-bit call takes it before PCG64 steps again. The buffered half is part of the bit generator, so all draws on one generator share it.

**Lemire's method**:
The rule that gives an integer in a range from 32-bit draws with one multiplication, and draws again only for a few values. `Generator.integers` and `Generator.choice` use it.

**Masked rejection**:
The rule that gives an integer from 0 to a maximum: it keeps the low bits of a draw that cover the maximum, and draws again when the value is above the maximum. `shuffle` (NumPy's `random_interval`) and `RandomState.randint` use it.

**Floyd's algorithm**:
The rule that draws `k` distinct indices of `n` with `k` draws, and no list of all `n` indices. `Generator.choice` without replacement uses it, and then shuffles the result.

**Proven path**:
A call, with the sizes and the ranges of its arguments, that the golden test proves against NumPy 2.5.4. A call outside the proven paths throws a `RangeError`.
_Avoid_: supported (a call that throws is not a call that NumPy refuses)
