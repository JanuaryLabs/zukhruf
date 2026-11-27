# @zukhruf/election

Candidates campaign for one claim, and the candidate that wins it leads for one term. Each term has an epoch that is higher than the epoch of each earlier term, so a newer leader always outranks an older one. A term is a lease on leadership. It ends when the leader resigns or its process dies. With a backend that can take the claim away, a term can also be lost while the leader still runs, and the signal of the term tells its leader so.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment.

```sh
npm install @zukhruf/election
```

## Elect a leader of one host

`SqliteElection` elects one leader among the processes of one host that use the same directory. The claim is the `FileLock` of `@zukhruf/fs` on `claimFile`: an exclusive SQLite transaction. The operating system holds that lock until the leader's process dies, so a dead leader frees the claim at once, and a living leader never loses it.

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteElection } from '@zukhruf/election';

const directory = await mkdtemp(join(tmpdir(), 'jobs-'));
const election = new SqliteElection({
  clock: globalThis,
  directory,
  claimFile: 'jobs.lock',
  epochFile: 'jobs.epoch',
});

const first = await election.campaign();
console.log('first term:', first?.epoch);
console.log('a second candidate wins:', await election.campaign());

await first?.resign();
await using second = await election.campaign({ timeout: 1000 });
console.log('next term:', second?.epoch);
await rm(directory, { recursive: true, force: true });
```

Output:

```
first term: 1n
a second candidate wins: undefined
next term: 2n
```

- `campaign({ timeout, signal })` resolves with a `Term`, or with `undefined` when another candidate still leads after `timeout` milliseconds. Without a `timeout`, it tries once. With `timeout: Infinity`, it waits until it wins or `signal` aborts. When `signal` aborts, it rejects with `signal.reason`, and a claim that it won meanwhile is given up.
- `claimFile` and `epochFile` are files in `directory`. Candidates with the same directory and the same file names are one group. Never delete `claimFile` while candidates run: a new file lets a second leader win.
- `election.name` is the path of `claimFile`: `join(directory, claimFile)`. Two elections with the same name are one election. A warning names the election by its name ([ADR 0010](./docs/adr/0010-an-election-has-a-name-and-the-name-of-a-sqlite-election-is-the-path-of-its-claim-file.md)).
- Each epoch of a `SqliteElection` is below 2^31, so `EpochTokenSource` of `@zukhruf/fencing` takes it. When `epochFile` holds 2^31 - 1, the next epoch would be 2^31: then `campaign` rejects with a `RangeError` that names the file, gives the claim up, and does not change the file ([ADR 0011](./docs/adr/0011-a-leader-selector-runs-a-task-each-time-it-wins-a-term-of-a-leader-election.md)).
- `epochFile` holds the epoch of the last term as decimal digits. When it holds other text, `campaign` rejects with a `SyntaxError` that names the file, gives the claim up, and does not change the file. An example is the empty file that `@zukhruf/mutex` 0.2.0 or earlier can leave after a power loss, because those versions did not sync the file to the disk. Thus the epochs never start again at 1, and each new term has a higher epoch than each earlier term.
- `lastEpoch()` resolves with the epoch of the last term in `epochFile`, or with `0n` when no term was won yet. It only reads the file. It does not campaign, it does not take the claim, and it does not create a file or the directory. Use it to find out if a value from an earlier term is stale, for example a fencing token that an old leader made with `EpochTokenSource`. A new term can start immediately after the read, so the answer can be old when you get it. When `epochFile` holds text that is not decimal digits, `lastEpoch()` rejects with the same `SyntaxError` as `campaign`. When it cannot read the file for another reason, it rejects with that error. It never answers `0n` for a file that it cannot read.
- A term that resigns clean writes a third file, `<claimFile>.clean`, beside `claimFile`. It holds the epoch of that term. The next term reads it and removes it.
- The directory must be on a local file system. On a network file system, `campaign` rejects with `NetworkDirectoryError`.
- A try never blocks the process. Between two tries, a candidate waits on pushes from the leader, not on a period ([A leader that hangs](#a-leader-that-hangs)).
- `clock` is the clock that the campaign waits on, and that measures its `timeout`, the heartbeats of a leader and the deadline of a reader. It is required. Give `globalThis` in production. A test gives a fake clock, for example `createClock()` of `@sinonjs/fake-timers`, and moves the time of the campaign without a real wait ([`@zukhruf/async`](../async/README.md#run-a-wait-on-a-clock)).
- To run a job each time this process leads, and to campaign again after each term, use a `LeaderSelector`. It resigns the term when the job ends, and its dispose waits for the job ([Run a task each time this process leads](#run-a-task-each-time-this-process-leads)).

## A leader that hangs

A hung leader keeps the claim of `SqliteElection`: a leader that `SIGSTOP` stopped, or a leader whose event loop is blocked. The kernel frees the claim only when the process ends. Thus the leader pushes a heartbeat on a pipe, a candidate waits on that pipe, and a candidate ends a leader that is silent for too long. A candidate waits as etcd's `Campaign` and ZooKeeper's leader election recipe wait: on a push, not on a period ([ADR 0007](./docs/adr/0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md)).

```ts
const election = new SqliteElection({
  clock: globalThis,
  directory,
  claimFile: 'jobs.lock',
  epochFile: 'jobs.epoch',
  leaseDuration: 15_000, // the default
  heartbeatInterval: 5_000, // the default: a third of leaseDuration
});

await using term = await election.campaign({ timeout: Infinity, signal });
```

- **The pipe.** The winner of a claim serves a pipe of [`@zukhruf/pipes`](../pipes/README.md) for its term. It sends a heartbeat on each connection when it accepts it, and then every `heartbeatInterval` until the term closes, also when a subclass overrides `watch` ([ADR 0004](./docs/adr/0004-a-leader-renews-its-term-with-a-heartbeat-on-a-pipe-that-it-serves.md)).
- **The leader record.** The winner writes `<claimFile>.leader` beside `claimFile`, before its term begins. It holds the epoch of the term, the process id of the leader, the address of its pipe, and its `leaseDuration`. The winner first removes the socket file of the pipe that the old record names, which a killed leader leaves ([ADR 0005](./docs/adr/0005-the-leader-record-names-the-process-and-the-pipe-of-a-term.md)).
- **The wait.** A candidate tries the claim. When another candidate holds it, the candidate reads the record, connects to the pipe, and waits. The close of the pipe tells it that the leader left, and it tries at once. A candidate under a healthy leader makes no try ([ADR 0007](./docs/adr/0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md)).
- **A hung leader.** A candidate that hears no heartbeat for the `leaseDuration` of the record sends `SIGKILL` to the process of the record, but only while it holds that process's pipe open. The kernel frees the claim and closes the pipe, and the candidate tries. The kernel refuses the kill for a process of another user: then the candidate ends nothing, and it waits for the close until its `timeout`. A reader never ends its own process, in the same way ([ADR 0006](./docs/adr/0006-a-candidate-ends-a-leader-that-is-silent-past-the-lease-duration.md)).
- **A pipe that a candidate cannot connect to.** A connect that rejects with `NoServerError` of [`@zukhruf/pipes`](../pipes/README.md#errors) comes while a new leader starts, or under a published leader. On Linux it also comes when the leader closes its pipe during the connect (#5317). A connect that rejects with `EAGAIN`, on Linux when the listen queue of a hung leader's pipe is full, and one that rejects with `EACCES`, for a pipe of another user, come while a leader serves, but the candidate cannot hold a connection to its pipe (#5425). After each of them, the candidate waits a back-off and tries again: 25 ms first, then 1.6 times longer each time, with a jitter of ±20 %, at most 1000 ms.
- **An observer.** `election.observe()` returns a `LeaderObserver` for a process that does not campaign. It holds a connection to the leader's pipe and ends a silent leader as a candidate does. `observer.left` resolves `'closed'` when the leader left, `'ended'` when the observer ended it, and `'absent'` when it held no connection to a leader's pipe: no leader served one, the pipe was another user's, or its listen queue was full. It rejects with any other error. Dispose it to close the connection; then `left` does not settle. Its connection and its deadline do not keep the process alive. One observer reads one term ([ADR 0009](./docs/adr/0009-a-process-that-does-not-campaign-observes-the-leader.md)).
- `leaseDuration` is the longest silence, in milliseconds, that a candidate or an observer accepts from the leader. It defaults to 15000, as the `LeaseDuration` of Kubernetes. A reader uses the value in the record, so the leader decides it.
- `heartbeatInterval` is the time between two heartbeats, in milliseconds. It defaults to a third of `leaseDuration`, as etcd's client sends a keepalive every TTL / 3. The name is etcd's `heartbeat-interval`.
- The constructor throws a `RangeError` unless `0 < heartbeatInterval < leaseDuration`.
- The pipe, its connections and the heartbeat timer of a leader do not keep its process alive. A waiting candidate keeps its process alive until the campaign ends.
- Run the candidates of one group as one user, in one PID namespace, with one `/tmp`. A candidate that runs as root can end a leader of any user.
- With `SqliteElection`, a hung leader never runs again after a takeover: a new term starts only after the old process ended. A leader that runs again before its deadline still leads, and its `term.signal` does not abort.

## The term

A term is a lease on leadership. `Term` implements the `Lease` interface of [`@zukhruf/lease`](../lease/README.md), so a function that takes a `Lease` also takes a term. See the glossary of [leases](../lease/CONTEXT.md).

- `term.epoch` is the number of the term. It is higher than the epoch of each earlier term of the election. The epoch of a `SqliteElection` is below 2^31.
- `term.resign()` ends the term and gives the claim up. A second call waits for the first, and its options do nothing. `await using` resigns at the end of its scope. When the release fails, the claim is still freed, and `resign` rejects with the release's error. When the release or the record of `clean` fails and freeing the claim fails too, `resign` rejects with a `SuppressedError`: its `suppressed` is that step's error, and its `error` is the failure to free. After a loss, `resign` never rejects, and the term still ends: a failure to stop watching the claim or to free it has no caller to go to, so it is a `TermWarning` (see [Errors](#errors)). When both fail, the warning's `cause` is a `SuppressedError`: its `suppressed` is the failure to stop watching, and its `error` is the failure to free.
- `term.resign({ clean: true })` records a clean shutdown for the next term, and then ends the term. Use it only when the leader leaves nothing for the next term to recover, for example no work in progress. A lost term records nothing, also with `clean`. When the record fails, the claim is freed, and `resign` rejects with that error. The socket lock store of `@zukhruf/mutex` resigns clean when no process holds a key ([its ADR 0018](../mutex/docs/adr/0018-the-next-leader-skips-the-grace-window-after-a-clean-shutdown.md)). `@zukhruf/single-flight` no longer records a clean shutdown, because its coordinator has no grace window to skip ([its ADR 0010](../single-flight/docs/adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md)).
- `term.afterCleanShutdown` is `true` only when the term just before this one resigned clean. Then the new leader knows that it has nothing to recover. It is `false` after a crash, after a lost term, after a resign without `clean`, and for the first term.
- `term.signal` aborts with `LeaseLostError` when the term is lost while its leader still runs. The `subject` of the error is `'leadership'`, and its `cause` is the reason of the backend. The signal does not abort when the leader resigns.

A leader that acts for the group must stop when `term.signal` aborts, because another candidate can lead then. `SqliteElection` never loses a living term, so its signal never aborts. A backend that can take the claim away can lose one.

A term has no fencing token. The signal warns the leader, but it does not protect a resource: a leader can write after another candidate won. To protect a resource, make fencing tokens from the epoch with `EpochTokenSource` of [`@zukhruf/fencing`](../fencing/README.md). It takes an epoch below 2^31, as each epoch of `SqliteElection` is, and throws a `RangeError` for a higher one. Then a resource can refuse the writes of an older leader:

```ts
import { EpochTokenSource } from '@zukhruf/fencing';

const tokens = new EpochTokenSource(term.epoch);
const token = await tokens.next('orders');
```

[ADR 0002](./docs/adr/0002-a-term-is-a-lease-on-leadership-with-no-fencing.md) tells why.

## Run a task each time this process leads

Some work must run in only one process of a group, for the whole life of each process: a writer of a warehouse, a cleanup, a poll of a queue. `LeaderSelector.start(election, listener, options)` campaigns with no time limit, runs `listener.takeLeadership(term, signal)` while the term lasts, and resigns the term when the task ends. With `autoRequeue`, it campaigns again, until its dispose. It is Apache Curator's `LeaderSelector`, over a `LeaderElection` as client-go's `LeaderElector` is over a `resourcelock.Interface` ([ADR 0011](./docs/adr/0011-a-leader-selector-runs-a-task-each-time-it-wins-a-term-of-a-leader-election.md)).

```ts title="leader.ts"
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Backoff } from '@zukhruf/async';
import {
  LeaderSelector,
  type LeaderSelectorListener,
  SqliteElection,
} from '@zukhruf/election';

const directory = await mkdtemp(join(tmpdir(), 'writer-'));
const election = () =>
  new SqliteElection({
    clock: globalThis,
    directory,
    claimFile: 'writer.lock',
    epochFile: 'writer.epoch',
  });
const autoRequeue = {
  backoff: new Backoff({
    initial: 1_000,
    multiplier: 2,
    max: 60_000,
    jitter: { kind: 'full' },
  }),
  clock: globalThis,
};
const writer = (name: string): LeaderSelectorListener => ({
  takeLeadership: async (term, signal) => {
    console.log(`${name} leads in term ${term.epoch}`);
    // Write until the selector stops the task: a dispose, an interrupt or a loss.
    while (!signal.aborted) await delay(100);
    console.log(`${name} resigns`);
  },
});

const first = LeaderSelector.start(election(), writer('first'), {
  autoRequeue,
});
await delay(150);
const second = LeaderSelector.start(election(), writer('second'), {
  autoRequeue,
});
await delay(150);
await first[Symbol.asyncDispose](); // The standby leads at once.
await delay(150);
await second[Symbol.asyncDispose]();
await rm(directory, { recursive: true, force: true });
```

Output:

```
first leads in term 1
first resigns
second leads in term 2
second resigns
```

The signal of the task aborts at the dispose, at `interruptLeadership()`, and when the term is lost. Return, or reject with `signal.reason`, to give the leadership up. After each round:

| The round ends because                                           | With `autoRequeue`                                                                                                                                                                           | Without `autoRequeue`                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| The dispose aborted the selector, in the campaign or in the task | The selector ends, after it resigned the term. `ended` resolves.                                                                                                                             | The same.                                                           |
| The term was lost, or `interruptLeadership()` aborted the task   | The next round starts at once, with no wait.                                                                                                                                                 | The selector waits for `requeue()`.                                 |
| The task resolved                                                | The next round starts at once.                                                                                                                                                               | The selector waits for `requeue()`.                                 |
| The task rejected                                                | The selector ends, after it resigned the term. `ended` and the dispose reject with the failure.                                                                                              | The same.                                                           |
| The resign failed after the task resolved                        | The selector ends with that failure. `ended` and the dispose reject with it.                                                                                                                 | The same.                                                           |
| The campaign failed                                              | A `LeaderSelectorWarning` (see [Errors](#errors)), then a wait of `backoff.duration(retries)` on `clock`, then the next campaign. `retries` counts the failed campaigns since the last term. | The selector ends. `ended` and the dispose reject with the failure. |

- **Each backend.** `start` takes a `LeaderElection`, so the selector leads over each backend: `SqliteElection` among the processes of one host, or a backend of your own ([Write a backend](#write-a-backend)). The task gets the `Term`, with its epoch.
- **A task that ends after a loss has a loss.** When the term is lost, a task that resolves or rejects after it ends the round as a loss, not as a failure.
- **The dispose waits.** It aborts the selector, and waits until the task ended and the term was resigned, so a standby takes over before this process exits. A second dispose waits for the first. Keep the selector in the `AsyncDisposableStack` of the program. It runs its rounds in a `BackgroundService` of [`@zukhruf/async`](../async/README.md#own-work-that-runs-until-you-stop-it-with-a-background-service).
- **A failure ends the selector.** The selector does not run a failed task again. The owner decides what comes next, for example `process.exit(1)`, so that the platform restarts the process.
- **`requeue()`** queues one more round of a selector without `autoRequeue`. It returns `false` while a round is queued or runs, and throws after the dispose and after a failure ended the selector. `hasLeadership` is true while `takeLeadership` runs.
- **With `autoRequeue`, the selector campaigns again after each failed campaign**, also after a fault that stays, as client-go tries again each `RetryPeriod` and Curator's `autoRequeue` "should ignore connection loss or session expired and just keep trying". A `NetworkDirectoryError` of `SqliteElection` stays, so check the directory with `assertLocalDirectory` of [`@zukhruf/fs`](../fs/README.md) before the start.

See the recipe [Run a job in only one process](./docs/recipes/run-a-job-in-only-one-process.md).

## Write a backend

`LeaderElection` is an abstract class. It runs the campaign, and it owns the term. Its constructor takes the name of the election and the clock. The name is the identity of the election in its backend: two elections with the same name are one election. Derive it from the claim, so that it cannot disagree with the claim ([ADR 0010](./docs/adr/0010-an-election-has-a-name-and-the-name-of-a-sqlite-election-is-the-path-of-its-claim-file.md)). A backend is a subclass that implements seven steps for its claim ([ADR 0008](./docs/adr/0008-the-backend-owns-the-wait-between-two-tries-and-poll-leaves-the-campaign.md)): `MutexElection` of [`@zukhruf/mutex`](../mutex/README.md#elect-a-leader-with-a-key) is a backend over a key of the mutex, so each lock store can hold the claim ([mutex ADR 0036](../mutex/docs/adr/0036-a-key-is-a-backend-of-leader-election.md)).

| Step                                | What it does                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open(signal)`                      | Prepares one attempt, for example a connection. The campaign calls `tryClaim` on it again and again.                                                  |
| `tryClaim(claim, signal)`           | Tries the claim once. Resolves with `{ epoch, afterCleanShutdown }` for the term it won, or with `undefined` while another candidate holds the claim. |
| `waitForChange(claim, signal)`      | Resolves when a try of the claim can win: the holder left, was ended, or the backend wants a new try. Settles when `signal` aborts.                   |
| `watch(claim, lose)`                | Watches a won claim for as long as its term lasts. Calls `lose` when the backend takes the claim away. Returns a `Disposable` that stops the watch.   |
| `recordCleanShutdown(claim, epoch)` | Records that the term of `epoch` resigned clean. The campaign calls it before `release`, while the term still holds the claim.                        |
| `release(claim)`                    | Gives a won claim up when the leader resigns.                                                                                                         |
| `close(claim)`                      | Frees the resources of an attempt, at each end.                                                                                                       |

A backend must keep six rules:

1. `tryClaim` gives the epoch in the same step that wins the claim. Each epoch is higher than each earlier one. A backend whose epoch feeds `EpochTokenSource` keeps it below 2^31, as `SqliteElection` does ([ADR 0011](./docs/adr/0011-a-leader-selector-runs-a-task-each-time-it-wins-a-term-of-a-leader-election.md)).
2. `tryClaim` gives `afterCleanShutdown: true` only when the term just before this one recorded a clean shutdown. It reads each record one time only. Thus a crash after a clean term never reads as clean.
3. `watch` calls `lose` before the backend can give the claim to another candidate. For a claim that the backend keeps only for a time, renew it well before that time ends, and count the time on a monotonic clock. Then an old leader stops before a new one starts.
4. The campaign never calls `recordCleanShutdown` or `release` after a loss, because the claim can be another candidate's then.
5. The campaign calls `close` after each end: a won term, a lost term, a failed attempt, or an attempt that never won. When a step fails and `release` or `close` fails too, the campaign rejects with a `SuppressedError`: its `suppressed` is the step's error, and its `error` is the failure to give the claim up or free it.
6. `waitForChange` settles when its signal aborts, and it never ends the attempt itself. The campaign aborts that signal at its `timeout`, and then it tries one last time. A backend with no push polls in its own `waitForChange`, for example with `delay` of `@zukhruf/async`.

This backend elects among the candidates of one process. Its claim is an entry in a map, and it has no push, so it polls:

```ts
import { delay } from '@zukhruf/async';
import { LeaderElection } from '@zukhruf/election';

const holders = new Map<string, bigint>();
const cleanShutdowns = new Set<string>();
let lastEpoch = 0n;

class MapElection extends LeaderElection<string> {
  readonly #name: string;

  constructor(name: string) {
    super(name, globalThis);
    this.#name = name;
  }

  protected async open() {
    return this.#name;
  }

  protected async tryClaim(name: string) {
    if (holders.has(name)) return undefined;
    // Only the holder records, and each claim removes the record. Thus a
    // record is always from the term just before this one.
    const afterCleanShutdown = cleanShutdowns.delete(name);
    lastEpoch += 1n;
    holders.set(name, lastEpoch);
    return { epoch: lastEpoch, afterCleanShutdown };
  }

  // A resign deletes the entry, but nothing tells the waiting candidates.
  protected waitForChange(_name: string, signal: AbortSignal) {
    return delay(10, { clock: this.clock, signal });
  }

  // Nothing takes an entry of the map away, so there is nothing to watch.
  protected watch() {
    return { [Symbol.dispose]() {} };
  }

  protected async recordCleanShutdown(name: string) {
    cleanShutdowns.add(name);
  }

  protected async release(name: string) {
    holders.delete(name);
  }

  protected async close() {}
}

const term = await new MapElection('jobs').campaign();
console.log('leader:', term?.epoch);
console.log('rival:', await new MapElection('jobs').campaign());
await term?.resign({ clean: true });
const next = await new MapElection('jobs').campaign();
console.log('rival after the resign:', next?.epoch);
console.log('after a clean shutdown:', next?.afterCleanShutdown);
```

Output:

```
leader: 1n
rival: undefined
rival after the resign: 2n
after a clean shutdown: true
```

The socket lock store of `@zukhruf/mutex` uses `SqliteElection`, with the claim file `leader.lock` and the epoch file `leader.epoch`. Its leader serves the other candidates over a socket in the directory, so it works on one host only, also with another backend. Its server stops when `term.signal` aborts. `@zukhruf/single-flight` uses `SqliteElection` the same way, with the claim file `flight.lock` and the epoch file `flight.epoch`, so the two packages never join one election in a shared directory.

## Errors

| Error                          | When                                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NetworkDirectoryError`        | The directory of a `SqliteElection` is on a network file system. It is the class of `@zukhruf/fs`.                                                                                                                                                             |
| `LeaseLostError`               | The reason of `term.signal` when the backend took the claim away. Its `subject` is `'leadership'`, and its `cause` is the backend's reason. It is the class of `@zukhruf/lease`, and this package exports it too.                                              |
| `signal.reason`                | A campaign rejects with it when its signal aborts.                                                                                                                                                                                                             |
| `SuppressedError`              | A campaign or a resign rejects with it when a step failed and giving the claim up or freeing it failed too. Its `suppressed` is the step's error, and its `error` is the failure to free.                                                                      |
| `RangeError`                   | A campaign of a `SqliteElection` rejects with it when the next epoch would be 2^31 or more. The message names `epochFile`.                                                                                                                                     |
| The failure of a leader's task | `ended` and the dispose of a `LeaderSelector` reject with the error of a task that failed, of a resign that failed, and, without `autoRequeue`, of a failed campaign. `requeue()` throws an `Error` after the dispose, and after a failure ended the selector. |

A failure that no caller waits for is a process warning, in the shape of [root ADR 0010](../../docs/adr/0010-a-package-warning-names-its-type-code-and-subject-and-keeps-the-failure-as-its-cause.md). A `'warning'` listener reads its type as `name`, its `code`, and its subject in `detail`, one `<term>: <value>` line each. Its `cause` is the failure, and its message ends with the failure's message. `--disable-warning=<code or type>` stops the print. `TermWarning` and `LeaderSelectorWarning` are classes that the package exports, so a listener can test `warning instanceof` the class ([root ADR 0011](../../docs/adr/0011-a-package-warning-is-an-instance-of-its-own-class-which-the-package-exports.md)). With two installed copies of the package, `instanceof` fails across the copies, so compare `code`.

| Warning                 | Code                                               | Detail                                  | When                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TermWarning`           | `ZUKHRUF_ELECTION_TERM_FREE_FAILED`                | `election: <name>` and `epoch: <epoch>` | A lost term fails to stop watching its claim or to free it. The term still ends. When both fail, the `cause` is a `SuppressedError`: its `suppressed` is the failure to stop watching, and its `error` is the failure to free. |
| `LeaderSelectorWarning` | `ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED` | `election: <name>`                      | A campaign of a `LeaderSelector` with `autoRequeue` fails. The selector waits `backoff.duration(retries)`, and campaigns again.                                                                                                |

## API

```ts
interface CampaignOptions {
  timeout?: number | undefined; // default: one try; Infinity: until it wins or signal aborts
  signal?: AbortSignal | undefined;
}

abstract class LeaderElection<Claim> {
  readonly name: string; // the identity of the election in its backend
  protected readonly clock: Clock;
  protected constructor(name: string, clock: Clock);
  campaign(options?: CampaignOptions): Promise<Term | undefined>;
  protected abstract open(signal: AbortSignal | undefined): Promise<Claim>;
  protected abstract tryClaim(
    claim: Claim,
    signal: AbortSignal | undefined,
  ): Promise<Pick<Term, 'epoch' | 'afterCleanShutdown'> | undefined>;
  protected abstract waitForChange(
    claim: Claim,
    signal: AbortSignal,
  ): Promise<void>;
  protected abstract watch(
    claim: Claim,
    lose: (reason: Error) => void,
  ): Disposable;
  protected abstract recordCleanShutdown(
    claim: Claim,
    epoch: bigint,
  ): Promise<void>;
  protected abstract release(claim: Claim): Promise<void>;
  protected abstract close(claim: Claim): Promise<void>;
}

interface ResignOptions {
  clean: boolean;
}

// The steps of the backend for the claim that a term won.
interface TermSteps {
  watch(lose: (reason: Error) => void): Disposable;
  recordCleanShutdown(): Promise<void>; // only for a term that was not lost, before release
  release(): Promise<void>; // only for a term that was not lost
  close(): Promise<void>; // at each end
}

class Term implements Lease, AsyncDisposable {
  constructor(
    {
      epoch,
      afterCleanShutdown,
      election, // the name of the election, for the detail of a warning
    }: Pick<Term, 'epoch' | 'afterCleanShutdown'> & { election: string },
    steps: TermSteps,
  );
  readonly epoch: bigint;
  readonly afterCleanShutdown: boolean;
  get signal(): AbortSignal; // aborts with LeaseLostError when the term is lost
  resign(options?: ResignOptions): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>; // resign()
}

interface LeaderSelectorListener {
  takeLeadership(term: Term, signal: AbortSignal): Promise<void>; // return, or reject with signal.reason
}

interface LeaderSelectorOptions {
  autoRequeue?: { backoff: Backoff; clock: Clock } | undefined; // without it: lead once, then wait for requeue()
}

class LeaderSelector implements AsyncDisposable {
  static start(
    election: LeaderElection<unknown>,
    listener: LeaderSelectorListener,
    options?: LeaderSelectorOptions,
  ): LeaderSelector;
  get hasLeadership(): boolean; // true while takeLeadership runs
  get ended(): Promise<void>; // rejects with the failure that ended the selector
  requeue(): boolean; // false while a round is queued or runs
  interruptLeadership(): void;
  [Symbol.asyncDispose](): Promise<void>; // waits for the task and the resign
}

class LeaderSelectorWarning extends Error {
  readonly code: 'ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED';
  readonly detail: string; // election: <name>
  constructor(failure: unknown, subject: { election: string });
}

class TermWarning extends Error {
  readonly code: 'ZUKHRUF_ELECTION_TERM_FREE_FAILED';
  readonly detail: string; // election: <name>, then epoch: <epoch>
  constructor(failure: unknown, subject: { election: string; epoch: bigint });
}

interface SqliteElectionOptions {
  directory: string;
  claimFile: string;
  epochFile: string;
  leaseDuration?: number | undefined; // default: 15000
  heartbeatInterval?: number | undefined; // default: leaseDuration / 3
  clock: Clock;
}

class SqliteElection extends LeaderElection<SqliteAttempt> {
  constructor(options: SqliteElectionOptions); // RangeError: unless 0 < heartbeatInterval < leaseDuration
  readonly name: string; // join(directory, claimFile)
  lastEpoch(): Promise<bigint>;
  observe(): LeaderObserver;
}

class LeaderObserver implements Disposable {
  get left(): Promise<'closed' | 'ended' | 'absent'>;
  [Symbol.dispose](): void;
}

export { NetworkDirectoryError } from '@zukhruf/fs';
export { LeaseLostError } from '@zukhruf/lease';
```

`campaign` builds the `Term` of a claim that it won, and gives it the backend's steps for that claim as `TermSteps` ([src/leader-election.ts](./src/leader-election.ts)). The term calls `watch` when it begins. When the leader resigns, it calls `recordCleanShutdown` (only with `clean: true`), `release` and `close`. After a loss, it calls only `close` ([src/term.ts](./src/term.ts)). `LeaderObserver` is exported as a type: `observe()` makes one.

## Documentation

- [How SqliteElection elects a leader](./docs/concepts/leader-election.md)
- [Recipe: Run a job in only one process](./docs/recipes/run-a-job-in-only-one-process.md), with `LeaderSelector`
- [Own one item at a time, and skip an item that another process owns](./docs/recipes/skip-work-that-another-process-owns.md)
- [ADR 0001: Leader election is a package, and each backend is a subclass of one campaign](./docs/adr/0001-leader-election-is-a-package-and-each-backend-is-a-subclass.md)
- [ADR 0002: A term is a lease on leadership, with no fencing](./docs/adr/0002-a-term-is-a-lease-on-leadership-with-no-fencing.md)
- [ADR 0003: A term that shuts down cleanly tells its successor](./docs/adr/0003-a-term-that-shuts-down-cleanly-tells-its-successor.md)
- [ADR 0004: A leader renews its term with a heartbeat on a pipe that it serves](./docs/adr/0004-a-leader-renews-its-term-with-a-heartbeat-on-a-pipe-that-it-serves.md) (proposed)
- [ADR 0005: The leader record names the process and the pipe of a term](./docs/adr/0005-the-leader-record-names-the-process-and-the-pipe-of-a-term.md) (proposed)
- [ADR 0006: A candidate ends a leader that is silent past the lease duration](./docs/adr/0006-a-candidate-ends-a-leader-that-is-silent-past-the-lease-duration.md) (proposed)
- [ADR 0007: A candidate waits on pushes from the leader's pipe, not on a period](./docs/adr/0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md) (proposed)
- [ADR 0008: The backend owns the wait between two tries, and poll leaves the campaign](./docs/adr/0008-the-backend-owns-the-wait-between-two-tries-and-poll-leaves-the-campaign.md) (proposed)
- [ADR 0009: A process that does not campaign observes the leader](./docs/adr/0009-a-process-that-does-not-campaign-observes-the-leader.md) (proposed)
- [ADR 0010: An election has a name, and the name of a SQLite election is the path of its claim file](./docs/adr/0010-an-election-has-a-name-and-the-name-of-a-sqlite-election-is-the-path-of-its-claim-file.md)
- [ADR 0011: A leader selector runs a task each time it wins a term of a leader election, over a `LeaderElection` only](./docs/adr/0011-a-leader-selector-runs-a-task-each-time-it-wins-a-term-of-a-leader-election.md)
- [Code copied into this package](./docs/copied-code.md)

## Development

This package is part of the [zukhruf](../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run election:test        # builds, then runs the tests in src/
npx nx run election:typecheck   # formats, lints, then type checks
npx nx run election:build       # compiles src/ to dist/
```

```
src/
  leader-election.ts     LeaderElection: the campaign, and the steps of a backend
  term.ts                Term: the epoch, the lease on leadership, and resign
  leader-selector.ts     LeaderSelector: a task each time this process wins a term
  sqlite/                SqliteElection: the backend of one host, its leader pipe,
                         its leader record, and the readers of the pipe
```
