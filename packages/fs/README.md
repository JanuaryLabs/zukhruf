# @zukhruf/fs

Helpers that write files, a lock on a file that the kernel frees when its holder dies, a presence that tells other processes that its owner still runs, and a stamp that tells that a file changed. A reader never sees a part of a write. `@zukhruf/mutex` uses them for its lock files, `@zukhruf/fencing` for its fencing counters, and `@zukhruf/election` for the claim and the epoch of each election. `@zukhruf/single-flight` claims a `FileLock` through `@zukhruf/election` for its election. It also holds a `FileLock` of its own for each key, in the file `execution-locks/<SHA-256 of the key>.lock`, and it never deletes these files ([key-locks.ts](../single-flight/src/key-lock/key-locks.ts)).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/fs
```

```ts
import { FileLock, atomicWrite, durableWrite } from '@zukhruf/fs';
```

## Replace a file in one step

A write that changes a file in place can stop halfway. Then a reader sees a part of the old content and a part of the new content. `atomicWrite` fills a draft beside the path, and then moves the draft over the path with one rename. A reader sees the old content or the new content.

```ts
import { atomicWrite } from '@zukhruf/fs';

await atomicWrite('/var/lib/app/queue', 'first\nsecond\n', {
  clock: globalThis,
});
```

## Make the replacement durable

After a rename, the operating system can keep the new content in memory for some time. A power loss in that time can bring back the old content. `durableWrite` replaces the file in one step, like `atomicWrite`. It returns only after the new content and the rename are on the disk:

1. It writes the draft and syncs the draft to the disk.
2. It moves the draft over the path.
3. It syncs the directory, because the rename is a change of the directory.

```ts
import { durableWrite } from '@zukhruf/fs';

await durableWrite('/var/lib/app/counter', '42', { clock: globalThis });
```

Use `durableWrite` when a value must never go back after a crash, for example a counter that gives out fencing tokens. A counter that goes back gives the same token two times.

On Windows, a process cannot open a directory to sync it. Some file systems refuse a sync of a directory with `EINVAL` or `ENOTSUP`. In these cases, the rename is as durable as that system makes it. Each other error of the sync reaches the caller.

## Write bytes, and set the mode of the file

`atomicWrite` and `durableWrite` take the same arguments:

```ts
atomicWrite(path: string, content: string | Uint8Array, options: { clock: Clock; mode?: number })
durableWrite(path: string, content: string | Uint8Array, options: { clock: Clock; mode?: number })
```

`clock` is the clock that the waits of the write run on. Give `globalThis` in production, and a fake clock in a test. A write waits only on Windows, between two tries of a rename that Windows refuses for now (see "Try again while Windows refuses a file for a moment"). `Clock` is the type of `@zukhruf/async`.

The content is a string or bytes. A `Buffer` is a `Uint8Array`, so a `Buffer` is bytes too. The write puts the bytes at the path with no change.

`mode` sets the POSIX file mode of the new file, for example `0o600` for a file that only its owner can read. The file gets that mode, whatever the process umask takes away: the write sets `mode` on the draft with `chmod` too, as write-file-atomic 5.0.1 does (#4444, `src/replace-in-one-step.test.ts`). The write sets `mode` on the draft before the rename, because the rename keeps the mode of the draft. Thus the file at the path never has a different mode, not even for a moment. When you do not give `mode`, the file gets the mode that `writeFile` gives a new file, and the umask applies. A write never keeps the mode of the file that it replaces.

```ts
import { randomBytes } from 'node:crypto';

import { atomicWrite } from '@zukhruf/fs';

await atomicWrite('/var/lib/app/key', randomBytes(32), {
  clock: globalThis,
  mode: 0o600,
});
```

On Windows, a file has no POSIX mode. Node.js uses only the write bit of `mode` there, to make the file read-only.

## Create a file only when it is absent

`createExclusive` creates the file when no file is at the path, and returns `true`. When a file is there, it changes nothing and returns `false`. It fills a draft first and then links the draft to the path. Thus the file is never empty: a reader of the new file sees all of its content.

```ts
import { createExclusive } from '@zukhruf/fs';

const created = await createExclusive('/var/lib/app/job.lock', 'pid 4242', {
  clock: globalThis,
});
if (!created) console.log('Another process holds the job.');
```

## A failed write leaves no draft

When a write fails, it removes its draft. Thus failed writes do not fill the directory with drafts. The file at the path keeps its old content.

When `createExclusive` fails and the removal of its draft fails too, it rejects with a `SuppressedError`: `suppressed` is the failure of the create, and `error` is the failure of the removal. When the create succeeds or finds a file, a failed removal does not change its answer: the process gets a warning, and the draft stays. A draft has a unique name, so it never blocks a later create.

## Keep room for the name of the draft

A draft has the name of the path plus `draftSuffixLength` characters. Most file systems limit a file name to 255 bytes. A caller that makes long file names, for example from user keys, keeps `draftSuffixLength` characters of room. Otherwise the name of the draft is too long, and the write fails with `ENAMETOOLONG`.

## Name a file after any key

A caller can keep one file for each key, for example one lock file for each lock key. The caller must make a file name from the key. A key can hold `/`, be `.` or `..`, or be too long for a file name. `safeFileName(key, longestSuffix)` gives a name that is one path segment. The name plus `longestSuffix` more characters fits in 255 characters, the longest file name of most file systems.

```ts
import { join } from 'node:path';

import { createExclusive, draftSuffixLength, safeFileName } from '@zukhruf/fs';

const name = safeFileName('orders/2026', '.lock'.length + draftSuffixLength);
await createExclusive(join('/var/lib/app/locks', `${name}.lock`), 'pid 4242', {
  clock: globalThis,
});
// The file is orders%2F2026.lock
```

- A key that fits gets its URI encoding, with each `.` as `%2E`. Thus a name is never `.` or `..`. The name of `job.lock` is `job%2Elock`, so it is never the name of `job` plus the suffix `.lock`.
- The encoding also encodes each uppercase letter. The names of `Sync`, `sync` and `SYNC` are `%53ync`, `sync` and `%53%59%4E%43`. APFS and NTFS compare file names without case. On these file systems too, each key gets its own file, as on Linux.
- Windows refuses `*` in a file name, so the encoding encodes each `*` as `%2A`. Windows also gives some names to devices: `con`, `prn`, `aux`, `nul`, `com0` to `com9` and `lpt0` to `lpt9`. Such a name stays a device name after a suffix, for example `con.lock`. When the encoding of a key is a device name, its first letter is encoded too. The name of `con` is `%63on`. Other names do not change: the name of `console` is `console`.
- A key that does not fit, or that is not well-formed Unicode, gets a hashed name: the first 32 characters of its encoding, `%%`, and the SHA-256 of its UTF-16 code units in hex. A hashed name has at most 98 characters. An encoding never holds `%%`, so a hashed name is never the name of a key that fits.

## Try again while Windows refuses a file for a moment

Windows refuses a file for a moment while a delete of it is in progress, or while another program holds it open with no sharing, for example a virus scanner. The error codes are `EPERM`, `EACCES`, and `EBUSY`. A real permission error has the same codes. `patiently` runs an operation again while Windows refuses the file, for up to 1 second. After that, the error reaches the caller. On other systems, `patiently` runs the operation one time.

```ts
import { readFile } from 'node:fs/promises';

import { patiently } from '@zukhruf/fs';

const content = await patiently(
  () => readFile('/var/lib/app/job.lock', 'utf8'),
  { clock: globalThis },
);
```

Each wait between two tries runs on the clock that you give. The 1 second is a time on that clock too. A test gives a fake clock and moves the time, so that the test does not wait. See [ADR 0005](./docs/adr/0005-a-write-waits-on-the-clock-that-the-caller-gives.md).

Each write of this package uses `patiently` for its rename or link, with the clock of the write.

## Lock a file

A process can die while it holds a lock. When the lock is a file that is present, for example a file from `createExclusive`, the file stays after the process dies. Then the lock stays until somebody deletes the file. A `FileLock` is a lock that the kernel holds. When the process of the holder stops, however it stops, the kernel frees the lock at once.

Node.js has no `flock`. Thus a `FileLock` is an exclusive SQLite transaction on the file. SQLite is part of Node.js (`node:sqlite`). `FileLock` opens the file with `open` of `@zukhruf/sqlite-open`.

```ts
import { FileLock } from '@zukhruf/fs';

using lock = FileLock.open('/var/lib/app/job.lock');
if (lock.tryLock()) {
  try {
    await runJob();
  } finally {
    lock.unlock();
  }
} else {
  console.log('Another process holds the job.');
}
```

- `FileLock.open(path)` opens the file. When no file is at the path, it creates an empty file. It takes no lock.
- `tryLock()` takes the lock and returns `true`. When another handle holds the lock, it returns `false` at once. It never waits: to wait, try again after a pause. Two handles in one process exclude each other too.
- When the file has other content, `tryLock()` throws. Only an empty file or a SQLite database can be a file lock.
- When the process can read the file but not write it, `tryLock()` throws the `DeniedError` of `@zukhruf/sqlite-open`. SQLite opens such a file read-only, and a read-only handle takes no lock that keeps other processes out ([ADR 0008](./docs/adr/0008-a-file-lock-refuses-a-file-that-its-process-cannot-write.md)).
- `unlock()` lets the lock go. The handle stays open, and it can lock again.
- A disposal closes the handle. A lock that the handle holds goes with it. A second disposal does nothing.
- A held lock stays held when nothing refers to its handle any more. Only `unlock()`, a disposal, or the end of the process lets it go.

`FileLock.check(path)` tells if a handle holds the lock now. It returns `'locked'`, `'unlocked'`, or `'missing'` when no file is at the path. It reads the file one time and never creates it. For that read, it holds a shared lock for a moment, so a `tryLock()` at that moment can return `false`. The answer can be old when you use it. Other faults, for example a directory at the path, throw.

Obey these rules:

- Open the file only through `FileLock`. On Unix, the lock is a POSIX record lock of the process. When the process closes any other descriptor of the file, the kernel drops the lock and gives no error.
- Do not delete the file while processes use it. A new file at the path has no lock, so a second process can lock it while the first one holds the old file.
- Use `assertLocalDirectory` first. Other machines do not see the lock reliably on a network file system.

The journal of the transaction is in memory, so a holder that dies leaves no `<path>-journal` file. Other programs can hold an exclusive SQLite transaction on the same file in the default journal mode. Such a transaction and a `FileLock` exclude each other. A journal file that such a program leaves is deleted by the next `tryLock()`.

## Tell other processes that an owner still runs

A **presence** tells other processes that its owner still runs. The owner holds the file lock of a file of its own while it lives. Another process checks the file: a held lock means that the owner runs, also when it is frozen. A free lock means that the owner stopped, also after `SIGKILL`. A process id cannot tell this, because a process id is used again, and a zombie process still answers `kill(pid, 0)`. The names come from FreeBSD `pidfile(3)` ([ADR 0007](./docs/adr/0007-a-presence-is-a-file-lock-that-its-owner-holds-while-it-lives.md)).

```ts
import { Presence } from '@zukhruf/fs';

// The owner: before its record appears.
const presence = Presence.tryOpen(`/var/lib/app/${id}.presence`);
if (!presence) throw new Error('Another program opened the presence file.');
// ... it writes its record, and works.
// It removes its record, then:
await presence.remove({ clock: globalThis });

// Another process, which found the record:
if (Presence.check(`/var/lib/app/${id}.presence`) !== 'present') {
  // The owner stopped. It removes the record, then the file of the presence.
  await Presence.removeIfEnded(`/var/lib/app/${id}.presence`, {
    clock: globalThis,
  });
}
```

| Call                                      | What happens underneath                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Presence.tryOpen(path)`                  | `FileLock.open(path)` and `tryLock()`. `undefined` at once when another handle holds the lock: another owner, a deleter, or a check for a moment. When a deleter removed the file meanwhile, the lock is on a file that no reader finds: it opens the new file and tries again.                                                                                                                               |
| `Presence.check(path)`                    | `FileLock.check(path)`: `'locked'` is `'present'`, `'unlocked'` is `'ended'`, and `'missing'` stays `'missing'`. It never creates the file and never takes the lock.                                                                                                                                                                                                                                          |
| `Presence.removeIfEnded(path, { clock })` | It opens the file as the SQLite URI `file:<path>?mode=rw`, which never creates it, and tries the lock. With the lock it deletes the file as `remove` does: `'removed'`. When another handle holds the lock, `check` tells why: `'present'` is an owner or another deleter, and `'ended'` is a check for a moment, which it waits out on `clock` for at most 1 second. `'missing'` when the file is not there. |
| `presence.remove({ clock })`              | On Unix: it deletes the file, then frees the lock, as `pidfile_remove(3)` does. On Windows: it frees the lock, then deletes the file; a refusal while another handle holds the lock leaves the file to it, and a refusal for a moment is tried again for 1 second (`patiently`).                                                                                                                              |
| `presence[Symbol.dispose]()`              | It frees the lock and keeps the file, as `pidfile_close(3)` does. A second disposal does nothing.                                                                                                                                                                                                                                                                                                             |

Obey these rules:

- Delete the file of another owner only with `removeIfEnded`. A check holds the file for a moment, so a deleter that tries the lock once can leave the file, and an open of `tryOpen` creates it again.
- Give each owner a path of its own, for example with a random id in the name. A presence is not a lock that owners share. For a lock that many processes take, use `FileLock`.
- Take the presence before the owner's record appears. Remove it only after the record is gone. Thus a record whose presence ended belongs to an owner that stopped.
- Decide what `'missing'` means for your records: a fault, an owner that moved on, or a record of an older release. The package cannot know it.
- A check, an open or a `removeIfEnded` in the owner's own process is safe. The check answers `'present'`, the open returns `undefined`, `removeIfEnded` resolves `'present'`, and the lock stays (`src/presence.test.ts`). Open the file only through `Presence`: a descriptor of `node:fs`, or of a second SQLite library, drops the lock on Unix when it closes.

`Presence` has no error class of its own. The faults of `FileLock` reach the caller, for example the `DeniedError` of a file that the process cannot write, and `remove` rejects with the error of the delete when the delete still fails after 1 second. `removeIfEnded` rejects when checks of other processes kept the lock from it for 1 second.

## Refuse a network directory

A lock that a file or SQLite holds works between the processes of one machine. On a network file system, for example NFS or SMB, other machines do not see that lock reliably. `assertLocalDirectory(directory)` rejects with `NetworkDirectoryError` when the directory is on a network file system. A directory that does not exist yet gets the result of its nearest parent that exists.

```ts
import { NetworkDirectoryError, assertLocalDirectory } from '@zukhruf/fs';

try {
  await assertLocalDirectory('/mnt/shared/locks');
} catch (error) {
  if (error instanceof NetworkDirectoryError) console.log(error.fileSystem); // 'NFS'
  throw error;
}
```

- On Linux, the check reads the file system type with `statfs`. FUSE counts as local.
- On Windows, a UNC path, for example `\\server\share`, is a network directory.
- On macOS, each directory counts as local, because macOS gives no stable file system type.
- When `statfs` fails, the check does not reject. The directory is used as if the check did not exist.

`@zukhruf/mutex` and `@zukhruf/single-flight` give this same `NetworkDirectoryError` class. A catch with `instanceof` works for each of them.

## Tell that a file changed

A program that watches a file reads it again after each write. A read of the whole file on each check costs too much, and a file-change event can come late or not at all. Git has the same problem for each file in a working tree. Git compares the stat data of the file with the stat data that it kept: when they are equal, the file did not change. A `FileStamp` is that stat data.

```ts
import { FileStamp } from '@zukhruf/fs';

const before = await FileStamp.read('/var/lib/app/store.json');
// ... later
const now = await FileStamp.read('/var/lib/app/store.json');
if (!now.equals(before)) console.log('The store changed. Read it again.');
```

- A file stamp holds the device, the inode, the size, the time of the last write and the time of the last change of the file. Each time is to the nanosecond.
- A write changes the stamp. This is also true when the writer gives back the old write time, as `rsync -t` and `tar` do, because the kernel sets the time of the change. The writer cannot set that time.
- A new file at the path changes the stamp, also with the same size and write time. A program that replaces its file with a rename makes a new file.
- A missing file has a stamp of its own. Two missing stamps of one path are equal. When the file comes back, the stamp changes.
- A path through a file, for example `file/store`, is missing too (`ENOTDIR`).
- Each other error of `stat` reaches the caller, for example `EACCES` for a folder that the process may not search. A file that the process may not see is not a missing file.
- `modifiedAt` is the time of the last write. It is `undefined` for a missing file.
- `FileStamp.read(path)` reads the stamp. `FileStamp.readSync(path)` reads it and blocks.
- `toString()` gives the stamp as text, so that you can keep it.

`FileStamps` holds the stamps of several files that change together, for example a database and its journal, or the files of one store. A write of any file changes the whole. A missing file is a part of it.

```ts
import { FileStamps } from '@zukhruf/fs';

const stamps = await FileStamps.read([
  '/var/lib/app/History',
  '/var/lib/app/History-journal',
]);
console.log(stamps.modifiedAt); // the newest write of the files that are present
```

`modifiedAt` of `FileStamps` is the newest write of the files that are present. It is `undefined` when no file is present.

No package on npm does this job. [ADR 0004](./docs/adr/0004-a-file-stamp-is-the-stat-data-that-git-compares.md) tells why each candidate failed.

## Make a temporary directory

`new TemporaryFiles().directory(prefix)` makes an empty directory in `os.tmpdir()`. Its name starts with `prefix`. The handle has `path` and `cleanup`. Disposal removes the directory and all that it holds.

```ts
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';

await using scratch = await new TemporaryFiles().directory('report-');
await writeReport(join(scratch.path, 'report.json'));
```

`directorySync(prefix)` does the same for code that cannot wait, such as a synchronous `Symbol.dispose`. Its handle is `Disposable`, so it goes with `using`.

`path` is the real path: the acquisition resolves symbolic links. On macOS, `os.tmpdir()` is below `/var`, and `/var` is a link to `/private/var`. git, a child process and a bind mount give the resolved path. Thus code can compare their output with `path` directly.

On Windows, a process that still holds a file open stops its removal for a short time. Thus disposal retries the removal on `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM`. It retries 8 times, and it waits 50 ms longer before each retry: 50 + 100 + … + 400 = 1.8 s at most. A removal that does not fail does not wait. When the last retry fails, disposal rejects (or, for `directorySync`, throws) with the error. Node's own `mkdtempDisposable` does not retry, and it gives the path as you wrote it.

The only option is `parent`, the directory that holds the new directory. The default is `os.tmpdir()`. Give a parent on the disk of a file that you rename out of the directory, because a rename across two disks fails with `EXDEV`. A Unix socket path has a limit of 104 bytes on macOS and 108 bytes on Linux. On macOS, the real path of `os.tmpdir()` uses 56 of them. Thus give a short parent, such as `/tmp`, for a socket. Node resolves a package from the parent directories of the file that imports it. Thus give a parent in the repository when a file in the directory imports a package of the repository.

[ADR 0006](./docs/adr/0006-a-temporary-directory-retries-its-removal-and-gives-its-real-path.md) records why the directory retries its removal and gives its real path. [Root ADR 0006](../../docs/adr/0006-production-code-and-tests-make-a-temporary-directory-with-temporaryfiles-of-zukhruf-fs.md) records why production code uses it too, and why it has a synchronous form.

## Check the error code

`isErrno(error, code)` tells if `error` is a Node.js system error with that error code.

```ts
import { isErrno } from '@zukhruf/fs';

try {
  await readFile(path, 'utf8');
} catch (error) {
  if (!isErrno(error, 'ENOENT')) throw error;
}
```

## Errors

| Error                   | When                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeniedError`           | The `DeniedError` of `@zukhruf/sqlite-open`. `tryLock()` throws it when the process can read the file but not write it, and `Presence.tryOpen` and `Presence.removeIfEnded` throw it at once for such a file. `FileLock.check` and `Presence.check` throw it when the process cannot read the file. Its `path` is the path of the lock, and its `cause` is the error of SQLite. Give the process access to the file. |
| `NetworkDirectoryError` | `assertLocalDirectory` rejects with it when the directory is on a network file system. Its `directory` is the directory that you gave, and its `fileSystem` names the file system, for example `'NFS'`.                                                                                                                                                                                                              |
| `SuppressedError`       | `createExclusive` rejects with it when the create fails and the removal of its draft fails too. Its `suppressed` is the failure of the create, and its `error` is the failure of the removal (`src/create-exclusive.test.ts`).                                                                                                                                                                                       |
| `ENAMETOOLONG`          | A write rejects with this error code when the name of its draft is too long for the file system (see "Keep room for the name of the draft", `src/draft.test.ts`). The removal of a draft that fails with `ENAMETOOLONG`, or with `ENOTDIR` for a parent that is a file, means that no draft is there. Thus `createExclusive` rejects with the error of its write, not with a `SuppressedError` (4494d9be).           |

A failure that no caller waits for is a process warning, in the shape of [root ADR 0010](../../docs/adr/0010-a-package-warning-names-its-type-code-and-subject-and-keeps-the-failure-as-its-cause.md). A `'warning'` listener reads its type as `name`, its `code`, and its subject in `detail`, one `<term>: <value>` line each. Its `cause` is the failure, and its message ends with the failure's message. `--disable-warning=<code or type>` stops the print. `CreateExclusiveWarning` is a class that the package exports, so a listener can test `warning instanceof` the class ([root ADR 0011](../../docs/adr/0011-a-package-warning-is-an-instance-of-its-own-class-which-the-package-exports.md)). With two installed copies of the package, `instanceof` fails across the copies, so compare `code`.

| Warning                  | Code                             | Detail          | When                                                                                   |
| ------------------------ | -------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `CreateExclusiveWarning` | `ZUKHRUF_FS_DRAFT_REMOVE_FAILED` | `draft: <path>` | `createExclusive` has its answer, and the removal of its draft fails. The draft stays. |

## API

```ts
type Clock = import('@zukhruf/async').Clock;

function atomicWrite(
  path: string,
  content: string | Uint8Array,
  options: { clock: Clock; mode?: number },
): Promise<void>;
function durableWrite(
  path: string,
  content: string | Uint8Array,
  options: { clock: Clock; mode?: number },
): Promise<void>;
function createExclusive(
  path: string,
  content: string,
  options: { clock: Clock },
): Promise<boolean>;
const draftSuffixLength: number;
function safeFileName(key: string, longestSuffix: number): string;
function patiently<T>(
  operation: () => Promise<T>,
  options: { clock: Clock },
): Promise<T>;
function isErrno(error: unknown, code: string): boolean;
function assertLocalDirectory(directory: string): Promise<void>;

class NetworkDirectoryError extends Error {
  readonly directory: string;
  readonly fileSystem: string;
}

class CreateExclusiveWarning extends Error {
  readonly code: 'ZUKHRUF_FS_DRAFT_REMOVE_FAILED';
  readonly detail: string; // draft: <path>
  constructor(failure: unknown, subject: { draft: string });
}

class FileLock implements Disposable {
  static open(path: string): FileLock;
  static check(path: string): 'locked' | 'unlocked' | 'missing';
  tryLock(): boolean;
  unlock(): void;
  [Symbol.dispose](): void;
}

class Presence implements Disposable {
  readonly path: string;
  static tryOpen(path: string): Presence | undefined;
  static check(path: string): 'present' | 'ended' | 'missing';
  static removeIfEnded(
    path: string,
    options: { clock: Clock },
  ): Promise<'removed' | 'present' | 'missing'>;
  remove(options: { clock: Clock }): Promise<void>;
  [Symbol.dispose](): void;
}

class FileStamp {
  readonly path: string;
  readonly modifiedAt: Date | undefined;
  static read(path: string): Promise<FileStamp>;
  static readSync(path: string): FileStamp;
  equals(other: FileStamp): boolean;
  toString(): string;
}

class FileStamps {
  readonly stamps: readonly FileStamp[];
  get modifiedAt(): Date | undefined;
  static read(paths: readonly string[]): Promise<FileStamps>;
  static readSync(paths: readonly string[]): FileStamps;
  equals(other: FileStamps): boolean;
  toString(): string;
}

interface TemporaryDirectory extends AsyncDisposable {
  path: string;
  cleanup: () => Promise<void>;
}
interface TemporaryDirectorySync extends Disposable {
  path: string;
  cleanup: () => void;
}
interface TemporaryDirectoryOptions {
  parent?: string; // default: os.tmpdir()
}
class TemporaryFiles {
  directory(
    prefix: string,
    options?: TemporaryDirectoryOptions,
  ): Promise<TemporaryDirectory>;
  directorySync(
    prefix: string,
    options?: TemporaryDirectoryOptions,
  ): TemporaryDirectorySync;
}
```

## Documentation

**Recipes**

- [Keep a state file that a crash never corrupts](./docs/recipes/keep-a-state-file-that-a-crash-never-corrupts.md)
- [Give each test its own temporary directory](./docs/recipes/give-each-test-its-own-temporary-directory.md)

**Decisions**

- [ADR 0001](./docs/adr/0001-the-writes-through-a-draft-are-one-package.md): the writes through a draft are one package.
- [ADR 0002](./docs/adr/0002-a-file-lock-is-an-exclusive-sqlite-transaction.md): a file lock is an exclusive SQLite transaction.
- [ADR 0003](./docs/adr/0003-the-content-is-bytes-and-the-caller-sets-the-file-mode-of-the-draft.md): the content is bytes, and the caller sets the file mode of the draft.
- [ADR 0004](./docs/adr/0004-a-file-stamp-is-the-stat-data-that-git-compares.md): a file stamp is the stat data that git compares.
- [ADR 0005](./docs/adr/0005-a-write-waits-on-the-clock-that-the-caller-gives.md): a write waits on the clock that the caller gives.
- [ADR 0006](./docs/adr/0006-a-temporary-directory-retries-its-removal-and-gives-its-real-path.md): a temporary directory retries its removal and gives its real path (superseded in part by [root ADR 0006](../../docs/adr/0006-production-code-and-tests-make-a-temporary-directory-with-temporaryfiles-of-zukhruf-fs.md)).
- [ADR 0007](./docs/adr/0007-a-presence-is-a-file-lock-that-its-owner-holds-while-it-lives.md): a presence is a file lock that its owner holds while it lives.
- [ADR 0008](./docs/adr/0008-a-file-lock-refuses-a-file-that-its-process-cannot-write.md): a file lock refuses a file that its process cannot write.
