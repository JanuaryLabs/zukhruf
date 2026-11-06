# SQLite open

Programs keep their data in SQLite databases. One program writes a database, and other programs read it, sometimes while the first program runs. This package opens every connection to such a database: the connection of the program that writes it, and the connections of the programs that read it. It sets the journal of a writing connection, waits out the locks of other connections, and names the failures that the caller can fix.

## Language

**Owner**:
The program that owns a database and writes it. `open(path)` opens its connection. The owner keeps the file, and sets its journal.
_Avoid_: App, store, writer

**Reader**:
A read-only connection to the database of an owner. `open(path, { readOnly: true })` opens it. A reader never writes to the database, and never changes its journal. The SQLite documentation uses this word for a connection that reads ("Write-Ahead Logging").
_Avoid_: Client, consumer, handle

**Journal**:
How SQLite keeps a commit safe when the program stops during the commit. The owner selects it with the `journal` option of `open`. Each journal is a strategy object, an instance of `WriteAheadLog`, `PersistentWriteAheadLog`, `RollbackJournal` or `UnchangedJournal`.
_Avoid_: Journal mode (SQLite's name for the setting, not for the strategy), mode

**Write-ahead log**:
A journal where SQLite adds each commit to the `-wal` file, and keeps an index of that file in the `-shm` file. Readers do not wait for the owner, and the owner does not wait for readers. SQLite deletes the two files when the last connection closes. `WriteAheadLog` is the default journal of an owner.
_Avoid_: WAL mode, log

**Persistent WAL**:
A write-ahead log whose `-wal` and `-shm` files stay after the last connection closes. A reader that cannot write the folder of the database cannot make these files, so it needs them to stay. `PersistentWriteAheadLog` selects it.
_Avoid_: Shared WAL, kept WAL

**Rollback journal**:
A journal where SQLite copies each page to the `-journal` file before a commit changes it. A commit waits until the readers stop. `RollbackJournal` selects it.
_Avoid_: Delete mode, legacy journal

**Hot journal**:
A rollback journal that an owner left when it stopped during a commit. The next connection that can write rolls it back. A reader cannot roll it back.
_Avoid_: Stale journal, crash journal

**Native library**:
The library `persist_wal` that turns on persistent WAL. SQLite loads it into the connection, because `node:sqlite` has no other way to set this file control. The package has one library for each platform.
_Avoid_: Addon (a Node addon is a different thing), plugin, extension (alone)

**Busy timeout**:
How long a connection waits for the lock of another connection before it fails with `SQLITE_BUSY` (5). The `timeout` option sets it. The default is 5000 milliseconds.
_Avoid_: Lock timeout, wait

**Unavailable**:
The file of the database is missing, or the system denies access to it. SQLite then gives `SQLITE_CANTOPEN` (14), or `SQLITE_READONLY_DIRECTORY` (1544) when the folder denies the write of a journal, and the file system gives `ENOENT`, `ENOTDIR`, `EACCES` or `EPERM`. The package then throws `UnavailableError`. The caller can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error
