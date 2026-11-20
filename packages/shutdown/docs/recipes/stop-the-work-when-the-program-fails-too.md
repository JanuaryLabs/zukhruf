# Recipe: Stop the work at a termination signal or at a failure of the program

**Use case.** A program runs two loops that watch for work. A termination signal must stop both loops. When one loop fails, the other loop must stop too, and the process must exit with code 1, not die by a termination signal. The signal of a `Shutdown` aborts at a stop request or at the end of its scope. It does not abort when one loop fails, so it does not stop the other loop. startup-credits and websets of context-compiler use this recipe (`apps/startup-credits/src/main.ts`, `apps/websets/src/main.ts`; context-compiler #3580).

**What you need.** A `Shutdown`, and one `AbortController` for the failures of the program.

## The steps

1. Make the `Shutdown` at the start of the entry point, before the first `await`.
2. Make an `AbortController` with the name `failed`.
3. Join the two signals: `AbortSignal.any([shutdown.signal, failed.signal])`. Give the joined signal to each loop.
4. Catch the error of each loop, and give it to `failed.abort(error)`.
5. After the loops stop, throw `failed.signal.reason` only when `failed.signal.aborted && !shutdown.signal.aborted`.

## The program

The program starts itself twice as a child process, as a supervisor does. On the first run, it sends SIGTERM to the child after two ticks. On the second run, the check loop of the child fails at its third tick. For each run, the program prints the lines of the child and its exit status.

```ts title="stop-on-failure.ts"
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { Shutdown } from '@zukhruf/shutdown';

const [role, path] = process.argv.slice(2);

// One tick each 100 ms, until the signal aborts.
async function* ticks(signal: AbortSignal) {
  for (let tick = 1; ; tick++) {
    try {
      await delay(100, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    yield tick;
  }
}

if (role === 'app') {
  using shutdown = new Shutdown();

  // Either loop that fails stops the other.
  const failed = new AbortController();
  const watching = AbortSignal.any([shutdown.signal, failed.signal]);
  await Promise.all([
    (async () => {
      for await (const tick of ticks(watching))
        console.log(`watch: tick ${tick}`);
      console.log('watch: stopped');
    })().catch((error: unknown) => failed.abort(error)),
    (async () => {
      for await (const tick of ticks(watching)) {
        if (path === 'failure' && tick === 3) {
          throw new Error('the warehouse is gone');
        }
      }
      console.log('check: stopped');
    })().catch((error: unknown) => failed.abort(error)),
  ]);
  if (failed.signal.aborted && !shutdown.signal.aborted) {
    throw failed.signal.reason;
  }
} else {
  // The supervisor: start the app on each path, and print its exit status.
  for (const path of ['signal', 'failure']) {
    console.log(`--- ${path}`);
    const app = spawn(
      process.execPath,
      [...process.execArgv, import.meta.filename, 'app', path],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const status = once(app, 'exit');
    createInterface({ input: app.stderr }).on('line', (line) => {
      if (line.startsWith('Error')) console.log(`stderr: ${line}`);
    });
    for await (const line of createInterface({ input: app.stdout })) {
      console.log(line);
      if (path === 'signal' && line === 'watch: tick 2') {
        app.kill('SIGTERM');
      }
    }
    const [code, signal] = await status;
    console.log(`exit status: code ${code}, signal ${signal}`);
  }
}
```

Output on Node.js 26.13.0:

```
--- signal
watch: tick 1
watch: tick 2
watch: stopped
check: stopped
exit status: code null, signal SIGTERM
--- failure
watch: tick 1
watch: tick 2
watch: tick 3
watch: stopped
stderr: Error: the warehouse is gone
exit status: code 1, signal null
```

## What the output shows

- **At SIGTERM, both loops stop, and the process dies by SIGTERM.** The signal of the `Shutdown` aborts, so the joined signal aborts too. `failed` does not abort, so the program throws nothing. After the cleanup, the package sends SIGTERM to its own process again ([ADR 0001](../adr/0001-the-process-dies-by-its-termination-signal-after-the-cleanup.md)).
- **At the failure, the other loop stops, and the process exits with code 1.** The check loop throws. Its `.catch()` aborts `failed`, and the joined signal aborts, so the watch loop stops at its next tick. There is no `check: stopped` line, because the check loop did not stop: it failed. The signal of the `Shutdown` did not abort, so the program throws the error of the loop.

## Why it works

- **`AbortSignal.any()` aborts when one of its signals aborts.** Each loop sees one signal, and it does not have to know which cause stopped it ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static)).
- **The throw ends the scope of the `Shutdown` first.** The `using` scope ends before the error leaves the block. With no stop request, the end of the scope removes the listeners of the package. Then Node.js gets the error with its default: it writes the error and exits with code 1 ([Stop at the end of a scope](../../README.md#stop-at-the-end-of-a-scope)).
- **`!shutdown.signal.aborted` keeps a stop request from looking like a failure.** A loop can fail because the stop ended its work, for example with an `AbortError`. Then `failed` aborts too, but the cause is the stop request. Without the check, the program throws during a shutdown. The package then writes the error as a crash and ends the process at once, by the termination signal ([Handle a crash](../../README.md#handle-a-crash)).

## Things to know

- **The exit status follows the cause.** A termination signal gives a death by the signal, and a failure gives exit code 1. See [Read what the parent sees](../../README.md#read-what-the-parent-sees).
- **A crash is not a failure of the program.** An exception that no code catches is a stop request, and the signal of the `Shutdown` aborts for it ([ADR 0003](../adr/0003-a-crash-starts-a-shutdown.md)). `failed` is for the errors that the program catches.
