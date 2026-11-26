# The name is parameterized-test and the package is public

Status: accepted by Ezz on 2026-11-26 ("Approve as written", backlog #5729).

Decision-makers: Ezz, on 2026-11-26, who chose the name `@zukhruf/parameterized-test` over `@zukhruf/table-test`, and ruled the package public on npm.

The package needs a name for its concept, not for its API or its callers (root ADR 0001, rule 1). The survey found these words:

| Source                                        | Word                                                  |
| --------------------------------------------- | ----------------------------------------------------- |
| Gerard Meszaros, _xUnit Test Patterns_ (2007) | Parameterized Test (the pattern)                      |
| JUnit 5                                       | `@ParameterizedTest`, artifact `junit-jupiter-params` |
| Go                                            | table-driven test, with `t.Run`                       |
| xUnit.net                                     | `[Theory]`                                            |
| Jest                                          | `test.each`, package `jest-each`                      |

## Decision

- The npm name is `@zukhruf/parameterized-test`, the folder is `packages/parameterized-test`, and the Nx project is `parameterized-test`.
- The package is public on npm. sdk-it, deepagents and context-compiler install it from npm. Root ADR 0001, rule 8, has no internal package.

## Considered Options

- **`@zukhruf/table-test`**, after Go's table-driven tests. Go's word names the table, and Go has no package for it: `t.Run` in a loop is the form.
- **`@zukhruf/test-each`.** It names one member of the API, and it is Jest's word.
- **`@zukhruf/theory`.** It is the jargon of xUnit.net, and a reader outside .NET does not know it.
- **`@zukhruf/parameterized-test`.** This option was selected: Meszaros's pattern name, and the word of JUnit's own artifact.
- **A private package.** Consumers outside zukhruf need it, and npm has no private scope for this workspace.

## Consequences

- The glossary uses "parameterized test" and avoids "theory" and "test-each" ([CONTEXT.md](../../CONTEXT.md)).
- The release adds the package to the `packageGroup` of the nx migrations, as each published `@zukhruf` package is (54e50f7d).

## Confirmation

- Meszaros, "Parameterized Test": [xunitpatterns.com](http://xunitpatterns.com/Parameterized%20Test.html).
- JUnit 5 user guide, "Parameterized Tests": [junit.org](https://junit.org/junit5/docs/current/user-guide/#writing-tests-parameterized-tests).
- Go wiki, "TableDrivenTests": [go.dev/wiki/TableDrivenTests](https://go.dev/wiki/TableDrivenTests).
