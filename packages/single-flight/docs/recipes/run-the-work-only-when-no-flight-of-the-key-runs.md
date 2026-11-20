# Recipe: Run the work only when no flight of the key runs

**Use case.** A tool removes an import that the user no longer selects. A pass of that import can run in another process at the same time, and the pass writes to the import. The removal must not run beside the pass. It must not wait for the pass either, because the pass removes the import itself when it ends. The removal runs only when no flight of the key is in progress. The server plugin and the CLI of context-compiler remove their stale imports this way.

**What you need.** A `SingleFlight` in each process, with the same directory, a codec and a clock. A flight with no value takes the codec `{ encode: () => '', decode: () => undefined }`. The clock is required: give `globalThis`.

## The steps

1. Create an `AbortController` for the call.
2. Call `flights.run(key, work, { onJoin: () => joined.abort(), signal: joined.signal })`. When the coordinator tells the caller to lead, the work runs.
3. When the caller joins a flight of the key, its `onJoin` aborts its own signal. The call then rejects with the reason of the signal, and the work does not run.
4. Catch the rejection. When `joined.signal.aborted` is true, the caller joined a flight: skip the work. Throw each other error again.

## The program

This program starts a pass of the key `import-a` in a child process. While the pass runs, the parent tries to remove the import, and it skips the removal. After the child process ended, the parent tries again, and the removal runs.

```ts title="remove-when-idle.ts"
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleFlight } from '@zukhruf/single-flight';

// A flight with no value: the codec sends empty text.
function flightsOf(directory: string) {
  return new SingleFlight<void>({
    directory,
    codec: { encode: () => '', decode: () => undefined },
    clock: globalThis,
  });
}

// Runs the removal only when no flight of the key runs.
async function removeUnlessBusy(
  flights: SingleFlight<void>,
  key: string,
): Promise<string> {
  const joined = new AbortController();
  try {
    await flights.run(key, async () => console.log(`removing ${key}`), {
      onJoin: () => joined.abort(),
      signal: joined.signal,
    });
    return 'removed';
  } catch (error) {
    if (!joined.signal.aborted) throw error;
    return 'skipped: a flight of the key runs';
  }
}

const [role, shared] = process.argv.slice(2);

if (role === 'pass') {
  // The pass of the import runs until the parent tells it to end.
  await using flights = flightsOf(shared!);
  await flights.run('import-a', async () => {
    process.send!('started');
    await once(process, 'message');
  });
  process.disconnect();
} else {
  const directory = await mkdtemp(join(tmpdir(), 'remove-when-idle-'));
  {
    await using flights = flightsOf(directory);
    const pass = fork(import.meta.filename, ['pass', directory]);
    const exited = once(pass, 'exit');
    await once(pass, 'message');
    console.log(
      'while the pass runs:',
      await removeUnlessBusy(flights, 'import-a'),
    );

    pass.send('finish');
    await exited;
    console.log(
      'after the pass ended:',
      await removeUnlessBusy(flights, 'import-a'),
    );
  }
  await rm(directory, { recursive: true, force: true });
}
```

Output:

```
while the pass runs: skipped: a flight of the key runs
removing import-a
after the pass ended: removed
```

## Why it works

Each call asks the coordinator, in one step, to lead a new flight of the key or to join the flight in progress ([ADR 0003](../adr/0003-a-caller-leads-or-joins-in-one-request-to-an-elected-coordinator.md)). Thus the answer "join" tells the caller that a flight of the key runs now. `onJoin` runs once, when the caller joins.

A cancel stops the wait of its caller only. The call rejects with the reason of the signal, and the flight continues for the other callers ([ADR 0004](../adr/0004-a-cancel-withdraws-only-its-caller.md); the test "a joiner that cancels rejects with its reason, and the leader and the other joiners still get the value" in `src/single-flight.test.ts`). Thus the pass is not changed by the removal that cancels.

`joined.signal.aborted` tells the two rejections apart. Only `onJoin` aborts that signal, so an aborted signal means that the caller joined a flight. Each other error, for example `NetworkDirectoryError`, propagates.

## Things to know

- **Use one `SingleFlight` and one key for the pass and for the removal.** The removal skips only a flight of its own key in its own directory.
- **A flight is not a lock.** The removal cancels only when a flight is in progress. A pass that starts after the removal ended runs as usual.
- **The pass joins the removal.** When a pass of the key comes while the removal runs, it joins the removal and gets its value. In the codec of a flight with no value, that value is `undefined`. When the pass and the removal have one `SingleFlight<T>` with a value, the removal returns a value of type `T` for those joiners. The CLI of context-compiler returns an empty list of sync lines.
- **A call just after the leader's call returned can still join that flight.** The leader's call returns when its work settled, and its landing can still be on its way to the coordinator. A call of another process in that time joins the flight, and the removal skips. In the program, the parent waits until the child process exits, and the child disposes its `SingleFlight` first. Disposing waits until the outcome of a flight that this process led reached the coordinator ([Join a run that is still in flight](./join-a-run-in-flight.md)).
- **When the work of the removal fails**, the call of the leader rejects with the error of the work, because `joined.signal` did not abort. See [Errors](../../README.md#errors).
