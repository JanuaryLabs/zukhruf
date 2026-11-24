# Code copied between the readline error tests

Two tests of `zukhruf/no-unhandled-readline-error` lint a fixture with type information, and each fixture must see the real `net.Socket` of `@types/node`. So each test points its fixture's `typeRoots` at the workspace's own `@types/node`, and the second test copies those lines from the first instead of sharing them.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it (backlog #5465). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

## Copied without a change

| Part        | Where                                                                               | What it does                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typeRoots` | `src/errors/no-unhandled-readline-error.test.ts`, `src/base/readline-error.test.ts` | Resolves `@types/node/package.json` with `createRequire` and takes the folder above its folder, so the fixture's `tsconfig` finds the real `@types/node`. |
