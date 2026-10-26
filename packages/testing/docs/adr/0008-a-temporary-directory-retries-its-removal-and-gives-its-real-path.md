# A temporary directory retries its removal and gives its real path

Tests create a temporary directory at about 837 places, and every place gives a prefix. Node's `mkdtempDisposable` removes the directory with `maxRetries: 0` (Node 26.10 source). On Windows, a file that another process still holds open makes the removal fail with "Access is denied" for a short time. Go's `testing.T.TempDir` retries that removal for at most 2 s ([go.dev/issue/50051](https://go.dev/issue/50051)). Thus `TemporaryFiles.directory(prefix, { parent })` removes the directory with `rm` (`recursive`, `force`) and Node's retry: `maxRetries: 8`, `retryDelay: 50`. On `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY` or `EPERM`, Node waits `retryDelay` ms longer before each retry. The waits are 50 × (1 + 2 + … + 8) = 50 × 36 = 1,800 ms, near Go's 2 s. The first retry comes after 50 ms, so a short hold costs little. A removal that does not fail does not wait. On macOS, `os.tmpdir()` is below `/var`, a link to `/private/var`, and git, child processes and microsandbox bind mounts give the resolved path. About 27 consumer places, 7 in git-hooks and 2 in zukhruf resolve the path themselves, and no place needs the unresolved path. Thus `path` is the real path, as in [tempy](https://github.com/sindresorhus/tempy). `prefix` is required. `parent` defaults to `os.tmpdir()`.

## Considered Options

- **Node's `mkdtempDisposable`.** It does not retry the removal. On Windows a held file makes the disposal fail.
- **The retry values of [Node core `test/common/tmpdir.js`](https://github.com/nodejs/node/blob/main/test/common/tmpdir.js).** `maxRetries: 3` with the default `retryDelay: 100` waits 600 ms at most, a third of Go's budget.
- **The retry values of tempy.** `maxRetries: 10` with `retryDelay: 100` waits 5.5 s at most. A test that fails for a different reason then waits longer to report it.
- **The unresolved path.** About 36 places resolve it again, and no place needs it.
- **A synchronous form.** 62 places use `mkdtempSync`, and an async test serves each of them. No place in any repository uses a synchronous `using` for a directory.
- **A `files` map that writes files at the acquisition.** About 152 places write files after the acquisition. That is how a test writes a file, not knowledge of the package.
- **Keep the directory when the test fails.** No place does this.
- **Change the working directory to the directory.** 8 places in 1 repository do this.

## Consequences

- A `parent` gives a short directory, such as `/tmp`, for a Unix socket: a socket path has a limit of 104 bytes on macOS. 64 places in cc and 4 in text2sql need it.
- A `parent` in a repository lets a file in the directory import the repository's packages. 5 places in sdk-it need it.
- When the last retry fails, disposal rejects with the error.
- `Sqlite.database()` uses `mkdtempDisposable` without a retry. It moves to `TemporaryFiles` in the code step.
- The `docker` area tests never import this package, so docker's own scratch directory stays a recorded copy.
