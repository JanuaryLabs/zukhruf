# Parameterized test

One test body that `node:test` runs for each row of a table, as its own test with its own name and result. The package owns the repetition only. The names, the options and the test context stay with `node:test`.

## Language

**Parameterized test**:
One test body that runs one time for each row of a table, and gives a separate named test for each row. The term is Gerard Meszaros's, from _xUnit Test Patterns_ (2007), and JUnit's `@ParameterizedTest`. Go calls it a table-driven test. A parameterized suite repeats a group of tests for each row.
_Avoid_: Theory (xUnit.net's attribute), data-driven test (rows from an external source), test-each (one member of the API)

**Table**:
The readonly array of rows that the caller gives to `each`. It is a literal in the test file, and it has one row or more.
_Avoid_: Data set, data provider (JUnit's `@MethodSource` and xUnit's `[MemberData]` read rows from a member or a file), fixtures (resources that a test acquires)

**Row**:
One element of a table: the inputs and the expected result of one case. A row can be a scalar, a tuple or an object. Its type is the inferred type of the element.
_Avoid_: Case (the test that a row gives), parameter, example

**Register callback**:
The function that `each` calls for each row, with the row and its index. It calls `test()`, `suite()` or `t.test()` in the caller's file, and returns the promise of that call.
_Avoid_: Body (the function of the test itself), factory, handler

**Native declaration**:
A call of `test()`, `suite()` or `t.test()` of `node:test`, and the promise that it returns. `node:test` records the file and line of the call, and uses that place in reports and in `--test-rerun-failures`.
_Avoid_: Registration (the act of `each`), wrapper call
