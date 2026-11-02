# A file stamp is the stat data that git compares

The source development kits of elt watch the stores of Mac apps. Each one asks the same question: did the file change since the last read? Five of them wrote their own answer, and Mail wrote a sixth for a different use:

- `safari-version.ts` and `books-version.ts` keep `ino:size:mtimeMs`. The two copies are the same, line for line.
- `clock-store.ts` keeps `ino:size:mtimeNs`.
- `teams-store.ts` and `slack-desktop-store.ts` keep `name:size:mtimeMs` for each file of a store. They also give the newest `mtimeMs` as the last write.
- `mail-files.ts` keeps `dev:ino:size:mtimeNs:ctimeNs`. It compares the stamp before and after a read, to know that the file did not change during the read.

A Chromium reader of History needed the same stamp two more times: once for the change signal, and once to check its copy of a locked database ([sqlite-snapshot ADR 0003](../../../sqlite/snapshot/docs/adr/0003-an-exclusive-owner-is-read-from-a-checked-copy.md)). That is more than three places, so the code moves into one home ([root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 2).

The copies did not agree on the parts. A stamp of `size` and `mtimeMs` misses two writes:

- A writer that gives back the old write time, as `rsync -t` and `tar` do. The size and the write time stay the same.
- Two writes in one millisecond. Git calls this the racy-git problem: a file that changes in the same tick as the stamp looks clean.

## Decision

A file stamp holds the device, the inode, the size, the write time and the change time of the file, with each time to the nanosecond. These are the fields that git compares in `ie_match_stat`. The kernel sets the change time on each write and on each change of the metadata, and a writer cannot set it. Thus a writer that gives back the old write time still changes the stamp.

A missing file (`ENOENT`, `ENOTDIR`) has a stamp of its own, so its return is a change. Each other error of `stat` reaches the caller. A folder that the process may not search is not a missing file: a watcher that took it for a missing file would report the store as deleted.

`FileStamps` holds the stamps of several files. Its `modifiedAt` is the newest write of the files that are present, as Teams and Slack computed it.

Both forms read with `read` or with `readSync`, as Node.js gives `stat` and `statSync`. `@zukhruf/sqlite-data-version` reads in a synchronous getter.

## Considered Options

- **`file-entry-cache`** (196 million downloads each week, release 2026-06). It keeps the size and the write time in milliseconds, with no inode and no change time. It compares a file with a cache that it saves to disk, and it gives no value to compare. It misses both writes above.
- **`@nodelib/fs.stat`.** It wraps `stat`, and it follows symbolic links. It makes no stamp.
- **`chokidar` and `fb-watchman`.** They watch with file-change events. A watcher still needs a stamp to know if an event changed the file, and an event can come late.
- **A hash of the content.** It reads the whole file on each check. A History file of Chromium is 23 MB.
- **The stat data of git.** This option was selected.

## Consequences

- The five copies in elt and the check of Mail move to `FileStamp` and `FileStamps`, and delete their own code.
- A stamp of the same file changes after `chmod` or a new hard link, because the change time changes. The caller then reads the file one more time and finds no change. That costs one read.
- Windows gives a file index as the inode and the change time of NTFS, so the stamp works there too. The tests that need a mode on a folder skip on Windows.
