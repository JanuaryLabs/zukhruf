# no-captured-assignment reads the scope, and is off until the repos are clean

The SQL Server `observe()` of elt kept a cache for each check in a `let`. The first probe of a check reset it, and a closure filled it. The result was correct only when the closures ran in one order. This is shared mutable state through closures, and its failure is temporal coupling. The ChangeWatcher of `@zukhruf/async` (#3840) removed that code. `zukhruf/no-captured-assignment` (#3878) reports the next case of this form: a nested function that assigns a `let`, a `var` or a parameter of an enclosing function.

The rule uses the scope analysis of ESLint. A write reference to a variable is reported when the function scope of the reference is not the function scope of the variable. Thus a write in a block, a loop or a generator body of the same function is not reported, and a write in a callback, a method, an accessor or an IIFE is reported. A module-scope variable is not reported, because `functional/no-let` in `base` bans a module-scope `let`. A `x ??= …` write is not reported. A lazy memo sets the value one time and never clears it, and `zukhruf/no-phase-flag` already accepts it.

## Considered Options

- **Read the types, and report a mutation of a captured object.** A closure that calls `map.set()` on a captured `Map` shares state as a closure that assigns a `let` does. But a check must know which methods change the object. `functional/immutable-data` knows the methods of arrays, objects, `Map` and `Set` from their types, and it reports each mutation, not only a mutation in a closure. For the methods of other classes, no type tells if a method changes the object. This option was not selected. The rule reports assignments only.
- **Skip an IIFE, a promise executor and a synchronous callback.** These run before the outer function continues, so their order is known. But the rule cannot see if a callback is synchronous (`forEach` is, `on` is not). An async IIFE writes after an `await`, and five async IIFEs in `elt/src/core/pipeline.ts` do this. Each case has a direct fix: return the value, `Promise.withResolvers()`, or `reduce()`. This option was not selected.
- **Turn the rule on in `base` now.** On 2026-11-06 the rule reported 191 findings in zukhruf (156 in tests), 120 in elt (67 in tests) and 37 in context-compiler (26 in tests). Most findings in tests are spy counters (`calls++`) and flags that a callback sets (`closed = true`). Turning the rule on breaks the lint of three repos. This option was not selected.
- **Ship the rule, and set it to `off` in `base`.** This option was selected. A repo can turn it on for its files. `base` keeps the key, so exactly one config owns the rule.

## Consequences

- `base` turns the rule on when the three repos have no findings. #3878 has the list of findings.
- A repo that wants the check now sets `'zukhruf/no-captured-assignment': 'error'` in its own config.
- A closure that changes a captured `Map`, a `Set` or an array is not reported.
