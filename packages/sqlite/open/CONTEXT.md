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

**Synchronous**:
When SQLite syncs the `-wal` file of a write-ahead log to the disk. `'normal'`, the default, syncs before each WAL checkpoint: a power loss can roll back the commits after the last WAL checkpoint. `'full'` syncs at each commit: a commit survives a power loss. The `synchronous` option of `WriteAheadLog` and `PersistentWriteAheadLog` sets it. SQLite uses the same word ("PRAGMA synchronous").
_Avoid_: Durability mode, fsync mode, sync level

**Page size**:
The size of each page of a database file, in bytes: a power of two from 512 to 65536 (`PageSize`). The `pageSize` option of `WriteAheadLog` and `PersistentWriteAheadLog` sets it for a new file, just before the write-ahead log step, because SQLite sets it only before the first write of a file and never in a write-ahead log. An existing file keeps its own page size. SQLite uses the same word ("PRAGMA page_size", [pragma.html](https://www.sqlite.org/pragma.html#pragma_page_size)).
_Avoid_: Block size

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

**Result code**:
The number that SQLite gives with an error, in two parts. The primary code is the low byte, the same for each variant (`SQLITE_BUSY`, 5). The extended code is the full number, and names the variant (`SQLITE_CONSTRAINT_NOTNULL`, 1299). `sqliteResultCode(error)` gives the two parts as `code` and `extendedCode`, the names of go-sqlite3. SQLite uses the same words ([Result and Error Codes](https://www.sqlite.org/rescode.html)).
_Avoid_: Error code, errcode (the field of `node:sqlite` that holds only the extended code)

**Unavailable**:
The file of the database is missing, or the system denies access to it. SQLite then gives `SQLITE_CANTOPEN` (14), or `SQLITE_READONLY_DIRECTORY` (1544) when the folder denies the write of a journal, and the file system gives `ENOENT`, `ENOTDIR`, `EACCES` or `EPERM`. The package then throws `UnavailableError`. The caller can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error

**Missing**:
An unavailable file that is not there, or that has a folder on its path that is not there. The file system gives `ENOENT` or `ENOTDIR`. The package then throws `MissingError`, a subclass of `UnavailableError`. The caller can check the path, or make the database.
_Avoid_: Not found, absent

**Denied**:
An unavailable file that the system keeps from this process: a file mode, a sandbox or a privacy rule. The file system gives `EACCES` or `EPERM`. The package then throws `DeniedError`, a subclass of `UnavailableError`. A path in a folder that the system denies is denied too, with a file there or not. The caller can give the process access.
_Avoid_: Permission error, forbidden
