import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { Docker } from '@zukhruf/docker';

import { Mutex } from '../../index.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { newProcessTimeout, waitUntil } from '../../testing/wait-until.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { DockerEngineStore } from './index.ts';

/**
 * The first seven tests are the design errors that the probes of
 * DockerEngineStore found. The name of each test says what the wrong design
 * broke. The tests after them are the contract of a lock store.
 */

const image = 'node:lts-alpine';
const heartbeatInterval = 500;
/**
 * The time limit of each wait that the engine must end. It is far above the
 * slowest engine under load, so a wait that reaches it never ends.
 */
const engineBound = 10_000;
const namespaceLabel = 'zukhruf.mutex.namespace';

/**
 * A client of the local engine and a new namespace. The disposal first ends
 * the client, so that no store of the test creates anything later, and then
 * removes each container and volume with the label of the namespace.
 */
async function engine() {
  const docker = await Docker.connect({ environment: process.env });
  const namespace = `zukhruf-mutex-test-${randomUUID()}`;
  const label = { label: [`${namespaceLabel}=${namespace}`] };
  return {
    docker,
    namespace,
    store: (client: Docker = docker) =>
      new DockerEngineStore({
        docker: client,
        image,
        namespace,
        heartbeatInterval,
      }),
    [Symbol.asyncDispose]: async () => {
      await docker[Symbol.asyncDispose]();
      await using cleaner = await Docker.connect({
        environment: process.env,
      });
      for (const { Id } of await cleaner.containers.list({
        all: true,
        filters: label,
      })) {
        await (await cleaner.containers.find(Id))?.remove({ force: true });
      }
      for (const { Name } of await cleaner.volumes.list({ filters: label })) {
        await (await cleaner.volumes.find(Name))?.remove({ force: true });
      }
    },
  };
}

/** Holds `key` until the returned `release` is called. */
async function hold(mutex: Mutex, key: string) {
  const entered = Promise.withResolvers<bigint>();
  const finish = Promise.withResolvers<void>();
  const held = mutex.acquire(key, async (lease) => {
    entered.resolve(lease.token.value);
    await finish.promise;
  });
  held.catch(entered.reject);
  const token = await entered.promise;
  return {
    token,
    release: async () => {
      finish.resolve();
      await held;
    },
  };
}

/**
 * A Unix socket proxy in front of the socket of the engine. `partition()`
 * stops forwarding in both directions and closes no socket. A hold keeps each
 * request to the engine from its trigger on, on every connection, until its
 * `release()`.
 */
async function engineProxy(docker: Docker) {
  const enginePath = new URL(docker.host).pathname;
  const directory = await scratchDirectory();
  const path = join(directory.path, 'engine.sock');
  const partitioned = new AbortController();
  const sockets = new Set<Socket>();
  const queues = new Map<Socket, Buffer[]>();
  let trigger: ({ request: RegExp } | { conflictOf: RegExp }) | undefined;
  let reached = Promise.withResolvers<void>();
  let holding = false;
  const startHolding = () => {
    holding = true;
    reached.resolve();
  };
  const server = createServer((client) => {
    const upstream = connect(enginePath);
    const queue: Buffer[] = [];
    queues.set(upstream, queue);
    let lastRequest = '';
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
    }
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('data', (chunk: Buffer) => {
      if (partitioned.signal.aborted) return;
      const line = /^[A-Z]+ \S+ HTTP\/1\.1/.exec(chunk.toString('latin1'));
      if (line !== null) lastRequest = line[0];
      if (
        !holding &&
        line !== null &&
        trigger !== undefined &&
        'request' in trigger &&
        trigger.request.test(line[0])
      ) {
        startHolding();
      }
      if (holding) queue.push(chunk);
      else upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (partitioned.signal.aborted) return;
      if (
        !holding &&
        trigger !== undefined &&
        'conflictOf' in trigger &&
        trigger.conflictOf.test(lastRequest) &&
        chunk.toString('latin1').startsWith('HTTP/1.1 409')
      ) {
        startHolding();
      }
      client.write(chunk);
    });
  });
  server.listen(path);
  await once(server, 'listening');
  const holdFrom = (next: { request: RegExp } | { conflictOf: RegExp }) => {
    trigger = next;
    reached = Promise.withResolvers<void>();
    return {
      reached: reached.promise,
      release: () => {
        holding = false;
        trigger = undefined;
        for (const [upstream, queue] of queues) {
          for (const chunk of queue.splice(0)) upstream.write(chunk);
        }
      },
    };
  };
  return {
    host: `unix://${path}`,
    partition: () => partitioned.abort(),
    /** Holds from the first request whose request line matches. */
    holdRequestsFrom: (request: RegExp) => holdFrom({ request }),
    /** Holds from the first create of a container that gets 409: a name conflict. */
    holdAfterNameConflict: () =>
      holdFrom({ conflictOf: /^POST \S*\/containers\/create\?/ }),
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await directory[Symbol.asyncDispose]();
    },
  };
}

/** Takes the key in its own process, reports its token, and keeps the key until it is killed. */
const holderSource = (namespace: string, key: string) => `
	import { Docker } from ${JSON.stringify(import.meta.resolve('@zukhruf/docker'))};
	import { Mutex } from ${JSON.stringify(new URL('../../index.ts', import.meta.url).href)};
	import { DockerEngineStore } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
	setInterval(() => {}, 1000);
	const docker = await Docker.connect({ environment: process.env });
	const store = new DockerEngineStore({ docker, image: ${JSON.stringify(image)}, namespace: ${JSON.stringify(namespace)}, heartbeatInterval: ${heartbeatInterval} });
	await new Mutex(store).acquire(${JSON.stringify(key)}, async (lease) => {
		process.send({ type: 'holding', token: String(lease.token.value) });
		await new Promise(() => {});
	});
`;

const outcomeOf = <T>(promise: Promise<T>, within: number) =>
  Promise.race([
    promise.then(
      (value) => ({ settled: 'resolved' as const, value }),
      (error: unknown) => ({ settled: 'rejected' as const, error }),
    ),
    delay(within, { settled: 'pending' as const }),
  ]);

test(
  "a killed holder's key goes to the next waiter",
  { timeout: 30_000 },
  async (t) => {
    // Arrange: another process holds the key.
    await using fixture = await engine();
    await using holder = startWorker(
      holderSource(fixture.namespace, 'report:daily'),
      'holder',
    );
    await waitUntil(
      t,
      () => holder.has('holding'),
      () => `The holder did not take the key: ${holder.stderr}`,
      newProcessTimeout,
    );
    const waiting = new Mutex(fixture.store()).acquire(
      'report:daily',
      async (lease) => lease.token.value,
    );

    // Act
    holder.child.kill('SIGKILL');
    const outcome = await outcomeOf(waiting, engineBound);

    // Assert
    assert.deepEqual(
      outcome,
      { settled: 'resolved', value: 2n },
      'The end of the attach of a killed holder must end its claim',
    );
  },
);

test(
  'a waiter wakes when the holder releases between the create of the waiter and its wait',
  { timeout: 30_000 },
  async () => {
    // Arrange: the waiter reaches the engine through a proxy that holds its requests after its create gets the name conflict.
    await using fixture = await engine();
    await using proxy = await engineProxy(fixture.docker);
    await using waiterClient = await Docker.connect({ host: proxy.host });
    const holder = await hold(new Mutex(fixture.store()), 'report:daily');
    const afterConflict = proxy.holdAfterNameConflict();
    const waiting = new Mutex(fixture.store(waiterClient)).acquire(
      'report:daily',
      async (lease) => lease.token.value,
    );
    await afterConflict.reached;

    // Act: the release comes before the waiter starts its wait.
    await holder.release();
    afterConflict.release();
    const outcome = await outcomeOf(waiting, engineBound);

    // Assert
    assert.deepEqual(
      outcome,
      { settled: 'resolved', value: 2n },
      'A release before the wait must not be lost',
    );
  },
);

test(
  'a key whose caller stopped between the create and the start goes to the next waiter after heartbeatInterval',
  { timeout: 30_000 },
  async () => {
    // Arrange: a caller created its claim, and the proxy keeps its start from the engine.
    await using fixture = await engine();
    await using proxy = await engineProxy(fixture.docker);
    await using stoppedClient = await Docker.connect({ host: proxy.host });
    const beforeStart = proxy.holdRequestsFrom(
      /^POST \S*\/containers\/[0-9a-f]+\/start /,
    );
    const stopped = new Mutex(fixture.store(stoppedClient)).acquire(
      'report:daily',
      async () => {},
    );
    stopped.catch(() => {});
    await beforeStart.reached;

    // Act
    const started = performance.now();
    const outcome = await outcomeOf(
      new Mutex(fixture.store()).acquire(
        'report:daily',
        async () => performance.now() - started,
      ),
      heartbeatInterval + engineBound,
    );

    // Assert: load on the engine can only make the wait longer.
    assert.equal(
      outcome.settled,
      'resolved',
      'A waiter must remove a created claim that nobody starts',
    );
    assert.ok(
      outcome.value >= heartbeatInterval,
      `The waiter got the key ${outcome.value.toFixed(0)} ms after it asked, before heartbeatInterval`,
    );
  },
);

test(
  'a caller whose claim a waiter removed before the start tries again',
  { timeout: 30_000 },
  async () => {
    // Arrange: a slow caller's start is held until a waiter removed its created claim and took the key.
    await using fixture = await engine();
    await using proxy = await engineProxy(fixture.docker);
    await using slowClient = await Docker.connect({ host: proxy.host });
    const beforeStart = proxy.holdRequestsFrom(
      /^POST \S*\/containers\/[0-9a-f]+\/start /,
    );
    const slow = new Mutex(fixture.store(slowClient)).acquire(
      'report:daily',
      async (lease) => lease.token.value,
    );
    slow.catch(() => {});
    await beforeStart.reached;
    const waiter = await hold(new Mutex(fixture.store()), 'report:daily');

    // Act: the start of the slow caller arrives after the removal of its claim.
    beforeStart.release();
    await delay(heartbeatInterval);
    await waiter.release();
    const outcome = await outcomeOf(slow, engineBound);

    // Assert
    assert.deepEqual(
      outcome,
      { settled: 'resolved', value: waiter.token + 1n },
      'A start that lost to a removal must send the caller back to the create',
    );
  },
);

test(
  'a holder that lost its claim during the mint gets no token',
  { timeout: 30_000 },
  async () => {
    // Arrange: a holder read the ladder, and the proxy keeps its create of a rung from the engine.
    await using fixture = await engine();
    await using proxy = await engineProxy(fixture.docker);
    await using staleClient = await Docker.connect({ host: proxy.host });
    const ran: string[] = [];
    const beforeRung = proxy.holdRequestsFrom(/^POST \S*\/volumes\/create /);
    const stale = new Mutex(fixture.store(staleClient)).acquire(
      'report:daily',
      async (lease) => {
        ran.push(`stale ${lease.token.value}`);
        return lease.token.value;
      },
    );
    stale.catch(() => {});
    await beforeRung.reached;
    const [claim] = await fixture.docker.containers.list({
      all: true,
      filters: { label: [`${namespaceLabel}=${fixture.namespace}`] },
    });
    assert.ok(claim);
    await (
      await fixture.docker.containers.find(claim.Id)
    )?.remove({
      force: true,
    });
    const next = await hold(new Mutex(fixture.store()), 'report:daily');
    ran.push(`next ${next.token}`);

    // Act: the stale holder climbs above the token of the next holder.
    beforeRung.release();
    await delay(2 * heartbeatInterval);
    const whileNextHolds = [...ran];
    await next.release();
    const outcome = await outcomeOf(stale, engineBound);

    // Assert
    assert.deepEqual(
      whileNextHolds,
      ['next 1'],
      'A holder whose claim is gone must not run with the token it minted',
    );
    assert.equal(outcome.settled, 'resolved');
    assert.ok(
      outcome.value > next.token,
      `The stale caller got ${outcome.value} after ${next.token}`,
    );
  },
);

test(
  'a held key is lost within heartbeatInterval when the engine stops answering',
  { timeout: 30_000 },
  async () => {
    // Arrange: the store reaches the engine through a proxy, and holds a key.
    await using fixture = await engine();
    await using proxy = await engineProxy(fixture.docker);
    await using client = await Docker.connect({ host: proxy.host });
    const seen = Promise.withResolvers<{
      lost: 'lost' | 'still held';
      after: number;
    }>();

    // Act: the connection stops silently while the task runs.
    const run = new Mutex(fixture.store(client)).acquire(
      'report:daily',
      async (lease) => {
        proxy.partition();
        const started = performance.now();
        const lost = await Promise.race([
          once(lease.signal, 'abort').then(() => 'lost' as const),
          delay(3000, 'still held' as const),
        ]);
        seen.resolve({ lost, after: performance.now() - started });
      },
    );
    run.catch(() => {});
    const { lost, after } = await seen.promise;

    // Assert: one interval to the next heartbeat, one interval for its answer.
    assert.equal(
      lost,
      'lost',
      'The holder must learn that its claim may be gone',
    );
    assert.ok(
      after < 2 * heartbeatInterval + 300,
      `The lease was lost ${after.toFixed(0)} ms after the partition, later than two heartbeat intervals`,
    );
  },
);

test(
  'the tokens increase after docker container prune',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using fixture = await engine();
    const mutex = new Mutex(fixture.store());
    const first = await mutex.acquire(
      'report:daily',
      async (lease) => lease.token.value,
    );

    // Act: an operator prunes the containers of the namespace that do not run.
    await promisify(execFile)('docker', [
      'container',
      'prune',
      '--force',
      '--filter',
      `label=${namespaceLabel}=${fixture.namespace}`,
    ]);
    const second = await mutex.acquire(
      'report:daily',
      async (lease) => lease.token.value,
    );

    // Assert
    assert.ok(second > first, `The token went from ${first} to ${second}`);
  },
);

test(
  'two stores on one engine never run tasks of one key at the same time',
  { timeout: 30_000 },
  async () => {
    // Arrange: two stores, each with its own client, as two machines have.
    await using fixture = await engine();
    await using other = await Docker.connect({ environment: process.env });
    const mutexes = [
      new Mutex(fixture.store()),
      new Mutex(fixture.store(other)),
    ];
    let inside = 0;
    let most = 0;
    const tokens: bigint[] = [];

    // Act
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) =>
        mutexes[index % 2]?.acquire('report:daily', async (lease) => {
          inside += 1;
          most = Math.max(most, inside);
          tokens.push(lease.token.value);
          await delay(20);
          inside -= 1;
        }),
      ),
    );

    // Assert
    assert.equal(most, 1, 'Two tasks of one key ran at the same time');
    assert.deepEqual(tokens, [1n, 2n, 3n, 4n, 5n, 6n]);
  },
);

test(
  'a waiter gets the key when the holder releases it',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using fixture = await engine();
    await using other = await Docker.connect({ environment: process.env });
    const holder = await hold(new Mutex(fixture.store()), 'report:daily');
    const waiting = new Mutex(fixture.store(other)).acquire(
      'report:daily',
      async (lease) => lease.token.value,
    );
    const whileHeld = await outcomeOf(waiting, 500);

    // Act
    await holder.release();
    const outcome = await outcomeOf(waiting, engineBound);

    // Assert
    assert.deepEqual(whileHeld, { settled: 'pending' });
    assert.deepEqual(outcome, { settled: 'resolved', value: 2n });
  },
);

test(
  'tryAcquire gives up on a held key and takes a free one',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using fixture = await engine();
    await using other = await Docker.connect({ environment: process.env });
    const store = fixture.store(other);
    const holder = await hold(new Mutex(fixture.store()), 'report:daily');

    // Act
    const whileHeld = await store.tryAcquire('report:daily');
    await holder.release();
    const afterRelease = await store.tryAcquire('report:daily');
    await afterRelease?.[Symbol.asyncDispose]();

    // Assert
    assert.equal(whileHeld, undefined);
    assert.equal(afterRelease?.token.value, 2n);
  },
);

test(
  'isHeld tells a held key from a free one and creates nothing',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using fixture = await engine();
    const store = fixture.store();
    const labelled = { label: [`${namespaceLabel}=${fixture.namespace}`] };

    // Act
    const free = await store.isHeld('report:daily');
    const containers = await fixture.docker.containers.list({
      all: true,
      filters: labelled,
    });
    const volumes = await fixture.docker.volumes.list({ filters: labelled });
    const holder = await hold(new Mutex(fixture.store()), 'report:daily');
    const held = await store.isHeld('report:daily');
    await holder.release();
    const released = await store.isHeld('report:daily');

    // Assert
    assert.equal(free, false);
    assert.deepEqual([containers.length, volumes.length], [0, 0]);
    assert.equal(held, true);
    assert.equal(released, false);
  },
);

test('the tokens of one key increase', { timeout: 30_000 }, async () => {
  // Arrange
  await using fixture = await engine();
  const mutex = new Mutex(fixture.store());

  // Act
  const tokens: bigint[] = [];
  for (let grant = 0; grant < 3; grant += 1) {
    tokens.push(
      await mutex.acquire('report:daily', async (lease) => lease.token.value),
    );
  }

  // Assert
  assert.deepEqual(tokens, [1n, 2n, 3n]);
});

test(
  'a cancelled acquire rejects with the reason of its signal and leaves no claim',
  { timeout: 30_000 },
  async () => {
    // Arrange
    await using fixture = await engine();
    await using other = await Docker.connect({ environment: process.env });
    const holder = await hold(new Mutex(fixture.store()), 'report:daily');
    const cancel = new AbortController();
    const reason = new Error('cancelled');
    const waiting = new Mutex(fixture.store(other)).acquire(
      'report:daily',
      async () => 'ran',
      { signal: cancel.signal },
    );
    await delay(300);

    // Act
    cancel.abort(reason);
    const outcome = await outcomeOf(waiting, engineBound);
    await holder.release();

    // Assert
    assert.deepEqual(outcome, { settled: 'rejected', error: reason });
    assert.equal(await fixture.store().isHeld('report:daily'), false);
  },
);

test(
  'two namespaces do not share a key or its tokens',
  { timeout: 30_000 },
  async () => {
    // Arrange: the second namespace is on the same engine.
    await using first = await engine();
    await using second = await engine();
    const firstMutex = new Mutex(first.store());
    await firstMutex.acquire('report:daily', async () => {});
    const holder = await hold(firstMutex, 'report:daily');

    // Act
    const other = await outcomeOf(
      new Mutex(second.store()).acquire(
        'report:daily',
        async (lease) => lease.token.value,
      ),
      engineBound,
    );
    await holder.release();
    const next = await firstMutex.acquire(
      'report:daily',
      async (lease) => lease.token.value,
    );

    // Assert
    assert.deepEqual(other, { settled: 'resolved', value: 1n });
    assert.equal(holder.token, 2n);
    assert.equal(next, 3n);
  },
);
