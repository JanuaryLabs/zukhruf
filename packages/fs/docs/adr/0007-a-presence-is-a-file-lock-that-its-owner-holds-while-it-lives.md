# A presence is a file lock that its owner holds while it lives

Status: Accepted 2026-11-24 (#5424, #5463). Ezz chose "Accept with your choices" for this API, named after FreeBSD `pidfile(3)` and APUE section 13.5, and for the four decisions at the end of this record. The same day he deferred the extraction ("I would avoid any kind of extraction right now, okay? Keep the copy and file it for later."). After the research of its home (below), he gave the go: "Go, into @zukhruf/fs". A probe then showed that a deleter which meets a check leaves the file. Ezz said: "step back and follow top performers. recall out rules and princples". Thus `removeIfEnded` went from Considered Options to the Decision (see "A deleter and a check"). Built 2026-11-24 (#5463).

A **presence** tells other processes that its owner still runs. The owner holds a `FileLock` on a file of its own for as long as it lives. Another process asks `FileLock.check`: `'locked'` means that the owner runs, `'unlocked'` means that it stopped. The kernel frees the lock when the owner stops, however it stops. Thus a frozen owner stays present, and a killed owner is gone at once. A process id cannot tell this: a process id is used again, and a zombie process still answers `kill(pid, 0)` (mutex [ADR 0012](../../../mutex/docs/adr/0012-a-file-store-holder-is-judged-by-its-presence.md); sqlite-notify ADR 0010, research 20j S3).

These places held this knowledge before #5463 (the line numbers are of that time). The count is by places, as the Rule of Three asks:

1. `@zukhruf/mutex`, `Presence` (`src/lock-stores/file-system/presence.ts`): `claim` at lines 35-46, `judge` at lines 54-67, `delete` at lines 83-92, `releaseAfter` and `withdraw` at lines 111-126. `LockFileStore`, `TicketQueueFileStore` and `HolderRecord` of `SqliteStore` use it. Mutex ADR 0012.
2. `@zukhruf/mutex`, `SessionDirectory` and `SessionRecord` (`src/lock-stores/socket/session-directory.ts`): `endIfStopped` at lines 84-90, `#takePresence` at lines 105-117, `#deleteIfFree` at lines 172-180, `unlinkRefused` at lines 184-193, the disposal at lines 224-231. Mutex [ADR 0033](../../../mutex/docs/adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md). The mutex copy ledger records places 1 and 2 as "A presence that outlasts its record".
3. `@zukhruf/git-hooks`, the lease of an install (`src/snapshot/installs.ts`): `leaseInstall` at lines 35-44, `isLeased` at lines 218-232 (071409aa, 2026-11-16). The copy ledger of the mutex does not list it, because it is in another package.
4. `@zukhruf/sqlite-notify`, the presence of a listener, which backlog #5424 decided on 2026-11-24 ("A FileLock presence (Recommended)"). A sender that meets `ECONNREFUSED` on macOS cannot tell a dead listener from a live listener with a full listen queue (`queue.test.ts`, "a full listen queue", 35136e9a). The sender removes the listener only when its presence ended.

Four places is more than three. Thus the knowledge moves into one class, as `FileLock` did at five places ([ADR 0002](./0002-a-file-lock-is-an-exclusive-sqlite-transaction.md)).

These uses of `FileLock` are not presences, and the count does not include them. Each one is a lock that many processes try to take on one shared file. No process owns the file, and no process deletes it:

- `KeyLocks` of `@zukhruf/single-flight` (`src/key-lock/key-locks.ts`, lines 35-76). It asks `FileLock.check` too, but the question is "does somebody hold key K", not "does owner X run".
- The claim of `SqliteElection` (`packages/election/src/sqlite/sqlite-election.ts`, line 123), the key lock of `SqliteStore` (`packages/mutex/src/lock-stores/sqlite/sqlite-store.ts`, lines 44 and 53), the reclaim lock (`packages/mutex/src/lock-stores/file-system/file-lock-store.ts`, line 105), the download lock (`packages/vector-decisions/src/model-bundle/download-head.ts`, line 49) and the build lock (`packages/git-hooks/src/snapshot/snapshots.ts`, line 279).

No other repository of the owner uses `FileLock`, `proper-lockfile` or `flock` (a `git grep` in each git repository below `~/Desktop`, 2026-11-24).

## What the places share and where they differ

The same in each place:

- Each owner has a file of its own: a new random id is in the name. No second owner ever opens that path.
- The owner takes the lock before its record appears, and it frees the lock only after its record is gone. A record whose presence ended thus belongs to an owner that stopped.
- A reader asks `FileLock.check`. `'locked'` means that the owner runs.
- When the owner opens its own new file and finds it locked, another program opened it. Places 1 and 3 throw.

The differences:

| Part                                | mutex `Presence`                                                    | mutex `SessionDirectory`                                                  | git-hooks lease                                                        | sqlite-notify listener (planned)                                   |
| ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The record                          | a lock file, a ticket, a holder record                              | `sessions/<id>.json`                                                      | none: the snapshot that links the install                              | the row in `zukhruf_notify_listener`                               |
| A missing presence file             | a fault while the record names the caller; else the caller moved on | the session stopped                                                       | no lease                                                               | the listener is from an older release: it counts as dead, as today |
| Who deletes another owner's file    | the waiter that removed the record, under the reclaim lock          | a new leader, also for a presence with no record                          | the prune deletes the whole install folder, under the lock of installs | the sender that removes the listener's rows                        |
| How it deletes another owner's file | `unlink` with no lock of its own                                    | under its own lock of the file (`#deleteIfFree`)                          | `rm -r` of the folder                                                  | not decided                                                        |
| How the owner deletes its own file  | it frees the lock, then deletes the file                            | it frees the lock, then deletes the file                                  | it deletes the file, then frees the lock                               | not decided                                                        |
| The open of its own file            | one try; a lock that it does not get throws                         | it tries again until it holds the lock and the path still names that file | one try; a lock that it does not get throws                            | not decided                                                        |

The rows "A missing presence file" and "Who deletes" are the domain of each consumer. They stay with the consumer. The rows "How it deletes" and "The open" are the same knowledge in four forms. Only the form of `SessionDirectory` is correct in every case:

- A deleter that frees the lock before it deletes the file lets a new owner lock the file in that moment. The deleter then deletes a file that a live owner holds. That owner holds a lock on a file that no reader can find, so it looks gone (the comment of `#deleteIfFree`, `session-directory.ts` lines 165-171). Places 1 and 3 are safe only because no owner ever opens a path that another process deletes.
- On Windows, the delete of a file that a handle keeps open is refused (`EPERM` or `EBUSY`). Thus a deleter on Windows must free the lock first. A refusal after that means that another handle opened the file. Place 3 deletes its file while it holds the lock, so on Windows its delete fails.

After this paper, #5462 gave place 3 the order of `SessionDirectory` (`endLease`, `unlinkRefused`), and #5424 built place 4 as a copy of it: `ListenerPresence` (`src/listener-presence.ts`) deletes another owner's file under its own lock, the owner deletes its own file while it holds the lock, and its open has one try.

## Decision

`@zukhruf/fs` exports the class `Presence` beside `FileLock`. It is the `FileLock` of one owner. The consumers keep their records, their names of files and their rule for a missing file.

```ts
type Clock = import('@zukhruf/async').Clock;

class Presence implements Disposable {
  /** The file of the presence. */
  readonly path: string;

  /**
   * Opens the file at `path`, creates it when it is absent, and takes its lock.
   * Returns `undefined` at once when another handle holds the lock: another
   * owner, a deleter, or a check for a moment. When the lock is on a file that
   * a deleter removed from the path meanwhile, it opens the new file and tries
   * again.
   */
  static tryOpen(path: string): Presence | undefined;

  /**
   * Whether the owner of the presence at `path` still runs. It reads the file
   * one time, never creates it, and never takes the lock. The answer can be old
   * when you use it.
   */
  static check(path: string): 'present' | 'ended' | 'missing';

  /**
   * Deletes the file of a presence that ended, while it holds its lock, and
   * never creates the file. When another handle holds the lock, `check` tells
   * why: `'present'` is an owner or another deleter, and `'ended'` is a check
   * for a moment, which it waits out on `clock` for at most 1 second.
   */
  static removeIfEnded(
    path: string,
    options: { clock: Clock },
  ): Promise<'removed' | 'present' | 'missing'>;

  /**
   * Ends the presence and deletes its file. On Unix it deletes the file while it
   * holds the lock, then frees the lock. On Windows it frees the lock first, then
   * deletes the file; a refusal while another handle holds the lock leaves the
   * file to that handle, and a refusal for a moment is tried again on `clock`
   * for at most 1 second (`patiently`).
   */
  remove(options: { clock: Clock }): Promise<void>;

  /** Ends the presence and keeps the file. A second disposal does nothing. */
  [Symbol.dispose](): void;
}
```

The deleter of another owner's file calls `removeIfEnded`. It deletes only while it holds the lock itself, as `remove` does:

```ts
const result = await Presence.removeIfEnded(path, { clock });
// 'removed', or 'present': the owner still runs, or 'missing'
```

### A deleter and a check

`Presence.check` reads the file, and for that read SQLite takes a shared lock for a moment. It cannot do less: node:sqlite has no `F_GETLK` (only the VFS of SQLite asks it), and `node:fs` has no `flock`. A deleter that tries the lock at that moment is refused, the same as for a live owner. The first design used `tryOpen` and `remove` for the deleter. A probe of 600 trials, in which an owner had stopped and two other processes checked its file again and again, left the file in 100 trials. A deleter that met a check also created the file again with its open, and a second deleter then removed it a second time.

What the leaders do:

| Leader                                | What it does                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FreeBSD `pidfile(3)`                  | One name for each daemon. A file that stays is opened again by the next daemon. No other process deletes it.                                                            |
| Python `filelock`, issue #31          | It keeps the lock file, because a delete races with the next open. Go `lockedfile`, Rust `fslock` and `fd-lock` keep it too.                                            |
| .NET 9 `FileOptions.DeleteOnClose`    | On Unix it deletes the file while it holds the lock, then closes it (`SafeFileHandle.Unix.cs` lines 132-141 and 373-397), as `remove` does.                             |
| SQLite, the recovery of a hot journal | It takes SHARED, then EXCLUSIVE, with no busy handler. On contention it stops, and the next reader finds the journal again and tries again (`pager.c` lines 5276-5291). |

The names of the presences are unique, so no next owner opens a file that stays. Thus a deleter must not leave it. `removeIfEnded` does what SQLite does, and asks why it was refused: it tries the lock first (EAFP), and catches only `SQLITE_BUSY`. Then `check` tells the cause. `'present'` means that an owner or another deleter holds the lock. `'missing'` means that the file is gone. `'ended'` means that a check held the file for a moment, so it tries again on `clock`, within the 1 second of `patiently`. It opens the file as the SQLite URI `file:<path>?mode=rw`, which never creates it. After it takes the lock, a `check` from its own process (see "The rule for one process") tells that the path still names the file that it locked; another deleter can have removed it meanwhile. With the retry, the probe removed the file in 600 of 600 trials, after 1 to 5 tries 1 ms apart, and kept the file of a live owner in 300 of 300 trials.

`tryOpen` stays synchronous and does not try again. A synchronous retry on a check must wait for the check to end, and a wait in a synchronous call blocks the event loop, which is the reason that a busy timeout lost (Considered Options). Only one owner can meet a check: the `SessionDirectory` of the mutex, whose recovery lists presence files that have no record yet. It tries `tryOpen` again on each turn, on its clock, for at most 1 second. The other owners take a presence before any record names it, so no other process checks it yet.

### Where the names come from

No standard library of Go or .NET has this class. Go has `syscall.Flock` and `golang.org/x/sys/unix.Flock`, and `cmd/go/internal/lockedfile`, which is internal. .NET has `FileStream.Lock` and a named `Mutex`, whose `AbandonedMutexException` tells the next waiter that the owner died. Neither has a call that asks if an owner runs. Thus the names come from the Unix pattern of the lock of a PID file: W. Richard Stevens and Stephen Rago, _Advanced Programming in the UNIX Environment_, section 13.5 "Single-Instance Daemons", and the `pidfile(3)` functions of FreeBSD libutil (FreeBSD 5.5, also in libbsd on Linux).

| Name                                | Source                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Presence`                          | The word of the mutex glossary and mutex ADR 0012. XMPP (RFC 6121, section 4) and Phoenix (`Phoenix.Presence`) use "presence" for "this entity is available now". The use of the word for a file lock is this repository's.                                                                                                                                                                      |
| `tryOpen`                           | `pidfile_open(3)`: it "opens (or creates) a file specified by the path argument and locks it", and fails with `EEXIST` when "some process already holds the lock". `try` is from `FileLock.tryLock` and Rust's `File::try_lock`: the call returns at once without the lock.                                                                                                                      |
| `check`                             | `FileLock.check` of this package, and `check` of `proper-lockfile`. `pidfile_signal(path, 0, …)` of FreeBSD 14 does the same job: it is "an effective way to verify the existence of a pidfile and of the process that owns it", and it fails with `ENOENT` when the file "does not exist, or exists but is not locked". `pgrep -F <file> -L` asks for a pidfile that is locked with `flock(2)`. |
| `removeIfEnded`                     | The name of the call in sqlite-notify that it replaces (`ListenerPresence.removeIfEnded`). No leading tool has a call for this, because no leading tool deletes the file of another owner (see "A deleter and a check").                                                                                                                                                                         |
| `remove`                            | `pidfile_remove(3)`: it "closes and removes a pidfile". FreeBSD's `_pidfile_remove` (`lib/libutil/pidfile.c`) calls `funlinkat` first and `close` second, as `remove` does on Unix.                                                                                                                                                                                                              |
| `[Symbol.dispose]`                  | `pidfile_close(3)`: it "closes a pidfile" and keeps the file.                                                                                                                                                                                                                                                                                                                                    |
| `'present'`, `'ended'`, `'missing'` | `'missing'` is the word of `FileLock.check`. "Present" and "ended" are the words of the mutex glossary ("A caller's presence … has ended"). They are not from a leading tool.                                                                                                                                                                                                                    |

The name `PidFile` lost: a `FileLock` file holds no process id (`tryLock` throws for a file with other content), and an owner is not a process. A presence that a worker thread opens ends when the thread ends (mutex ADR 0012, case four).

### Where it lives

Ezz asked: "does this belong in a new package or an existing one, and what else should a new package contain". The research of 2026-11-24 (session mutex-ba) found no leading tool with a package for a presence. A local check of liveness always sits beside the primitive of the file lock:

- FreeBSD libutil has `pidfile(3)` beside `flopen(3)`, which it is built on (release/14.1.0, `libutil.h` lines 95-127).
- The Rust crate `fslock` 0.2.1 has `try_lock_with_pid` on its `LockFile`. The crate `pidfile` has `lock` and `check` on `fcntl`.
- Rust `std::fs`, Go `lockedfile`, Java `java.nio.channels`, .NET `FileStream.Lock` and Python `fcntl` and `filelock` keep the lock in their file module, and have no call for liveness.
- Only Curator gives the distributed form a module of its own (`recipes.nodes`: `PersistentNode`, `PersistentEphemeralNode`, `GroupMember`). etcd puts `Session` in `concurrency` beside `Mutex` and `Election`. ZooKeeper has `EPHEMERAL` as a create mode. Consul has its sessions in `api`.

The directory of live owners (list the members, drop the ones that ended; Curator `GroupMember`) is in two places: `SessionDirectory.recover` of the mutex, and `isLeased` with the prune of `@zukhruf/git-hooks`, which is a reference count. Two places are strike 2, so that part stays with them. The three consumers depend on `@zukhruf/fs` and `@zukhruf/async` already, so the package adds no dependency edge. Thus `Presence` goes into `@zukhruf/fs`, beside `FileLock`. The scope of this package says "a lock on a file that the kernel frees when its holder dies" already. A new package would hold `Presence` alone.

### The rule for one process

The DECIDED note of #5424 says that a sender in the listener's own process must never check the listener's lock, because a close of any descriptor drops a POSIX lock. The tests of this package show that this is not true for a check through `FileLock`:

- `src/file-lock.test.ts`, "a check in the process that holds the lock answers locked, and the lock stays held for other processes".
- `src/file-lock.test.ts`, "a second handle in the process that holds the lock is refused, and disposing it keeps the lock for other processes".

Both passed on macOS on 2026-11-24 (`node --conditions=@zukhruf/source --test --test-name-pattern="in the process that holds the lock" packages/fs/src/file-lock.test.ts`: 2 pass). SQLite keeps one record for each file in the process (`unixInodeInfo` in `os_unix.c`). While a connection of the process holds a lock on the file, the close of another connection does not close its descriptor: `unixClose` keeps it for later (`setPendingFd`). Thus:

- `Presence.check` in the owner's process answers `'present'`. That answer is true, and the lock stays.
- `Presence.tryOpen` in the owner's process returns `undefined`, and `Presence.removeIfEnded` resolves `'present'`, so a deleter in that process never deletes a live presence.
- The rule that stays is the rule of `FileLock`: open the file only through `Presence`. A `readFile`, an `open` of `node:fs`, or a second SQLite library in the process (for example `better-sqlite3`, or the native library of `@zukhruf/sqlite-open`) has its own descriptor. Its close drops the lock on Unix, and no error tells it. The comment at `packages/git-hooks/src/snapshot/installs.ts` lines 214-217 is out of date: its `isLeased` reads the leases through `FileLock.check`, which keeps the lock.

### Windows

The rules of `FileLock` apply. SQLite locks the file with `LockFileEx`, which belongs to the handle, not to the process. A close of another handle does not drop it. The delete of a file that a handle keeps open is refused, and `remove` handles that refusal as the Decision says. A check opens the file for a moment, so a delete at that moment is refused for a moment too; `patiently` tries again.

### Errors

`Presence` has no error class of its own. A lock that another handle holds is a result (`undefined`), as in `FileLock.tryLock`. The faults of `FileLock` reach the caller: the `UnavailableError` or the `DeniedError` of `@zukhruf/sqlite-open` for a file that cannot be opened, and the SQLite error `SQLITE_NOTADB` for a file with other content. `remove` rejects with the error of the delete when the delete still fails after 1 second. `removeIfEnded` rejects when checks of other processes kept the lock from it for 1 second.

## Considered Options

- **A new package for the presence.** It would hold `Presence` alone, and no leading tool has one (see "Where it lives"). If it is ever made, its name comes from Curator's `nodes`.
- **A third copy in sqlite-notify.** The Rule of Three forbids it: this is the fourth place.
- **`tryOpen` with `remove` for the deleter.** It was the first design. A deleter that meets a check gets `undefined` and leaves the file, and its open creates the file again (see "A deleter and a check").
- **Keep the file that stays, as `pidfile` and Python `filelock` do.** Their names are used again, so the next owner opens the file. The names of a presence are unique, so the files would grow without end.
- **A busy timeout.** It cannot tell a check from a live owner, so it waits the full time for each owner that runs. node:sqlite has no busy handler, so the wait blocks the event loop.
- **An error class for a presence that another handle holds.** The next step differs: `SessionDirectory` tries again, and the others throw their own fault. `FileLock.tryLock` returns `false` for the same fact. Thus `tryOpen` returns `undefined`.
- **`kill(pid, 0)` with the process id in the record.** A process id is used again (sqlite-notify ADR 0010, S3 failed in 5 of 5 runs), and a zombie process answers it (mutex ADR 0012).
- **`proper-lockfile` or a heartbeat.** A frozen owner looks stale, and its lock goes to a second owner ([ADR 0002](./0002-a-file-lock-is-an-exclusive-sqlite-transaction.md), Considered Options).
- **A native `flock`, for example `fs-ext` or `fs-native-extensions`.** It needs a compiled binary for each platform (ADR 0002).

## Consequences

The places before and after:

| Place                                     | Before                                                                  | After                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mutex `Presence.claim`                    | `FileLock.open` and `tryLock`; `false` throws                           | `Presence.tryOpen` of `@zukhruf/fs`; `undefined` throws the same error                                                                                               |
| mutex `Presence.judge`                    | `FileLock.check`, `'locked'` is present                                 | `Presence.check`; the rule for `'missing'` (a fault, or `'moved'`) stays in the mutex                                                                                |
| mutex `Presence.delete` of a gone caller  | `unlink` with no lock                                                   | `Presence.removeIfEnded(path, { clock })`: the delete holds the lock                                                                                                 |
| mutex `Presence.releaseAfter`, `withdraw` | free the lock, then delete the file                                     | the record goes first, as now, then `remove`                                                                                                                         |
| mutex `SessionDirectory.#takePresence`    | a loop of `FileLock.open`, `tryLock` and `FileLock.check`               | a loop of `Presence.tryOpen` while it returns `undefined`: a deleter holds the file for a moment                                                                     |
| mutex `#deleteIfFree`, `unlinkRefused`    | its own order for Unix and Windows                                      | `Presence.removeIfEnded(path, { clock })`, also in the recovery sweep; both functions are deleted                                                                    |
| mutex `endIfStopped`                      | `FileLock.check(…) === 'locked'`                                        | `Presence.check(…) === 'present'`                                                                                                                                    |
| mutex `SessionRecord` disposal            | delete the record, free the lock, delete the file                       | delete the record, then `remove`                                                                                                                                     |
| git-hooks `leaseInstall`                  | `FileLock.open` and `tryLock`; `rmSync` of the file, then the lock goes | `Presence.tryOpen`; the lease is the presence, and its end is `remove`, which also works on Windows                                                                  |
| git-hooks `isLeased`                      | `FileLock.check(…) === 'locked'`                                        | `Presence.check(…) === 'present'`; the comment of lines 214-217 goes                                                                                                 |
| sqlite-notify `Listening.register`        | no presence                                                             | `Presence.tryOpen` before the row is inserted; `undefined` is a fault                                                                                                |
| sqlite-notify `Listening.end`             | removes the rows, closes the socket and the connection                  | removes the rows, then `remove` of the presence, then the socket and the connection                                                                                  |
| sqlite-notify `Wakes`, a refused connect  | `NoServerError` makes the listener dead                                 | on a platform other than Linux, `Presence.check`: `'present'` makes the connection lost (a later send tries again); `'ended'` and `'missing'` make the listener dead |
| sqlite-notify `Wakes.removed`             | deletes the socket file                                                 | also `Presence.removeIfEnded(path, { clock })` in `ListenerPresence.removeIfEnded`, on Windows too: a pipe goes when its program exits, but the presence file stays  |

- The mutex copy ledger closes its entry "A presence that outlasts its record", and the ledger of sqlite-notify closes its entry for `ListenerPresence`. The mutex keeps its own class for the presence of a caller, `CallerPresence`, with `pathOf`, `judge` and `isNamedCallerPresent`. sqlite-notify keeps `ListenerPresence`, with its path and its rule that a missing file is a listener of an older release.
- The fs glossary gets the term **Presence**, and the term **File lock** keeps its `_Avoid_` items.
- The four places move in one commit (#5463), because the fixed release group publishes `@zukhruf/fs` and its consumers together.
- A deleter that meets a check waits it out, so it leaves no file of an owner that ended (`src/presence.test.ts`, "removeIfEnded removes the file of an ended presence that other processes check in a loop").
- Open: a deleter whose lock is on a file that another deleter removed meanwhile cannot tell that file from a new file of the same owner at the path when that owner holds it. Only `SessionDirectory` opens a path again (`#takePresence`), and only when a recovery deleted its file during its open. The tests do not reach this order.

Decided with the owner on 2026-11-24:

1. **The name `Presence` belongs to `@zukhruf/fs`.** No two packages export a class of one name, so the mutex's class for the presence of a caller becomes `CallerPresence` and uses this one; its rule that a missing file is a fault stays in the mutex.
2. **A listener's presence file lives beside the database file**, not beside its pipe, because a Windows pipe is no file and no file can be made in its namespace. #5424's `<address>.lock` is replaced.
3. **The reopen loop of `SessionDirectory` gets the 1 s bound of `patiently`** of this package, in place of no limit.
4. **The note "a sender in the listener's own process never checks its own lock" goes from #5424**: a check from the holder's own process is safe (see "The rule for one process").
