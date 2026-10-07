# Recipe: Compute a value once and share it

**Use case.** Three processes start at the same time, and each needs the schema of a database. To read the schema takes a long time. Thus the first process writes the schema to a cache file, and the other processes read that file. Only one process must read the schema from the database.

**What you need.** A host lock store, for example `SqliteStore`, and one key for the value. Each caller reads the cache before it acquires the key, and again after.

## The steps

1. Read the cache. If the value is in the cache, use it. You do not need the key.
2. If the value is not in the cache, acquire the key.
3. While you hold the key, read the cache again. Another caller can write the value while you wait.
4. If the value is still not in the cache, compute the value and write it to the cache. Then the task ends, and the mutex releases the key.

## The program

This program starts three copies of itself. Each copy needs the schema. To compute the schema takes 200 ms, and each computation adds one line to `builds.log`.

```ts title="compute-once.ts"
import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Mutex, SqliteStore } from '@zukhruf/mutex';

const [role, shared] = process.argv.slice(2);

if (role === 'instance') {
  const mutex = new Mutex(new SqliteStore(join(shared!, 'locks')));
  const cache = join(shared!, 'schema.txt');

  const readCache = () =>
    readFile(cache, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });

  async function computeSchema() {
    await appendFile(join(shared!, 'builds.log'), `${process.pid}\n`);
    await delay(200); // To read the schema of a large database takes time.
    return 'orders, customers';
  }

  const schema =
    (await readCache()) ??
    (await mutex.acquire('schema:sales', async () => {
      // Another copy can write the schema while this copy waits for the key.
      const ready = await readCache();
      if (ready !== undefined) return ready;
      const computed = await computeSchema();
      // Replace the file in one step: a copy that reads without the key never sees half of it.
      await writeFile(`${cache}.${process.pid}`, computed);
      await rename(`${cache}.${process.pid}`, cache);
      return computed;
    }));
  await appendFile(join(shared!, 'results.log'), `${schema}\n`);
} else {
  const directory = await mkdtemp(join(tmpdir(), 'compute-once-'));
  const exits = [1, 2, 3].map(() =>
    once(fork(import.meta.filename, ['instance', directory]), 'exit'),
  );
  await Promise.all(exits);
  const lines = async (file: string) =>
    (await readFile(join(directory, file), 'utf8')).trim().split('\n');
  console.log({
    builds: (await lines('builds.log')).length,
    results: await lines('results.log'),
  });
  await rm(directory, { recursive: true, force: true });
}
```

Output:

```
{
  builds: 1,
  results: [ 'orders, customers', 'orders, customers', 'orders, customers' ]
}
```

## Why it works

Only the holder of `schema:sales` computes the schema. The holder writes the schema before the mutex releases the key. Thus each waiter that gets the key later finds the schema in its second read, and does not compute it again. A copy that starts after the write finds the schema in its first read, and does not acquire the key.

## Another program writes the same file

Sometimes a program that does not use your lock store also writes the file. For example, a command-line tool refreshes a login token in its own credentials file. Your key does not stop that program, and a [fencing token](../concepts/fencing-tokens.md) cannot help: the program has no token.

Read the file again just before you write it. If the file changed, start again from the new content:

```ts
const token = await mutex.acquire('login', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readFile(credentials, 'utf8');
    const login = JSON.parse(before);
    if (login.expiresAt > Date.now() + 60_000) return login.accessToken;
    const fresh = await refresh(login.refreshToken);
    // The other program can write the file while the refresh runs.
    if ((await readFile(credentials, 'utf8')) !== before) continue;
    await writeFile(credentials, JSON.stringify(fresh));
    return fresh.accessToken;
  }
  throw new Error('The login changed during each refresh. Try again.');
});
```

This makes the time in which the two programs can collide short. It does not remove that time: the other program can write between the second read and your write. Only the other program can remove it, if it uses the same lock store.

## Things to know

- **The first read is optional. The second read is necessary.** Without the second read, each waiter computes the value again after the holder releases the key.
- **Write the value before the release, and replace the file in one step.** A caller can do its first read at any time, also while the holder writes. A rename replaces the file in one step, so that caller never reads half of the value.
- **A failed computation does not stop the next caller.** If the task throws, the call rejects, and the mutex releases the key. The next waiter does its second read, finds no value, and computes the value.
- **To limit the wait, give a signal**: `mutex.acquire(key, task, { signal: AbortSignal.timeout(30_000) })`. Without a signal, a waiter waits as long as the holder computes. When the signal aborts, the caller [cancels](../concepts/acquire-modes.md#cancel-a-wait): the call rejects with the reason of the signal, and the task does not run.
- **Waiters of the file lock stores and `SqliteStore` poll.** For a computation that takes seconds or minutes, increase `pollInterval`. In a test with a `pollInterval` of 10 ms, five waiters used approximately 390 ms of CPU time during a hold of 3 seconds.
- **All callers must share one lock store.** A process with its own `MemoryStore` computes the value again. See [reach](../concepts/reach.md).
