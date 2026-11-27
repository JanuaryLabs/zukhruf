# A temporary directory writes the files of a record, and a path is valid as Go's fs.ValidPath says

Status: Accepted 2026-11-27 (backlog #6079).

Decision-makers: Ezz, on 2026-11-27. Asked where a temporary folder made from a file tree lives, he chose "Fits @zukhruf/fs" over adopting fs-fixture and over a new package. Asked what a path that leaves the folder throws, he chose "TypeError ERR_INVALID_ARG_VALUE".

A test that needs files on disk makes an empty directory with `TemporaryFiles` and then writes its files with a loop of its own. A sweep of the test files of the active repositories on 2026-11-27 found this in 84 files of 8 repositories: `fixtureWorkspace` of `@zukhruf/eslint` and its copy in `tools/eslint-rules`, `workspace()` of `@zukhruf/nx`, three tests of mteb, the repository builders of git-hooks (#4509), and `writeFiles` of sdk-it, among others. The knowledge that the folder needs, its real path and its retried removal on Windows ([ADR 0006](./0006-a-temporary-directory-retries-its-removal-and-gives-its-real-path.md)), is already in `TemporaryFiles`.

## The leaders

| Leader            | A tree on disk                                                                                 | A path that leaves the folder                                                                                                   | Link                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Go                | `os.CopyFS(dir, fsys)` writes an `fs.FS`, for example a `testing/fstest.MapFS` of path to file | `fs.ValidPath` refuses an empty, `.` or `..` element and a rooted path; on Windows `filepath.Localize` also refuses `\` and `:` | https://pkg.go.dev/os#CopyFS, https://pkg.go.dev/io/fs#ValidPath |
| memfs             | `vol.fromJSON({ 'path/a.txt': '...' })`, a flat record                                         | resolved against the root                                                                                                       | https://github.com/streamich/memfs                               |
| fs-fixture 2.16.2 | `createFixture(tree)`, nested objects, symbolic links, functions                               | joined with the folder                                                                                                          | read 2026-11-27 (`dist/index.mjs`)                               |
| Node.js           | none; an invalid argument is a `TypeError` with the code `ERR_INVALID_ARG_VALUE`               | —                                                                                                                               | https://nodejs.org/api/errors.html#err_invalid_arg_value         |

## Decision

- `directory(prefix, { parent, files })` and `directorySync(prefix, { parent, files })` write `files` into the new directory before the acquisition resolves. `files` is a flat record of a relative path, with `/` between its folders, to its content, a string or a `Uint8Array`, as memfs and `fstest.MapFS` take a tree.
- A path is valid as `fs.ValidPath` of Go says: relative, with no empty, `.` or `..` element. On Windows a `\` or a `:` is refused too, as `filepath.Localize` of Go does. A refused path rejects, or throws for `directorySync`, a `TypeError` with the code `ERR_INVALID_ARG_VALUE` that names the path. The check runs before the directory is made, so nothing is left, also not in `parent`.
- A write that fails removes the directory through the same removal as disposal, with its retries, and the acquisition rejects with the error of the write.
- The record holds files. A folder is made for each file. An empty folder and a symbolic link are not in the record, as `os.CopyFS` does not copy a symbolic link.

## Considered Options

- **Adopt fs-fixture 2.16.2.** It gives the real path, and its disposal has no retry on Windows. It makes its own folder outside `TemporaryFiles`, so each call site would pass a removal with retries and a parent through its `fs` option: a wrapper again.
- **A new package beside `@zukhruf/fs`.** About fifteen lines on a concept that this package owns.
- **A nested object, as fs-fixture takes.** A flat record has one key for each file, as memfs and `fstest.MapFS` have, and no key can be a file and a folder at once.
- **Resolve each path and refuse only one that leaves the folder.** Then `a/../b` and `./a` are valid, and two keys can name one file. `fs.ValidPath` refuses both.
- **The files of a record, valid as `fs.ValidPath` says, in `TemporaryFiles`.** This option was selected.

## Consequences

- The copies move to `files` after the release: the 12 places in zukhruf (backlog #6079), the repository builders of git-hooks (#4509), and sdk-it's `writeFiles`.
- A symbolic link and an empty folder are later on the map, when a test needs one.

## Confirmation

- `src/temporary-files.files.test.ts`: the files with their content and their folders, bytes, a failed write that leaves nothing, each refused path with nothing made, the sync form, an empty record, and the removal of a written tree. The files go under the real path, which `src/temporary-files.test.ts` proves for a parent that is a symbolic link, in both forms. The Windows refusal runs only on Windows (backlog #6161 has the Windows proof of `@zukhruf/process`; this package has no Windows runner either).
