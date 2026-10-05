# Recipe: Run a job in only one process

**Use case.** Three copies of your app run on one host. A background job, for example a cleanup, must run in only one copy. When that copy stops, another copy must start the job.

**What you need.** Only [leader election](../concepts/leader-election.md), from `mutex/leader-election`. You do not need a mutex: the leader runs the job for as long as it leads.

## The steps

1. Each copy creates a `LeaderElection` with the same directory.
2. Each copy runs campaigns in a loop. A campaign waits up to `timeout` while another copy leads.
3. The copy that wins runs the job until it stops.
4. When the leader stops, the kernel ends its term, and the next campaign of another copy wins.

## The program

This program starts three candidates. It kills the first leader and shows the second leader.

```ts title="singleton-job.ts"
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { LeaderElection } from '@zukhruf/mutex/leader-election';

const [role, shared] = process.argv.slice(2);

if (role === 'candidate') {
  const election = new LeaderElection(shared!);
  for (;;) {
    const leadership = await election.campaign({ timeout: 200 });
    if (!leadership) continue; // Another copy leads. Try again.
    process.send!({ pid: process.pid, epoch: Number(leadership.epoch) });
    for (;;) {
      await delay(100); // Run one step of the job here.
    }
  }
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

  while (leaders.length < 1) await delay(10);
  const first = leaders[0]!;
  candidates.find((candidate) => candidate.pid === first.pid)!.kill('SIGKILL');

  while (leaders.length < 2) await delay(10);
  const second = leaders[1]!;
  console.log({
    firstEpoch: first.epoch,
    secondEpoch: second.epoch,
    samePid: first.pid === second.pid,
  });

  for (const candidate of candidates) candidate.kill();
  await rm(directory, { recursive: true, force: true });
}
```

Output:

```
{ firstEpoch: 1, secondEpoch: 2, samePid: false }
```

## Why it works

The leader holds an exclusive SQLite transaction for its full term. The other campaigns get "busy" and wait. When the leader process stops, the kernel removes its file lock, and the next campaign wins. The new leader gets a higher epoch.

## Things to know

- **Do not delete the election directory** while copies run. A new `leader.lock` file lets a second leader win.
- **Use the epoch to fence the job's writes.** If the old leader was only frozen, it can continue. Give `leadership.epoch` to the resource as a fencing token. See [fencing tokens](../concepts/fencing-tokens.md).
- **To stop leading**, call `await leadership.resign()`, or use `await using`.
- **A campaign does not block** the event loop. The copy continues other work while it waits.
