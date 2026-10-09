# The writes through a draft are one package

`@zukhruf/mutex` and `@zukhruf/single-flight` write files through a draft. A write fills a draft beside the path, and then puts the draft at the path in one step. Four places did this: `atomicWrite`, `createExclusive`, and `durableWrite` in the mutex, and a copy of `durableWrite` in the single flight. Each place named its draft `<path>.<random UUID>.tmp`. The copies already went apart: when the rename failed, `durableWrite` removed its draft, but `atomicWrite` left its draft in the directory.

This project follows the Rule of Three, as Fowler gives it in _Refactoring_: "The third time you do something similar, you refactor." The count is the number of places, not the number of packages. Four places is more than three. Thus the writes and the helpers that they use are in this package, and the mutex and the single flight use it.

The four places have the same parts and two differences. The same parts are the name of the draft, the removal of a draft that a failed write leaves, and the change in one step. The differences are:

- How the draft gets to the path: a rename replaces a file that is there (`atomicWrite`, `durableWrite`). A link creates the file only when it is absent (`createExclusive`).
- If the write syncs to the disk: `durableWrite` syncs, and `atomicWrite` does not.

Thus each kind of write is its own function, and one private module names the draft.

## Considered Options

- **Keep the copies.** A fix in one copy does not get to the others. The left drafts show that this already happened.
- **One function with options, for example `{ durable, ifAbsent }`.** Each option makes a call do a different thing, and a reader must know each option to know what a call does. Fowler names this a flag argument, and removes it with one function for each case. Rust's `tempfile` has the same split: `persist` replaces a file that is there, and `persist_noclobber` does not.
- **Three functions on one private draft module.** This option was selected.

## Consequences

- `@zukhruf/mutex` and `@zukhruf/single-flight` depend on `@zukhruf/fs`.
- A fix to the draft applies to each kind of write.
- `safeFileName` stays in the mutex: only the mutex makes file names from keys.
- The check that refuses a network directory is in this package too. It had two copies, in the mutex and in the single flight. The new `@zukhruf/election` package is its third user, so the Rule of Three applies. Its error, `NetworkDirectoryError`, is one class. The packages that refuse a network directory give that class from their own entry points, so a catch with `instanceof` works for each of them.
- The tests of this package have their own copies of the test helpers that record and refuse disk calls. A test file keeps its helpers (backlog #2509).
