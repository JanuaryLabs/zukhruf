# @zukhruf/single-flight

Callers of one key share the flight in progress, in one process or across the processes of a host. A caller that comes while a flight runs does not start a second flight and does not fail with a "busy" error. It joins the flight and gets its outcome. This pattern is also known as single-flight or request coalescing, as in Go's `golang.org/x/sync/singleflight`.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## The problem

A user runs `sync`. A second `sync` starts while the first one runs. The mutex of `@zukhruf/mutex` gives two choices, and the user wants neither:

- In the acquire mode skip if busy, the second `sync` fails with a "busy" error.
- In the acquire mode wait, the second `sync` waits for the first one, and then runs a second sync.

The user wanted a sync to happen. Thus the second `sync` must tell the user that a sync runs, wait for it, and report its outcome. That is a join:

```ts
import { setTimeout as delay } from 'node:timers/promises';

import { SingleFlight } from '@zukhruf/single-flight';

const flights = new SingleFlight<string>();
let builds = 0;

async function buildReport() {
  builds += 1;
  await delay(100); // Building the report takes time.
  return `report ${builds}`;
}

const calls = [1, 2, 3].map(() =>
  flights.run('report:daily', buildReport, {
    onJoin: () => console.log('A report is being built. Waiting for it…'),
  }),
);
console.log(await Promise.all(calls), { builds });
```

Output:

```
A report is being built. Waiting for it…
A report is being built. Waiting for it…
[
  { value: 'report 1', joined: false },
  { value: 'report 1', joined: true },
  { value: 'report 1', joined: true }
] { builds: 1 }
```

The first caller is the leader: its call runs the flight. The other two callers join it. `onJoin` runs once for each joiner, before it waits. A call after the flight ended starts a new flight: a flight is not a cache. To keep a value after its flight, see the mutex recipe [Compute a value once and share it](../mutex/docs/recipes/compute-once-and-share-it.md).

## Use it

This project is an experiment.

```sh
npm install @zukhruf/single-flight @zukhruf/mutex
```

`@zukhruf/mutex` is a peer dependency. `SharedFlight` uses its mutex, and `SingleFlight` does not.

## In one process: `SingleFlight`

`flights.run(key, work, { onJoin, signal })` resolves with `{ value, joined }`. `joined` is `false` for the leader and `true` for each joiner.

- A failed flight rejects each caller with the original error of the work.
- `work` gets a signal that aborts when the flight is abandoned. Read it only when the work can stop early.

## Across processes: `SharedFlight`

A `SharedFlight` makes a flight visible to the other processes of the host. It uses three parts:

- A `SingleFlight`: the callers in one process share one flight first.
- The mutex: the holder of the key is the leader. The other processes learn that the key is busy.
- The records: the leader writes the flight record, and joiners in other processes read it.

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mutex, SqliteStore } from '@zukhruf/mutex';
import { FileFlightRecords, SharedFlight } from '@zukhruf/single-flight';

const directory = await mkdtemp(join(tmpdir(), 'app-'));

const flights = new SharedFlight({
  mutex: new Mutex(new SqliteStore(join(directory, 'locks'))),
  records: new FileFlightRecords(join(directory, 'flights')),
  parse: (value) => {
    if (typeof value !== 'string') throw new TypeError('Not a sync summary.');
    return value;
  },
});

const { value, joined } = await flights.run(
  'sync',
  async () => 'synced 42 files',
  {
    onJoin: () => console.log('A sync is running. Waiting for it…'),
  },
);
console.log({ value, joined });
await rm(directory, { recursive: true, force: true });
```

Output:

```
{ value: 'synced 42 files', joined: false }
```

The program with three processes is in the recipe [Join a run that is still in flight](./docs/recipes/join-a-run-in-flight.md).

| Option         | What it does                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutex`        | Decides which caller is the leader. All processes must use one lock directory, with a host lock store such as `SqliteStore`.                                        |
| `records`      | Keeps the flight records. All processes must use the same records. Give the records a directory of their own, never the lock directory.                             |
| `parse`        | Turns a value read from a flight record into your type. The value travels as JSON, so a `Date` arrives as a string. The leader also gets `parse` of the JSON value. |
| `pollInterval` | Milliseconds between two reads of a flight record while a caller joins. Defaults to `100`.                                                                          |

The work gets the lease of the key. A leader whose lease is lost records the flight as interrupted, and the call rejects with the reason of the lease.

A joiner never acquires the key. It reads the flight record until the flight has an outcome, and it asks the mutex only whether a running flight still has a holder. [ADR 0001](./docs/adr/0001-a-joiner-follows-its-flight-record-without-acquiring-the-key.md) tells why.

## Errors

| The caller is                          | The flight                                             | The call rejects with          |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| The leader, or a joiner in its process | Failed                                                 | The original error of the work |
| A joiner in another process            | Failed                                                 | `FlightFailedError`            |
| A joiner in another process            | Interrupted: the holder stopped, or its lease was lost | `FlightInterruptedError`       |
| A joiner in another process            | Its flight record is gone, before the joiner read it   | `FlightOutcomeLostError`       |
| The leader, or a joiner in its process | Ended, and the records refused its outcome             | The error of the records       |
| A joiner in another process            | Ended, and the records refused its outcome             | `FlightInterruptedError`       |

`FlightFailedError` has the `key` and the `failure`: the `name`, the `message` and the `code` of the error. A thrown value that is not an error keeps only its text. A value that JSON cannot carry, such as a `BigInt`, fails the flight.

When the holder of a flight stops and the next holder begins a new flight, the new flight is the successor. A joiner of the stopped flight continues with the successor and gets its outcome.

## Cancel a wait

Give a signal to stop the wait of one caller: `flights.run(key, work, { signal: AbortSignal.timeout(30_000) })`. The call rejects with the reason of the signal. The flight continues for the other callers, also when the leader's caller cancels.

When all callers of a flight cancel, the flight is abandoned:

- The next call of the key starts a new flight.
- In `SingleFlight`, the signal of the work aborts.
- In `SharedFlight`, a process that joins stops to read the flight record, and it never starts a flight for callers that left. A flight that a process leads continues to its end, because joiners in other processes can wait for its outcome.

[ADR 0002](./docs/adr/0002-a-flight-that-all-callers-left-is-abandoned.md) tells how other tools solve this.

## Records

`new FileFlightRecords(directory, { keepFor })` keeps one JSON file for each key. The name of the file is the SHA-256 of the key, so any key is a valid file name. The leader replaces the file in one step, so a joiner never reads a part of it.

`keepFor` is the keep window, in milliseconds. It defaults to `60_000`. Keep it at least 20 times the `pollInterval` of each joiner. A joiner that reads the flight record after the keep window gets `FlightOutcomeLostError`.

To keep the flight records in another place, for example a table of your database, write your own `FlightRecords`:

```ts
interface FlightRecords {
  begin(key: string): Promise<string>;
  finish(key: string, id: string, outcome: Finished): Promise<void>;
  latest(key: string): Promise<LatestFlight | undefined>;
  outcome(key: string, id: string): Promise<Outcome>;
}
```

- `begin` records a new running flight and returns a new id. A flight of the key that is still running becomes interrupted, and the new flight is its successor.
- `finish` records the outcome. It does nothing when the flight is not running.
- `outcome` returns `running`, the outcome, or `missing` when the flight record is gone.
- Only the holder of the key calls `begin` and `finish`. Joiners call only `latest` and `outcome`.

## Documentation

- [Join a run that is still in flight](./docs/recipes/join-a-run-in-flight.md): three processes, one sync.
- [ADR 0001: A joiner follows its flight record without acquiring the key](./docs/adr/0001-a-joiner-follows-its-flight-record-without-acquiring-the-key.md)
- [ADR 0002: A flight that all callers left is abandoned](./docs/adr/0002-a-flight-that-all-callers-left-is-abandoned.md)

## Development

This package is part of the [zukhruf](../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run single-flight:test        # builds, then runs the tests in src/
npx nx run single-flight:typecheck   # formats, lints, then type checks
npx nx run single-flight:build       # compiles src/ to dist/
```

The tests run from `src/`, not from `dist/`. The tests across processes start `src/testing/caller.fixture.ts` in child processes.

```
src/
  single-flight.ts         SingleFlight: the flights of one process
  flight.ts                one flight of this process and its callers
  shared-flight.ts         SharedFlight: the leader, and joiners across processes
  follow.ts                how a joiner finds and follows a flight record
  flight-records.ts        the FlightRecords interface and the outcomes
  file-flight-records.ts   FileFlightRecords: one JSON file for each key
  errors.ts                FlightFailedError, FlightInterruptedError, FlightOutcomeLostError
  testing/                 the caller process that the tests start
```
