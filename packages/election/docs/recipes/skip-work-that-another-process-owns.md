# Recipe: Own one item at a time, and skip an item that another process owns

**Use case.** Several processes of one host work on the same list of items, for example one import for each folder. Only one process can work on an item at a time. A process that finds an item owned by another process must skip it, and do the next item. Without an election for each item, two processes do the same item at the same time and write over each other.

**What you need.** Only `SqliteElection` ([how it elects a leader](../concepts/leader-election.md)). Each item has its own election, so each item has its own leader and its own epochs.

## The steps

1. For each item, create a `SqliteElection` with one shared `directory`. Give it a `claimFile` and an `epochFile` named after the item.
2. To skip an owned item, call `campaign()` with no `timeout`. It tries the claim once. It resolves with a `Term` when the process now owns the item, or with `undefined` when another process owns it.
3. When the campaign resolves `undefined`, skip the item. Do not work on it.
4. When the process must own the item before it continues, call `campaign({ timeout: Infinity, signal })` one time. It waits until it wins, or until `signal` aborts.
5. Work on the item while the term lasts. Resign the term when the work ends, for example with `await using`.

## The program

The program forks a second process that owns the item `b`. The first process tries each of the items `a`, `b` and `c` once, and skips `b`. Then it waits for `b`, kills the owner, and owns `b` in the next term.

```ts title="skip-owned-items.ts"
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteElection } from '@zukhruf/election';

// One election for each item. All claim files are in one shared directory.
function owners(directory: string, item: string): SqliteElection {
  return new SqliteElection({
    clock: globalThis,
    directory,
    claimFile: `${item}.owner.lock`,
    epochFile: `${item}.owner.epoch`,
  });
}

const [role, shared] = process.argv.slice(2);

if (role === 'other') {
  // Another process owns the item "b" until it stops.
  const term = await owners(shared!, 'b').campaign();
  process.send!({ owns: 'b', epoch: Number(term!.epoch) });
  setInterval(() => {}, 1000); // Keep the term until the process is killed.
} else {
  const directory = await mkdtemp(join(tmpdir(), 'owners-'));
  const other = fork(import.meta.filename, ['other', directory]);
  const [message] = await once(other, 'message');
  console.log('other process:', message);

  // One try for each item: work on it, or skip it.
  for (const item of ['a', 'b', 'c']) {
    await using term = await owners(directory, item).campaign();
    if (term === undefined) {
      console.log(item, 'skipped: another process owns it');
      continue;
    }
    console.log(item, 'done in epoch', Number(term.epoch));
  }

  // Wait for the item "b" until it is free. With timeout: Infinity, the
  // campaign never resolves undefined: it wins, or it rejects when the signal aborts.
  {
    const waiting = owners(directory, 'b').campaign({
      timeout: Infinity,
      signal: AbortSignal.timeout(30_000),
    });
    other.kill('SIGKILL');
    await using term = (await waiting)!;
    console.log('b done in epoch', Number(term.epoch), 'after the owner died');
  }

  await rm(directory, { recursive: true, force: true });
}
```

Output:

```
other process: { owns: 'b', epoch: 1 }
a done in epoch 1
b skipped: another process owns it
c done in epoch 1
b done in epoch 2 after the owner died
```

## What the output shows

- **The items `a` and `c` are in epoch 1, and `b` is in epoch 2.** Each item has its own epoch file, so each item counts its own terms. The second term of `b` has a higher epoch than the term of the dead owner.
- **One try skips `b` and does not wait.** `campaign()` without a `timeout` tries the claim once. The test "a timeout of 0 tries once" in `src/leader-election.test.ts` shows it, and `src/sqlite/sqlite-election.test.ts` shows that a second campaign resolves `undefined` while the first leader leads.
- **The wait for `b` ends when its owner dies.** The kernel frees the file lock of a dead process. The waiting candidate reads the close of the owner's pipe as a push, and tries again ([ADR 0007](../adr/0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md)).

## Things to know

- **Do not loop on `campaign({ timeout: Infinity })`.** That campaign never resolves `undefined`: it tries again until it wins, and it rejects with `signal.reason` when `signal` aborts (`campaign` in `src/leader-election.ts`). A check for `undefined` after it never runs. Its type is still `Term | undefined`, so the program writes `!`. Loop only on a campaign with a finite `timeout`. To campaign again after each term, use `LeaderSelector` of this package, as in [Run a job in only one process](./run-a-job-in-only-one-process.md).
- **Give a signal to a campaign that waits without end.** Without a signal, nothing stops the campaign while another process owns the item. See [Elect a leader of one host](../../README.md#elect-a-leader-of-one-host).
- **Keep the claim files out of the item's own folder.** Never delete a claim file while candidates run: a new file lets a second leader win (`SqliteElectionOptions.claimFile` in `src/sqlite/sqlite-election.ts`). When a process removes the folder of an item, a claim file in that folder goes with it. Put the claim files of all items in one directory that no process removes.
- **Name each item's files so that they do not collide.** `SqliteElection` also writes `<claimFile>.leader`, and `<claimFile>.clean` after a clean resign. Use a name that is a valid file name and unique for each item. Do not use `leader.lock` and `leader.epoch` of `SocketStore` (`@zukhruf/mutex`), or `flight.lock` and `flight.epoch` of `@zukhruf/single-flight`: a process with these names joins their election ([the README](../../README.md#write-a-backend)).
- **Stop the work when `term.signal` aborts.** `SqliteElection` never loses a living term, but another backend can take the claim away. See [the term](../../README.md#the-term).
