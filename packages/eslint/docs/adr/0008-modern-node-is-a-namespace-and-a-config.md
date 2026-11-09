# Modern Node is a namespace and a config

Node and JavaScript add APIs that replace older code. The `node-native` skill finds this code, but only when a person runs the skill. A check finds it on each lint run, so these checks go into ESLint. The skill finds new candidates, and it proves that a package can go.

`createHash(algorithm).update(data).digest(encoding)` is the first case. No installed or published rule reports it, so this package must own the check. A rule name for each API, such as `zukhruf/no-one-shot-create-hash`, makes hundreds of top-level names. So the checks go under one namespace, `modern-node`, and one config, `modern-node/recommended`. This is the shape of `hermes/recommended`: the plugin has its own rules with short names, and the config also turns on rules of other plugins. A new check joins the namespace, and no repo changes its config.

## Considered Options

- **One rule, `zukhruf/modern-node`, with checks that options turn on and off.** ADR 0001 rejects this. Two configs that set the rule with different options replace each other.
- **A concept under the `zukhruf/` prefix.** The rule names stay top-level names, and nothing shows that they belong together.
- **All of `unicorn/recommended`.** It has no subset for this purpose. Its `unopinionated` config gives 7,696 findings on this repo, most of them on style, such as `prefer-unicode-code-point-escapes`. So the config lists the unicorn rules by name, as `hermes/recommended` lists es-x rules.

## Which rules are on

A rule is on when at most 1 hit in 10 is on good code. The measurement ran on 2026-11-09 with unicorn 79.0.0, `@e18e/eslint-plugin` 0.8.1, eslint-plugin-n 18.5.0 and TypeScript 6.0.3. It read 11,804 files in 26 repos. A reviewer read up to 12 hits of each rule in their code. The counts below are for the 11 repos that use this package. A sample can show that a rule is bad. It cannot prove that a rule is good.

e18e's `modernization` config is the base. These rules did not pass:

| Rule                               | Hits on good code             | Why                                                                                                                                                           |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e18e/prefer-spread-syntax`        | 2 of 8                        | The fixer changes `a.concat(b)` to `[...a, b]`. When `b` is an array, the result changes and no error occurs.                                                 |
| `e18e/prefer-array-to-spliced`     | No hits                       | The fixer changes `[...s].splice(0, 1)` to `s.toSpliced(0, 1)`. The first gives the removed items, and the second gives the remaining items. No error occurs. |
| `e18e/prefer-array-fill`           | 3 of 11                       | The fix gives `unknown[]`, so the code does not compile.                                                                                                      |
| `e18e/prefer-get-or-insert`        | 2 of 7                        | The default runs on each call, so a cache stops working.                                                                                                      |
| `e18e/prefer-throw-if-no-entry`    | 3 of 6                        | The code reads the thrown error.                                                                                                                              |
| `unicorn/prefer-structured-clone`  | 9 of 9                        | The code wants the JSON form of the value.                                                                                                                    |
| `unicorn/prefer-promise-try`       | 2 of 7                        | `Promise.try` runs the function now, and the code defers it on purpose.                                                                                       |
| `unicorn/prefer-regexp-escape`     | 1 of 8 (3 of 12 in all repos) | The fix can change what the pattern matches, and no error occurs.                                                                                             |
| `unicorn/prefer-json-import`       | 3 of 4                        | The file is outside `rootDir`, or the code rewrites it.                                                                                                       |
| `unicorn/prefer-uint8array-base64` | 2 of 8                        | `Uint8Array.fromBase64` throws on input that `Buffer` accepts.                                                                                                |
| `n/prefer-promises/fs`             | 2 of 2                        | It reads `fs.watch` as callback I/O.                                                                                                                          |

These rules are also off:

- `unicorn/prefer-iterator-concat` found no good code, but TypeScript 6 has no type for `Iterator.concat`.
- `unicorn/no-array-sort` and `unicorn/no-array-reverse` found no good code. But in all 12 hits of `no-array-sort` that a reviewer read, the array was already a new copy, so the change fixed nothing. `e18e/prefer-array-to-sorted` and `e18e/prefer-array-to-reversed` report the `[...x].sort()` form, and they have fixers.
- `unicorn/prefer-dispose` waits for a decision (#4065). Typed lint removes half of its hits, but the rule moves per-test teardown out of `try`/`finally`.
- e18e's performance rules are not about new APIs. `e18e/prefer-static-regex` found good code in 10 of 10 hits.

`e18e/ban-dependencies` is on. Its data gives some packages a native replacement, and it gives others only a different package, such as `express` to `h3`. A different package is a choice of the repo, not a new API. The rule has no option for the type of replacement, so its `allowed` option names these packages. The data cannot give this list: the rule uses the first replacement that matches, and a package such as `js-yaml` also has replacements of other types.

## Consequences

- `@e18e/eslint-plugin` and `eslint-plugin-unicorn` are optional peers. A repo that does not import `@zukhruf/eslint/modern-node` does not need them.
- The config is for code that runs on Node, so a browser bundle stays out of it. On 2026-11-09, MDN marks `Error.isError` "Limited availability". In `packages/diagram`, the fix put `Error.isError` in a `catch` block of browser code, where it can throw. The tests run on Node, so they did not find this. The root config of this repo sets `ignores` for the packages that it also gives `zukhruf/react`.
- `eslint-plugin-unicorn` 79 needs ESLint 10.4 or later. A repo on ESLint 9 must update first.
- `unicorn/prefer-uint8array-hex` needs Node 26. Code that runs on Node 24 turns this rule off.
- The e18e fixers do not read types. `[...set].sort()` becomes `set.toSorted()`. The unicorn fixer of `prefer-set-methods` changes `[...a].filter(…)` to `a.difference(…)`, which gives a `Set`. The type check finds these in TypeScript, but no check finds them in a `.mjs` file.
- `crypto-hash` has the first fixer in this package. It reports without a fix when the fix is not safe, for example when the file already has a different `hash`.
