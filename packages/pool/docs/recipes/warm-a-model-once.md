# Recipe: Warm a model once, then start the other workers

**Use case.** A helper loads a model when it starts. The first time a helper binary runs, it compiles the model and writes it to a cache; later starts only load the cache. Apple's Vision does this. When four workers start together with an empty cache, each one compiles the model: four times the work, and the compiles compete for the same chips. `LeaderFirst` starts the first worker alone, and the others when it is ready, so they load the cache.

**What you need.** A worker with `ready()`, which settles when the helper has the model in memory.

## The steps

1. Give the worker a `ready()` that warms the helper up and settles when the model is in memory.
2. Choose `startup: new LeaderFirst()`.
3. Wait for `pool.ready()` when the host must know that all workers are warm. A job does not have to wait for it: a job takes a worker that starts.

## The program

A helper compiles the model in 2 seconds when the cache is empty, and loads it in 200 ms when the cache has it. The program warms four workers twice, each time with an empty cache: with `Parallel` and with `LeaderFirst`.

```ts title="warm-once.ts"
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { Coprocess } from '@zukhruf/coprocess';
import {
  Fixed,
  LeaderFirst,
  NoEviction,
  Parallel,
  Pool,
  type Startup,
  type Worker,
} from '@zukhruf/pool';

const [role, cache] = process.argv.slice(2);

if (role === 'helper') {
  // The first helper compiles the model and writes it to the cache. A helper
  // that finds the cache only loads the model.
  for await (const line of createInterface({ input: process.stdin })) {
    const model = join(cache!, 'model');
    const cached = await readFile(model, 'utf8').catch(() => undefined);
    if (cached === undefined) {
      await delay(2_000); // Compiling takes long.
      await writeFile(model, 'compiled');
      await appendFile(join(cache!, 'compiles.log'), `${process.pid}\n`);
    } else await delay(200); // Loading is short.
    process.stdout.write(`${line}\n`);
  }
} else {
  // A worker is ready when its helper has the model in memory.
  class ModelWorker implements Worker {
    readonly #helper: Coprocess;

    constructor(cache: string) {
      this.#helper = new Coprocess(
        process.execPath,
        [import.meta.filename, 'helper', cache],
        { name: 'model helper' },
      );
    }

    async ready(): Promise<void> {
      await this.#helper.request({ warm: true });
    }

    exited(): Promise<unknown> {
      return this.#helper.exited();
    }

    kill(): void {
      this.#helper.kill();
    }

    close(): Promise<void> {
      return this.#helper.close();
    }
  }

  async function warm(startup: Startup) {
    const cache = await mkdtemp(join(tmpdir(), 'model-cache-'));
    const start = performance.now();
    {
      await using pool = new Pool({
        size: new Fixed(4),
        startup,
        eviction: new NoEviction(),
        clock: globalThis,
        create: () => new ModelWorker(cache),
      });
      await pool.ready();
    }
    const seconds = ((performance.now() - start) / 1000).toFixed(1);
    const compiles = (await readFile(join(cache, 'compiles.log'), 'utf8'))
      .trim()
      .split('\n').length;
    await rm(cache, { recursive: true, force: true });
    console.log(
      `${startup.constructor.name}: ${compiles} of 4 helpers compiled the model, all ready after ${seconds} s`,
    );
  }

  await warm(new Parallel());
  await warm(new LeaderFirst());
}
```

Output:

```
Parallel: 4 of 4 helpers compiled the model, all ready after 2.3 s
LeaderFirst: 1 of 4 helpers compiled the model, all ready after 2.6 s
```

## What the output shows

- With `Parallel`, each helper found the cache empty, so each one compiled the model.
- With `LeaderFirst`, the first helper compiled the model. The other three started when it was ready, found the cache, and only loaded it. They were ready 0.3 s later than with `Parallel`, and they did a quarter of the work.

## Things to know

- **The others start when the first worker settles, also when its warm-up fails.** Then each of them may compile the model.
- **A worker that the pool starts later does not wait.** A replacement after an exit, or a worker that a sizing that learns tries, starts at once: the first worker settled long before.
- **Set a time limit for the warm-up in the worker.** The pool waits for `ready()` with no time limit. See [Hold workers only while there is work](./hold-workers-only-while-there-is-work.md).
- **Startups**: `OnDemand` starts a worker only when a job needs one, `Parallel` starts all workers together, and `OrderedReady` starts them one after the other. See [Choose when the workers start](../../README.md#choose-when-the-workers-start).
