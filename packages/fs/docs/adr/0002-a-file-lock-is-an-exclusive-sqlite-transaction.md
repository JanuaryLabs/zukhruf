# A file lock is an exclusive SQLite transaction

Some packages need a lock that the kernel frees when its holder dies. A lock that stays after its holder dies blocks every other process until somebody deletes it by hand. Node.js has no `flock` and no `fcntl` lock. Thus each of these packages held an exclusive SQLite transaction on a file, and took the SQLite result code `SQLITE_BUSY` to mean "another process holds it". Five places did this:

- `SqliteStore` of `@zukhruf/mutex` holds the lock of a key.
- The reclaim lock of `@zukhruf/mutex` lets one waiter at a time evict a dead holder.
- The presence of `@zukhruf/mutex` tells a waiter that a caller still runs.
- `SqliteElection` of `@zukhruf/election` holds the claim of a leader.
- The election copy of `@zukhruf/single-flight` holds the claim of a coordinator.

The copies already went apart. Two of them kept the journal in memory, and the others kept the default journal on the disk. One of them kept its connections from garbage collection, and the others did not. Each package had its own copy of the checks of the SQLite result codes. This project follows the Rule of Three: the count is the number of places, and five is more than three (backlog #2517). Thus the lock is one class in this package, `FileLock`, and the copies use it.

`FileLock` has the shape of the file locks of other platforms: Rust's `File::try_lock` and `File::unlock` (stable since Rust 1.89), Java NIO's `FileChannel.tryLock` and `FileLock`, Deno's `FsFile.lock` and `FsFile.unlock`, and POSIX `flock` with `LOCK_EX | LOCK_NB`:

- `FileLock.open(path)` opens the file and takes no lock.
- `tryLock()` takes the lock, or returns `false` at once.
- `unlock()` lets the lock go, and the handle stays open.
- A disposal closes the handle, and a held lock goes with it.

There is no `lock()` that waits. SQLite waits with a busy timeout, and a busy timeout blocks the event loop of Node.js while it waits. Node.js uses no busy timeout unless the caller sets one, so `FileLock` sets none. A caller that must wait tries again after a pause. Then it chooses its own interval and stops on its own `AbortSignal`, as the mutex and the election do.

`FileLock.check(path)` tells if a handle holds the lock now, and never creates the file. The presence of the mutex needs it: a waiter checks the presence of another caller and must not take its lock. The name is partly coined. Rust has no query for a lock. The nearest are POSIX `lockf` with `F_TEST` and `fcntl` with `F_GETLK`. Unlike them, `check` holds a shared lock for its one read, so a `tryLock()` at that moment can return `false`.

These rules come from the copies:

- The journal is always in memory (`PRAGMA journal_mode = MEMORY`), as the reclaim lock chose in commit 847ab2f. A journal on the disk stays after a holder that dies. The locks of the memory journal are the same as the locks of the default journal. Only WAL mode is different: in WAL mode, an exclusive transaction does not stop readers. Thus a `FileLock` and an exclusive transaction of a published version, with the default journal, exclude each other.
- A file with other content makes `tryLock()` throw (`SQLITE_NOTADB`). A refusal would make a caller wait for a holder that never comes.
- A connection that holds the lock is kept in a module-level set until it lets the lock go. Garbage collection closes a connection that nothing refers to, and SQLite then lets the lock go. A test shows this on Node.js 26: without the set, a lock of a handle that nothing refers to stops at the next garbage collection.
- `check` opens the file read-only. When SQLite cannot open the file and no file is at the path, the result is `'missing'`. A file that is present but cannot be opened is a fault, and `check` throws.

## Considered Options

- **A native addon, for example `fs-ext` or `os-lock`.** It gives `flock` or `fcntl` directly. But it needs a compiler or a prebuilt binary for each platform, and this package has no dependencies.
- **`proper-lockfile`.** It makes a directory as the lock, and the holder refreshes its modification time. A lock of a dead holder stays until it is stale, 10 seconds by default. A living holder that cannot refresh in time looks stale, and a second process takes its lock.
- **A directory, a link, or a file made with `O_EXCL`.** The kernel does not remove them when the holder dies. `createExclusive` of this package is such a file, and it is not a lock that the kernel frees.
- **A parameter for the journal mode.** No caller needs another journal mode, and WAL mode would break the lock. Thus there is no parameter.
- **An exclusive SQLite transaction in one class.** `node:sqlite` is part of Node.js, and SQLite locks the file through the kernel: POSIX record locks on Unix, `LockFileEx` on Windows. This option was selected.

## Consequences

- `@zukhruf/fs` imports `node:sqlite`.
- New versions make no `<path>-journal` file beside a file lock. Published versions still make one while they hold a lock, and it stays when they die. The next `tryLock()` deletes it.
- The checks of the SQLite result codes are private to `FileLock`.
- On Unix, closing any other descriptor of the file in the process drops the lock without an error. Thus the file is opened only through `FileLock`.
- A network file system does not share the lock reliably between machines. `assertLocalDirectory` refuses such a directory.
