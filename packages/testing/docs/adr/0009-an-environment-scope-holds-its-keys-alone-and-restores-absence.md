# An environment scope holds its keys alone and restores absence

Tests change `process.env` by hand and restore it at the end. 37 places restore correctly. 6 places write the string `"undefined"` to a key that was absent before: factory `workspace.test.ts:38` and `:50`, `git.test.ts:68`, the text2sql Postgres and SQL Server finders, and deepagents `docker-sandbox.test.ts:1770`. `openai-traces.test.ts:1060` loses an empty string. `t.mock.property(process.env, …)` throws, so `node:test` has no form for it. Thus `new Environment().set(values)` assigns each key on the real `process.env` and returns an environment scope, `{ cleanup, [Symbol.dispose] }`. A value of `undefined` deletes the key for the scope (about 3 places). At restore, a key that was absent is deleted, and an empty string is a value. A key belongs to one open scope at a time: a second `set` that names a held key throws and names the key. Go's [`testing.T.Setenv`](https://pkg.go.dev/testing#T.Setenv) refuses a parallel test for the same reason. `TestContext` does not tell whether tests run at the same time, and tests of one file can overlap. No place nests scopes or runs environment tests at the same time. ADR 0007 says that library code does not read `process.env`, and the caller gives the environment. This area fits that rule. Here the environment is the subject of the test, not configuration of the library. The scope reads the earlier values only to restore them, and it never selects its own behavior from them.

## Considered Options

- **Replace the `process.env` object.** desktop-stack and data-source-adapter do this. Native addons then do not see the changes.
- **`Object.defineProperty` on `process.env`.** Node resets its `TZ` cache only on an assignment.
- **Nested scopes on one key.** No place needs them, and a restore order across scopes adds state that a test cannot see.
- **One key for each call.** About 6 places set several keys at once, for example 7 keys in the text2sql chat-sandbox test.
- **A `PATH` prepend method.** 1 place does it. The README gives a recipe with `path.delimiter`.

## Consequences

- To set several keys, a test gives them to one `set`.
- A module that reads a variable when it loads keeps that value (about 15 places). The test sets the scope, then loads the module with `await import()`, or runs the code in a child process.
- A child process sees the scope only if it inherits the environment when it starts. About 40 places give `env` to the child, and need no scope.
