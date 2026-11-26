# The caller calls test() and each only collects the native promise

> **Design for review.**

Status: Proposed 2026-11-26 (backlog #5729).

Decision-makers: the session that fixed #2561 on 2026-10-11 (9832e1ec), and Ezz, who kept the form on 2026-11-26 with the move of the code to this package.

`node:test` records the file and line of each `test()` call. It uses that place in reports, in editor links, and as the key of a saved result for `--test-rerun-failures`. The first `.each` of `@zukhruf/testing/node` took `(rows, name, [options], body)` and called `test()` itself. So each row of each test file had the file and line of the helper. In #2561 the saved results of `--test-rerun-failures` collided across files: on Node 26.10.0 a failed row for `test` and one for `suite` both exited 0 on the second pass.

## Decision

`each(rows, register)` calls `register(row, index)` for each row. The register callback calls `test()`, `suite()` or `t.test()` in the caller's file and returns its promise. `each` only checks that it got a promise and waits for all of them.

- A register callback that returns no promise is a `TypeError('each() callback must return test() or suite()')`. The rule `zukhruf/prefer-each` and this check together keep one form.
- An empty table is an `Error('each() requires at least one case')`, because a table with no rows tests nothing and would pass.
- `each` adds no options and no name format. The native call owns them.

## Considered Options

- **A helper that calls `test()` itself**, as the first `.each`, `@streetsidesoftware/test-each`, `test-each` and `jest-each` do. The helper's file and line go on each row, and `--test-rerun-failures` gives a false exit 0 (#2561).
- **A `for` loop that calls `test()`.** It gives the same tests, as nodejs/node PR #53716 says. It does not check for an empty table, and the loops can take many shapes; `zukhruf/prefer-each` asks for one.
- **The caller calls `test()`, and `each` collects the promise.** This option was selected.

## Consequences

- Each register callback has the word `test` two times: `test.each(rows, (row) => test(…))`. This is the cost of a correct file and line.
- A row cannot have options that `node:test` does not have.

## Confirmation

- #2561 (`agent-backlog show 2561`): the root cause and the reproduction on Node 26.10.0.
- 9832e1ec: `packages/testing/src/node/node.test.ts` runs saved-failure reruns across files, name filters, skip and todo, a failed row, and the two errors.
- The probe of [ADR 0002](./0002-the-exports-are-copies-of-the-functions-of-node-test-and-node-test-stays-unchanged.md): the file and line of each row is the caller's, with the copies as with `node:test`.
