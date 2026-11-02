# Recipe: Hold workers only while there is work

**Use case.** A server or a command-line tool reads files with helpers that each hold a model in memory. Most commands read no file, and the server is idle for hours. Workers that stay alive with no jobs hold their memory for nothing: on one Mac, 17 idle helpers of old servers held 2 GiB each. A helper whose warm-up never ends also holds its slot for nothing.

**What you need.** A worker with `ready()`, and a host that can build the pool when a command first needs it.

## The steps

1. Build the pool in the host when a command first reads a file, for example with `this.#pool ??= new Pool(...)`. A command that reads no file starts no helper.
2. Choose `eviction: new IdleTimeout({ after })`. The pool closes a worker that stays idle for `after` milliseconds. The next job that needs its slot starts a new worker.
3. Give `ready()` its own time limit. The pool waits for `ready()` with no time limit, so a worker whose warm-up can hang rejects when its limit ends. The pool then kills and closes the worker, and the job that waits for it fails.
4. Dispose the pool with the host.

## The program

The host has two helpers, and closes a helper after 2 idle seconds. The first helper of the run never finishes its warm-up. The others load the model in 300 ms.

```ts title="only-while-work.ts"
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { Coprocess } from '@zukhruf/coprocess';
import {
  Fixed,
  IdleTimeout,
  LeaderFirst,
  Pool,
  type Worker,
} from '@zukhruf/pool';

const [role, folder] = process.argv.slice(2);

if (role === 'helper') {
  // The first helper of the run never finishes its warm-up. The others load
  // the model in 300 ms, then read one file for each request.
  let warm = false;
  for await (const line of createInterface({ input: process.stdin })) {
    if (!warm) {
      const first = await writeFile(join(folder!, 'hung'), '', { flag: 'wx' })
        .then(() => true)
        .catch(() => false);
      if (first) await new Promise(() => {});
      await delay(300);
      warm = true;
    }
    process.stdout.write(
      `${JSON.stringify({ text: `text of ${JSON.parse(line)}` })}\n`,
    );
  }
} else {
  let started = 0;

  class ModelWorker implements Worker {
    readonly #helper: Coprocess;

    constructor(folder: string) {
      started++;
      this.#helper = new Coprocess(
        process.execPath,
        [import.meta.filename, 'helper', folder],
        { name: 'model helper' },
      );
    }

    // The pool waits for ready() with no time limit, so the worker sets its
    // own: a warm-up takes 300 ms, and one that takes a second has hung.
    async ready(): Promise<void> {
      await untilAborted(
        this.#helper.request('warm-up'),
        AbortSignal.timeout(1_000),
      );
    }

    read(file: string): Promise<unknown> {
      return this.#helper.request(file);
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

  // The host builds the pool when a command first reads a file. A command
  // that reads no file starts no helper.
  class Host {
    readonly #folder: string;
    #pool: Pool<ModelWorker> | undefined;

    constructor(folder: string) {
      this.#folder = folder;
    }

    status(): string {
      if (!this.#pool) return `no pool, ${started} helpers started`;
      const { starting, idle, lent } = this.#pool.stats;
      return `${starting} starting, ${idle} idle, ${lent} lent, ${started} helpers started`;
    }

    read(file: string): Promise<unknown> {
      this.#pool ??= new Pool({
        size: new Fixed(2),
        startup: new LeaderFirst(),
        eviction: new IdleTimeout({ after: 2_000 }),
        clock: globalThis,
        create: () => new ModelWorker(this.#folder),
      });
      return this.#pool.use((worker) => worker.read(file));
    }

    async [Symbol.asyncDispose](): Promise<void> {
      await this.#pool?.[Symbol.asyncDispose]();
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'only-while-work-'));
  {
    await using host = new Host(scratch);
    console.log('status:', host.status());
    await host
      .read('a.png')
      .catch((error: Error) => console.log('read a.png failed:', error.name));
    console.log('read b.png:', await host.read('b.png'));
    console.log('status:', host.status());
    await delay(3_000);
    console.log('3 s later:', host.status());
    console.log('read c.png:', await host.read('c.png'));
    console.log('status:', host.status());
  }
  await rm(scratch, { recursive: true, force: true });
}
```

Output:

```
status: no pool, 0 helpers started
read a.png failed: TimeoutError
read b.png: { text: 'text of b.png' }
status: 0 starting, 1 idle, 0 lent, 2 helpers started
3 s later: 0 starting, 0 idle, 0 lent, 2 helpers started
read c.png: { text: 'text of c.png' }
status: 0 starting, 1 idle, 0 lent, 3 helpers started
```

## What the output shows

- `status` read no file, so the host built no pool and started no helper.
- The first read built the pool. Its first helper hung, so `ready()` rejected after 1 second with `TimeoutError`, and that read failed. The pool killed and closed the helper.
- The second helper had started when the first one settled, so `b.png` took it. The slot of the helper that hung stays empty until a job needs it.
- After 2 idle seconds, the pool closed the idle helper: all counts are 0.
- The next read started a new helper, the third of the run.

## Things to know

- **Why the host builds the pool, and the pool has no `min` option.** When to start the workers is a decision of the host: the pool gives one rule for each startup ([ADR 0001](../adr/0001-startups-and-sizings-are-classes-that-a-caller-chooses.md)). With `startup: new OnDemand()`, a pool that you build early also starts no worker until a job needs one.
- **Choose `after` for your workers.** Mature pools use 20 s (the .NET thread pool), 30 s (generic-pool), 300 s (KEDA, the Kubernetes HPA) and 10 minutes (HikariCP). A worker that is costly to start needs a long time; a worker that holds much memory needs a short time.
- **An evicted worker is not an exit.** The pool does not replace it and does not start a back-off. See [ADR 0006](../adr/0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md).
- **Jobs stay on the low slots.** A job takes the idle worker in the lowest slot, so the high slots stay idle and their eviction lets them go.
- **A worker that a sizing keeps but does not run is not evicted.** It is the worker that a step of a sizing that learns tries. See [Let the pool find how many workers pay](./find-how-many-workers-pay.md).
