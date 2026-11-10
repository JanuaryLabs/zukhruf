import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';

import { Docker } from '@zukhruf/docker';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import type { DatabaseOptions } from '@zukhruf/testing/postgres';

import { DockerEngineStore } from '../../lock-stores/docker/docker-engine-store.ts';
import type { LockStore } from '../../mutex/lock-store.ts';
import type { Partitionable } from '../contract/sessions.ts';
import {
  type Fixture,
  type Host,
  type StoreModule,
  type Subject,
  sharesWithProcesses,
  sharesWithThreads,
} from '../contract/subject.ts';

export const dockerNamespaceLabel = 'zukhruf.mutex.namespace';

/** Where the stores of a Docker engine case meet. The location of the fixture is this object as JSON. */
interface DockerEngineLocation {
  host: string;
  namespace: string;
  /**
   * The test run's variables from the fixture's environment, empty outside a
   * run. Each process that opens a store reads the run's labels from them,
   * which records the process in the run. Only these two: the location is
   * in each child's source, so the rest of the environment would reach argv.
   */
  run: {
    ZUKHRUF_TESTING_RUN_ID?: string | undefined;
    ZUKHRUF_TESTING_RUN_DIR?: string | undefined;
  };
}

/** The image of each DockerEngineStore container. */
export const dockerImage = 'node:lts-alpine';

/**
 * A new namespace on the engine that `environment` selects, with
 * `dockerImage` on it: the store never pulls its image. The location also
 * has the variables of the test run, so the teardown of the run removes what
 * a killed process left. The disposal removes each container and volume with
 * the label of the namespace, through a client of its own, so it runs after
 * each store of the test ended its client.
 */
export async function dockerEngineFixture(
  environment: DatabaseOptions['environment'],
): Promise<Fixture> {
  const { host } = await (async () => {
    await using docker = await Docker.connect({
      clock: globalThis,
      environment,
    });
    if (!(await docker.images.inspect(dockerImage))) {
      await docker.images.pull(dockerImage);
    }
    return { host: docker.host };
  })();
  const location: DockerEngineLocation = {
    host,
    namespace: `zukhruf-mutex-test-${randomUUID()}`,
    run: {
      ZUKHRUF_TESTING_RUN_ID: environment.ZUKHRUF_TESTING_RUN_ID,
      ZUKHRUF_TESTING_RUN_DIR: environment.ZUKHRUF_TESTING_RUN_DIR,
    },
  };
  return {
    location: JSON.stringify(location),
    [Symbol.asyncDispose]: async () => {
      await using cleaner = await Docker.connect({ clock: globalThis, host });
      const filters = {
        label: [`${dockerNamespaceLabel}=${location.namespace}`],
      };
      for (const { Id } of await cleaner.containers.list({
        all: true,
        filters,
      })) {
        await (await cleaner.containers.find(Id))?.remove({ force: true });
      }
      for (const { Name } of await cleaner.volumes.list({ filters })) {
        await (await cleaner.volumes.find(Name))?.remove({ force: true });
      }
    },
  };
}

/**
 * A DockerEngineStore takes a connected client, and `open` is synchronous. So
 * this store connects its own client when it opens, and gives each call to a
 * DockerEngineStore over that client once it is connected. The free sockets
 * of a client do not keep a process running, so a child or a thread that
 * never disposes its client can exit.
 */
export function dockerEngineStore(location: string) {
  const { host, namespace, run }: DockerEngineLocation = JSON.parse(location);
  // Before the first claim: the read records this process in the run, so the
  // run's teardown waits for it and sweeps what it created
  // (@zukhruf/testing ADR 0006 and ADR 0013).
  const labels = new DockerTestbed({ environment: run }).defaults.Labels;
  const docker = Docker.connect({ clock: globalThis, host });
  const store = docker.then(
    (client) =>
      new DockerEngineStore({
        docker: client,
        image: dockerImage,
        namespace,
        heartbeatInterval: 500,
        labels,
        clock: globalThis,
      }),
  );
  const lockStore: LockStore = {
    acquire: async (key, options) => (await store).acquire(key, options),
    tryAcquire: async (key) => (await store).tryAcquire(key),
    isHeld: async (key) => (await store).isHeld(key),
  };
  return { docker, store: lockStore };
}

/** The store of a child process or a worker thread over `location`. */
export const openInProcess = (location: string) =>
  dockerEngineStore(location).store;

const module: StoreModule = {
  url: new URL(import.meta.url),
  export: 'openInProcess',
};

export const subject: Subject<Host> = {
  name: 'DockerEngineStore',
  fixture: dockerEngineFixture,
  open: (location) => {
    const { docker, store } = dockerEngineStore(location);
    return {
      store,
      [Symbol.asyncDispose]: async () => {
        await (await docker)[Symbol.asyncDispose]();
      },
    };
  },
  process: { module, admit() {} },
  grantLatency: 300,
};

export const sharing = sharesWithProcesses(subject.process);

export const threadSharing = sharesWithThreads<Host>({ module, admit() {} });

/**
 * A Unix socket proxy in front of the socket of the engine. `partition()`
 * stops forwarding in both directions and closes no socket. A hold keeps each
 * request to the engine from its trigger on, on every connection, until its
 * `release()`.
 */
export async function engineProxy(docker: Docker) {
  const enginePath = new URL(docker.host).pathname;
  const directory = await new TemporaryFiles().directory('mutex-test-');
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

export const partitionable: Partitionable = {
  heartbeatInterval: 500,
  async partitionable(location, clock) {
    const { host, namespace, run }: DockerEngineLocation = JSON.parse(location);
    const stack = new AsyncDisposableStack();
    const direct = stack.use(await Docker.connect({ clock: globalThis, host }));
    const proxy = stack.use(await engineProxy(direct));
    const client = stack.use(
      await Docker.connect({ clock: globalThis, host: proxy.host }),
    );
    return {
      store: new DockerEngineStore({
        docker: client,
        image: dockerImage,
        namespace,
        heartbeatInterval: this.heartbeatInterval,
        labels: new DockerTestbed({ environment: run }).defaults.Labels,
        clock,
      }),
      partition: () => proxy.partition(),
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  },
};
