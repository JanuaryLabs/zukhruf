# Recipe: Skip a job that is already running

**Use case.** A cron job builds a report every minute. Sometimes a report takes longer than one minute. A new tick must not start a second report, and it must not wait in line either: it must skip. An admin button also builds the report. The admin must get a fresh report, so the admin waits.

**What you need.** A key with the default acquire mode [skip if busy](../concepts/acquire-modes.md), and an override to wait for the admin. Any lock store works. This program uses `MemoryStore`; for several processes, use a host lock store such as `SqliteStore`.

## The steps

1. Create the key with `mutex.key(name, { mode: Modes.skipIfBusy() })`.
2. The cron job calls `report.run(task)`. It gets `{ acquired: false }` if a report is running.
3. The admin calls `report.run(task, { mode: Modes.wait() })`. It waits for the running report, and then runs its own.

## The program

Five cron ticks fire at the same time. Then a sixth tick runs while the admin asks for a report.

```ts title="skip-a-running-job.ts"
import { setTimeout as delay } from 'node:timers/promises';

import { MemoryStore, Modes, Mutex } from '@zukhruf/mutex';

const mutex = new Mutex(new MemoryStore());
const report = mutex.key('report:daily', { mode: Modes.skipIfBusy() });
const runs: string[] = [];

async function buildReport(trigger: string) {
  await delay(100); // Building the report takes time.
  runs.push(trigger);
  return trigger;
}

// Five ticks at the same time: one builds the report, four skip.
const ticks = await Promise.all(
  [1, 2, 3, 4, 5].map((n) => report.run(() => buildReport(`cron ${n}`))),
);

// A tick runs, and the admin asks at the same time: the admin waits, then builds a fresh report.
const tick = report.run(() => buildReport('cron 6'));
const admin = await report.run(() => buildReport('admin'), {
  mode: Modes.wait(),
});
await tick;

console.log({
  skipped: ticks.filter((result) => !result.acquired).length,
  admin,
  runs,
});
```

Output:

```
{ skipped: 4, admin: 'admin', runs: [ 'cron 1', 'cron 6', 'admin' ] }
```

## Why it works

The key `report:daily` is exclusive for every caller, so two reports never run at the same time. The acquire mode changes only what a caller does while the key is busy. A cron tick that skips never becomes a holder. The admin's call overrides the key's default and waits in line.

The result of a cron tick is `{ acquired: true, value } | { acquired: false }`. TypeScript makes you check `acquired` before you read `value`. The admin's result is the value, because a caller that waits always runs its task.

## Things to know

- **To wait a short time before you skip**, use `Modes.skipIfBusy({ waitAtMost: 500 })`. The caller waits at most 500 ms, then gives up.
- **A skipped tick does not run later.** If every tick must run, use the default `Modes.wait()`.
- **The admin can stop its wait.** Give a signal: `report.run(task, { mode: Modes.wait(), signal })`. When the signal aborts, the call rejects, and the report does not run. This is a cancel, not a skip.
- **A caller that gave up or cancelled keeps its place in line** in some lock stores, and passes the key on when its place reaches the front. It never blocks the callers after it.
