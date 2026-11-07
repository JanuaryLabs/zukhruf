# Copied code

The Rule of Three (workspace ADR 0001, rule 2) keeps these rules in two places. Each fix goes into both copies, and the commit names both files.

## Copied without changes

**@zukhruf/mteb `src/dependencies/python.ts` `compareStrings` → `src/structured/cpython/python-text.ts` `compareStrings`.**
Python's order of two strings, by code point.

## A frozen package

**`packages/structured-eval` → this package, until offers-evals #3892 and context-compiler #3893 use the release of `@zukhruf/evals`.**
Ezz chose to keep it frozen until its two consumers switch (2026-11-07, "Keep frozen until switch"). A fix goes into this package only; the frozen copy gets no fix, and its consumers take the fix when they switch. Then `packages/structured-eval` is deleted with the coding:remove-code skill.
