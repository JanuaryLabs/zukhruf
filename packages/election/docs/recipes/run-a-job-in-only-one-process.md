# Recipe: Run a job in only one process

**Use case.** Three copies of your app run on one host. A background job, for example a cleanup, must run in only one copy. When that copy stops or crashes, another copy must start the job.

**What you need.** `LeaderSelector` of this package, over a `SqliteElection` ([how it elects a leader](../concepts/leader-election.md)). The selector campaigns, runs the job while its copy leads, resigns the term when the job ends, and campaigns again ([ADR 0011](../adr/0011-a-leader-selector-runs-a-task-each-time-it-wins-a-term-of-a-leader-election.md)).

## The steps

1. Each copy creates a `SqliteElection` with the same directory, claim file and epoch file.
2. Each copy starts a `LeaderSelector` over the election, with `autoRequeue`, and keeps it in an `await using` scope.
3. The copy that wins runs the job in `takeLeadership` until its signal aborts.
4. When the leader crashes, the kernel ends its term. When it stops, the dispose of its selector resigns the term. A waiting copy then wins the next term.

## The program

This program starts three candidates. It kills the first leader with `SIGKILL`, stops the second leader with `SIGTERM`, and shows the three terms.

```ts title="singleton-job.ts"
import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Backoff } from '@zukhruf/async';
import { LeaderSelector, SqliteElection } from '@zukhruf/election';

const [role, shared] = process.argv.slice(2);

if (role === 'candidate') {
  const stop = Promise.withResolvers<void>();
  process.once('SIGTERM', () => stop.resolve());
  {
    await using cleanup = LeaderSelector.start(
      new SqliteElection({
        clock: globalThis,
        directory: shared!,
        claimFile: 'cleanup.lock',
        epochFile: 'cleanup.epoch',
      }),
      {
        takeLeadership: async (term, signal) => {
          process.send!({ pid: process.pid, epoch: Number(term.epoch) });
          // Run the job until the selector stops it.
          while (!signal.aborted) {
            await delay(100); // Run one step of the job here.
          }
        },
      },
      {
        // Campaign again after each term; wait longer after each failed campaign.
        autoRequeue: {
          backoff: new Backoff({
            initial: 100,
            multiplier: 2,
            max: 5_000,
            jitter: { kind: 'full' },
          }),
          clock: globalThis,
        },
      },
    );
    await Promise.race([stop.promise, cleanup.ended]);
  } // The dispose resigns the term before the process exits.
  process.disconnect();
} else {
  const directory = await mkdtemp(join(tmpdir(), 'singleton-'));
  const candidates = [1, 2, 3].map(() =>
    fork(import.meta.filename, ['candidate', directory]),
  );
  const leaders: Array<{ pid: number; epoch: number }> = [];
  for (const candidate of candidates) {
    candidate.on('message', (leader) =>
      leaders.push(leader as (typeof leaders)[number]),
    );
  }
  const leader = async (count: number) => {
    while (leaders.length < count) await delay(10);
    const { pid } = leaders[count - 1]!;
    return candidates.find((candidate) => candidate.pid === pid)!;
  };
  const running = (candidate: ChildProcess) =>
    candidate.exitCode === null && candidate.signalCode === null;

  (await leader(1)).kill('SIGKILL'); // A crash: the kernel ends the term.
  (await leader(2)).kill('SIGTERM'); // A stop: the dispose resigns the term.
  await leader(3);
  console.log({
    epochs: leaders.map(({ epoch }) => epoch),
    processes: new Set(leaders.map(({ pid }) => pid)).size,
  });

  const exits = candidates
    .filter(running)
    .map((candidate) => once(candidate, 'exit'));
  for (const candidate of candidates.filter(running)) candidate.kill('SIGTERM');
  await Promise.all(exits);
  await rm(directory, { recursive: true, force: true });
}
```

Output:

```
{ epochs: [ 1, 2, 3 ], processes: 3 }
```

## Why it works

The leader holds an exclusive SQLite transaction for its full term, and serves a pipe that sends a heartbeat. The other candidates campaign with no time limit: each one waits on the leader's pipe and makes no new try until the pipe closes. When the first leader gets `SIGKILL`, the kernel removes its file lock and closes the pipe, so a waiting candidate wins term 2. When the second leader gets `SIGTERM`, the end of its `await using` scope disposes the selector: the dispose aborts the signal of `takeLeadership`, waits until the job returns, and resigns the term. A third candidate then wins term 3 at once, without a wait for the lease of the old leader. Each new term gets a higher epoch.

## Things to know

- **A job that fails ends the selector.** When `takeLeadership` rejects with an error other than `signal.reason`, the selector resigns the term, and `ended` and the dispose reject with that error. The selector does not run the job again: the owner decides, for example with `process.exit(1)`, so that the platform restarts the process. The program above ends with that error through `Promise.race`.
- **End the job with `signal.reason`, or return.** A rejection with `signal.reason` after the signal aborted is a clean end. `setTimeout` of `node:timers/promises` rejects with its own `AbortError`, whose `cause` is the reason (Node.js 26), so the selector would read it as a failure of the job. Loop on `signal.aborted`, as the program does, or wait with `delay` of `@zukhruf/async`, which rejects with `signal.reason`.
- **A failed campaign tries again.** With `autoRequeue`, the selector emits a `LeaderSelectorWarning` with the code `ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED`, `election: <name>` in `detail` and the failure as `cause`, waits `backoff.duration(retries)` on `clock`, and campaigns again. `retries` counts the failed campaigns since the last term. Without `autoRequeue`, a failed campaign ends the selector with its error. A `NetworkDirectoryError` does not go away, so check the directory with `assertLocalDirectory` of [`@zukhruf/fs`](../../../fs/README.md) before you start the selector. Then the selector does not warn without end.
- **Do not delete the election directory** while copies run. A new claim file lets a second leader win.
- **Do not use the file names of `SocketStore`.** `SocketStore` claims `leader.lock` and counts terms in `leader.epoch`. If the job uses these names in a directory of a `SocketStore`, it joins the election of the lock store. The job then wins terms that the lock store needs, or waits while the lock store leads.
- **The signal also aborts at a loss.** `SqliteElection` never loses a living term, but another backend can take the claim away. Then the signal of `takeLeadership` aborts, the selector gives the term up, and with `autoRequeue` it campaigns again at once.
- **Use the epoch to fence the job's writes.** With `SqliteElection`, a hung leader never runs again after a takeover: a candidate that hears no heartbeat for the `leaseDuration` sends `SIGKILL` to the leader's process, and a new term starts only after that process ended. With another backend, a hung old leader can run again after a new leader won. Make fencing tokens from `term.epoch` with `EpochTokenSource` of `@zukhruf/fencing`, and give them to the resource. The epoch of a `SqliteElection` is below 2^31, so `EpochTokenSource` takes it. See [the term](../../README.md#the-term).
- **Across machines, give the selector another backend.** The selector takes each `LeaderElection`. A backend whose claim is in a database that each machine reaches leads across machines ([Write a backend](../../README.md#write-a-backend)).
- **A campaign does not block** the event loop. The copy continues other work while it waits.
