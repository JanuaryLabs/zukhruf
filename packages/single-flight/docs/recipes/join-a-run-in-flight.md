# Recipe: Join a run that is still in flight

**Use case.** A command-line tool has a `sync` command. A sync takes a long time. A user starts `sync` in two terminals, or cron starts it while the user runs it. A second sync must not run, and a "busy" error does not help the user. The second `sync` must tell the user that a sync runs, wait for it, and report its outcome.

**What you need.** A `SharedFlight` in each process, with a host lock store such as `SqliteStore` and a `FileFlightRecords`. All processes use the same lock directory and the same records directory. The two directories are different.

## The steps

1. Create a `SharedFlight` with the mutex, the records and a `parse` function for the value.
2. Call `flights.run('sync', sync, { onJoin })`. The first caller is the leader: its process runs the sync.
3. Each other caller joins the flight. Its `onJoin` tells the user that a sync runs. Then it waits for the outcome of the flight.
4. Each caller gets `{ value, joined }`. The value is the same for all callers of the flight.

## The program

This program starts three copies of itself at the same time. Each copy runs `sync`. A sync takes 1 second, and it adds one line to `syncs.log`.

```ts title="join-a-sync.ts"
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Mutex, SqliteStore } from '@zukhruf/mutex';
import { FileFlightRecords, SharedFlight } from '@zukhruf/single-flight';

const [role, shared] = process.argv.slice(2);

if (role === 'sync') {
  const flights = new SharedFlight({
    mutex: new Mutex(new SqliteStore(join(shared!, 'locks'))),
    records: new FileFlightRecords(join(shared!, 'flights')),
    parse: (value) => {
      if (typeof value !== 'string') throw new TypeError('Not a sync summary.');
      return value;
    },
  });

  async function sync() {
    await appendFile(join(shared!, 'syncs.log'), `${process.pid}\n`);
    await delay(1000); // A sync takes time.
    return 'synced 42 files';
  }

  const { value, joined } = await flights.run('sync', sync, {
    onJoin: () => console.log('A sync is running. Waiting for it…'),
  });
  await appendFile(
    join(shared!, 'outcomes.log'),
    `${joined ? 'joined' : 'ran'}: ${value}\n`,
  );
} else {
  const directory = await mkdtemp(join(tmpdir(), 'join-a-sync-'));
  const exits = [1, 2, 3].map(() =>
    once(fork(import.meta.filename, ['sync', directory]), 'exit'),
  );
  await Promise.all(exits);
  const lines = async (file: string) =>
    (await readFile(join(directory, file), 'utf8')).trim().split('\n');
  console.log({
    syncs: (await lines('syncs.log')).length,
    outcomes: (await lines('outcomes.log')).sort(),
  });
  await rm(directory, { recursive: true, force: true });
}
```

Output:

```
A sync is running. Waiting for it…
A sync is running. Waiting for it…
{
  syncs: 1,
  outcomes: [
    'joined: synced 42 files',
    'joined: synced 42 files',
    'ran: synced 42 files'
  ]
}
```

## Why it works

Only the holder of the key `sync` runs the sync, so the mutex lets one copy be the leader. Before the leader runs the sync, it writes a flight record: the flight is running. The other copies find the key busy. They read the flight record, call `onJoin`, and then read the flight record again until the flight has an outcome. A joiner never acquires the key, so it never makes the key busy for another caller. See [ADR 0001](../adr/0001-a-joiner-follows-its-flight-record-without-acquiring-the-key.md).

The value goes into the flight record as JSON. Each copy, also the leader, gets `parse` of that JSON value. Thus all callers get the value in the same shape.

## Things to know

- **A copy that starts after the sync ended runs a new sync.** A flight is not a cache. To share a value after its flight ended, see the mutex recipe [Compute a value once and share it](../../../mutex/docs/recipes/compute-once-and-share-it.md).
- **To limit the wait, give a signal**: `flights.run('sync', sync, { onJoin, signal: AbortSignal.timeout(30_000) })`. When the signal aborts, the call of that copy rejects with the reason of the signal. The sync continues for the other copies.
- **When the sync fails**, the leader rejects with the original error. A joiner in another process rejects with `FlightFailedError`, which has the `name`, the `message` and the `code` of the error.
- **When the process of the leader stops during the sync**, a joiner rejects with `FlightInterruptedError`. The next `sync` runs a new sync. If another process begins the next sync first, the joiner continues with that successor and gets its outcome.
- **Joiners read the flight record every `pollInterval` milliseconds.** The default is 100 ms. For a sync that takes minutes, increase it. Then keep the outcome readable for longer, too: `new FileFlightRecords(directory, { keepFor })` with `keepFor` at least 20 times the `pollInterval`.
- **Callers in one process share one flight first.** Only one caller in each process reads the flight records.
