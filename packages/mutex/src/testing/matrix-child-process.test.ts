import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { type TestContext, test } from 'node:test';

import { Docker } from '@zukhruf/docker';
import { TemporaryFiles } from '@zukhruf/fs';
import { timebox, waitFor } from '@zukhruf/testing/async';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { startWorker } from '@zukhruf/testing/process';

import { mutexUrl } from './module-urls.ts';
import {
  dockerImage,
  subject as dockerSubject,
} from './subjects/docker-engine.ts';

const memoryUrl = new URL('./subjects/memory.ts', import.meta.url);
const dockerUrl = new URL('./subjects/docker-engine.ts', import.meta.url);
const workerProcessUrl = import.meta.resolve('@zukhruf/testing/process');

/** Whether the process `pid` still runs. EPERM means the OS gave the pid to a process of another user. */
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      Error.isError(error) &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'EPERM')
    )
      return false;
    throw error;
  }
};

test('a matrix child exits when its test process is killed', async (t) => {
  // Arrange: a test process starts a matrix child that grants a key again and again.
  await using testProcess = startWorker(
    `
				import { startWorker } from ${JSON.stringify(workerProcessUrl)};

				const child = startWorker(\`
					import { setTimeout as delay } from 'node:timers/promises';
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};
					import { openInProcess } from ${JSON.stringify(memoryUrl.href)};

					const mutex = new Mutex(openInProcess());
					await mutex.acquire('report:daily', async () => {});
					process.send({ type: 'granted' });
					for (;;) {
						await mutex.acquire('report:daily', async () => {});
						await delay(10);
					}
				\`, 'child');
				child.child.once('message', () =>
					process.send({ type: 'granting', pid: child.child.pid }),
				);
			`,
    'test process',
  );
  // The matrix child must grant.
  await testProcess.next('granting', { signal: t.signal });
  const pid = Number(testProcess.find('granting')?.pid);
  try {
    // Act
    testProcess.child.kill('SIGKILL');
    await testProcess.closed;

    // Assert
    await waitFor(
      () =>
        assert.ok(
          !isRunning(pid),
          'The matrix child must exit when its test process is killed',
        ),
      { signal: t.signal },
    );
  } finally {
    if (isRunning(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('a matrix child that opens the DockerEngineStore in the run of the fixture holds the run’s reaper', async (t) => {
  // Arrange: a run of its own, with its records in a scratch directory.
  await using records = await new TemporaryFiles().directory('mutex-test-');
  const store = dockerSubject;
  await using fixture = await store.fixture({
    ...process.env,
    ZUKHRUF_TESTING_RUN_ID: randomUUID(),
    ZUKHRUF_TESTING_RUN_DIR: records.path,
  });
  await using host = store.open(fixture.location);

  // Act
  await using child = startWorker(
    `
				import { openInProcess } from ${JSON.stringify(dockerUrl.href)};

				const store = openInProcess(${JSON.stringify(fixture.location)});
				process.send({ type: 'started' });
				// A call waits for the store, which holds the run's reaper first.
				await store.isHeld('report:daily');
				process.send({ type: 'held' });
				setInterval(() => {}, 1000);
			`,
    'child',
    { admit: (child) => store.process.admit(host, child) },
  );
  // The matrix child must start.
  await child.next('started', { signal: t.signal });

  // Assert
  // The disposal kills the child: a kill during its take of the hold would
  // leave the run's reaper created.
  // The matrix child must hold the run's reaper.
  await child.next('held', { signal: t.signal });
});

/** A docker-in-docker engine of this run, and a client of it through a unix socket of this machine. */
interface SecondEngine extends AsyncDisposable {
  client: Docker;
  /** The `unix://` host of the relay. */
  host: string;
}

/**
 * A docker-in-docker engine, created by this run's testbed, and a unix
 * socket at `relay` on this machine that relays to its TCP port. The testbed
 * publishes that port on 127.0.0.1 of the engine's host only: it gives root
 * there.
 */
async function secondEngine(relay: string): Promise<SecondEngine> {
  await using stack = new AsyncDisposableStack();
  const service = stack.use(
    await new DockerTestbed({ environment: process.env }).serve(
      {
        Image: 'docker:28.5.2-dind',
        Cmd: [
          'dockerd',
          '--host=unix:///var/run/docker.sock',
          '--host=tcp://0.0.0.0:2375',
          '--tls=false',
        ],
        Env: ['DOCKER_TLS_CERTDIR='],
        HostConfig: { Privileged: true },
      },
      {
        internalPort: 2375,
        healthy: ({ port }) =>
          timebox(
            async () => {
              const ping = await fetch(`http://127.0.0.1:${port}/_ping`);
              if (!ping.ok) throw new Error(`The ping answered ${ping.status}`);
            },
            { maxRetryTime: 60_000 },
          ),
      },
    ),
  );
  const connections = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(service.port, service.host);
    for (const socket of [client, upstream]) {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    }
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  server.listen(relay);
  await once(server, 'listening');
  stack.defer(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of connections) socket.destroy();
      }),
  );
  await chmod(relay, 0o600);
  const host = `unix://${relay}`;
  const client = stack.use(
    await Docker.connect({
      clock: globalThis,
      environment: { DOCKER_HOST: host },
    }),
  );
  // Platform setup that no product operation exposes: the second engine starts
  // with no image, and a pull from Docker Hub inside it in each test is slow
  // and meets the rate limit of Docker Hub. The engine of this process has
  // each image that the store and the run's reaper use there, or pulls it
  // once, and loads it into the second engine. docker:28.5.2-cli is the
  // REAPER_IMAGE of @zukhruf/testing, which does not export it.
  await using ambient = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  const images = ['docker:28.5.2-cli', dockerImage];
  for (const image of images) {
    if ((await ambient.images.inspect(image)) === undefined) {
      await ambient.images.pull(image);
    }
  }
  await client.images.load(await ambient.images.save(images));
  const owned = stack.move();
  return {
    client,
    host,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** A path of a unix socket that fits the 104 bytes of macOS. */
const shortSocket = () => `/tmp/zt-${randomUUID().slice(0, 8)}.sock`;

/** The ids of the containers on the engine of `client` with the label `label`. */
const labelled = async (client: Docker, label: string) =>
  (
    await client.containers.list({ all: true, filters: { label: [label] } })
  ).map(({ Id }) => Id);

/**
 * Runs `source` in a matrix child with the run of a fixture on a second
 * engine, whose location is `location` in its scope. Each claim of the
 * store and the run's reaper must be on that engine, not on the engine that
 * this process's environment selects. The child inherits the environment of
 * this process, and the location's DOCKER_HOST wins over it.
 */
async function onSecondEngine(
  t: TestContext,
  source: (location: string) => string,
): Promise<void> {
  await using records = await new TemporaryFiles().directory('mutex-test-');
  await using second = await secondEngine(shortSocket());
  await using ambient = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  const run = randomUUID();
  await using fixture = await dockerSubject.fixture({
    ...process.env,
    DOCKER_HOST: second.host,
    ZUKHRUF_TESTING_RUN_ID: run,
    ZUKHRUF_TESTING_RUN_DIR: records.path,
  });

  await using child = startWorker(source(fixture.location), 'child');
  await waitFor(
    () =>
      assert.ok(
        child.has('acquired'),
        `The matrix child must acquire a key.\n${child.stderr}`,
      ),
    { interval: 5, signal: t.signal },
  );

  const claims = `dev.zukhruf.testing.run=${run}`;
  const reapers = `dev.zukhruf.testing.reaper=${run}`;
  assert.notDeepEqual(await labelled(second.client, claims), []);
  assert.equal((await labelled(second.client, reapers)).length, 1);
  assert.deepEqual(await labelled(ambient, claims), []);
  assert.deepEqual(await labelled(ambient, reapers), []);
}

test('a matrix child that opens the DockerEngineStore of a fixture on a second engine creates its claims and holds the run’s reaper on that engine', async (t) => {
  await onSecondEngine(
    t,
    (location) => `
				import { openInProcess } from ${JSON.stringify(dockerUrl.href)};

				const store = openInProcess(${JSON.stringify(location)});
				await store.acquire('report:daily');
				process.send({ type: 'acquired' });
				setInterval(() => {}, 1000);
			`,
  );
});

test('a matrix child that opens the partitionable DockerEngineStore of a fixture on a second engine creates its claims and holds the run’s reaper on that engine', async (t) => {
  await onSecondEngine(
    t,
    (location) => `
				import { partitionable } from ${JSON.stringify(dockerUrl.href)};

				const { store } = await partitionable.partitionable(${JSON.stringify(location)}, globalThis);
				await store.acquire('report:daily');
				process.send({ type: 'acquired' });
				setInterval(() => {}, 1000);
			`,
  );
});
