# Copied code

This package keeps a copy of one rule that another place also holds. The reason is the Rule of Three (workspace ADR 0001, rule 2): the rule is in two places, so it stays a copy. A third place that needs a CPython rule starts its extraction into @zukhruf/python, which already holds the CPython rules that three places copied (its ADR 0001). Until then, make each fix in both copies, and name both files in the commit.

## Copied without changes

**@zukhruf/mteb `src/dependencies/python.ts` `compareStrings` → `src/cpython/python-text.ts` `compareStrings`.**
Python's order of two strings, by code point.
