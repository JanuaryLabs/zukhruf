# Recipe: Hold workers only while there is work

**Use case.** A server or a command-line tool reads files with helpers that each hold a model in memory. Most commands read no file, and the server is idle for hours. Workers that stay alive with no jobs hold their memory for nothing: on one Mac, 17 idle helpers of old servers held 2 GiB each. A helper whose warm-up never ends also holds its slot for nothing.

**What you need.** A worker with `ready()`, and a host that builds its `Pool` and `PoolWorkers` when it starts.

## The steps

1. Choose `startup: new OnDemand()` for the `PoolWorkers`. The owner starts a worker only when a job needs one, so a command that reads no file starts no helper.
2. Choose `eviction: new IdleTimeout({ after })`. The owner closes a worker that stays idle for `after` milliseconds. The next job that needs its slot starts a new worker.
3. Give `ready()` its own time limit. The owner waits for `ready()` with no time limit, so a worker whose warm-up can hang rejects when its limit ends. The owner then kills and closes the worker, and the job that waits for it fails with a `JobFailedError` whose `failure` has the warm-up's error.
4. Dispose the `Pool` and the `PoolWorkers` with the host.

## The program

The host offers two helpers, and closes a helper after 2 idle seconds. The first helper of the run never finishes its warm-up. The others load the model in 300 ms.

```ts title="only-while-work.ts"
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import {
  Fixed,
  IdleTimeout,
  JobFailedError,
  OnDemand,
  Pool,
  PoolWorkers,
  type Worker,
  WorkerKind,
} from '@zukhruf/pool';
import { Command, Coprocess } from '@zukhruf/process';

const model = new WorkerKind<string, unknown>({
  name: 'model',
  revision: 1,
  policy: 'standard',
  retryLimit: 0,
  expireInSeconds: 60,
});

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

  async function startHelper(folder: string): Promise<Coprocess> {
    const helper = new Command(
      process.execPath,
      [import.meta.filename, 'helper', folder],
      { name: 'model helper', env: process.env, clock: globalThis },
    );
    return new Coprocess(await helper.start());
  }

  class ModelWorker implements Worker<string, unknown> {
    readonly #helper: Promise<Coprocess>;

    constructor(folder: string) {
      started++;
      this.#helper = startHelper(folder);
    }

    // The owner waits for ready() with no time limit, so the worker sets its
    // own: a warm-up takes 300 ms, and one that takes a second has hung.
    async ready(): Promise<void> {
      const helper = await this.#helper;
      await untilAborted(helper.request('warm-up'), AbortSignal.timeout(1_000));
    }

    async run(file: string): Promise<unknown> {
      return (await this.#helper).request(file);
    }

    async exited(): Promise<unknown> {
      return (await this.#helper).exited();
    }

    kill(): void {
      // A helper that did not start has nothing to kill: ready() rejected
      // with its StartError.
      void this.#helper.then(
        (helper) => helper.process.signal('SIGKILL'),
        () => false,
      );
    }

    async close(): Promise<void> {
      await (await this.#helper).close();
    }
  }

  // The host offers its workers and sends its jobs from its start. With
  // OnDemand, a command that reads no file starts no helper.
  class Host implements AsyncDisposable {
    readonly #stack = new AsyncDisposableStack();
    readonly #workers: PoolWorkers<string, unknown>;
    readonly #pool: Pool<string, unknown>;

    constructor(folder: string, store: string) {
      this.#workers = this.#stack.use(
        new PoolWorkers({
          kind: model,
          store,
          clock: globalThis,
          size: new Fixed(2),
          startup: new OnDemand(),
          eviction: new IdleTimeout({ after: 2_000 }),
          create: () => new ModelWorker(folder),
        }),
      );
      this.#pool = this.#stack.use(
        new Pool({ kind: model, store, clock: globalThis }),
      );
    }

    status(): string {
      const { starting, idle, lent } = this.#workers.stats;
      return `${starting} starting, ${idle} idle, ${lent} lent, ${started} helpers started`;
    }

    read(file: string): Promise<unknown> {
      return this.#pool.run(file);
    }

    [Symbol.asyncDispose](): Promise<void> {
      return this.#stack.disposeAsync();
    }
  }

  // A store of its own; a host of the computer gives computerStore(process.env).
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'only-while-work-'),
  );
  await using host = new Host(scratch.path, join(scratch.path, 'store.sqlite'));
  console.log('status:', host.status());
  await host
    .read('a.png')
    .catch((error: unknown) =>
      console.log(
        'read a.png failed:',
        error instanceof JobFailedError ? error.failure.name : error,
      ),
    );
  console.log('read b.png:', await host.read('b.png'));
  console.log('status:', host.status());
  await delay(3_000);
  console.log('3 s later:', host.status());
  console.log('read c.png:', await host.read('c.png'));
  console.log('status:', host.status());
}
```

Output:

```
status: 0 starting, 0 idle, 0 lent, 0 helpers started
read a.png failed: TimeoutError
read b.png: { text: 'text of b.png' }
status: 0 starting, 1 idle, 0 lent, 2 helpers started
3 s later: 0 starting, 0 idle, 0 lent, 2 helpers started
read c.png: { text: 'text of c.png' }
status: 0 starting, 1 idle, 0 lent, 3 helpers started
```

## What the output shows

- `status` read no file, so the owner started no helper.
- The first read started a helper. It hung, so `ready()` rejected after 1 second with `TimeoutError`, and that read failed with a `JobFailedError` of that name. The owner killed and closed the helper.
- The next read started the second helper in the empty slot. With `OnDemand` no slot starts again by itself.
- After 2 idle seconds, the owner closed the idle helper: all counts are 0.
- The next read started a new helper, the third of the run.

## Things to know

- **Why the startup decides, and the pool has no `min` option.** When to start the workers is the startup's rule: one rule for each startup ([ADR 0001](../adr/0001-startups-and-sizings-are-classes-that-a-caller-chooses.md)). With `OnDemand`, a `PoolWorkers` that the host builds at its start holds no helper until a job needs one. Its election and its store cost no helper.
- **Choose `after` for your workers.** Mature pools use 20 s (the .NET thread pool), 30 s (generic-pool), 300 s (KEDA, the Kubernetes HPA) and 10 minutes (HikariCP). A worker that is costly to start needs a long time; a worker that holds much memory needs a short time.
- **An evicted worker is not an exit.** The owner does not replace it and does not start a back-off. See [ADR 0006](../adr/0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md).
- **Jobs stay on the low slots.** A job takes the idle worker in the lowest slot, so the high slots stay idle and their eviction lets them go.
- **A worker that a sizing keeps but does not run is not evicted.** It is the worker that a step of a sizing that learns tries. See [Let the pool find how many workers pay](./find-how-many-workers-pay.md).
