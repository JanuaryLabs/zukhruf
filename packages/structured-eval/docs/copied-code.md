# Copied code

This package keeps copies of two CPython rules that other places also hold. The reason is the Rule of Three (workspace ADR 0001, rule 2): each rule is in two places, so it stays a copy. A third place that needs one of these rules starts the extraction into @zukhruf/python, which already holds the CPython rules that three places copied (its ADR 0001). Until then, make each fix in both copies, and name both files in the commit.

## Copied without changes

**@zukhruf/mteb `src/dependencies/python.ts` `compareStrings` → `src/paths/cpython/python-text.ts` `compareStrings`.**
Python's order of two strings, by code point.

## Copied with changes

**`src/paths/cpython/python-equals.ts` `pythonEquals` → offers-evals `src/scorers/python-equality.ts` `PythonEquality`.**
Python's `==` for two JSON leaves: a bool, an int and a float compare as numbers, exactly, so `True == 1 == 1.0`.
Changes: `PythonEquality` is a class that implements the `Equality` strategy of offers-evals, and the value on the right can be absent.
