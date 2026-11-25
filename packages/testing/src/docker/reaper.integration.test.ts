import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type TestContext, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { untilAborted } from '@zukhruf/async';
import {
  BindSourceNotFoundError,
  type Container,
  ContainerNotFoundError,
  Docker,
} from '@zukhruf/docker';
import { TemporaryFiles } from '@zukhruf/fs';

import { retryUntilReady } from '../async/retry-until-ready.ts';
import { waitFor } from '../async/wait-for.ts';
import { engine, proxyless } from '../testing/current-engine.ts';
import { docker } from '../testing/engine-client.ts';
import { EngineProxy } from '../testing/engine-proxy.ts';
import { LEASE_IMAGE } from './engine-lease.ts';
import { DockerTestbed } from './index.ts';
import {
  REAPER_DEFAULTS,
  REAPER_IMAGE,
  REAPER_LABEL,
  ReaperHold,
  type ReaperSettings,
  SERVER_LABEL,
  reaperName,
  reaperRequest,
} from './reaper.ts';
import { directoryParent } from './run-records.ts';

const RUN_LABEL = 'dev.zukhruf.testing.run';
const KIND_LABEL = 'dev.zukhruf.testing.kind';

/** Pulls `image` when the engine of this process does not have it. */
async function present(image: string): Promise<void> {
  if ((await docker.images.inspect(image)) === undefined)
    await docker.images.pull(image);
}

/**
 * Short inputs, as the tests of Ryuk give it (ADR 0020, item 4), with the
 * shipped request time limit: a tighter one races the engine calls on a loaded
 * runner, and a call that hits it keeps the reaper (#5266, #5482, #5635). A
 * test of the limit sets its own.
 */
const quick: ReaperSettings = {
  ...REAPER_DEFAULTS,
  grace: 300,
  interval: 200,
  passes: 2,
  retries: 2,
};

/** A Node process that runs `source`, with `Docker`, `ReaperHold` and `DockerTestbed` in scope, and the lines it prints. */
interface Program {
  child: ChildProcess;
  /** The next line that the program printed. Rejects when it exits first. */
  line(): Promise<string>;
  /** Writes a line to its standard input. */
  send(text: string): void;
}

function program(
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): Program {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { Docker } from ${JSON.stringify(import.meta.resolve('@zukhruf/docker'))};
        import { ReaperHold } from ${JSON.stringify(new URL('./reaper.ts', import.meta.url).href)};
        import { DockerTestbed } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
        ${source}
      `,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], env },
  );
  const lines = createInterface({ input: child.stdout! })[
    Symbol.asyncIterator
  ]();
  const exited = once(child, 'exit').then(([code]) => {
    throw new Error(`The program exited with ${String(code)}`);
  });
  exited.catch(() => {});
  return {
    child,
    line: async () => {
      const next = await Promise.race([lines.next(), exited]);
      if (next.done === true) throw new Error('The program closed its output');
      return next.value;
    },
    send: (text) => child.stdin!.write(`${text}\n`),
  };
}

/** A process with `env` that holds the reaper of `run` with `settings`, prints a line, and lives until it is killed. */
async function holder(
  run: string,
  settings: ReaperSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChildProcess> {
  const { child, line } = program(
    `
    const docker = await Docker.connect({ clock: globalThis, environment: process.env });
    await ReaperHold.take(docker, docker.host, ${JSON.stringify(run)}, ${JSON.stringify(settings)}, globalThis);
    console.log('held');
    setInterval(() => {}, 60_000);
  `,
    env,
  );
  assert.equal(await line(), 'held');
  return child;
}

/**
 * A process that holds the reaper of `run` with `settings`, then creates and
 * starts a container of the run, prints its id, and lives until it is killed.
 */
function creator(run: string, settings: ReaperSettings): Program {
  return program(`
    const docker = await Docker.connect({ clock: globalThis, environment: process.env });
    await ReaperHold.take(docker, docker.host, ${JSON.stringify(run)}, ${JSON.stringify(settings)}, globalThis);
    const container = await docker.containers.create({
      Image: 'alpine:latest',
      Cmd: ['sleep', '3600'],
      Labels: { ${JSON.stringify(RUN_LABEL)}: ${JSON.stringify(run)} },
    });
    await container.start();
    console.log(container.id);
    setInterval(() => {}, 60_000);
  `);
}

/**
 * A test process of the run `run` whose records are in `records`, with
 * `environment` over this process's: it holds the run's reaper through
 * `DockerTestbed.defaults()` once, prints the labels as JSON, and then, for
 * each line `create`, creates a container with those labels through a client
 * of its own, as a sandbox launcher does, and prints its id.
 */
function launcher(
  run: string,
  records: string,
  environment: NodeJS.ProcessEnv = {},
): Program {
  return program(
    `
      import { createInterface } from 'node:readline';
      const testbed = new DockerTestbed({ environment: process.env });
      const { Labels } = await testbed.defaults();
      const docker = await Docker.connect({ clock: globalThis, environment: process.env });
      console.log(JSON.stringify(Labels));
      for await (const command of createInterface({ input: process.stdin })) {
        if (command !== 'create') continue;
        const container = await docker.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '3600'], Labels });
        await container.start();
        console.log(container.id);
      }
    `,
    {
      ...process.env,
      ...environment,
      ZUKHRUF_TESTING_RUN_ID: run,
      ZUKHRUF_TESTING_RUN_DIR: records,
    },
  );
}

async function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

/** A started container of the run `run`, with `labels` and an anonymous volume. */
async function object(
  run: string,
  labels: Record<string, string> = {},
): Promise<string> {
  const container = await docker.containers.create({
    Image: 'alpine:latest',
    Cmd: ['sleep', '3600'],
    Labels: { [RUN_LABEL]: run, ...labels },
    Volumes: { '/data': {} },
  });
  await container.start();
  return container.id;
}

const exists = async (id: string): Promise<boolean> =>
  (await docker.containers.find(id)) !== undefined;

const volumeExists = async (name: string): Promise<boolean> =>
  (await docker.volumes.find(name)) !== undefined;

/**
 * True when the reaper `id` of `run` ended: it is gone, or it is a kept
 * reaper (ADR 0031), which exited with 0 under the name
 * `<reaperName(run)>-<self>` after a call hit its request time limit, as
 * endedOnce reads it.
 */
const reaperEnded = async (id: string, run: string): Promise<boolean> => {
  const reaper = await (await docker.containers.find(id))?.inspect();
  return (
    reaper === undefined ||
    (reaper.State?.Status === 'exited' &&
      reaper.State.ExitCode === 0 &&
      reaper.Name?.startsWith(`/${reaperName(run)}-`) === true)
  );
};

const reapers = async (run: string): Promise<string[]> =>
  (
    await docker.containers.list({
      all: true,
      filters: { label: [`${REAPER_LABEL}=${run}`] },
    })
  ).map(({ Id }) => Id);

/** The PIDs of the `cat` processes in the reaper `id` on the engine of `client`: one for each holder. */
async function holdersOf(id: string, client = docker): Promise<string[]> {
  const reaper = await client.containers.find(id);
  if (reaper === undefined) return [];
  const { stdout } = await reaper.exec({ Cmd: ['pgrep', '-x', 'cat'] });
  return stdout.split('\n').filter((pid) => pid !== '');
}

/** The anonymous volumes of the container `id`. */
async function volumesOf(id: string): Promise<string[]> {
  const inspected = await (await docker.containers.find(id))?.inspect();
  return (inspected?.Mounts ?? []).flatMap(({ Name }) =>
    Name === undefined ? [] : [Name],
  );
}

/** Removes what the test made: the containers and volumes of `run`, its reaper, and `others`. */
async function removeRun(run: string, others: string[] = []): Promise<void> {
  const filters = {
    label: [`${RUN_LABEL}=${run}`],
  };
  for (const id of [
    ...(await reapers(run)),
    ...others,
    ...(await docker.containers.list({ all: true, filters })).map(
      ({ Id }) => Id,
    ),
  ])
    await (await docker.containers.find(id))?.remove({ force: true, v: true });
  for (const { Name } of await docker.volumes.list({ filters }))
    await (await docker.volumes.find(Name))?.remove({ force: true });
}

const gone = (t: TestContext, check: () => Promise<void>) =>
  waitFor(check, { signal: t.signal, interval: 100 });

/**
 * Gives the id of the exec of the next `event` in the container `id`, from
 * `since` on: of the exec `exec` only, when given.
 */
async function execEvent(
  id: string,
  since: number,
  event: 'exec_start' | 'exec_die',
  signal: AbortSignal,
  exec?: string,
): Promise<string> {
  for await (const { Actor } of docker.events({
    since,
    filters: { container: [id], event: [event] },
    signal,
  })) {
    const found = Actor?.Attributes?.execID;
    if (exec === undefined || found === exec) {
      assert.ok(found !== undefined, `the ${event} event has an exec id`);
      return found;
    }
  }
  throw new Error('the events of the engine ended');
}

/**
 * Starts the reaper of `run` with `settings`, and with no wait for a first
 * holder, with each of its engine requests through `proxy`, as moby-ryuk's
 * tests give its reaper a client that fails chosen calls. Its `docker` CLI
 * reads `DOCKER_HOST`, so the test points it at a TCP port of this process
 * that forwards to the proxy (as in docker-global-setup.integration.test.ts).
 * Gives its id, and its end once (endedOnce).
 */
async function proxiedReaper(
  stack: AsyncDisposableStack,
  proxy: EngineProxy,
  run: string,
  settings: ReaperSettings,
): Promise<{ id: string; finished: Promise<'removed' | 'kept'> }> {
  await present('alpine:latest');
  // Docker Desktop resolves host.docker.internal to this machine. On a native
  // Linux engine the reaper reaches this machine at the gateway of the
  // default bridge; the relay listens there only, never on every address.
  const resolves = await docker.containers.run({
    Image: 'alpine:latest',
    Cmd: ['getent', 'hosts', 'host.docker.internal'],
    HostConfig: { AutoRemove: true },
  });
  const desktop = resolves.exitCode === 0;
  const bridge = desktop
    ? undefined
    : await (await docker.networks.find('bridge'))?.inspect();
  const gateway = bridge?.IPAM?.Config?.[0]?.Gateway;
  assert.ok(desktop || gateway !== undefined, 'the bridge has a gateway');
  const socket = proxy.host.slice('unix://'.length);
  const relay = createServer((client) => {
    const upstream = connect(socket);
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  relay.listen(0, gateway ?? '127.0.0.1');
  await once(relay, 'listening');
  stack.defer(
    () => new Promise<void>((resolve) => relay.close(() => resolve())),
  );
  const address = relay.address();
  assert.ok(address !== null && typeof address === 'object');
  await present(REAPER_IMAGE);
  const body = reaperRequest(
    run,
    { ...settings, firstHolder: 0 },
    '/var/run/docker.sock',
    directoryParent(docker.host),
  );
  const since = Math.floor(Date.now() / 1000) - 1;
  const reaper = await docker.containers.create(
    {
      ...body,
      Env: [
        ...(body.Env ?? []),
        `DOCKER_HOST=tcp://host.docker.internal:${address.port}`,
      ],
      HostConfig: {
        ...body.HostConfig,
        ...(desktop
          ? {}
          : { ExtraHosts: ['host.docker.internal:host-gateway'] }),
      },
    },
    { name: reaperName(run) },
  );
  const finished = endedOnce(reaper.id, run, since);
  finished.catch(() => {});
  await reaper.start();
  return { id: reaper.id, finished };
}

/**
 * Resolves when the reaper `id` of `run` ended, from `since` on, after one
 * start and one end, with how it ended. A reaper removes itself, so its exit
 * code is 137 at its end and the engine destroys it: `removed`. A reaper with
 * a call that hit its request time limit exits 0 under the name of a kept
 * reaper, and stays (ADR 0031): `kept`. A crash that its restart policy
 * followed with a start rejects.
 */
async function endedOnce(
  id: string,
  run: string,
  since: number,
): Promise<'removed' | 'kept'> {
  const actions: (string | undefined)[] = [];
  for await (const { Action, Actor } of docker.events({
    since,
    filters: { container: [id], event: ['start', 'die', 'destroy'] },
  })) {
    const kept =
      Action === 'die' &&
      Actor?.Attributes?.exitCode === '0' &&
      Actor.Attributes.name?.startsWith(`${reaperName(run)}-`) === true;
    actions.push(kept ? 'kept' : Action);
    if (kept || Action === 'destroy') break;
  }
  const end = actions.at(-1) === 'kept' ? 'kept' : 'removed';
  assert.deepEqual(
    actions,
    end === 'kept' ? ['start', 'kept'] : ['start', 'die', 'destroy'],
    'the reaper ends once, and its policy never starts it again',
  );
  return end;
}

/** `promise`, or, when `signal` aborts first, a rejection that names `what`. */
async function within<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  what: string,
): Promise<T> {
  try {
    return await untilAborted(promise, signal);
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      throw new Error(`${what} did not happen`, { cause: error });
    }
    throw error;
  }
}

/** The records directory of a new run, under `directory`. */
async function recordsOf(directory: string): Promise<string> {
  const records = join(directory, 'run');
  await mkdir(records);
  return records;
}

/** The name of the sweep lease of `fingerprint`: the name each reaper and each test process of that server agree on (ADR 0014). */
const sweepLease = (fingerprint: string): string =>
  `zukhruf-testing-sweep-${fingerprint}`;

/** A container with the name and the label of the reaper of `run` that exited and stays, unlike a real one, which removes itself at its end. */
async function staleReaper(run: string): Promise<string> {
  const stale = await docker.containers.create(
    {
      Image: 'alpine:latest',
      Cmd: ['true'],
      Labels: { [REAPER_LABEL]: run },
    },
    { name: reaperName(run) },
  );
  await stale.start();
  await stale.wait({ condition: 'not-running' });
  return stale.id;
}

/**
 * A test process of the run `run` whose records are in `records`: it makes a
 * directory with `DockerTestbed.directory()` and writes a file in it, runs
 * `fill` with `testbed` and `directory` in scope, prints the directory's path,
 * and lives until it is killed.
 */
function directoryMaker(run: string, records: string, fill = ''): Program {
  return program(
    `
      const testbed = new DockerTestbed({ environment: process.env });
      const directory = await testbed.directory();
      await directory.writeFile('file.txt', 'owned');
      ${fill}
      console.log(directory.path);
      setInterval(() => {}, 60_000);
    `,
    {
      ...process.env,
      ZUKHRUF_TESTING_RUN_ID: run,
      ZUKHRUF_TESTING_RUN_DIR: records,
    },
  );
}

/** Whether the engine's host has `path`: the engine refuses a bind mount whose source its host does not have. */
async function onEngineHost(path: string): Promise<boolean> {
  try {
    await docker.containers.run({
      Image: 'alpine:latest',
      Cmd: ['true'],
      HostConfig: {
        Mounts: [{ Type: 'bind', Source: path, Target: '/probe' }],
      },
    });
    return true;
  } catch (error) {
    if (error instanceof BindSourceNotFoundError) return false;
    throw error;
  }
}

/** Marks a reaper with the source of its socket on the engine's host (ADR 0020, item 14). */
const SOCKET_LABEL = 'dev.zukhruf.testing.reaper.socket';

/** A second engine of this run, and a client of it through a unix socket of this machine. */
interface SecondEngine extends AsyncDisposable {
  /** The container of the second engine, on the engine of this process. */
  container: Container;
  client: Docker;
  /** The `unix://` host of the relay. */
  host: string;
  /** Stops the dockerd of the second engine and resolves when its next dockerd answers: a restart of the engine. Its wait ends at `signal`. */
  restart(signal: AbortSignal): Promise<void>;
}

/** A path of a unix socket that fits the 104 bytes of macOS. */
const shortSocket = () => `/tmp/zt-${randomUUID().slice(0, 8)}.sock`;

/**
 * A docker-in-docker engine, created by this run's testbed, whose dockerd
 * listens on each path of `sockets`, with `binds`, and a unix socket at
 * `relay` on this machine that relays to its TCP port. The testbed publishes
 * that port on 127.0.0.1 of the engine's host only: it gives root there.
 */
async function secondEngine({
  sockets,
  binds = [],
  relay,
}: {
  sockets: string[];
  binds?: string[];
  relay: string;
}): Promise<SecondEngine> {
  await using stack = new AsyncDisposableStack();
  const service = stack.use(
    await new DockerTestbed({ environment: process.env }).serve(
      {
        Image: 'docker:28.5.2-dind',
        // Its first process starts dockerd again each time it ends, so a test
        // restarts the engine with no start of its container: each start
        // publishes the port on another port of the engine's host.
        Entrypoint: [
          'sh',
          '-c',
          'while :; do dockerd-entrypoint.sh "$@"; done',
          'sh',
        ],
        Cmd: [
          'dockerd',
          ...sockets.map((socket) => `--host=unix://${socket}`),
          '--host=tcp://0.0.0.0:2375',
          '--tls=false',
        ],
        Env: ['DOCKER_TLS_CERTDIR='],
        HostConfig: { Privileged: true, Binds: binds },
      },
      {
        internalPort: 2375,
        healthy: ({ port }) =>
          retryUntilReady(
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
  // Half-open: a client ends its input of an exec before the engine sent the
  // output, which a relay that closes both ways at that end loses.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({
      port: service.port,
      host: service.host,
      allowHalfOpen: true,
    });
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
  // each image that the tests and the reaper use there, or pulls it once, and
  // loads it into the second engine.
  const images = [REAPER_IMAGE, 'alpine:latest'];
  for (const image of images) await present(image);
  await client.images.load(await docker.images.save(images));
  const owned = stack.move();
  return {
    container: service.container,
    client,
    host,
    restart: async (signal) => {
      const stopped = await service.container.exec({
        Cmd: [
          'sh',
          '-c',
          'pid=$(pidof dockerd) && kill "$pid" && while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done',
        ],
      });
      if (stopped.exitCode !== 0)
        throw new Error(`The stop of dockerd exited with ${stopped.exitCode}`);
      await waitFor(() => client.info(), { signal, interval: 100 });
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** The source of the socket of each reaper of `run` on the engine of `client`. */
const reaperSockets = async (client: Docker, run: string) =>
  (
    await client.containers.list({
      all: true,
      filters: { label: [`${REAPER_LABEL}=${run}`] },
    })
  )
    // The socket label is the contract of ADR 0020, item 14, and the only view of which socket a reaper used.
    .map(({ Labels }) => Labels?.[SOCKET_LABEL]);

/**
 * The source of the socket of each reaper of `run` that the second engine
 * removes from now on, in order. The stream starts at the second engine's own
 * clock, so an event before the stream attaches is still in it.
 */
async function removedReapers(second: SecondEngine, run: string) {
  const { stdout } = await second.container.exec({ Cmd: ['date', '+%s'] });
  const since = Number(stdout.trim());
  const watch = new AbortController();
  const sockets: (string | undefined)[] = [];
  const watching = (async () => {
    for await (const { Actor } of second.client.events({
      since,
      filters: { label: [`${REAPER_LABEL}=${run}`], event: ['destroy'] },
      signal: watch.signal,
    }))
      // The socket label is the contract of ADR 0020, item 14, and the only view of which socket a reaper used.
      sockets.push(Actor?.Attributes?.[SOCKET_LABEL]);
  })();
  watching.catch(() => {});
  return { sockets, [Symbol.dispose]: () => watch.abort() };
}

/** A started container of the run `run` on the engine of `client`. */
async function objectOn(client: Docker, run: string): Promise<string> {
  const container = await client.containers.create({
    Image: 'alpine:latest',
    Cmd: ['sleep', '3600'],
    Labels: { [RUN_LABEL]: run },
  });
  await container.start();
  return container.id;
}

/** The holders of the running reaper of `run` on the engine of `client`: none while no reaper of it runs. */
async function heldOn(client: Docker, run: string): Promise<number> {
  const [reaper] = await client.containers.list({
    filters: { label: [`${REAPER_LABEL}=${run}`] },
  });
  return reaper === undefined ? 0 : (await holdersOf(reaper.Id, client)).length;
}

// Each test scopes its objects by its own run id, so these run four at a time.
describe('the reaper of a run', { concurrency: 4 }, () => {
  test('one reaper of a run keeps the run’s objects while one of its holders lives, and removes them, with their anonymous volumes, after the last one ended', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    const holders: ChildProcess[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      for (const child of holders) await killed(child);
      await removeRun(run);
    });

    holders.push(await holder(run, quick), await holder(run, quick));
    const id = await object(run);
    const anonymous = await volumesOf(id);
    const { name: volume } = await docker.volumes.create({
      Labels: { [RUN_LABEL]: run },
    });
    const reapersWhileHeld = await reapers(run);

    await killed(holders[0]!);
    // A fixed window, longer than the grace and each pass of the reaper: the
    // test proves that the reaper removed nothing while one holder lives.
    await delay(quick.grace + quick.interval * quick.passes + 2_000);
    const keptWhileOneHolds = [await exists(id), await volumeExists(volume)];
    await killed(holders[1]!);

    assert.equal(reapersWhileHeld.length, 1);
    assert.deepEqual(keptWhileOneHolds, [true, true]);
    await gone(t, async () => {
      assert.equal(await exists(id), false);
      assert.equal(await volumeExists(volume), false);
      for (const name of anonymous)
        assert.equal(await volumeExists(name), false);
      assert.deepEqual(await reapers(run), []);
    });
  });

  test('the reaper of a run keeps a shared server that carries the run’s label', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => removeRun(run));

    const child = await holder(run, quick);
    cleanup.defer(() => killed(child));
    const server = await object(run, { [SERVER_LABEL]: randomUUID() });
    const owned = await object(run);

    await killed(child);

    await gone(t, async () => {
      assert.equal(await exists(owned), false);
      assert.deepEqual(await reapers(run), []);
    });
    assert.equal(await exists(server), true);
  });

  test('a holder that comes during the grace stops the countdown, and the reaper acts after that holder ended', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    // Much longer than the start of a holder, so the second holder comes within it.
    const settings = { ...quick, grace: 15_000 };
    const holders: ChildProcess[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      for (const child of holders) await killed(child);
      await removeRun(run);
    });

    holders.push(await holder(run, settings));
    const id = await object(run);
    const [reaper] = await reapers(run);
    assert.ok(reaper);

    await killed(holders[0]!);
    holders.push(await holder(run, settings));
    const heldAgain = {
      reapers: await reapers(run),
      holders: (await holdersOf(reaper)).length,
      kept: await exists(id),
    };
    await killed(holders[1]!);

    assert.deepEqual(heldAgain, {
      reapers: [reaper],
      holders: 1,
      kept: true,
    });
    await gone(t, async () => assert.equal(await exists(id), false));
  });

  test(
    'a reaper whose removal fails tries it again one interval later, and removes the volume once the engine allows it',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      await present('alpine:latest');
      await using stack = new AsyncDisposableStack();
      const others: string[] = [];
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => removeRun(run, others));

      const { name: volume } = await docker.volumes.create({
        Labels: { [RUN_LABEL]: run },
      });
      // Not of the run: the engine refuses the removal of the volume while it runs.
      const using = await docker.containers.create({
        Image: 'alpine:latest',
        Cmd: ['sleep', '3600'],
        HostConfig: { Binds: [`${volume}:/data`] },
      });
      others.push(using.id);
      await using.start();
      const proxy = stack.use(await EngineProxy.start(engine));
      const removal = `/volumes/${volume}`;
      // The reaper tries a removal again only after the engine refused it, so a
      // second try means the first was refused. The volume is freed before the
      // engine gets that second try.
      let tries = 0;
      proxy.intercept('DELETE', removal, async () => {
        tries += 1;
        if (tries === 2) await using.remove({ force: true });
      });

      await proxiedReaper(stack, proxy, run, {
        ...quick,
        interval: 500,
        passes: 0,
        retries: 8,
      });

      await gone(t, async () => {
        assert.equal(await volumeExists(volume), false);
        assert.deepEqual(await reapers(run), []);
      });
      const deletes = proxy.requests.filter(
        ({ method, path }) => method === 'DELETE' && path === removal,
      );
      assert.ok(
        deletes.length >= 2,
        `${deletes.length} removals of the volume`,
      );
    },
  );

  test('a reaper whose drop of a database never gets an answer ends within its request time limit, keeps that database, removes the run’s containers, and keeps its stopped container with a line that names the drop', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    const database = `test_${run.replaceAll('-', '')}_0123456789abcdef`;
    // A list that does not answer within one request time limit counts as
    // done (ADR 0020, item 8), so a tighter limit than the shipped one races
    // the list under load, not the drop.
    const settings = {
      ...quick,
      grace: 100,
      passes: 0,
      requestTimeout: REAPER_DEFAULTS.requestTimeout,
    };
    const others: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => removeRun(run, others));

    // A shared Postgres server whose psql lists the run's database and never
    // ends a drop. The database is a file that the drop would remove. A drop
    // writes its command to /dropped first.
    const fake = await docker.containers.create({
      Image: 'alpine:latest',
      Entrypoint: [
        'sh',
        '-c',
        `mkdir -p /databases && touch /databases/${database}
printf '%s\\n' '#!/bin/sh' 'case "$*" in *DROP*) echo "$*" > /dropped; sleep 3600; rm -f /databases/*;; *) ls /databases;; esac' > /usr/local/bin/psql
chmod +x /usr/local/bin/psql
exec sleep 3600`,
      ],
      Cmd: [],
      Labels: { [SERVER_LABEL]: randomUUID(), [KIND_LABEL]: 'postgres' },
    });
    others.push(fake.id);
    await fake.start();
    const child = await holder(run, settings);
    cleanup.defer(() => killed(child));
    const owned = await object(run);

    await killed(child);

    // Within the grace, one list, one drop that times out, and the expiry
    // pass. The drop hit its limit, so the reaper keeps its container (ADR 0031).
    const kept = await waitFor(
      async () => {
        const [stopped] = await docker.containers.list({
          all: true,
          filters: { label: [`${REAPER_LABEL}=${run}`], status: ['exited'] },
        });
        assert.ok(stopped?.Id !== undefined, 'the reaper kept its container');
        return stopped.Id;
      },
      { signal: t.signal, interval: 100 },
    );
    const { stderr } = await (await docker.containers.find(kept))!.logs();
    const dropped = await fake.exec({ Cmd: ['cat', '/dropped'] });
    assert.match(dropped.stdout, new RegExp(`DROP DATABASE.*${database}`));
    const { stdout } = await fake.exec({ Cmd: ['ls', '/databases'] });
    assert.equal(stdout.trim(), database);
    assert.equal(await exists(owned), false);
    assert.deepEqual(
      stderr.split('\n').filter((line) => line.includes(`server=${fake.id}`)),
      [
        `level=WARN msg="request time limit" call="docker exec ${fake.id} drop ${database}" server=${fake.id} limit=${settings.requestTimeout} run=${run}`,
      ],
    );
  });

  test('a reaper whose list of the databases of a shared server hits its request time limit keeps those databases, keeps its stopped container with one line for each list, and a hold that comes while it closes holds the next reaper of the run', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    const database = `test_${run.replaceAll('-', '')}_0123456789abcdef`;
    // The list answers after 2 s, so the limit of 1 s ends it in each pass.
    // The re-check passes keep the reaper closing for about 9 s.
    const settings = {
      ...quick,
      grace: 100,
      interval: 2_000,
      passes: 3,
      requestTimeout: 1_000,
    };
    const holders: ChildProcess[] = [];
    const others: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      for (const child of holders) await killed(child);
      await removeRun(run, others);
    });

    // A shared Postgres server whose psql answers a list of the run's
    // database after 2 s. A drop writes its command to /dropped and removes
    // the database, a file.
    const fake = await docker.containers.create({
      Image: 'alpine:latest',
      Entrypoint: [
        'sh',
        '-c',
        `mkdir -p /databases && touch /databases/${database}
printf '%s\\n' '#!/bin/sh' 'case "$*" in *DROP*) echo "$*" > /dropped; rm -f /databases/*;; *) sleep 2; ls /databases;; esac' > /usr/local/bin/psql
chmod +x /usr/local/bin/psql
exec sleep 3600`,
      ],
      Cmd: [],
      Labels: { [SERVER_LABEL]: randomUUID(), [KIND_LABEL]: 'postgres' },
    });
    others.push(fake.id);
    await fake.start();
    holders.push(await holder(run, settings));
    const owned = await object(run);
    const [closing] = await reapers(run);
    assert.ok(closing);
    await killed(holders[0]!);
    // The first pass removed the run's container: the reaper is closing.
    await gone(t, async () => assert.equal(await exists(owned), false));

    // A limit of 3 s: the reaper of this hold lists the server in time.
    holders.push(await holder(run, quick));
    // A fixed window, longer than the first wait of a restart policy of
    // Docker (100 ms): a reaper that the engine starts again runs after it.
    await delay(3_000);
    const kept = await docker.containers.inspect(closing);
    const { stderr } = await (await docker.containers.find(closing))!.logs();
    const [next] = (await reapers(run)).filter((id) => id !== closing);
    const { stdout } = await fake.exec({ Cmd: ['ls', '/databases'] });

    assert.equal(kept?.State?.Status, 'exited');
    assert.deepEqual(
      stderr.split('\n').filter((line) => line.includes(`server=${fake.id}`)),
      Array.from(
        { length: settings.passes + 1 },
        () =>
          `level=WARN msg="request time limit" call="docker exec ${fake.id} list" server=${fake.id} limit=${settings.requestTimeout} run=${run}`,
      ),
    );
    assert.ok(next, 'the hold is on the next reaper of the run');
    assert.equal((await holdersOf(next)).length, 1);
    assert.equal(stdout.trim(), database);
  });

  test('a reaper that no holder holds removes the run’s objects after its wait for a first holder, and exits', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    await present(REAPER_IMAGE);
    const ids: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await removeRun(run, ids);
    });

    ids.push(await object(run));
    // The reaper of a process that was killed between the start of its
    // reaper and its hold: no holder ever comes.
    const reaper = await docker.containers.create(
      reaperRequest(
        run,
        { ...quick, firstHolder: 1_000 },
        '/var/run/docker.sock',
        directoryParent(docker.host),
      ),
      { name: reaperName(run) },
    );

    await reaper.start();

    await gone(t, async () => {
      assert.equal(await exists(ids[0]!), false);
      assert.deepEqual(await reapers(run), []);
    });
  });

  test('a reaper whose socket does not reach its engine exits 1, and the engine does not start it again', async () => {
    const run = randomUUID();
    await present(REAPER_IMAGE);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await removeRun(run);
    });

    // A file of the engine's host that no engine listens on. No holder asks
    // this reaper, so none removes it after its answer.
    const reaper = await docker.containers.create(
      reaperRequest(
        run,
        { ...quick, firstHolder: 0, requestTimeout: 1_000 },
        '/etc/hosts',
        directoryParent(docker.host),
      ),
      { name: reaperName(run) },
    );
    const exited = reaper.wait({ condition: 'next-exit' });
    await reaper.start();
    const { StatusCode } = await exited;
    // A fixed window, longer than the first wait of a restart policy of
    // Docker (100 ms) and the run of the reaper (1 s): a reaper that the engine
    // starts again runs, or waits for its next start, after it.
    await delay(3_000);

    assert.equal(StatusCode, 1);
    assert.deepEqual(
      await docker.containers.list({
        all: true,
        filters: {
          label: [`${REAPER_LABEL}=${run}`],
          status: ['running', 'restarting'],
        },
      }),
      [],
    );
  });

  test('a test process whose hold was cut holds the reaper again at once, and the reaper removes what it creates after that, once it exits', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-reaper-',
    );
    const run = randomUUID();
    await present('alpine:latest');
    const launched = launcher(run, await recordsOf(directory.path));
    const ids: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await killed(launched.child);
      await removeRun(run, ids);
    });

    await launched.line();
    const [reaper] = await reapers(run);
    assert.ok(reaper);
    const [cat] = await holdersOf(reaper);
    assert.ok(cat);

    // The engine ends the exec of the hold, as at a break of its connection.
    await (await docker.containers.find(reaper))!.exec({
      Cmd: ['kill', cat],
    });
    await gone(t, async () => {
      const [now] = await reapers(run);
      assert.ok(
        now === undefined || (await holdersOf(now)).some((pid) => pid !== cat),
        'held again, or the reaper is gone',
      );
    });
    launched.send('create');
    ids.push(await launched.line());
    await killed(launched.child);

    await gone(t, async () => {
      assert.equal(await exists(ids[0]!), false);
      assert.deepEqual(await reapers(run), []);
    });
  });

  test('a test process whose reaper was removed holds a new reaper at once, and that reaper removes what it creates after that, once it exits', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-reaper-',
    );
    const run = randomUUID();
    await present('alpine:latest');
    const launched = launcher(run, await recordsOf(directory.path));
    const ids: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await killed(launched.child);
      await removeRun(run, ids);
    });

    await launched.line();
    const [first] = await reapers(run);
    assert.ok(first);

    await (await docker.containers.find(first))?.remove({ force: true });
    await gone(t, async () => {
      const [now] = await reapers(run);
      assert.ok(now !== undefined && now !== first, 'a new reaper');
      assert.equal((await holdersOf(now)).length, 1);
    });
    launched.send('create');
    ids.push(await launched.line());
    await killed(launched.child);

    await gone(t, async () => {
      assert.equal(await exists(ids[0]!), false);
      assert.deepEqual(await reapers(run), []);
    });
  });

  test('a hold on a reaper that is closing waits until the engine removed it, and holds the next reaper of the run', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    // The re-check passes keep the reaper closing for about 4.5 s.
    const settings = { ...quick, grace: 300, interval: 1_500, passes: 3 };
    const holders: ChildProcess[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      for (const child of holders) await killed(child);
      await removeRun(run);
    });

    holders.push(await holder(run, settings));
    const id = await object(run);
    const [closing] = await reapers(run);
    assert.ok(closing);
    await killed(holders[0]!);
    // The first pass removed the run's container: the reaper is closing.
    await gone(t, async () => assert.equal(await exists(id), false));

    holders.push(await holder(run, settings));

    assert.equal(await exists(closing), false);
    const [next] = await reapers(run);
    assert.ok(next, 'the hold is on a new reaper');
    assert.equal((await holdersOf(next)).length, 1);
  });

  test('a hold on a reaper that stays closing past the readiness bound of the hold rejects with the hold’s named error', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    // After its first pass, the reaper keeps its door closed for 10 minutes.
    const closing = { ...quick, grace: 0, passes: 1, interval: 600_000 };
    const readiness = 3_000;
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await removeRun(run);
    });

    const id = await object(run);
    // A holder that ends: the reaper does its first pass and stays closing.
    await killed(await holder(run, closing));
    // The first pass removed the run's container: the reaper is closing.
    await gone(t, async () => assert.equal(await exists(id), false));

    await assert.rejects(
      ReaperHold.take(
        docker,
        docker.host,
        run,
        { ...quick, readiness },
        globalThis,
      ),
      {
        message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of ${readiness} ms`,
      },
    );
  });

  test(
    'a held() that joins the hold a cut hold takes again rejects with the hold’s named error when the bound of that hold ends, before its own bound',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      const readiness = 2_000;
      const clock = createClock();
      await using stack = new AsyncDisposableStack();
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(async () => {
        await removeRun(run);
      });

      const proxy = stack.use(await EngineProxy.start(engine));
      const client = stack.use(
        await Docker.connect({
          clock: globalThis,
          environment: { DOCKER_HOST: proxy.host },
        }),
      );
      // The first exec create is the hold that take() takes. The second is
      // the hold that is taken again after the cut: held here, so that hold
      // is in flight when held() joins it.
      const again = proxy.hold('POST', /^\/containers\/[^/]+\/exec$/, 2);
      stack.defer(() => again.release());
      const hold = await ReaperHold.take(
        client,
        client.host,
        run,
        { ...quick, readiness },
        clock,
      );
      const [reaper] = await reapers(run);
      assert.ok(reaper);
      const [cat] = await holdersOf(reaper);
      assert.ok(cat);

      // The engine ends the exec of the hold, as at a break of its connection.
      await (await docker.containers.find(reaper))!.exec({
        Cmd: ['kill', cat],
      });
      // The bound of the hold taken again starts before its exec create.
      await within(again.reached, t.signal, 'the hold taken again');
      clock.tick(readiness / 2);
      const joined = hold.held();
      // The bound of the hold taken again ends here. The bound of held()
      // started half a bound later, so it does not end.
      clock.tick(readiness / 2);

      await assert.rejects(within(joined, t.signal, 'the end of held()'), {
        message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of ${readiness} ms`,
      });
    },
  );

  test(
    'a hold on a reaper that stays closing ends its wait for the removal of that reaper at the readiness bound: its client leaves the request in flight',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      await present('alpine:latest');
      // After its first pass, the reaper keeps its door closed for 10 minutes.
      const closing = { ...quick, grace: 0, passes: 1, interval: 600_000 };
      const readiness = 3_000;
      const clock = createClock();
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(async () => {
        await removeRun(run);
      });

      const id = await object(run);
      // A holder that ends: the reaper does its first pass and stays closing.
      await killed(await holder(run, closing));
      // The first pass removed the run's container: the reaper is closing.
      await gone(t, async () => assert.equal(await exists(id), false));
      await using stack = new AsyncDisposableStack();
      const proxy = stack.use(await EngineProxy.start(engine));
      const client = stack.use(
        await Docker.connect({
          clock: globalThis,
          environment: { DOCKER_HOST: proxy.host },
        }),
      );
      // The reaper answers `closing` to the exec of the hold. The first
      // inspect after that exec starts is the hold's wait for the removal of
      // the reaper: held here until its client leaves.
      const wait = proxy.hold('GET', /^\/containers\/[^/]+\/json$/, 1, () =>
        proxy.requests.some(({ path }) => /^\/exec\/[^/]+\/start$/.test(path)),
      );
      stack.defer(() => wait.release());
      void wait.left.then(() => wait.release());
      const taking = ReaperHold.take(
        client,
        client.host,
        run,
        { ...quick, readiness },
        clock,
      );
      taking.catch(() => {});
      const held = await within(
        wait.reached,
        t.signal,
        'the wait for the removal of the closing reaper',
      );
      const exec = proxy.requests.findIndex(({ path }) =>
        /^\/exec\/[^/]+\/start$/.test(path),
      );
      assert.ok(
        exec !== -1 && proxy.requests.indexOf(held) > exec,
        'the held inspect comes after the start of the exec of the hold',
      );

      clock.tick(readiness);

      await within(wait.left, t.signal, 'the client leaving that wait');
      await assert.rejects(taking, {
        message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of ${readiness} ms`,
      });
    },
  );

  test(
    'a hold whose create of the reaper gets no answer ends that create at the readiness bound: its client leaves the request in flight',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      const readiness = 3_000;
      const clock = createClock();
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(async () => {
        await removeRun(run);
      });

      // The proxy forwards the create once its client left, and its disposal
      // waits for the engine's answer, so the cleanup sees that reaper.
      await using stack = new AsyncDisposableStack();
      const proxy = stack.use(await EngineProxy.start(engine));
      const client = stack.use(
        await Docker.connect({
          clock: globalThis,
          environment: { DOCKER_HOST: proxy.host },
        }),
      );
      const create = proxy.hold('POST', '/containers/create', 1);
      stack.defer(() => create.release());
      void create.left.then(() => create.release());
      const taking = ReaperHold.take(
        client,
        client.host,
        run,
        { ...quick, readiness },
        clock,
      );
      taking.catch(() => {});
      await within(create.reached, t.signal, 'the create of the reaper');

      clock.tick(readiness);

      await within(create.left, t.signal, 'the client leaving the create');
      await assert.rejects(taking, {
        message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of ${readiness} ms`,
      });
    },
  );

  test(
    'a holder that comes while a pass of the reaper runs keeps what it creates while it lives',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      await present('alpine:latest');
      await using stack = new AsyncDisposableStack();
      const ids = [await object(run)];
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => removeRun(run, ids));

      const proxy = stack.use(await EngineProxy.start(engine));
      // The first list of containers is the reaper's check of its socket
      // (ADR 0020, item 14). The second is the first request of the pass: its
      // list of the run's containers.
      const listing = proxy.hold('GET', '/containers/json', 2);
      stack.defer(() => listing.release());
      const since = Math.floor(Date.now() / 1000) - 1;
      const { id: reaper } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
      });
      await within(listing.reached, t.signal, 'the list of the pass');

      const late = creator(run, quick);
      cleanup.defer(() => killed(late.child));
      const created = late.line();
      created.catch(() => {});
      const watch = new AbortController();
      const refused = execEvent(reaper, since, 'exec_die', watch.signal);
      refused.catch(() => {});
      await within(
        Promise.race([created, refused]),
        t.signal,
        'a hold or its refusal',
      );
      watch.abort();
      listing.release();
      ids.push(
        await within(created, t.signal, 'the create of the late holder'),
      );
      // The volume list of the pass comes after its removal of the containers.
      await waitFor(
        () =>
          assert.ok(
            proxy.requests.some(
              ({ method, path }) => method === 'GET' && path === '/volumes',
            ),
          ),
        { signal: t.signal, interval: 100 },
      );

      assert.equal(await exists(ids[1]!), true);
      assert.equal(await exists(ids[0]!), false);
    },
  );

  test(
    'a holder that comes during the last pass of the reaper, after its removal of the containers, and then exits, leaves nothing that it created',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      await present('alpine:latest');
      await using stack = new AsyncDisposableStack();
      const ids = [await object(run)];
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => removeRun(run, ids));

      const proxy = stack.use(await EngineProxy.start(engine));
      // A pass lists the run's volumes after it removed the run's containers.
      const listing = proxy.hold('GET', '/volumes', 1);
      stack.defer(() => listing.release());
      const since = Math.floor(Date.now() / 1000) - 1;
      const { id: reaper } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
      });
      await within(listing.reached, t.signal, 'the volume list of the pass');

      const late = creator(run, quick);
      cleanup.defer(() => killed(late.child));
      const created = late.line();
      created.catch(() => {});
      const watch = new AbortController();
      const refused = execEvent(reaper, since, 'exec_die', watch.signal);
      refused.catch(() => {});
      await within(
        Promise.race([created, refused]),
        t.signal,
        'a hold or its refusal',
      );
      watch.abort();
      listing.release();
      ids.push(
        await within(created, t.signal, 'the create of the late holder'),
      );
      await killed(late.child);

      await gone(t, async () => {
        assert.equal(await exists(ids[1]!), false);
        assert.deepEqual(await reapers(run), []);
      });
    },
  );

  test(
    'a reaper that finds the sweep lease of an expired shared server taken on each of its sweepTries keeps that server and ends once',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      const fingerprint = randomUUID();
      const lease = sweepLease(fingerprint);
      const sweepTries = 3;
      await using stack = new AsyncDisposableStack();
      const others = [lease];
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => removeRun(run, others));

      await present('alpine:latest');
      await present('busybox:1.37.0');
      const shared = await docker.containers.create({
        Image: 'alpine:latest',
        Cmd: ['sleep', '3600'],
        Labels: { [SERVER_LABEL]: fingerprint },
      });
      const server = shared.id;
      others.unshift(server);
      await shared.start();
      // The reaper reads the age of a server in whole seconds of the engine's
      // clock: a server is older than a TTL of 1 ms from the next second on.
      const { Created } = await shared.inspect();
      assert.ok(Created !== undefined, 'the server has its creation time');
      const born = Math.floor(Date.parse(Created) / 1000);
      await waitFor(
        async () => {
          const { stdout } = await shared.exec({
            Cmd: ['date', '-u', '+%s'],
          });
          assert.ok(Number(stdout.trim()) > born, 'the server is 1 s old');
        },
        { signal: t.signal, interval: 200 },
      );
      const proxy = stack.use(await EngineProxy.start(engine));
      // Another holder of the sweep lease, such as a reaper of another run,
      // takes it again before each create of the reaper under test, and lets
      // it go when that reaper looks for its end. The sweep lease of each
      // other shared server is refused, so the test keeps them all.
      proxy.sweepOnly([fingerprint]);
      const events: ('try' | 'gone')[] = [];
      // The removal of the holder. It starts at the first inspect of the lease
      // after the Conflict, and never runs inside that inspect: the reaper
      // bounds each request by its requestTimeout, and polls until the lease
      // is gone.
      let removal: Promise<void> | undefined;
      proxy.intercept('POST', '/containers/create', async ({ body }) => {
        const { Labels: labels }: { Labels: Record<string, string> } =
          JSON.parse(body);
        if (labels['dev.zukhruf.testing.lease'] !== 'sweep') return;
        await removal;
        removal = undefined;
        events.push('try');
        if ((await docker.containers.find(lease)) !== undefined) return;
        const taken = await docker.containers.create(
          {
            Image: 'busybox:1.37.0',
            Entrypoint: ['cat'],
            Cmd: [],
            OpenStdin: true,
          },
          { name: lease },
        );
        await taken.start();
      });
      proxy.intercept('GET', `/containers/${lease}/json`, () => {
        removal ??= (async () => {
          const taken = await docker.containers.find(lease);
          if (taken === undefined) return;
          await taken.remove({ force: true });
          events.push('gone');
        })();
      });

      const { finished } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
        serverTtl: 1,
        sweepTries,
      });

      await within(finished, t.signal, 'the end of the reaper');
      await removal;
      assert.deepEqual(
        events,
        Array.from({ length: sweepTries }, () => ['try', 'gone']).flat(),
      );
      assert.equal(await exists(server), true);
    },
  );

  test(
    'a reaper removes each stopped reaper that is older than keptTtl, and keeps a younger stopped reaper, a created reaper, a reaper that runs, and a reaper that starts again before its removal',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      await present('alpine:latest');
      await using stack = new AsyncDisposableStack();
      const others: string[] = [];
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => removeRun(run, others));
      const keptTtl = 10_000;
      const reaperOf = async (cmd: string[]) => {
        const container = await docker.containers.create({
          Image: 'alpine:latest',
          Cmd: cmd,
          Labels: { [REAPER_LABEL]: randomUUID() },
        });
        others.push(container.id);
        return container;
      };

      const old = await staleReaper(randomUUID());
      others.push(old);
      const created = await reaperOf(['sleep', '3600']);
      const live = await reaperOf(['sleep', '3600']);
      await live.start();
      const restarted = await reaperOf(['sleep', '3600']);
      await restarted.start();
      await restarted.kill();
      await restarted.wait({ condition: 'not-running' });
      // The reaper reads the age of a reaper in whole seconds of the engine's
      // clock: these are older than keptTtl from the next second on.
      await delay(keptTtl + 1_100);
      const proxy = stack.use(await EngineProxy.start(engine));
      // The fifth list of containers is the reaper's list of stopped reapers,
      // after the check of its socket, the two lists of its pass and the list
      // of its expiry pass. The young reaper is made while that list waits, so
      // it is younger than keptTtl however long the reaper took to get there
      // (#5635: a loaded engine took longer than keptTtl).
      const stopped = proxy.hold('GET', '/containers/json', 5);
      stack.defer(() => stopped.release());
      // keptTtl expires each stopped reaper of the engine older than 10 s,
      // such as a kept reaper of another session. The proxy refuses the
      // removal of each reaper but those of the test and the reaper under
      // test. It starts `restarted` before the engine gets its removal, as the
      // engine does with a reaper that it starts again between the list of
      // stopped reapers and the removal.
      const ours = new Set([old, created.id, live.id, restarted.id]);
      proxy.intercept('DELETE', /^\/containers\/[^/]+$/, async ({ path }) => {
        const target = await docker.containers.inspect(
          decodeURIComponent(path.slice('/containers/'.length)),
        );
        const owner = target?.Config?.Labels?.[REAPER_LABEL];
        if (owner === undefined || owner === run) return;
        if (target?.Id === restarted.id) await restarted.start();
        if (target?.Id !== undefined && ours.has(target.Id)) return;
        throw new Error('The test keeps each other reaper.');
      });

      const { finished } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
        keptTtl,
      });
      await within(stopped.reached, t.signal, 'the list of stopped reapers');
      const young = await staleReaper(randomUUID());
      others.push(young);
      ours.add(young);
      stopped.release();

      await within(finished, t.signal, 'the end of the reaper');
      assert.deepEqual(
        {
          old: await exists(old),
          young: await exists(young),
          created: await exists(created.id),
          live: await exists(live.id),
          restarted: await exists(restarted.id),
        },
        { old: false, young: true, created: true, live: true, restarted: true },
      );
    },
  );

  test(
    'a reaper whose list of the shared servers hits its request time limit keeps its stopped container with one line that names the list and no server',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      await using stack = new AsyncDisposableStack();
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => removeRun(run));

      const proxy = stack.use(await EngineProxy.start(engine));
      // The lists of containers of a reaper: the check of its socket, the
      // list of the run's containers, and the list of the shared servers.
      const servers = proxy.hold('GET', '/containers/json', 3);
      stack.defer(() => servers.release());
      const settings = {
        ...quick,
        grace: 0,
        passes: 0,
        requestTimeout: 1_000,
      };
      await proxiedReaper(stack, proxy, run, settings);

      const kept = await waitFor(
        async () => {
          const [stopped] = await docker.containers.list({
            all: true,
            filters: { label: [`${REAPER_LABEL}=${run}`], status: ['exited'] },
          });
          assert.ok(stopped?.Id !== undefined, 'the reaper kept its container');
          return stopped.Id;
        },
        { signal: t.signal, interval: 100 },
      );
      const { stderr } = await (await docker.containers.find(kept))!.logs();

      assert.deepEqual(
        stderr
          .split('\n')
          .filter((line) => line.includes('msg="request time limit"')),
        [
          `level=WARN msg="request time limit" call="docker ps" limit=${settings.requestTimeout} run=${run}`,
        ],
      );
    },
  );

  test('a reaper whose shared server is removed while it drops the run’s database in it removes the run’s containers, writes no line of a request time limit, and ends once', async (t) => {
    const run = randomUUID();
    const database = `test_${run.replaceAll('-', '')}_0123456789abcdef`;
    // No request time limit ends the drop: only the removal of its server does.
    const settings = {
      ...quick,
      grace: 100,
      passes: 0,
      requestTimeout: 600_000,
    };
    const others: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => removeRun(run, others));

    await present('alpine:latest');
    // A shared Postgres server whose psql lists the run's database, and
    // writes the command of a drop to /dropped and never ends it.
    const fake = await docker.containers.create({
      Image: 'alpine:latest',
      Entrypoint: [
        'sh',
        '-c',
        `mkdir -p /databases && touch /databases/${database}
printf '%s\\n' '#!/bin/sh' 'case "$*" in *DROP*) echo "$*" > /dropped; exec sleep 3600;; *) ls /databases;; esac' > /usr/local/bin/psql
chmod +x /usr/local/bin/psql
exec sleep 3600`,
      ],
      Cmd: [],
      Labels: { [SERVER_LABEL]: randomUUID(), [KIND_LABEL]: 'postgres' },
    });
    others.push(fake.id);
    await fake.start();
    const since = Math.floor(Date.now() / 1000) - 1;
    const child = await holder(run, settings);
    cleanup.defer(() => killed(child));
    const owned = await object(run);
    const reaper = await docker.containers.find(reaperName(run));
    assert.ok(reaper);
    const ended = endedOnce(reaper.id, run, since);
    ended.catch(() => {});
    // The reaper removes itself, and its logs with it: the test reads them
    // while it runs. docker exec exits 137 when its container is removed
    // during the call, as a call that the limit killed does.
    const logged = (async () => {
      const decoder = new TextDecoder();
      let stderr = '';
      for await (const { stream, data } of reaper.followLogs())
        if (stream === 'stderr')
          stderr += decoder.decode(data, { stream: true });
      return stderr;
    })();
    logged.catch(() => {});
    await killed(child);
    await waitFor(
      async () => {
        const dropped = await fake.exec({ Cmd: ['cat', '/dropped'] });
        assert.match(dropped.stdout, new RegExp(`DROP DATABASE.*${database}`));
      },
      { signal: t.signal, interval: 100 },
    );

    await fake.remove({ force: true, v: true });

    assert.equal(
      await within(ended, t.signal, 'the end of the reaper'),
      'removed',
    );
    assert.equal(await exists(owned), false);
    assert.deepEqual(
      (await logged)
        .split('\n')
        .filter((line) => line.includes('msg="request time limit"')),
      [],
    );
  });

  test(
    'a holder whose test process is killed before the reaper checked its socket ends its exec, and leaves no cat in the reaper',
    { skip: proxyless },
    async (t) => {
      const run = randomUUID();
      await using stack = new AsyncDisposableStack();
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => removeRun(run));

      const proxy = stack.use(await EngineProxy.start(engine));
      // The first list of containers is the reaper's check of its socket
      // (ADR 0020, item 14): held here, so a holder waits for its result. No
      // request time limit ends that check.
      const check = proxy.hold('GET', '/containers/json', 1);
      stack.defer(() => check.release());
      const since = Math.floor(Date.now() / 1000) - 1;
      const { id: reaper } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        requestTimeout: 600_000,
      });
      await within(check.reached, t.signal, 'the check of the socket');
      const watch = new AbortController();
      stack.defer(() => watch.abort());
      const started = execEvent(reaper, since, 'exec_start', watch.signal);
      started.catch(() => {});
      const owner = program(`
        const docker = await Docker.connect({ clock: globalThis, environment: process.env });
        await ReaperHold.take(docker, docker.host, ${JSON.stringify(run)}, ${JSON.stringify(quick)}, globalThis);
      `);
      cleanup.defer(() => killed(owner.child));
      const hold = await within(started, t.signal, 'the exec of the hold');

      await killed(owner.child);

      await within(
        execEvent(reaper, since, 'exec_die', t.signal, hold),
        t.signal,
        'the end of the exec of the hold',
      );
      assert.deepEqual(await holdersOf(reaper), []);
    },
  );

  test('a hold of a run whose reaper ended and was never removed holds a new reaper', async () => {
    const run = randomUUID();
    await present('alpine:latest');
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => removeRun(run));

    const stale = await staleReaper(run);

    const child = await holder(run, quick);
    cleanup.defer(() => killed(child));

    const [next] = await reapers(run);
    assert.ok(next);
    assert.notEqual(next, stale);
    assert.equal((await holdersOf(next)).length, 1);
  });

  test('defaults() in a run holds the run’s reaper and gives the run’s labels', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-defaults-',
    );
    const run = randomUUID();
    const launched = launcher(run, directory.path);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await killed(launched.child);
      await removeRun(run);
      await gone(t, async () => assert.deepEqual(await reapers(run), []));
    });

    const labels: unknown = JSON.parse(await launched.line());

    assert.deepEqual(labels, { [RUN_LABEL]: run });
    const [reaper] = await reapers(run);
    assert.ok(reaper, 'defaults() holds a reaper');
    assert.equal((await holdersOf(reaper)).length, 1);
  });

  test('the reaper of a run removes the directory of its killed test process, with no later run', async (t) => {
    await using records = await new TemporaryFiles().directory(
      'zukhruf-testing-directory-',
    );
    const run = randomUUID();
    await present('alpine:latest');
    const maker = directoryMaker(run, records.path);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await killed(maker.child);
      await removeRun(run);
    });

    const path = await maker.line();
    const made = await onEngineHost(path);
    await killed(maker.child);

    assert.equal(made, true);
    await gone(t, async () => assert.equal(await onEngineHost(path), false));
  });

  test('the reaper of a run removes a directory of its killed test process that holds a folder a container made chmod 000', async (t) => {
    await using records = await new TemporaryFiles().directory(
      'zukhruf-testing-directory-',
    );
    const run = randomUUID();
    await present('alpine:latest');
    const maker = directoryMaker(
      run,
      records.path,
      `const locked = await testbed.run({
      Image: 'alpine:latest',
      Cmd: ['sh', '-c', 'mkdir -p /fixture/locked/inner && echo owned > /fixture/locked/inner/file.txt && chmod 000 /fixture/locked && stat -c %a /fixture/locked'],
      HostConfig: { Mounts: [{ Type: 'bind', Source: directory.path, Target: '/fixture' }] },
    });
    if (locked.exitCode !== 0 || locked.stdout.trim() !== '0') throw new Error(\`The container did not lock the folder: \${locked.output}\`);`,
    );
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await killed(maker.child);
      await removeRun(run);
    });

    const path = await maker.line();
    const made = await onEngineHost(path);
    await killed(maker.child);

    assert.equal(made, true);
    await gone(t, async () => assert.equal(await onEngineHost(path), false));
  });

  test('the reaper of a run keeps the run’s directories while one of its test processes lives, and removes them after the last one ended', async (t) => {
    await using records = await new TemporaryFiles().directory(
      'zukhruf-testing-directory-',
    );
    const run = randomUUID();
    await present('alpine:latest');
    const makers = [
      directoryMaker(run, records.path),
      directoryMaker(run, records.path),
    ];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      for (const { child } of makers) await killed(child);
      await removeRun(run);
    });

    const paths = [await makers[0]!.line(), await makers[1]!.line()];
    await killed(makers[0]!.child);
    // A fixed window, longer than the grace and each pass of the reaper of a
    // testbed: the test proves that the reaper removed nothing while one test
    // process lives.
    const { grace, interval, passes } = REAPER_DEFAULTS;
    await delay(grace + interval * passes + 2_000);
    const keptWhileOneLives = [
      await onEngineHost(paths[0]!),
      await onEngineHost(paths[1]!),
    ];
    await killed(makers[1]!.child);

    assert.deepEqual(keptWhileOneLives, [true, true]);
    await gone(t, async () => {
      for (const path of paths)
        assert.equal(await onEngineHost(path), false, path);
    });
  });
});

// Each test starts a privileged docker:dind engine of its own; two at a time bound the load on the engine host.
describe('the reaper on a second engine of its own', { concurrency: 2 }, () => {
  test('a hold whose /var/run/docker.sock reaches another engine removes that reaper, holds one on the socket of its client, and that reaper removes the run’s objects on its engine once the holder is killed', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-reaper-',
    );
    const relay = shortSocket();
    // Its /var/run/docker.sock is the socket of the engine of this process.
    await using second = await secondEngine({
      sockets: [relay],
      binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      relay,
    });
    const run = randomUUID();
    using removed = await removedReapers(second, run);
    const launched = launcher(run, await recordsOf(directory.path), {
      DOCKER_HOST: second.host,
    });
    try {
      await launched.line();
      const held = await reaperSockets(second.client, run);
      launched.send('create');
      const id = await launched.line();

      await killed(launched.child);

      assert.deepEqual(held, [relay]);
      await gone(t, async () => {
        assert.deepEqual(removed.sockets, ['/var/run/docker.sock', relay]);
        assert.equal(await second.client.containers.find(id), undefined);
        assert.deepEqual(await reaperSockets(second.client, run), []);
      });
    } finally {
      await killed(launched.child);
    }
  });

  test('defaults() rejects with each socket that it tried and why, when no socket reaches the engine, and leaves no reaper and no directory at the missing path', async () => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-reaper-',
    );
    const relay = shortSocket();
    // It has no file at the path of the relay, and its /var/run/docker.sock is
    // the socket of the engine of this process.
    await using second = await secondEngine({
      sockets: [shortSocket()],
      binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      relay,
    });
    const run = randomUUID();
    const testbed = new DockerTestbed({
      environment: {
        DOCKER_HOST: second.host,
        ZUKHRUF_TESTING_RUN_ID: run,
        ZUKHRUF_TESTING_RUN_DIR: await recordsOf(directory.path),
      },
    });
    try {
      await assert.rejects(testbed.defaults(), {
        message: `The reaper ${reaperName(run)} found no socket of the engine ${second.host} that reaches that engine: /var/run/docker.sock: the socket reaches an engine that does not run this reaper; ${relay}: the engine’s host has no file at this path`,
      });

      assert.deepEqual(await reaperSockets(second.client, run), []);
      const { exitCode } = await second.container.exec({
        Cmd: ['test', '-e', relay],
      });
      assert.equal(exitCode, 1);
    } finally {
      await (await testbed.client())[Symbol.asyncDispose]();
    }
  });

  test('a hold whose /var/run/docker.sock and client socket both reach the engine keeps /var/run/docker.sock', async () => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-reaper-',
    );
    const relay = shortSocket();
    await using second = await secondEngine({
      sockets: ['/var/run/docker.sock', relay],
      relay,
    });
    const run = randomUUID();
    const launched = launcher(run, await recordsOf(directory.path), {
      DOCKER_HOST: second.host,
    });
    try {
      await launched.line();

      assert.deepEqual(await reaperSockets(second.client, run), [
        '/var/run/docker.sock',
      ]);
    } finally {
      await killed(launched.child);
    }
  });

  test('defaults() names /var/run/docker.sock as a socket that does not answer, when the engine’s host has a file there that no engine listens on', async () => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-reaper-',
    );
    const relay = shortSocket();
    // It has no file at the path of the relay, and its dockerd listens on
    // another path only.
    await using second = await secondEngine({
      sockets: [shortSocket()],
      relay,
    });
    // Platform setup that no operation of the testbed exposes: a regular file at
    // /var/run/docker.sock of the engine's host.
    const made = await second.container.exec({
      Cmd: ['sh', '-c', ': > /var/run/docker.sock'],
    });
    assert.equal(made.exitCode, 0);
    const run = randomUUID();
    const testbed = new DockerTestbed({
      environment: {
        DOCKER_HOST: second.host,
        ZUKHRUF_TESTING_RUN_ID: run,
        ZUKHRUF_TESTING_RUN_DIR: await recordsOf(directory.path),
      },
    });
    try {
      await assert.rejects(testbed.defaults(), {
        message: `The reaper ${reaperName(run)} found no socket of the engine ${second.host} that reaches that engine: /var/run/docker.sock: the socket does not answer: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?; ${relay}: the engine’s host has no file at this path`,
      });

      assert.deepEqual(await reaperSockets(second.client, run), []);
    } finally {
      await (await testbed.client())[Symbol.asyncDispose]();
    }
  });

  test('a test process whose reaper on the socket of its client was removed holds a new reaper on that socket first, before /var/run/docker.sock, which reaches another engine', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-reaper-',
    );
    const relay = shortSocket();
    // Its /var/run/docker.sock is the socket of the engine of this process.
    await using second = await secondEngine({
      sockets: [relay],
      binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      relay,
    });
    const run = randomUUID();
    using removed = await removedReapers(second, run);
    const launched = launcher(run, await recordsOf(directory.path), {
      DOCKER_HOST: second.host,
    });
    try {
      await launched.line();
      const [first] = await second.client.containers.list({
        filters: { label: [`${REAPER_LABEL}=${run}`] },
      });
      assert.ok(first);

      // The engine ends the hold, as at a removal of the reaper by another tool.
      await (
        await second.client.containers.find(first.Id)
      )?.remove({
        force: true,
      });
      await gone(t, async () => {
        const [next] = await second.client.containers.list({
          filters: { label: [`${REAPER_LABEL}=${run}`] },
        });
        assert.ok(next !== undefined && next.Id !== first.Id, 'a new reaper');
        assert.deepEqual(await reaperSockets(second.client, run), [relay]);
      });
      await killed(launched.child);

      // A kill before the new hold attached leaves the reaper waiting for a
      // first holder: 60 s by default.
      await gone(t, async () => {
        assert.deepEqual(removed.sockets, [
          '/var/run/docker.sock',
          relay,
          relay,
        ]);
        assert.deepEqual(await reaperSockets(second.client, run), []);
      });
    } finally {
      await killed(launched.child);
    }
  });

  test('a holder holds the reaper of its run again after a restart of the engine, and that reaper keeps the run’s objects', async (t) => {
    const relay = shortSocket();
    await using second = await secondEngine({
      sockets: ['/var/run/docker.sock'],
      relay,
    });
    const run = randomUUID();
    const child = await holder(run, quick, {
      ...process.env,
      DOCKER_HOST: second.host,
    });
    try {
      const owned = await objectOn(second.client, run);

      await second.restart(t.signal);

      await waitFor(
        async () => assert.equal(await heldOn(second.client, run), 1),
        { signal: t.signal, interval: 100 },
      );
      assert.notEqual(await second.client.containers.find(owned), undefined);
    } finally {
      await killed(child);
    }
  });

  test('a reaper that the engine starts again after its restart waits for a first holder, so a holder that comes back late finds the run’s objects', async (t) => {
    const relay = shortSocket();
    await using second = await secondEngine({
      sockets: ['/var/run/docker.sock'],
      relay,
    });
    const run = randomUUID();
    const child = await holder(run, quick, {
      ...process.env,
      DOCKER_HOST: second.host,
    });
    try {
      const owned = await objectOn(second.client, run);

      // A test process that is slow to come back, as one whose event loop is busy.
      child.kill('SIGSTOP');
      try {
        await second.restart(t.signal);
        // A fixed window, longer than the grace and the passes of the reaper:
        // a reaper that did not wait for a first holder removed the run's
        // objects within it.
        await delay(quick.grace + quick.interval * quick.passes + 2_000);
      } finally {
        child.kill('SIGCONT');
      }

      await waitFor(
        async () => assert.equal(await heldOn(second.client, run), 1),
        { signal: t.signal, interval: 100 },
      );
      assert.notEqual(await second.client.containers.find(owned), undefined);
    } finally {
      await killed(child);
    }
  });
});

// Each test below waits on a short window of real time, so they run alone, one after another.

test('a container that the engine creates after the first pass of the reaper is removed by a re-check pass', async (t) => {
  const run = randomUUID();
  await present('alpine:latest');
  // The re-check passes span 6 s after the first pass.
  const settings = { ...quick, grace: 300, interval: 3_000, passes: 2 };
  const ids: string[] = [];
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => removeRun(run, ids));

  const child = await holder(run, settings);
  cleanup.defer(() => killed(child));
  const [reaper] = await reapers(run);
  assert.ok(reaper);
  ids.push(await object(run));
  const removed = (await docker.containers.find(ids[0]!))!
    .wait({ condition: 'removed', signal: t.signal })
    .catch((error: unknown) => {
      if (!(error instanceof ContainerNotFoundError)) throw error;
    });
  await killed(child);
  // The first pass removes the first container, after its list.
  await within(removed, t.signal, 'the removal by the first pass');

  // No anonymous volume: one would hold up the volume removal of the first pass.
  const late = await docker.containers.create({
    Image: 'alpine:latest',
    Cmd: ['sleep', '3600'],
    Labels: { [RUN_LABEL]: run },
  });
  ids.push(late.id);
  await late.start();

  // The fact under test: a re-check pass removed the late container.
  await gone(t, async () => assert.equal(await exists(ids[1]!), false));
  // The reaper ended: removed, or kept after a call hit its request time
  // limit. A failure names what the reaper wrote.
  await gone(t, async () => {
    if (await reaperEnded(reaper, run)) return;
    const logs = await (await docker.containers.find(reaper))?.logs();
    assert.fail(`the reaper has not ended:\n${logs?.stderr ?? ''}`);
  });
});

test('a reaper whose engine restarts after its last holder was killed starts again by itself, and removes the run’s objects and itself with no test process', async (t) => {
  const relay = shortSocket();
  await using second = await secondEngine({
    sockets: ['/var/run/docker.sock'],
    relay,
  });
  const run = randomUUID();
  // The grace is longer than the stop of the engine, which ends the reaper
  // within Docker's stop timeout of 10 s: the engine restarts while the reaper
  // waits its grace.
  const settings = { ...quick, grace: 20_000, firstHolder: 1_000 };
  const child = await holder(run, settings, {
    ...process.env,
    DOCKER_HOST: second.host,
  });
  try {
    const owned = await objectOn(second.client, run);
    await killed(child);

    await second.restart(t.signal);
    const keptUntilTheRestart =
      (await second.client.containers.find(owned)) !== undefined;

    assert.equal(keptUntilTheRestart, true);
    await waitFor(
      async () => {
        assert.equal(await second.client.containers.find(owned), undefined);
        assert.deepEqual(await reaperSockets(second.client, run), []);
      },
      { signal: t.signal, interval: 100 },
    );
  } finally {
    await killed(child);
  }
});

test('a holder holds the reaper of its run again after a kill of the reaper’s process, and that reaper keeps the run’s objects', async (t) => {
  const relay = shortSocket();
  await using second = await secondEngine({
    sockets: ['/var/run/docker.sock'],
    relay,
  });
  const run = randomUUID();
  // A short wait for a first holder: a reaper that its holder does not hold
  // again within it removes the run's objects.
  const settings = { ...quick, firstHolder: 2_000 };
  const child = await holder(run, settings, {
    ...process.env,
    DOCKER_HOST: second.host,
  });
  try {
    const owned = await objectOn(second.client, run);
    const [reaper] = await second.client.containers.list({
      filters: { label: [`${REAPER_LABEL}=${run}`] },
    });
    assert.ok(reaper);
    const pid = (
      await (await second.client.containers.find(reaper.Id))?.inspect()
    )?.State?.Pid;
    assert.ok(pid !== undefined);

    // A SIGKILL on the engine's host, as at a kill for lack of memory: not a
    // stop through the engine, after which Docker does not start it again.
    const kill = await second.container.exec({
      Cmd: ['kill', '-9', String(pid)],
    });

    assert.equal(kill.exitCode, 0);
    await waitFor(
      async () => assert.equal(await heldOn(second.client, run), 1),
      { signal: t.signal, interval: 100 },
    );
    assert.notEqual(await second.client.containers.find(owned), undefined);
  } finally {
    await killed(child);
  }
});

/** The OpenSSH server of `droppableSshEngine`: a key login as root, with the defaults of sshd for a client that went away. Alpine's sshd_config sets `AllowTcpForwarding no`, which also denies the connect to the engine socket. */
const sshdScript = [
  'apk add --no-cache openssh-server iptables > /dev/null',
  'ssh-keygen -A > /dev/null',
  'mkdir -p /root/.ssh',
  'printf "%s\\n" "$KEY" > /root/.ssh/authorized_keys',
  'exec /usr/sbin/sshd -D -e -o ClientAliveInterval=0 -o TCPKeepAlive=yes -o AllowTcpForwarding=yes -o AllowStreamLocalForwarding=yes -o PermitRootLogin=prohibit-password',
].join(' && ');

/** The exit status of `dropWhenQuiet` while sshd has a byte that its client did not acknowledge. */
const unacknowledged = 3;

/**
 * Drops each packet of port 22 in the network namespace of sshd, both ways,
 * once each established connection of port 22 has no byte that sshd sent and
 * its client did not acknowledge, and exits `unacknowledged` before that
 * (#5612). Such a byte gets retransmitted after the drop, so `tcp_retries2`
 * ends the connection with no keep-alive byte. In /proc/net/tcp and
 * /proc/net/tcp6, column 4 is the state (`01` is ESTABLISHED) and column 5 is
 * `tx_queue:rx_queue` in hex; for an established socket, tx_queue is
 * `write_seq - snd_una`: the bytes that sshd wrote and its client did not
 * acknowledge yet. The check needs one established connection at least, so a
 * table that it cannot read never passes it.
 */
const dropWhenQuiet = [
  `awk '$4 == "01" && $2 ~ /:0016$/ { seen = 1; if ($5 !~ /^0+:/) sent = 1 } END { exit seen && !sent ? 0 : ${unacknowledged} }' /proc/net/tcp /proc/net/tcp6`,
  'iptables -I INPUT -p tcp --dport 22 -j DROP',
  'iptables -I OUTPUT -p tcp --sport 22 -j DROP',
].join(' && ');

/** The first bytes that the server on 127.0.0.1:`port` sends, or nothing when it closes first. */
async function banner(port: number): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  try {
    const [data] = await Promise.race([
      once(socket, 'data'),
      once(socket, 'close').then(() => ['']),
    ]);
    return String(data);
  } finally {
    socket.destroy();
  }
}

/**
 * An SSH engine host whose network a test can cut (#5543): an OpenSSH server
 * in a container of the local engine, which reaches that engine at
 * /var/run/docker.sock. sshd sends no probe of its own (`ClientAliveInterval
 * 0`, its default), and TCP keep-alive waits 2 h. `tcp_retries2=5` in the
 * network namespace of the container ends a connection whose data gets no
 * answer after about 12.6 s, instead of about 15.4 min. Platform setup that
 * no product operation exposes: a holder machine that goes away with no
 * close.
 */
async function droppableSshEngine() {
  await using stack = new AsyncDisposableStack();
  const directory = stack.use(
    await new TemporaryFiles().directory('zukhruf-sshd-'),
  );
  const key = join(directory.path, 'id_ed25519');
  await promisify(execFile)('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    key,
  ]);
  const service = stack.use(
    await new DockerTestbed({ environment: process.env }).serve(
      {
        Image: 'alpine:latest',
        Entrypoint: ['sh', '-c', sshdScript],
        Env: [`KEY=${(await readFile(`${key}.pub`, 'utf8')).trim()}`],
        HostConfig: {
          CapAdd: ['NET_ADMIN'],
          Sysctls: { 'net.ipv4.tcp_retries2': '5' },
          Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        },
      },
      {
        internalPort: 22,
        healthy: ({ port }, exited) =>
          waitFor(async () => assert.match(await banner(port), /^SSH-2\.0-/), {
            signal: exited,
            interval: 200,
          }),
      },
    ),
  );
  const hostKey = await service.container.exec({
    Cmd: ['cat', '/etc/ssh/ssh_host_ed25519_key.pub'],
  });
  const knownHosts = join(directory.path, 'known_hosts');
  await writeFile(
    knownHosts,
    `[${service.host}]:${service.port} ${hostKey.stdout.trim()}\n`,
  );
  const owned = stack.move();
  return {
    /** The ssh:// host of the local engine through the server. */
    host: `ssh://root@${service.host}:${service.port}/var/run/docker.sock`,
    /** The flags of `ssh` that log in with the test's key and trust only the server's host key. */
    flags: [
      '-F',
      '/dev/null',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'StrictHostKeyChecking=yes',
    ],
    /** Drops each packet of port 22 in the server's network namespace, both ways, once the client acknowledged each byte of sshd: no close, no answer and no retransmission reaches either side. */
    async drop(signal: AbortSignal) {
      const dropped = await waitFor(
        async () => {
          const tried = await service.container.exec(
            { Cmd: ['sh', '-c', dropWhenQuiet] },
            { signal },
          );
          assert.notEqual(
            tried.exitCode,
            unacknowledged,
            'sshd has a byte on port 22 that its client did not acknowledge',
          );
          return tried;
        },
        { signal },
      );
      assert.equal(dropped.exitCode, 0, dropped.stderr);
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/**
 * A process that holds the reaper of `run` with `settings` through its own
 * SSH connection to `host`, prints `held`, and lives until it is killed. At
 * the line `block`, it blocks its event loop for 60 s, as a busy test process
 * can, and then prints `unblocked`.
 */
function sshHolder(
  run: string,
  settings: ReaperSettings,
  { host, flags }: { host: string; flags: string[] },
): Program {
  return program(
    `
      import { createInterface } from 'node:readline';
      const docker = await Docker.connect({ clock: globalThis, environment: process.env, sshFlags: ${JSON.stringify(flags)} });
      await ReaperHold.take(docker, docker.host, ${JSON.stringify(run)}, ${JSON.stringify(settings)}, globalThis);
      console.log('held');
      for await (const command of createInterface({ input: process.stdin })) {
        if (command !== 'block') continue;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        console.log('unblocked');
      }
    `,
    { ...process.env, DOCKER_HOST: host },
  );
}

describe('the reaper over SSH', { concurrency: 3 }, () => {
  // The wait ends at the time limit of the test target, 300 s, with the start
  // of the SSH server and the hold. With a keep-alive byte each 15 s, about 12.6 s of
  // retransmissions, the grace and the passes, it ends in about 35 s; with no
  // keep-alive byte, TCP keep-alive of the engine's host waits 2 h.
  test('a holder whose network goes away with no close, and then the holder, ends its hold within the keep-alive interval and the retransmission limit of the engine’s host, and the reaper removes the run’s objects', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    await using sshd = await droppableSshEngine();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => removeRun(run));
    const held = sshHolder(run, quick, sshd);
    cleanup.defer(() => killed(held.child));
    assert.equal(await held.line(), 'held');
    const id = await object(run);

    await sshd.drop(t.signal);
    await killed(held.child);

    await gone(t, async () => {
      assert.equal(await exists(id), false);
      assert.deepEqual(await reapers(run), []);
    });
  });

  test('a holder that is killed with its network up ends its hold, and the reaper removes the run’s objects', async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    await using sshd = await droppableSshEngine();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => removeRun(run));
    const held = sshHolder(run, quick, sshd);
    cleanup.defer(() => killed(held.child));
    assert.equal(await held.line(), 'held');
    const id = await object(run);

    await killed(held.child);

    await gone(t, async () => {
      assert.equal(await exists(id), false);
      assert.deepEqual(await reapers(run), []);
    });
  });

  test('a holder whose event loop is blocked for 60 s keeps its hold, and the reaper removes nothing', async () => {
    const run = randomUUID();
    await present('alpine:latest');
    await using sshd = await droppableSshEngine();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => removeRun(run));
    const held = sshHolder(run, quick, sshd);
    cleanup.defer(() => killed(held.child));
    assert.equal(await held.line(), 'held');
    const id = await object(run);
    const reaper = await reapers(run);

    held.send('block');
    assert.equal(await held.line(), 'unblocked');

    assert.equal(await exists(id), true);
    assert.deepEqual(await reapers(run), reaper);
    assert.equal(reaper.length, 1);
  });
});

/**
 * A process that takes the engine lease `name`, with the run label of `run`,
 * through its own SSH connection to `host`, as a `DockerTestbed` outside a run
 * does, prints `held`, and lives until it is killed. No reaper holds `run`, so
 * only the end of the lease's attach ends the lease.
 */
function sshLeaseHolder(
  run: string,
  name: string,
  { host, flags }: { host: string; flags: string[] },
): Program {
  return program(
    `
      import { EngineLease } from ${JSON.stringify(new URL('./engine-lease.ts', import.meta.url).href)};
      const docker = await Docker.connect({ clock: globalThis, environment: process.env, sshFlags: ${JSON.stringify(flags)} });
      const lease = await EngineLease.take(docker, { ${JSON.stringify(RUN_LABEL)}: ${JSON.stringify(run)} }, { name: ${JSON.stringify(name)} });
      if (lease === undefined) throw new Error('Another holder has the lease');
      console.log('held');
      setInterval(() => {}, 60_000);
    `,
    { ...process.env, DOCKER_HOST: host },
  );
}

// The wait ends at the time limit of the test target, 300 s, with the start of
// the SSH server and the lease. With a keep-alive byte each 15 s and about
// 12.6 s of retransmissions, it ends in about 30 s; with no keep-alive byte,
// TCP keep-alive of the engine's host waits 2 h.
test('an engine lease whose holder reaches the engine over SSH outside a run, and whose network and then holder go away with no close, ends within the keep-alive interval and the retransmission limit of the engine’s host', async (t) => {
  const run = randomUUID();
  const name = `zukhruf-testing-lease-${run}`;
  await present(LEASE_IMAGE);
  await using sshd = await droppableSshEngine();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => removeRun(run));
  const held = sshLeaseHolder(run, name, sshd);
  cleanup.defer(() => killed(held.child));
  assert.equal(await held.line(), 'held');

  await sshd.drop(t.signal);
  await killed(held.child);

  await gone(t, async () => assert.equal(await exists(name), false));
});
