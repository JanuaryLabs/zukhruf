# @zukhruf/parameterized-test

> **Design for review: no code yet.** The README, the glossary and the ADRs are the API on paper. Nothing is built before the maintainer approves them (backlog #5729).

`test.each` and `suite.each` for `node:test`. Each row of a table becomes one test with its own name and its own result. One failed row does not hide the other rows.

The package imports nothing of zukhruf. It imports only `node:test` and `node:util/types`. Thus the tests of each package can use it, also the tests of the packages that `@zukhruf/testing` depends on ([ADR 0001](./docs/adr/0001-the-package-is-its-own-tool-package-and-imports-nothing-of-zukhruf.md)). The code moved here from `@zukhruf/testing/node`, which is gone, with no alias.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install --save-dev @zukhruf/parameterized-test
```

```ts
import { test } from '@zukhruf/parameterized-test';

void test.each(
  [
    ['42', 42],
    ['1.5', 1.5],
  ] as const,
  ([input, expected]) =>
    test(`Number reads ${input} as ${expected}`, (t) => {
      t.assert.equal(Number(input), expected);
    }),
);
```

The run reports two tests. Each has the name that the register callback gave it.

## Repeat a test for each row

Give the table and a register callback to `test.each`. The callback gets the row and its index. It calls `test()` and returns the promise of that call. Names, options (`skip`, `todo`, `only`, `timeout`) and the test context belong to that native call.

```ts
void test.each(
  [
    { name: 'empty', input: '', valid: false },
    { name: 'digits', input: '0042', valid: true },
  ],
  (row) =>
    test(row.name, { timeout: 1_000 }, (t) => {
      t.assert.equal(/^\d+$/.test(row.input), row.valid);
    }),
);
```

## Repeat a suite for each row

`suite.each` repeats a group of tests for each row. Each test acquires and disposes its own resources inside its body.

```ts
import { suite, test } from '@zukhruf/parameterized-test';

void suite.each(['utf8', 'utf16le'] as const, (encoding) =>
  suite(encoding, () => {
    test('round-trips text', (t) => {
      t.assert.equal(
        Buffer.from('hello', encoding).toString(encoding),
        'hello',
      );
    });
  }),
);
```

## Use it and describe

`it` is `test`, and `describe` is `suite`, as in `node:test`.

```ts
import { describe, it } from '@zukhruf/parameterized-test';

void describe.each(['memory', 'sqlite'] as const, (store) =>
  describe(store, () => {
    void it.each([1, 2], (count) =>
      it(`holds ${count} keys`, (t) => {
        t.assert.ok(count > 0);
      }),
    );
  }),
);
```

## Repeat subtests inside a test

Inside a test, the register callback can return `t.test()`. Await `test.each` to keep the parent test alive until its subtests end. The subtests then count in the parent's plan, and the parent's `concurrency` controls them.

```ts
test('parses each form', async (t) => {
  await test.each(['1', '01', '+1'], (input) =>
    t.test(input, (child) => {
      child.assert.equal(Number(input), 1);
    }),
  );
});
```

## Each call and what happens underneath

| Call                                          | What happens                                                                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.each(rows, register)`                   | Calls `register(row, index)` synchronously, one time for each row, in the order of the table. Returns one promise that resolves when all the native promises resolve.                                                                                 |
| `register` returns no promise                 | `each` throws `TypeError('each() callback must return test() or suite()')` at once. The rows before it are already registered.                                                                                                                        |
| `rows` is empty                               | `each` throws `Error('each() requires at least one case')` before it calls `register`. An empty table is a defect of the test, not a pass.                                                                                                            |
| `register` calls `test()` or `suite()`        | `node:test` records the file and line of that call, which is in the caller's file. Reports, editor links and `--test-rerun-failures` use that place ([ADR 0003](./docs/adr/0003-the-caller-calls-test-and-each-only-collects-the-native-promise.md)). |
| `suite.each(rows, register)`                  | As `test.each`. Inside a suite, the native promises resolve at once.                                                                                                                                                                                  |
| `test(…)`, `suite(…)`, `it(…)`, `describe(…)` | The native function of `node:test`, through a bound copy ([ADR 0002](./docs/adr/0002-the-exports-are-copies-of-the-functions-of-node-test-and-node-test-stays-unchanged.md)).                                                                         |

A helper that calls `test()` itself puts the file and line of the helper on each row. In #2561 that place was the same for all test files: the saved results of `--test-rerun-failures` collided across files, and a run with a failed row exited 0 on the second pass. The fix, 9832e1ec, moved the `test()` call into the caller's file.

## node:test stays unchanged

The exports are copies of `test` and `suite` of `node:test`. Each copy is `fn.bind(undefined)` with the own property descriptors of the native function. Thus the getters `mock`, `snapshot` and `assert` stay lazy getters. On the copy of `test`, `test.test` and `test.it` point to the copy, and `test.suite` and `test.describe` point to the copy of `suite`. Each copy also has `each`.

`@zukhruf/testing/node` did `Object.assign(nodeTest, { each })`. That added `each` to the function of `node:test` itself, for each module of the process. This package does not change `node:test`.

A probe on Node 26.13.1 ran the same test files through the copies and through `node:test`. The names, the file and line of each test, the status, skip and todo, and the exit codes were the same with no flag, with `--test-only`, with `--test-name-pattern`, with `--test-skip-pattern`, and in three passes of `--test-rerun-failures`. After the import, `node:test`'s `test` had no `each`.

## Errors

| Error                                                        | When                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `TypeError('each() callback must return test() or suite()')` | The register callback returned a value that is not a promise. |
| `Error('each() requires at least one case')`                 | The table has no rows.                                        |

Both errors are thrown synchronously, while the file registers its tests. `node:test` reports the file as failed.

## Scope: now, later, never

| When  | What                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Now   | `test.each`, `suite.each`, `it`, `describe`.                                                                                                                                                |
| Later | Rows of a matrix (the Cartesian product of two or more tables), when a caller needs them.                                                                                                   |
| Never | printf names (`%s`, `$input`); tagged-template tables; a helper that calls `test()` itself; rows from an external data source; skip or only for each row beyond the options of `node:test`. |

## What the package does not do

- **It does not make names.** The register callback writes the name with a template literal. Jest's printf format and `$variable` names add a second language for a thing that JavaScript already does.
- **It does not read a table from a template literal.** Jest's tagged-template table has rows of type `any`. A readonly array keeps the inferred type of each row.
- **It does not call `test()` for the caller.** See [ADR 0003](./docs/adr/0003-the-caller-calls-test-and-each-only-collects-the-native-promise.md).
- **It does not read rows from files, CSV or a database.** JUnit's `@CsvFileSource` and xUnit's `[MemberData]` do. A test reads its file and gives the rows as an array.
- **It has no own options for skip or only.** Give `skip`, `todo` or `only` to the native call in the register callback.

## Why Node has none

Node core decided that `test.each` belongs in userland: nodejs/node [#47902](https://github.com/nodejs/node/issues/47902), and PR [#53716](https://github.com/nodejs/node/pull/53716), closed with "no advantage over array.forEach or a for loop". A `for` loop that calls `test()` gives the same named tests. This package exists to enforce one form. The ESLint rule `zukhruf/prefer-each` reports a loop in a test file that declares tests, and names this package in its message.

## Why each npm candidate failed

Probed on 2026-11-26.

| Package                         | Version | Why it failed                                                                                                   |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `@streetsidesoftware/test-each` | 1.0.0   | Returns no promise. An empty table passes. It calls `test()` itself, so `node:test` records the library's file. |
| `test-each`                     | 7.0.1   | Returns no promise. An empty table passes. Four dependencies.                                                   |
| `jest-each`                     | 30.5.2  | Returns no promise. An empty table becomes a failing test. Needs a stand-in for Jest's globals. Rows are `any`. |
| `expect-node`                   | 0.6.0   | Returns no promise. Accepts an empty table. No types. A whole test framework.                                   |

## Who uses it

| Consumer                  | How                                                                                                                                                                                             | Record |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| zukhruf test files        | Every test file that repeats a test over a table: 136 loops that declared tests became `test.each` (cbf95ce6), the tests of `testing` too, and 82 loops over a table inside one test (26b9b614) | #5729  |
| `zukhruf/prefer-each`     | An error on a loop that declares tests; its message names this package                                                                                                                          | #5729  |
| `zukhruf/no-tabular-test` | An error on a loop inside one test over a table of independent cases; its message names this package                                                                                            | #5729  |
| sdk-it                    | 69 files moved here (2ea8d2a7)                                                                                                                                                                  | #5729  |
| deepagents                | 6 files moved here (b136e29d)                                                                                                                                                                   | #5729  |
| context-compiler          | 2 files, as above                                                                                                                                                                               | #5729  |

## The same concepts in other systems

| Concept                                  | Other systems                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parameterized test                       | Gerard Meszaros, _xUnit Test Patterns_ (2007), "Parameterized Test" ([xunitpatterns.com](http://xunitpatterns.com/Parameterized%20Test.html)). JUnit 5 `@ParameterizedTest`, in the artifact `junit-jupiter-params` ([guide](https://junit.org/junit5/docs/current/user-guide/#writing-tests-parameterized-tests)). |
| Table and one named subtest for each row | Go: table-driven tests with `t.Run` ([go.dev/wiki/TableDrivenTests](https://go.dev/wiki/TableDrivenTests)).                                                                                                                                                                                                         |
| Rows as attributes                       | xUnit.net `[Theory]` with `[InlineData]` or `TheoryData<T>`; NUnit `[TestCase]`; MSTest `[DataRow]`.                                                                                                                                                                                                                |
| `test.each` and `describe.each`          | Jest, through its own package `jest-each`, which `jest-circus` depends on.                                                                                                                                                                                                                                          |

## API

```ts
import type { suite as nodeSuite, test as nodeTest } from 'node:test';

/** Calls register synchronously for each row and waits for every native declaration. */
type Each = <Row>(
  rows: readonly Row[],
  register: (row: Row, index: number) => Promise<void>,
) => Promise<void>;

/** A copy of test of node:test, with each. node:test stays unchanged. */
export declare const test: typeof nodeTest & { each: Each };
/** A copy of suite of node:test, with each. */
export declare const suite: typeof nodeSuite & { each: Each };
export { suite as describe, test as it };
```

## Documentation

**Decisions**

- [ADR 0001](./docs/adr/0001-the-package-is-its-own-tool-package-and-imports-nothing-of-zukhruf.md): the package is its own tool package, and it imports nothing of zukhruf.
- [ADR 0002](./docs/adr/0002-the-exports-are-copies-of-the-functions-of-node-test-and-node-test-stays-unchanged.md): the exports are copies of the functions of `node:test`, and `node:test` stays unchanged.
- [ADR 0003](./docs/adr/0003-the-caller-calls-test-and-each-only-collects-the-native-promise.md): the caller calls `test()`, and `each` only collects the native promise.
- [ADR 0004](./docs/adr/0004-the-name-is-parameterized-test-and-the-package-is-public.md): the name is `@zukhruf/parameterized-test`, and the package is public.
