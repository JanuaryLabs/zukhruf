# The content is bytes, and the caller sets the file mode of the draft

`atomicWrite` and `durableWrite` took only a string, and they had no file mode. No decision gave a reason for this. [ADR 0001](./0001-the-writes-through-a-draft-are-one-package.md) records only that the four first callers wrote strings from async code. The limits stayed from those callers.

Other callers write bytes or need a file that only its owner can read. They wrote their own replacement in one step:

- The `SecureStore` of text2sql writes a `Buffer` with mode `0o600`. Its draft has the name `${path}.${pid}.tmp`. Two writes of one path in one process fill the same draft, so one write can fail or put the content of the other at the path (backlog #2427). The draft of this package has a random name, so two writers stay apart.
- Two spreadsheet stores of text2sql write a `Uint8Array`.
- The grant files of elt and four state files of theagentlab write with mode `0o600`.

## Decision

The content is `string | Uint8Array`. A `Buffer` is a `Uint8Array`. These are the types that `writeFile` and `FileHandle.writeFile` take, so the package passes the content on with no change.

The caller can give `{ mode }`. The write sets the mode when it creates the draft: `writeFile(draft, content, { mode })` for `atomicWrite`, and `open(draft, 'wx', mode)` for `durableWrite`. A rename keeps the mode of the draft. Thus the file at the path has the mode from the first moment that a reader can find it.

When the caller gives no mode, the write does the same as before: the file gets the mode that `writeFile` gives a new file. The package does not choose a default mode. The mode of the file that the write replaces does not stay, as before.

## Considered Options

- **Set the mode with `chmod` after the rename.** Between the rename and the `chmod`, the new content is at the path with the mode from the umask. Another user can open the file in that time, and an open file stays readable after the `chmod`. Rejected.
- **Bytes and a mode on the draft.** This option was selected.
- **A sync variant, for example `atomicWriteSync`.** The theagentlab callers write from sync code today. Each of them can become async, and no caller has a real need for a sync write. Rejected.
- **A write that replaces a path with a draft that another writer fills, for example a stream or a child process.** Three callers do this (two in text2sql, one in elt). It is a different function with its own questions. Deferred to a talk with the owner of the package.
- **A mode for `createExclusive`.** No caller needs it now. Not part of this decision.

## Consequences

- The callers above can replace their own drafts with `atomicWrite` or `durableWrite`, after a release.
- A test shows that the draft has the mode before the rename. A `chmod` after the rename fails that test.
- On Windows, Node.js uses only the write bit of a mode. The mode test runs only on POSIX systems.
