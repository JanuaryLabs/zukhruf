# Production code and tests make a temporary directory with TemporaryFiles of @zukhruf/fs

`TemporaryFiles` gives a temporary directory at its real path and removes it with a retry for Windows ([fs ADR 0006](../../packages/fs/docs/adr/0006-a-temporary-directory-retries-its-removal-and-gives-its-real-path.md)). It was the `./fs` area of `@zukhruf/testing`, and the rule `zukhruf/no-raw-temp-directory` reported a raw temporary directory in test files only.

On 2026-11-16 a count over the repositories gave about 2,440 places that make a temporary directory. About 2,230 test places used `TemporaryFiles`. The 26 places in production code, in 7 repositories, made the directory by hand in three ways: `mkdtempDisposable`, `mkdtemp` with an `rm` in `finally`, and a folder that a class removes later. Production code cannot import a package of the tool layer, so `TemporaryFiles` was out of its reach. Node's own `mkdtempDisposable` removes with `maxRetries: 0` and gives the path as written. `git-hooks` resolved the real path of its snapshot folder by hand. The owner said: "it exists everywhere, not just in the proactive app, literally everywhere."

## Decision

`TemporaryFiles` is in `@zukhruf/fs`, and every file uses it: the rule `zukhruf/no-raw-temp-directory` is in the base config. The owner chose "Move to @zukhruf/fs" and "Add directorySync" on 2026-11-16.

- `@zukhruf/testing` has no `./fs` area and depends on `@zukhruf/fs`. Each importer imports `@zukhruf/fs`. No alias stays.
- `directorySync(prefix, { parent })` gives a `Disposable` for code that cannot wait, such as the synchronous `Symbol.dispose` of the owner copy of `@zukhruf/sqlite-snapshot`. Node has both forms too: `mkdtempDisposable` and `mkdtempDisposableSync`.
- `@zukhruf/fs` depends on `async` and `sqlite-open`, so their tests cannot import it ([ADR 0001](./0001-zukhruf-is-a-layered-standard-library.md)). The rule is off for these two packages, and `sqlite-open` keeps a copy (its `docs/copied-code.md`). Docker had a copy for the same reason with `@zukhruf/testing`; it uses `@zukhruf/fs` now.

## Considered Options

- **Keep `TemporaryFiles` for tests only.** Go keeps its retrying removal in `testing` (`t.TempDir`), and Go production code uses `os.MkdirTemp`. But production code here gives the folder to child processes (git, Codex, ffmpeg), which hold files open as the tests' child processes do.
- **Node's `mkdtempDisposable` in production, with a rule against a hand-written `rm`.** No new dependency, but no real path and no retry.
- **Only the asynchronous form.** The public `Snapshot` of `@zukhruf/sqlite-snapshot` would dispose asynchronously, and each of its consumers would change for a temporary folder.

## Consequences

- A consumer of `@zukhruf/testing/fs` changes its import to `@zukhruf/fs` and lists `@zukhruf/fs` as a dependency.
- A consumer of `@zukhruf/eslint` gets the rule in production files too, and replaces each raw temporary directory there.
- The recorded SSH-forward folder of `@zukhruf/testing` is below the real path of `/tmp`. The cleanup accepts a record whose parent has the real path of `/tmp`.
