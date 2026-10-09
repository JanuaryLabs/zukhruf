# Recipe: Join a run that is still in flight

**Use case.** A command-line tool has a `sync` command. A sync takes a long time. A user starts `sync` in two terminals, or cron starts it while the user runs it. A second sync must not run, and a "busy" error does not help the user. The second `sync` must tell the user that a sync runs, wait for it, and report its outcome.

**What you need.** A `SingleFlight` in each process, with the same directory and a codec for the value. The directory is a local folder of your tool, for example its data folder.

## The steps

1. Create a `SingleFlight` with the directory and the codec.
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

import { SingleFlight } from '@zukhruf/single-flight';

const [role, shared] = process.argv.slice(2);

if (role === 'sync') {
  const flights = new SingleFlight<string>({
    directory: join(shared!, 'flights'),
    codec: { encode: (summary) => summary, decode: (text) => text },
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
  await flights[Symbol.asyncDispose]();
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

The three copies use one directory, so they take part in one election. The first copy that wins becomes the coordinator. Each copy then sends its call to the coordinator. The coordinator answers the first call: lead. It answers the other two calls: join. The leader runs the sync. When the sync ends, the coordinator pushes its outcome to the two joiners. See [ADR 0003](../adr/0003-a-caller-leads-or-joins-in-one-request-to-an-elected-coordinator.md).

The value goes to the joiners as text. Each copy, also the leader, gets `decode` of that text. Thus all callers get the value in the same shape.

## Things to know

- **A copy that starts after the sync ended runs a new sync.** A flight is not a cache. To share a value after its flight ended, see the mutex recipe [Compute a value once and share it](../../../mutex/docs/recipes/compute-once-and-share-it.md).
- **To limit the wait, give a signal**: `flights.run('sync', sync, { onJoin, signal: AbortSignal.timeout(30_000) })`. When the signal aborts, the call of that copy rejects with the reason of the signal. The sync continues for the other copies.
- **When the sync fails**, the leader rejects with the original error. A joiner rejects with `FlightFailedError`, which has the `name`, the `message` and the `code` of the error.
- **When the process of the leader stops during the sync**, each joiner rejects with `FlightInterruptedError`, and no joiner runs the sync again. The next `sync` runs a new sync.
- **When the coordinator stops during the sync**, the other copies elect a new coordinator. The leader reasserts its flight, and the joiners get the outcome of the sync. See [When a process stops](../../README.md#when-a-process-stops).
- **Dispose the `SingleFlight` before the process ends.** Disposing waits until the outcome of a sync that this process led reached the coordinator.
