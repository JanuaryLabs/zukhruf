# Copied code

This package keeps copies of two rules that another place also holds. The reason is the Rule of Three (workspace ADR 0001, rule 2): each rule is in two places, so it stays a copy. A third place that needs a CPython rule starts its extraction into @zukhruf/python, which already holds the CPython rules that three places copied (its ADR 0001). Until then, make each fix in both copies, and name both files in the commit.

## Copied without changes

**@zukhruf/mteb `src/dependencies/python.ts` `compareStrings` → `src/paths/cpython/python-text.ts` `compareStrings`.**
Python's order of two strings, by code point.

**`src/paths/metrics/path-f1.ts` `PathF1.of` → `src/paths/metrics/leaf-token-f1.ts` `LeafTokenF1#tokenF1`.**
The F1 of evaluate.py (f1_from_counts and token_f1): 0 when nothing is shared, else precision and recall first, then 2·p·r/(p + r). That arithmetic gives other bits than 2·shared/(stated + expected) on many counts, such as 1 shared of 1 expected and 5 stated. The records family's 2s/(a+b) form is other knowledge, not a third copy. Backlog #3852.
