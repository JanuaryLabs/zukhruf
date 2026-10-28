# A replaced file is followed by name

`DataVersion` keeps one read-only connection to the database of the owner. A connection reads the file that it opened, not the path. The owner can replace the file at the path: it can rename a new file over the path, or delete the file, its WAL and its shared-memory index and create them again. Then the connection reads the old file, which has no name now. The data version of the old file never changes again, so a caller that polls `current` sees no more commits.

This occurred. On 2026-10-15, while the machine ran, WhatsApp deleted `ChatStorage.sqlite` and all its other stores, and created them again. A probe showed the effect: a reader stayed at data version 3 and saw 2 rows, and a new connection saw 5 rows. A probe in C on the system `libsqlite3` showed the same, so the cause is the connection, not `node:sqlite`.

## Decision

`DataVersion` follows the path by name, as GNU `tail -F` does.

- `FollowedDatabase` holds the connection and the identity of its file: the device and inode from `stat`. It reads the identity as a bigint, because inode numbers on NTFS and ReFS are larger than 2^53.
- Each read of `current` reads the status of the path. When the path names a file with a different identity, `FollowedDatabase` opens the new file. Then it closes the old file.
- It opens the new file first. While the old file is open, the system cannot give its inode to a new file. A probe on Linux overlayfs gave the inode of a closed file to the next file 200 times in 200. With the old file open, it did so 0 times in 200.
- It reads the status before it opens the file. If the owner replaces the file between the two, the next read of `current` gives one extra change. In the other order, the old connection can get the identity of the new file, and then `DataVersion` never sees the replaced file.
- A path that this process cannot see is no change: the path is missing, or the mode of a folder denies this process. The owner deletes the file and then creates it again, and `DataVersion` keeps the old connection until the file comes back. The open connection still reads, so a denied folder does not stop a poll. In `new DataVersion`, the open of SQLite then fails with `SQLITE_CANTOPEN`, and the caller gets its unavailable error, as before.
- `DataVersion` gives its own number. It adds one each time the identity or the data version of the held file changes. The data version of a new connection starts again at 1 or 2, so it can be equal to a value from the old connection. The number of `DataVersion` only goes up, so a caller can compare values from before and after a replaced file.

`current` stays a `number`. The 14 consumers in elt need no change.

## Considered Options

- **Give an opaque string, as the `resourceVersion` of Kubernetes.** It changes the type for the 14 consumers, and it gives them nothing more.
- **Add an offset to `PRAGMA data_version` at each new connection.** This needs a data version that only goes up. SQLite promises only that the value is different.
- **Open the file again at each poll.** Each poll then opens a connection and reads the schema. It still needs the number of `DataVersion`, because each new connection starts again.
- **Watch the folder with file-change events.** The events are different on each platform, and the order of an event and a poll is not fixed.
- **Identify the file by its content, as the fingerprint of Filebeat.** The first bytes of SQLite files are almost the same, so the content does not identify the file.
- **Follow the path by its device and inode.** This option was selected.

## Consequences

- A caller sees a replaced file at the next poll, and each later commit to the new file.
- Each poll reads the status of the path one time.
- A read of the status that fails for a cause other than a missing path or a denied folder gives the error of the file system.
- A file that the owner creates between the status read and the open of `new DataVersion` gives one extra change at the first poll.
