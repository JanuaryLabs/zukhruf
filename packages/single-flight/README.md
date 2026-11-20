# @zukhruf/single-flight

Callers of one key share the flight in progress, in one process and across all the processes that use one directory. A caller that comes while a flight runs does not start a second flight and does not fail with a "busy" error. It joins the flight and gets its outcome. This pattern is also known as single-flight or request coalescing, as in Go's `golang.org/x/sync/singleflight`.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment.

```sh
npm install @zukhruf/single-flight
```

The lease that the work gets comes from `@zukhruf/lease`, and its token comes from `@zukhruf/fencing`. Both are dependencies of this package, so you install nothing more.

A user runs `sync`. A second `sync` starts while the first one runs. The mutex of `@zukhruf/mutex` gives two choices, and the user wants neither:

- In the acquire mode skip if busy, the second `sync` fails with a "busy" error.
- In the acquire mode wait, the second `sync` waits for the first one, and then runs a second sync.

The user wanted a sync to happen. Thus the second `sync` must tell the user that a sync runs, wait for it, and report its outcome. That is a join:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SingleFlight } from '@zukhruf/single-flight';

const directory = await mkdtemp(join(tmpdir(), 'reports-'));
const flights = new SingleFlight<string>({
  clock: globalThis,
  directory,
  codec: { encode: (report) => report, decode: (text) => text },
});
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
await flights[Symbol.asyncDispose]();
await rm(directory, { recursive: true, force: true });
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

The first caller is the leader: its call runs the work of the flight. The other two callers join it. `onJoin` runs once for each joiner, before it waits. A call after the flight ended starts a new flight: a flight is not a cache. To keep a value after its flight, see the mutex recipe [Compute a value once and share it](../mutex/docs/recipes/compute-once-and-share-it.md).

## The directory

The directory is the local folder where the processes that share flights meet. Each process that uses a `SingleFlight` keeps four files and a folder there: `flight.lock`, `flight.lock.leader`, `flight.epoch`, `flight.sock` and `execution-locks/`. The leader writes its process id and the address of its pipe to `flight.lock.leader`. A term of a single flight resigns with no `clean` option, so it writes no `flight.lock.clean` (8aa4c656). The election of [`@zukhruf/election`](../election/README.md) claims `flight.lock` with a file lock, and records the epoch of the last term in `flight.epoch`. The folder `execution-locks/` has one file for each key that ever led: the key lock of that key, named by the SHA-256 of the key. The process that runs the work of a key holds a file lock on that file (see [When a process stops](#when-a-process-stops)). The files stay after the flights, so do not remove them while a process uses the directory. The journal of the claim is in memory, so a coordinator that stops leaves no `flight.lock-journal` file. All the processes that name the same directory are one group, and the callers of one key share a flight in that group only.

Each `SingleFlight` also takes a `clock`: the clock of the waits of the group, for example the wait for a key lock. Give `globalThis` in production. A test gives a fake clock, for example `createClock()` of `@sinonjs/fake-timers` ([`@zukhruf/async`](../async/README.md#run-a-wait-on-a-clock)).

There is no default directory. One default would put each application on the host into one group, and unrelated applications that use the same key would join each other's flights. Give each group its own directory, for example a folder of your application's data.

- The directory must be on a local file system. On a network file system, a call rejects with `NetworkDirectoryError`.
- The absolute path of `flight.sock` must have 103 bytes or fewer on macOS, and 107 bytes or fewer on Linux. [`@zukhruf/pipes`](../pipes/README.md) checks it: a longer path throws a `RangeError` when you create the `SingleFlight`. On Windows, the socket is the named pipe `\\.\pipe\zukhruf-single-flight-<hash of the socket path>`, and the length of the directory does not matter.
- A single flight and a socket lock store of `@zukhruf/mutex` can use one directory. They use different files, and they never meet.

## Run a flight

`flights.run(key, work, { onJoin, signal })` resolves with `{ value, joined }`. `joined` is `false` for the leader and `true` for each joiner.

All the processes of the directory take part in one election. The winner is the coordinator. Each call asks the coordinator, in one step, to lead a new flight of the key or to join the flight in progress. When the work of the leader ends, the coordinator pushes the outcome to each joiner. Callers in the same process go through the coordinator too, also in worker threads. [ADR 0003](./docs/adr/0003-a-caller-leads-or-joins-in-one-request-to-an-elected-coordinator.md) tells why.

The work gets the lease of the flight:

- `token`: a `FencingToken`. Its high 32 bits are the epoch of the coordinator's term, so a newer term always gives higher tokens.
- `signal`: it aborts with `LeaseLostError` when the flight is no longer the leader's, so its outcome reaches no joiner. The `subject` of the error is the key. This occurs when a new coordinator refuses the reassert of the leader, because it knows a newer flight of the key, or when this process cannot connect to a coordinator again.

| Option          | What it does                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directory`     | The local folder where the processes of one group meet. See [The directory](#the-directory).                                                                                                  |
| `codec`         | Turns the value of a flight into text for the joiners, and back. See [The codec](#the-codec).                                                                                                 |
| `clock`         | The clock of each wait of the group: `globalThis` in production, a fake clock in a test. It is required. See [The directory](#the-directory).                                                 |
| `leaseDuration` | The longest silence, in milliseconds, that the other processes accept from this process while it is the coordinator. See [When a process stops](#when-a-process-stops). The default is 15000. |

`flights[Symbol.asyncDispose]()` waits until each landing of this process reached a coordinator, and then it disconnects. When this process is the coordinator, the other processes elect a new one. The work of a flight that this process leads continues, and this process keeps the key lock of that key until the work ends.

## The codec

The value of a flight goes to the joiners as text. The codec has two functions: `encode` turns a value into text, and `decode` turns the text back into a value. The coordinator only carries the text. Thus the format is yours: JSON, or a format that keeps what JSON drops, such as `undefined` and `Map`. The leader gets `decode(encode(value))` too, so each caller gets the value in the same shape.

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Codec, SingleFlight } from '@zukhruf/single-flight';

interface Sync {
  at: Date;
  files: number;
}

const syncs: Codec<Sync> = {
  encode: (sync) => JSON.stringify(sync),
  decode: (text) => {
    const { at, files } = JSON.parse(text);
    return { at: new Date(at), files };
  },
};

const directory = await mkdtemp(join(tmpdir(), 'syncs-'));
const flights = new SingleFlight({
  clock: globalThis,
  directory,
  codec: syncs,
});
const { value } = await flights.run('sync', async () => ({
  at: new Date('2026-10-09T12:00:00Z'),
  files: 42,
}));
console.log(value.at instanceof Date, value.files);
await flights[Symbol.asyncDispose]();
await rm(directory, { recursive: true, force: true });
```

Output:

```
true 42
```

A codec that cannot encode the value fails the flight for all callers. A codec that cannot decode the text fails only the call that decodes it.

## Cancel a wait

Give a signal to stop the wait of one caller: `flights.run(key, work, { signal: AbortSignal.timeout(30_000) })`. The call rejects with the reason of the signal. The flight continues for the other callers. When the caller of the leader cancels, the work continues and lands for the joiners. A call whose signal aborted before the call rejects at once: it never leads and never joins. [ADR 0004](./docs/adr/0004-a-cancel-withdraws-only-its-caller.md) tells why.

## When a process stops

A leader keeps its flight while its process lives. Before its work starts, the leader takes a kernel lock on its key, the key lock. It frees the key lock only when its work settled and its flight needs nothing more from it: the coordinator acknowledged its landing, its lease was lost, or its `SingleFlight` closed. The kernel keeps the key lock while the process lives, also while the process is frozen, and it frees the key lock when the process dies. Thus no other process starts the work of the key beside it. [ADR 0010](./docs/adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md) tells why.

- **The process of a leader stops.** The coordinator tells each joiner that the flight is interrupted, and each joiner rejects with `FlightInterruptedError` at once. No joiner runs the work again. The kernel frees the key lock, and the next call of the key leads a new flight.
- **A leader disposes its `SingleFlight` while its work runs.** The coordinator interrupts the flight, because a disposed leader cannot send its outcome. Each joiner rejects with `FlightInterruptedError`. The work continues, and the leader keeps the key lock until the work ends. A call of the key in another process waits until then, and then it leads a new flight.
- **The coordinator stops or disposes.** The other processes elect a new coordinator, and it answers at once:
  - Each leader reasserts its flight, and sends its landing again when it has one.
  - Each joiner rejoins its flight by the flight's token, and it gets the outcome of that flight.
  - A new call of a key that no process holds leads or joins at once.
  - A new call or a rejoin of a key whose key lock another process holds, while the new coordinator knows no flight of the key, waits. When the leader reasserts its flight, the call or the rejoin joins it. When the key lock frees first, the call leads, and the rejoin gets `FlightInterruptedError`.
- **The coordinator is frozen or busy past its lease duration, for example stopped by a debugger or in a long synchronous step.** The coordinator sends a heartbeat on the pipe of its election. A process that hears no heartbeat for longer than the `leaseDuration` of the coordinator ends the process of the coordinator. Then the other processes elect a new coordinator, as when the coordinator stops. Set `leaseDuration` above the longest pause of your processes. [ADR 0011](./docs/adr/0011-a-follower-observes-the-coordinator-so-a-frozen-coordinator-is-ended.md) tells why.
- **A leader is frozen or busy, for example stopped by a debugger or in a long synchronous step.** When its process is not the coordinator, it keeps its flight and its key lock. When the coordinator stops in that time, the calls of the key wait. When the leader continues, it reasserts its flight, and the calls that waited join it. When its process dies instead, the kernel frees the key lock, the joiners get `FlightInterruptedError`, and the next call leads. When its process is the coordinator, a process ends it after the lease duration, as the item above tells, with the same result.
- **A leader loses its lease.** This occurs only when a new coordinator refuses its reassert, because it knows a newer flight of the key, or when this process cannot connect to a coordinator again. The signal of the lease aborts with `LeaseLostError`, and the call of the leader rejects with that error. When the work throws its own error after the loss, the call rejects with a new `LeaseLostError`, and the error of the work is its `cause`. Thus `LeaseLostError` tells the leader that its outcome reached no joiner. Its joiners get `FlightInterruptedError`. The leader keeps the key lock until its work ends, so the next flight of the key runs after it, not beside it. [ADR 0007](./docs/adr/0007-a-work-error-after-a-lost-lease-rejects-with-leaselosterror.md) tells why.
- **A joiner's leader and the coordinator stop together.** The joiner gets `FlightInterruptedError` from the new coordinator. It never runs the work again.

A call that was on its way to a coordinator that stopped joined nothing. It goes again to the next coordinator as a new call. [ADR 0005](./docs/adr/0005-a-joiner-rejoins-its-flight-by-its-token.md) tells why.

### How long a call waits

- A call of a key waits with no limit while a process that lives holds the key lock, for example a frozen leader, or a leader whose work does not end. To set a limit, give a `signal`. A call of another key does not wait for it.
- A leader frees the key lock only when it reads the acknowledgment of its landing. A new call of the same key in the process of the leader waits in that process until the key lock frees, and then goes to the coordinator. Thus two flights of one key in one process follow each other with no wait. A call of the key from another process that comes before the key lock frees waits for one more check of the key lock, about 10 ms.

## Move a program from 0.3.x to this version

Version 0.3.13 to 0.3.15 had a pull design. These parts changed:

- `SharedFlight`, `FlightRecords` and `FileFlightRecords` are gone. Each `SingleFlight` now works across processes. Give it a `directory` and a `codec`.
- `parse` is gone. The `codec` replaces it.
- The records, `keepFor` and `pollInterval` are gone. The coordinator pushes each outcome, so nothing is kept and nothing is read again. `FlightOutcomeLostError` is gone too.
- A joiner in the leader's own process now gets `FlightFailedError`, not the original error of the work. Each caller goes through the coordinator.
- The signal that told the work that all its callers left is gone. The work gets the lease of the flight.
- A caller whose signal aborted before the call rejects at once.
- A joiner of an interrupted flight no longer continues with the next flight of the key. It gets `FlightInterruptedError`.

## Errors

| Error                                    | When                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The original error of the work           | The caller is the leader, and its work threw.                                                                                                                                                                              |
| `FlightFailedError`                      | The caller is a joiner, and the work of its leader threw, or `encode` threw in the leader.                                                                                                                                 |
| `FlightInterruptedError`                 | The caller is a joiner, and its flight is interrupted: the leader's process stopped, or the leader lost the lease.                                                                                                         |
| `LeaseLostError`                         | The caller is the leader, and it lost the lease: the call rejects with the reason of the lease's signal. When its work then threw, the call rejects with a new `LeaseLostError`, and its `cause` is the error of the work. |
| The error of `encode`                    | The caller is the leader, and `encode` threw.                                                                                                                                                                              |
| The error of `decode`                    | The caller's own `decode` threw. Only that caller rejects.                                                                                                                                                                 |
| `ProtocolVersionError`                   | Each caller: the coordinator speaks another protocol version.                                                                                                                                                              |
| `NetworkDirectoryError`                  | Each caller: the directory is on a network file system.                                                                                                                                                                    |
| `Error('This single flight is closed.')` | Each caller: the `SingleFlight` is disposed.                                                                                                                                                                               |

A joiner in the leader's own process is a joiner too: it gets `FlightFailedError`, not the original error. `FlightFailedError` has the `key` and the `failure`: the `name`, the `message` and the `code` of the error. A thrown value that is not an error keeps only its text.

`LeaseLostError` is the class of [`@zukhruf/lease`](../lease/README.md). This package exports it too, because the call of a leader rejects with it.

## Who uses it

| Consumer                       | How                                                                                                                                                                                                                                                                                                                                                                                                                              | Record                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| context-compiler `apps/cli`    | `new SingleFlight<readonly SyncLine[]>({ directory: this.root, codec: { encode: JSON.stringify, decode: JSON.parse }, clock: globalThis })` in `src/imports.ts`. A `sync` runs the pass of each import in the flight whose key is the folder of the import. A second `sync` joins it and shows the lines of the joined pass. It replaced the busy outcome of the pass lock of `SQLitePasses`, which made a second `sync` exit 1. | context-compiler d40b2e2 |
| context-compiler `apps/server` | `SingleFlight<void>` with `codec: { encode: () => '', decode: () => undefined }` in `src/plugin.ts`, with the folder of the import as the key. A second chat server joins the pass in progress instead of skipping it. To remove a stale import, it leads the flight of the folder, and a call that joins gives up the wait at once (`onJoin` aborts its `signal`).                                                              | context-compiler d40b2e2 |
| elt `apps/web`                 | `SingleFlight<void>` in `src/flights.ts`, in the folder `flights` of the app's data. `POST /sync` runs the flight `'sync'` and `POST /clear` runs the flight `'clear'`. It replaced the `exclusive()` check that refused a second Sync or Clear with 409.                                                                                                                                                                        | elt 27845820             |

## API

```ts
interface Codec<T> {
  encode(value: T): string;
  decode(text: string): T;
}

interface SingleFlightOptions<T> {
  directory: string; // a local folder; no default
  codec: Codec<T>;
  clock: Clock; // @zukhruf/async: globalThis in production, a fake clock in a test
  leaseDuration?: number; // default: 15000
}

interface RunOptions {
  onJoin?: (() => void) | undefined; // once, when this caller joins
  signal?: AbortSignal | undefined; // cancels the wait of this caller only
}

interface FlightValue<T> {
  readonly value: T;
  readonly joined: boolean; // false for the leader, true for each joiner
}

class SingleFlight<T> implements AsyncDisposable {
  constructor(options: SingleFlightOptions<T>);
  run(
    key: string,
    work: (lease: FencedLease) => Promise<T>, // FencedLease of @zukhruf/fencing
    options?: RunOptions,
  ): Promise<FlightValue<T>>;
  [Symbol.asyncDispose](): Promise<void>;
}

// A leader's error as text, because an Error object cannot cross a process boundary.
interface Failure {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

class FlightFailedError extends Error {
  constructor(key: string, failure: Failure);
  readonly key: string;
  readonly failure: Failure;
}

class FlightInterruptedError extends Error {
  constructor(key: string);
  readonly key: string;
}

class ProtocolVersionError extends Error {
  constructor(ours: number, theirs: number);
  readonly ours: number; // the protocol of this process
  readonly theirs: number; // the protocol of the coordinator
}

export { NetworkDirectoryError } from '@zukhruf/fs';
export { LeaseLostError } from '@zukhruf/lease';
```

## Documentation

**Recipes**

- [Join a run that is still in flight](./docs/recipes/join-a-run-in-flight.md): three processes, one sync.
- [Run the work only when no flight of the key runs](./docs/recipes/run-the-work-only-when-no-flight-of-the-key-runs.md)

**Decisions**

- [ADR 0003](./docs/adr/0003-a-caller-leads-or-joins-in-one-request-to-an-elected-coordinator.md): a caller leads or joins in one request to an elected coordinator.
- [ADR 0004](./docs/adr/0004-a-cancel-withdraws-only-its-caller.md): a cancel withdraws only its caller.
- [ADR 0005](./docs/adr/0005-a-joiner-rejoins-its-flight-by-its-token.md): a joiner rejoins its flight by its token.
- [ADR 0006](./docs/adr/0006-the-election-and-the-connection-are-a-copy-of-the-mutex-code.md): the election and the connection are a copy of the mutex code.
- [ADR 0007](./docs/adr/0007-a-work-error-after-a-lost-lease-rejects-with-leaselosterror.md): a work error after a lost lease rejects with LeaseLostError.
- [ADR 0008](./docs/adr/0008-a-connection-closes-only-when-its-framing-breaks.md): a connection closes only when its framing breaks.
- [ADR 0010](./docs/adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md): a leader holds a kernel lock on its key until its outcome is handed over.
- [ADR 0011](./docs/adr/0011-a-follower-observes-the-coordinator-so-a-frozen-coordinator-is-ended.md): a follower observes the coordinator, so a frozen coordinator is ended.
- Superseded: [ADR 0001](./docs/adr/0001-a-joiner-follows-its-flight-record-without-acquiring-the-key.md), [ADR 0002](./docs/adr/0002-a-flight-that-all-callers-left-is-abandoned.md) and [ADR 0009](./docs/adr/0009-the-next-coordinator-skips-the-grace-window-after-a-clean-shutdown.md).

**Copied code**: [Code copied from the mutex](./docs/copied-from-mutex.md): each copied file, what changed, and why; the rules that the single flight shares with the mutex; and the code that is in two places inside the single flight.

## Development

This package is part of the [zukhruf](../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run single-flight:test        # builds, then runs the tests in src/
npx nx run single-flight:typecheck   # formats, lints, then type checks
npx nx run single-flight:build       # compiles src/ to dist/
```

The tests run from `src/`, not from `dist/`. The tests across processes start the script of `src/testing/caller.ts` in child processes.

```
src/
  single-flight.ts      SingleFlight: each call goes to the coordinator
  codec.ts              the Codec interface
  errors.ts             FlightFailedError, FlightInterruptedError
  client/               the requests of one process: runs, leads, landings
  coordinator/          the coordinator of one term: flights, sessions, parked runs, its server
  key-lock/             the key locks: the kernel lock on each key that a leader holds
  protocol/             the messages between a process and its coordinator
  connection/           the socket, the handshake and the supervisor (a copy); the election of the directory (@zukhruf/election)
  shared/               the record check (a copy); file writes and the network directory check are in @zukhruf/fs
  testing/              the caller process that the tests start
```
