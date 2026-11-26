# The package is its own tool package and imports nothing of zukhruf

Status: accepted by Ezz on 2026-11-26 ("Approve as written", backlog #5729).

Decision-makers: Ezz, on 2026-11-26, who chose to move `test.each` and `suite.each` into a new package with no zukhruf dependency ("fix 1"), in place of a home in an existing package.

`test.each` and `suite.each` live in `@zukhruf/testing/node` (`packages/testing/src/node/index.ts`, about 25 lines). That file imports only `node:test` and `node:util/types`. But the package `@zukhruf/testing` depends on `async`, `docker`, `fs`, `ssh`, and on `sqlite-open` through them. A test of one of these packages cannot import `@zukhruf/testing/node`: lint fails with `Circular dependency between "fs" and "testing" detected: fs -> testing -> fs` (probed 2026-11-26). [Root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md) forbids that import for the same reason. 22 of the 134 loops that `zukhruf/prefer-each` reports (2026-11-26) are in these packages (docker 8, fs 8, sqlite-open 3, ssh 3), so they cannot follow the rule today.

[Testing ADR 0016](../../../testing/docs/adr/0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md) puts a shared test helper into an area of `@zukhruf/testing`. This ADR reverses that for this helper only, because its area cannot reach every test.

## Decision

The code moves to `packages/parameterized-test`, a package of its own with the tags `std:tool` and `layer:island`.

- It imports only `node:test` and `node:util/types`. It has no dependencies.
- `std:tool` is the only layer that the test files of each layer may import (root ADR 0001, the table of layers). The UI and UI extension layers allow only the tool layer in their tests.
- The move is a move of imported code, not a copy, so the Rule of Three does not apply (root ADR 0001, rule 3).
- `@zukhruf/testing/node` goes away with no alias. Each importer changes its import in the same release.

## Considered Options

- **`@zukhruf/testing/node`, as today.** The tests of `async`, `docker`, `fs`, `ssh` and `sqlite-open` cannot import it.
- **`@zukhruf/async`.** Its concept is waits and the clock, not test declarations. Its shipped code would import `node:test`. The UI layers cannot import a base package in their tests.
- **A new `std:base` package.** The tests of the UI and UI extension layers may import only the tool layer.
- **`@zukhruf/eslint`.** Its concept is lint rules, and it brings ESLint to each test that imports it.
- **Its own `std:tool` package.** This option was selected.

## Consequences

- The tool row of root ADR 0001 gets `parameterized-test`, and `@zukhruf/testing` drops its `./node` export.
- `@zukhruf/testing` and its tests import this package like any other package.
- The message of `zukhruf/prefer-each` names `@zukhruf/parameterized-test`.
- sdk-it, deepagents and context-compiler change their imports after the release.

## Confirmation

- The cycle message above, from `npx eslint --stdin --stdin-filename packages/fs/src/create-exclusive.test.ts` with a body that imports `@zukhruf/testing/node` (2026-11-26; the file on disk did not change).
- The layer table of root ADR 0001: only `std:tool` is in the column "Test files may also import" of each layer.
- Precedent: Jest keeps `test.each` in its own package `jest-each`, which `jest-circus` depends on (`npm view jest-circus dependencies`).
