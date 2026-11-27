# A pool error is recognized across copies of the package by a symbol brand

Status: Accepted 2026-11-27 (backlog #6148).

Decision-makers: the zukhruf session mutex-91 decided from the evidence and Temporal's design, with Ezz's go on the AskUserQuestion "Go on Temporal's symbol-based instanceof for @zukhruf/pool's errors" ("Go").

One process can load two copies of `@zukhruf/pool`. context-compiler links elt, so its CLI loads `@zukhruf/pool` 0.8.164 from `context-compiler/node_modules` and again from `elt/node_modules`. Each copy has its own classes, and `cc.DeprecatedRevisionError === elt.DeprecatedRevisionError` is false. JavaScript's `x instanceof Y` walks the prototype chain of `x` and looks for the exact object `Y.prototype`. Thus elt's `error instanceof DeprecatedRevisionError` is false for the error that the CLI's `Pool` throws. elt stores the row as failed, and the watch runs on, on a deprecated store (#6148, "GAP FOUND").

Temporal's TypeScript SDK has the same problem and a fix. Its doc of `SymbolBasedInstanceOfError` says: "Another case is when two copies of the same library gets loaded in the same realm." The fix "works by adding a special symbol property to the prototype of 'clazz', and then checking for the presence of that symbol" ([packages/common/src/type-helpers.ts:197-245](https://github.com/temporalio/sdk-typescript/blob/main/packages/common/src/type-helpers.ts)). Temporal applies it to every error class of its `errors.ts`.

## Decision

Each error class that the pool defines and exports carries a brand, as Temporal's `SymbolBasedInstanceOfError` does. These are `DeprecatedRevisionError`, `DisposedError`, `JobCancelledError`, `JobFailedError`, `JobNotFoundError` and `PoolWarning`. `NetworkDirectoryError` and `LeaderSelectorWarning` belong to `@zukhruf/fs` and `@zukhruf/election`, so they stay as they are.

- `brand(errorClass, name)` in [src/errors.ts](../../src/errors.ts) puts the key `Symbol.for('@zukhruf/pool/<name>')` on the prototype of the class. `Symbol.for` reads the global symbol registry, so every copy of the package gets the same symbol.
- `brand` gives the class a `Symbol.hasInstance`. When `this` is the class itself, a value is an instance when its prototype chain has the key. The name and the fields of the value do not decide.
- A subclass that declares no `Symbol.hasInstance` inherits the one of its base class. For it, the check falls back to the prototype chain, as Temporal's does. Without the fallback, every instance of the base class is an instance of each subclass.
- The tests run the TypeScript source through Node's type stripping, which runs no decorators. Thus `brand` is a function that the module calls after each class, not a decorator.

**The keys are a contract between versions of the package.** A host can load two different versions, and each version must recognize the errors of the other. Thus the key of each class is `@zukhruf/pool/<class name>`, and it never changes. A renamed class keeps the key of its old name.

## Considered Options

- **Load one copy only.** npm dedupes two copies only when one version satisfies the ranges of both dependents. Two linked repos have their own `node_modules`, and a range can differ, so npm cannot merge them. Node's `--preserve-symlinks` changes how every linked package resolves, not only this one.
- **Compare `error.name`.** A plain `Error` that has the same name passes. The brand is set only by the class.
- **A decorator, as Temporal writes it.** Node's type stripping does not run decorators, so the tests of the source would not see the brand.

## Consequences

- `instanceof` of a pool error is true for an error of any copy and of any version that has the brand. An older version without the brand is not recognized. Its hosts must update.
- Each new error class of the pool calls `brand` with its name, and gets a row in [src/errors.test.ts](../../src/errors.test.ts).
- `brand` is the first copy of this knowledge in zukhruf (strike 1), so it stays in the pool.
- elt and context-compiler use the new release (#6148).

## Confirmation

- [src/errors.test.ts](../../src/errors.test.ts) imports the module again under the URL `errors.ts?copy`. Node loads it as a second module record, with its own classes, which the test asserts. Before `brand`, all 6 rows failed: an error of the second copy was not an instance of the class of the first copy. After `brand`, they pass.
- For each of the 6 classes, a plain `Error` with the name, the message and the fields of its error is not an instance of it.
- For each of the 6 classes, its error is an instance of no other error class of the pool. Thus each class has its own key.
- An error of a subclass is an instance of the subclass and of the base class. An error of the base class is not an instance of the subclass.
- `undefined`, `null`, a string and a number are no instance, and the check does not throw. A `catch` can get any value.
- The write-test skill's `mutate.mjs` caught 11 of 11 mutations: no key on the prototype, `Symbol` in place of `Symbol.for`, one key for all classes, no `brand` call for `PoolWarning` or for `DisposedError`, a check of the name for all classes or for one, a check that is always true, no check for a non-object, a subclass fallback that is always true, and a subclass check by the key.
