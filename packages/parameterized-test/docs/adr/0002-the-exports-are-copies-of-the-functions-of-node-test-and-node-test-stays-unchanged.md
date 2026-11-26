# The exports are copies of the functions of node:test, and node:test stays unchanged

Status: accepted by Ezz on 2026-11-26 ("Approve as written", backlog #5729).

Decision-makers: Ezz, on 2026-11-26, who chose a separate copy of the functions of `node:test` over a change to them, with the condition "you need to make sure it works with node".

`@zukhruf/testing/node` exports `Object.assign(nodeTest, { each })` and `Object.assign(nodeSuite, { each })`. `Object.assign` changes its first argument. Thus the import adds `each` to the `test` and `suite` of `node:test` itself, for each module of the process, also for modules that never import the package.

## Decision

`test` and `suite` are copies of the native functions, with `each` added to the copies.

- A copy is `fn.bind(undefined)`, with the own property descriptors of the native function except `length`, `name` and `prototype`. The getters `mock`, `snapshot` and `assert` stay lazy getters, so a copy reads them only when the test reads them.
- On the copy of `test`, `test.test` and `test.it` point to the copy, and `test.suite` and `test.describe` point to the copy of `suite`. Thus `test.it.each` works as `test.each`.
- `it` is the copy of `test`, and `describe` is the copy of `suite`.
- `node:test` is not changed.

## Considered Options

- **`Object.assign` on the function of `node:test`** (today). It gives `node:test`'s `test` an `each` in the whole process. A module that uses `each` without the import works only when another module imported the package first.
- **A wrapper function that calls `test()`.** `node:test` would record the file and line of the wrapper. See [ADR 0003](./0003-the-caller-calls-test-and-each-only-collects-the-native-promise.md).
- **A bound copy with the native descriptors.** This option was selected.

## Consequences

- An upgrade of Node that adds a property to `test` gives it to the copy at load time, because the copy reads all own descriptors.
- `test === nodeTest` is false. No code in zukhruf compares the two (`git grep`, 2026-11-26).

## Confirmation

The probe of 2026-11-26 on Node 26.13.1 (session mutex-03, scratchpad `compat/`, run again for this paper) ran the same test files once through the copies and once through `node:test`, and compared the output:

- The names, the file and line of each test, the status, skip and todo, and the exit code were the same with no flag, with `--test-only`, with `--test-name-pattern`, and with `--test-skip-pattern`.
- They were the same in three passes of `--test-rerun-failures` over a `test.each` of three rows: pass 1 failed row 2 and exited 1, pass 2 ran row 2 fixed and exited 0, pass 3 replayed the saved results and exited 0. Each row had the file and line of the caller.
- After the import of the copies, `'each' in nodeTest` was false.
