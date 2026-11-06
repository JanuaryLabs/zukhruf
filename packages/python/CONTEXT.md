# Python

A TypeScript port gives the same numbers and text as a Python program only when it follows the rules of CPython. This context holds those rules.

## Language

**CPython rule**:
A result of CPython 3.12 that JavaScript gives differently, such as the text of a float or the order of the keys of a parsed object.
_Avoid_: Python semantics (the language, not one interpreter)

**Compensated sum**:
A sum that keeps the error of each addition and adds it back at the end: Neumaier's algorithm, the `sum()` of CPython 3.12 for floats.
_Avoid_: exact sum (`math.fsum` is exact; this is not)

**Float repr**:
The text that `repr()` gives for a float: the shortest digits that read back as the same float.

**Int**:
A JSON number without `.`, `e` or `E`. Python reads it as an int, exact at any size, so it is a `bigint` here.
_Avoid_: integer (JavaScript calls `7.0` an integer)

**Float**:
A JSON number with `.`, `e` or `E`, or the token `NaN`, `Infinity` or `-Infinity`.

**White space**:
A character for which Python's `str.isspace()` is true.
