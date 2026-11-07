# Python

A TypeScript port gives the same numbers and text as a Python program only when it follows the rules of CPython. This context holds those rules.

## Language

**CPython rule**:
A result of CPython 3.12 that JavaScript gives differently, such as the text of a float or the order of the keys of a parsed object.
_Avoid_: Python semantics (the language, not one interpreter)

**Compensated sum**:
A sum that keeps the error of each addition and adds it back at the end: Neumaier's algorithm, the `sum()` of CPython 3.12 for floats.
_Avoid_: exact sum (`math.fsum` is exact; this is not)

**Compensated mean** (ADR 0003):
The **compensated sum** of some floats divided by their number: what a Python program gives for `sum(values) / len(values)`. Python raises `ZeroDivisionError` for no value. CPython has no function for it, so the name is our name.
_Avoid_: fmean (`statistics.fmean` uses `math.fsum`), mean (`statistics.mean` uses exact fractions, and numpy's mean uses the pairwise sum)

**Float repr**:
The text that `repr()` gives for a float: the shortest digits that read back as the same float.

**Int**:
A JSON number without `.`, `e` or `E`. Python reads it as an int, exact at any size, so it is a `bigint` here.
_Avoid_: integer (JavaScript calls `7.0` an integer)

**Float**:
A JSON number with `.`, `e` or `E`, or the token `NaN`, `Infinity` or `-Infinity`.

**White space**:
A character for which Python's `str.isspace()` is true.

**JSON.parse value**:
The value that `JSON.parse` gives for a JSON text: an object for each dict and the nearest number for each int. Code that reads only plain JavaScript, such as a JSON Schema validator, needs it.
_Avoid_: plain JSON (JSON is text)

**Edge**:
The place where code gives a value to code that reads only plain JavaScript. A value stays `JsonData` up to an edge.
