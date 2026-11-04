# Copied code

This package keeps copies of four parts of @zukhruf/mteb. The JSON metrics and the ratio of sums need the same CPython rules that mteb ports, and mteb is a large package with many dependencies, so this package does not import it.

The reason is the Rule of Three (workspace ADR 0001, rule 2). This package is the second place for each part. A third place that needs one of these CPython rules starts the extraction (backlog #3770). Until then, make each fix in both copies, and name both files in the commit.

Paths on the left are in `packages/mteb/src/`. Paths on the right are in `packages/structured-eval/src/`.

## Copied without changes

- `dependencies/python.ts` `pythonFloatRepr` → `paths/cpython/python-text.ts` `floatRepr`: the repr() of a float in CPython.
- `dependencies/python.ts` `compareStrings` → `paths/cpython/python-text.ts` `compareStrings`: Python's order of two strings, by code point.

## Copied with changes

**`dependencies/python.ts` `pythonSum` → `aggregation/neumaier-sum.ts` `NeumaierSum`.**
Both add floats with Neumaier's compensated summation, as the sum() of CPython 3.12 does.
Changes: `NeumaierSum` is a running sum (`add`, `value`), because a ratio of sums adds one ratio at a time. The arithmetic is the same.

**`results/json.ts` `jsonLoadsInOrder`, `pythonTokens`, `stringEnd` → `paths/cpython/python-json.ts` `loadsJson`.**
Both read JSON as CPython's json.loads does: each object as a Map in the order of its keys, and the NaN, Infinity and -Infinity tokens of Python's json module, through the visitor of `jsonc-parser`.
Changes: a number whose source text has no `.`, `e` or `E` becomes a bigint, as Python reads it as an int. The values have the type `JsonData`.
