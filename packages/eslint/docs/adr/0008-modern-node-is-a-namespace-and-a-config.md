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
- `unicorn/prefer-abort-signal-timeout` found no hits, but code cannot obey it. It asks for `AbortSignal.timeout`, and `island/no-ambient-time` reports `AbortSignal.timeout` in each library file. A probe through the root config shows this report.
- e18e's performance rules are not about new APIs. `e18e/prefer-static-regex` found good code in 10 of 10 hits.

### `unicorn/prefer-dispose`

A `try`/`finally` that only disposes a resource becomes `using` or `await using`. The decision of #4065 turns the rule on for TypeScript files only, because only types prove that a value has a disposer. A probe shows this: with no type information, the rule reports a resource that has only `close()`, and `using` on that resource throws at run time.

Under the root config, the rule gave 18 findings in this repo, with no false positive. All 18 are in tests or test support. The 18 suggestions are correct. The disposers of `mariadb`, `mysql2` and PGlite call the same `end()` or `close()` as the `finally` did. The fix puts each resource in a new block. A script removed the block at 14 sites where the block ended its parent, so that the resource ends at the same time. The block stays at 4 sites, where code runs after the resource closes.

### Rules with no hits

These rules gave no hits in 11,782 files of 24 repos, and the catalog of the `node-native` skill proves that each one fires on its own idiom. They are on, so that new code does not bring these idioms back:

- `unicorn/no-new-buffer`
- `unicorn/prefer-abort-signal-any`: `island/no-ambient-time` does not report `AbortSignal.any`.
- `unicorn/prefer-array-from-async`: `zukhruf/no-collect-loop` also asks for `Array.fromAsync`, so the rules do not conflict. The unicorn rule reports only an empty array in the statement before the loop. It reported 0 of the 27 valid cases and 4 of the 26 invalid cases of the test of `no-collect-loop`. A loop that both rules report gets two findings, and the unicorn rule gives the fix.
- `unicorn/prefer-url-search-parameters`

### `e18e/ban-dependencies`

The rule reports a package that its data replaces. It is off, on imports and on `package.json`, because it does not pass the bar on either. The rule reads only the name of a package. The code can need that package for something that no native API does. The `node-native` skill keeps this job, because it reads how the code uses each package.

Its data also gives some packages only a different package, such as `express` to `h3`. That is a choice of the repo, not a new API, and the rule has no option for the type of replacement.

On imports, the 11 repos that use this package have 41 hits after the hits that only name a different package:

- All 14 hits of `uuid` use `v5`, `v7`, `validate` or `parse`. `crypto.randomUUID` gives only v4.
- The hit of `gaxios` reads `GaxiosError`, an error of a Google library.
- The 17 hits of `lodash-es` are mixed. `escapeRegExp` has a native API. `snakeCase`, `merge`, `mergeWith` and `flow` do not.
- `dotenv` (4), `chalk` (4) and `micromatch` (1) have a native API.

On `package.json`, the measurement read 444 files in 24 repos with `jsonc-eslint-parser`. A control proved that the rule fires. It gave 78 hits, and this repo has none. A reviewer read 12 of the 69 hits that do not only name a different package, and 4 are on good code: `uuid`, `gaxios` and `lodash-es` two times.

The `allowed` option could hide these names, but each new measurement added more names to the list, and a list by hand does not tell a good use from a bad one.

### Candidates for own rules

A prototype of each candidate ran on 11,782 files in 24 repos, with a control for each. No candidate is built. A rule must have a rewrite that keeps the behavior, at most 1 hit in 10 on good code, and a replacement that no other rule of this package reports. Each candidate fails at least one of these conditions.

| Candidate                                                                   | Hits                                                                                                              | Sample                                                                                              | Why it is not built                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Promise((r) => setTimeout(r, ms))` to `node:timers/promises`           | 106 in 13 repos; 9 here                                                                                           | 2 of 12 are browser code. 14 of 106 are in a file with a fake clock.                                | `island/no-ambient-time` reports `setTimeout` of `node:timers/promises` in a library. A probe shows this report. All 9 hits here are in tests. This `setTimeout` also rejects a string as the time, and the global `setTimeout` accepts it.                                                                                                                                                 |
| `'data'` and `'end'` by hand to `text()` of `node:stream/consumers`         | 6 in 3 repos; 0 here                                                                                              | 4 of 6 are server handlers that nothing awaits.                                                     | `text()` rejects when a client closes early. In a handler that nothing awaits, this rejection ends the process. The hand-written code ignores the close.                                                                                                                                                                                                                                    |
| The same, with a process output and no `'end'`                              | 43 in 8 repos; 6 here                                                                                             | 4 of 12 read the output while the process runs.                                                     | `text()` gives a value only at the end.                                                                                                                                                                                                                                                                                                                                                     |
| `signal.addEventListener('abort', …)` to `addAbortListener`                 | 79 in 14 repos; 26 here                                                                                           | 3 of 12 are good code. With no `aborted` check and no `AbortController` name: 47 hits, and 3 of 12. | `addAbortListener` adds three things: it calls the listener when the signal is already aborted, it ignores `stopImmediatePropagation`, and it gives a disposer. A listener on a live signal needs none.                                                                                                                                                                                     |
| `+=` of a chunk in a `'data'` listener, with no `setEncoding` on the stream | 54 in 10 repos; 32 in 5 repos that use this package; 6 here, all in tests. The run read 11,826 files in 26 repos. | 5 of 12 are good code. Outside tests: 9 hits, and 1 is good code.                                   | A chunk can end inside a multi-byte character, and this `+=` then garbles the character. But a test usually reads the ASCII output of its own script, so the garble cannot occur. Outside tests, 1 of 9 is also above the limit: a Python script writes only `json.dumps` output to stdout. Types do not help: the type of the chunk is `any` with `setEncoding` and with no `setEncoding`. |

The rule `mock-timers` and the rule for a `try`/`finally` around `rm` are also not built. Tests use the real clock and wait for the fact, and `zukhruf/no-raw-temp-directory` bans the native API.

## Consequences

- `@e18e/eslint-plugin` and `eslint-plugin-unicorn` are optional peers. A repo that does not import `@zukhruf/eslint/modern-node` does not need them.
- The config is for code that runs on Node, so a browser bundle stays out of it. On 2026-11-09, MDN marks `Error.isError` "Limited availability". In `packages/diagram`, the fix put `Error.isError` in a `catch` block of browser code, where it can throw. The tests run on Node, so they did not find this. The root config of this repo sets `ignores` for the packages that it also gives `zukhruf/react`.
- `eslint-plugin-unicorn` 79 needs ESLint 10.4 or later. A repo on ESLint 9 must update first.
- `unicorn/prefer-dispose` needs type information. `zukhruf/base` gives it. A repo that lints TypeScript with no type information must turn this rule off.
- `unicorn/prefer-uint8array-hex` needs Node 26. Code that runs on Node 24 turns this rule off.
- The e18e fixers do not read types. `[...set].sort()` becomes `set.toSorted()`. The unicorn fixer of `prefer-set-methods` changes `[...a].filter(…)` to `a.difference(…)`, which gives a `Set`. The type check finds these in TypeScript, but no check finds them in a `.mjs` file.
- `crypto-hash` has the first fixer in this package. It reports without a fix when the fix is not safe, for example when the file already has a different `hash`.
