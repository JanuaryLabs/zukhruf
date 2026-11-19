# Recipe: Wait for the work in flight before shutdown

**Use case.** A server starts work for each request, and does not wait for it in one place. At shutdown, the server must stop new work, then wait until the work in flight ends, but not for longer than a timeout. Without a count, the server closes while work still runs, or each piece of code keeps its own count and latch by hand. A search found 6 such places in our repos (#4519). The server plugin of context-compiler and `transcription.ts` now count their work with a `WaitGroup` and wait for zero at close ([ADR 0015](../adr/0015-a-wait-group-counts-disposable-tokens-and-may-count-up-again-after-zero.md)).

**What you need.** A `WaitGroup` for the work in flight, and a `timeout` for the shutdown.

## The steps

1. Make one `WaitGroup` for the work in flight.
2. At the start of each work, write `using _work = group.add()`. The token is disposed at the end of the block, also when the work fails.
3. At shutdown, stop new work first.
4. Make a timeout with `using limit = timeout(ms, { clock: globalThis })`.
5. Call `group.wait({ signal: limit.signal })`. It ends when the count is zero, or rejects with a `TimeoutError` when the timeout aborts first.

## The program

A server starts two requests, of 100 ms and 300 ms, and then closes. It refuses a third request after the close. The program runs the server two times: with a timeout of 1,000 ms, and with a timeout of 50 ms.

```ts title="shutdown.ts"
import { setTimeout as delay } from 'node:timers/promises';

import { WaitGroup, timeout } from '@zukhruf/async';

// A server that counts each request in flight, and waits for them at close.
class Server {
  readonly #inFlight = new WaitGroup();
  #open = true;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async handle(request: string, ms: number): Promise<void> {
    if (!this.#open) {
      console.log(`${this.name}: ${request} refused, the server closes`);
      return;
    }
    using _request = this.#inFlight.add();
    console.log(`${this.name}: ${request} started`);
    await delay(ms);
    console.log(`${this.name}: ${request} done`);
  }

  async close(limitMs: number): Promise<void> {
    this.#open = false;
    console.log(`${this.name}: close, wait at most ${limitMs} ms`);
    using limit = timeout(limitMs, { clock: globalThis });
    try {
      await this.#inFlight.wait({ signal: limit.signal });
      console.log(`${this.name}: no request in flight, closed`);
    } catch (error) {
      console.log(
        `${this.name}: ${(error as Error).name}, closed with requests in flight`,
      );
    }
  }
}

async function run(server: Server, limitMs: number): Promise<void> {
  const requests = [server.handle('a', 100), server.handle('b', 300)];
  await server.close(limitMs);
  await server.handle('c', 100);
  await Promise.all(requests);
}

await run(new Server('patient'), 1_000);
await run(new Server('hasty'), 50);
```

Output:

```
patient: a started
patient: b started
patient: close, wait at most 1000 ms
patient: a done
patient: b done
patient: no request in flight, closed
patient: c refused, the server closes
hasty: a started
hasty: b started
hasty: close, wait at most 50 ms
hasty: TimeoutError, closed with requests in flight
hasty: c refused, the server closes
hasty: a done
hasty: b done
```

## Why it works

- **The count includes each request that started.** `add` counts the request until `using` disposes its token at the end of `handle`. The close stops new requests first, so the count can only go down after the close.
- **The wait ends at zero.** The patient server closed only after `a` and `b` were done. A wait on a count of zero ends at once, so a server with no request in flight closes at once.
- **The timeout cancels the wait, not the work.** The hasty server's wait rejected with a `TimeoutError` after 50 ms, and `a` and `b` were done later. A cancel stops only the wait ([README](../../README.md#a-cancel-stops-the-wait-not-the-work)).

## Things to know

- **Stop new work before the wait.** The count can go up again after zero, so a request that starts after the wait began makes the wait go on. A wait that started before a zero still ends at that zero, also when an `add` follows in the same step (`src/wait-group.test.ts`, [ADR 0015](../adr/0015-a-wait-group-counts-disposable-tokens-and-may-count-up-again-after-zero.md)).
- **A wait with no timeout takes `{ signal: undefined }`.** The server plugin of context-compiler waits this way, because it aborts its watches first, and each watch stops on that signal. `transcription.ts` waits this way too, but its work is the dispose of a pool of engines, which takes no signal, so its wait ends only when each dispose ends.
- **Dispose the timeout when the wait ends.** `using limit` stops its timer. The timer does not keep the process alive unless you give `ref: true` ([ADR 0012](../adr/0012-a-timeout-keeps-the-process-alive-only-when-the-caller-says-so.md)).
- **A token counts once.** A second dispose of one token changes nothing, so the count never goes below zero (`src/wait-group.test.ts`).
- **A test can give a fake clock** to `timeout` in place of `globalThis`, and move it past the timeout ([ADR 0006](../adr/0006-a-timeout-is-a-signal-on-the-clock-that-the-caller-gives.md)).
