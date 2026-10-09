# @zukhruf/fs

Helpers that write files. A reader never sees a part of a write. `@zukhruf/mutex` and `@zukhruf/single-flight` use them for their lock files, fencing counters, and election epochs.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Replace a file in one step

A write that changes a file in place can stop halfway. Then a reader sees a part of the old content and a part of the new content. `atomicWrite` fills a draft beside the path, and then moves the draft over the path with one rename. A reader sees the old content or the new content.

```ts
import { atomicWrite } from '@zukhruf/fs';

await atomicWrite('/var/lib/app/queue', 'first\nsecond\n');
```

## Make the replacement durable

After a rename, the operating system can keep the new content in memory for some time. A power loss in that time can bring back the old content. `durableWrite` replaces the file in one step, like `atomicWrite`. It returns only after the new content and the rename are on the disk:

1. It writes the draft and syncs the draft to the disk.
2. It moves the draft over the path.
3. It syncs the directory, because the rename is a change of the directory.

```ts
import { durableWrite } from '@zukhruf/fs';

await durableWrite('/var/lib/app/counter', '42');
```

Use `durableWrite` when a value must never go back after a crash, for example a counter that gives out fencing tokens. A counter that goes back gives the same token two times.

On Windows, a process cannot open a directory to sync it. Some file systems refuse a sync of a directory with `EINVAL` or `ENOTSUP`. In these cases, the rename is as durable as that system makes it. Each other error of the sync reaches the caller.

## Create a file only when it is absent

`createExclusive` creates the file when no file is at the path, and returns `true`. When a file is there, it changes nothing and returns `false`. It fills a draft first and then links the draft to the path. Thus the file is never empty: a reader of the new file sees all of its content.

```ts
import { createExclusive } from '@zukhruf/fs';

const created = await createExclusive('/var/lib/app/job.lock', 'pid 4242');
if (!created) console.log('Another process holds the job.');
```

## Keep room for the name of the draft

A draft has the name of the path plus `draftSuffixLength` characters. Most file systems limit a file name to 255 bytes. A caller that makes long file names, for example from user keys, keeps `draftSuffixLength` characters of room. Otherwise the name of the draft is too long, and the write fails with `ENAMETOOLONG`.

## Try again while Windows refuses a file for a moment

Windows refuses a file for a moment while a delete of it is in progress, or while another program holds it open with no sharing, for example a virus scanner. The error codes are `EPERM`, `EACCES`, and `EBUSY`. A real permission error has the same codes. `patiently` runs an operation again while Windows refuses the file, for up to 1 second. After that, the error reaches the caller. On other systems, `patiently` runs the operation one time.

```ts
import { readFile } from 'node:fs/promises';

import { patiently } from '@zukhruf/fs';

const content = await patiently(() =>
  readFile('/var/lib/app/job.lock', 'utf8'),
);
```

Each write of this package uses `patiently` for its rename or link.

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
