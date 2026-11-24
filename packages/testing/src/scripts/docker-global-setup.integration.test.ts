import assert from 'node:assert/strict';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { hash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { type TestContext, describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { untilAborted } from '@zukhruf/async';
import {
  BindSourceNotFoundError,
  ContainerNotFoundError,
  Docker,
} from '@zukhruf/docker';
import { type TemporaryDirectory, TemporaryFiles, isErrno } from '@zukhruf/fs';

import { waitFor } from '../async/wait-for.ts';
import { EngineLease } from '../docker/engine-lease.ts';
import { DockerTestbed } from '../docker/index.ts';
import {
  REAPER_DEFAULTS,
  REAPER_IMAGE,
  REAPER_LABEL,
  type ReaperSettings,
  reaperName,
  reaperRequest,
} from '../docker/reaper.ts';
import { directoryParent, runSocketFolder } from '../docker/run-records.ts';
import { engine, proxyless } from '../testing/current-engine.ts';
import { docker } from '../testing/engine-client.ts';
import { EngineProxy } from '../testing/engine-proxy.ts';
import {
  library,
  runEnvironment,
  runnerArgs,
} from '../testing/global-setup-run.ts';

const signals =
  process.platform === 'win32'
    ? 'Windows ends a process on a signal, so it runs no global teardown'
    : false;
const client = JSON.stringify(import.meta.resolve('@zukhruf/docker'));

/** What a worker of a run created, written where the test can read it. */
interface State {
  id: string;
  general: string;
  path: string;
  volume: string;
  /** Of the server, which runs with --rm. */
  anonymousVolumes: string[];
  /** Of the general container, which does not. */
  generalVolumes: string[];
  run: string;
  record: string;
  /** Of the test process. */
  pid: number;
}

/**
 * A test file of a run that creates one of everything a run owns, records
 * it in `statePath`, and then ends the way `ending` says.
 */
const workerSource = (statePath: string, ending: string, timeout: number) => `
  import { test } from 'node:test';
  import { existsSync } from 'node:fs';
  import { writeFile } from 'node:fs/promises';
  import { setTimeout } from 'node:timers/promises';
  import { DockerTestbed } from ${library};
  test('disposable resources before interruption', { timeout: ${timeout} }, async (t) => {
    const docker = new DockerTestbed({ environment: process.env });
    const { container } = await docker.serve({ Image: 'postgres:18-alpine', Env: ['POSTGRES_PASSWORD=test'] }, { internalPort: 5432 });
    const general = await docker.start({ Image: 'postgres:18-alpine', Cmd: ['sleep', '600'] });
    const fixture = await docker.directory();
    await fixture.writeFile('sentinel.txt', 'owned');
    const volume = await docker.volume();
    const anonymous = async (handle) => (await handle.inspect()).Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name);
    const anonymousVolumes = await anonymous(container);
    const generalVolumes = await anonymous(general);
    const directory = process.env.ZUKHRUF_TESTING_RUN_DIR;
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.id, general: general.id, path: fixture.path, volume: volume.name, anonymousVolumes, generalVolumes, run: process.env.ZUKHRUF_TESTING_RUN_ID, record: directory, pid: process.pid }));
    ${ending}
  });
`;

/** What a small worker of a run created. */
interface SmallState {
  id: string;
  run: string;
  record: string;
  /** Of the test process. */
  pid: number;
}

/** A test file of a run that starts one container, records it, then runs `ending`. */
const smallWorkerSource = (statePath: string, ending: string) => `
  import { test } from 'node:test';
  import { writeFile } from 'node:fs/promises';
  import { setTimeout } from 'node:timers/promises';
  import { DockerTestbed } from ${library};
  test('one container', { timeout: 150000 }, async () => {
    const docker = new DockerTestbed({ environment: process.env });
    const container = await docker.start({ Image: 'alpine:latest', Cmd: ['sleep', '600'] });
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.id, run: process.env.ZUKHRUF_TESTING_RUN_ID, record: process.env.ZUKHRUF_TESTING_RUN_DIR, pid: process.pid }));
    ${ending}
  });
`;

/** The environment of a runner whose engine is `proxy`. */
const proxiedEnvironment = (
  state: string,
  proxy: EngineProxy,
): Record<string, string | undefined> => ({
  ...runEnvironment(state),
  // A selected context wins over DOCKER_HOST.
  DOCKER_CONTEXT: undefined,
  DOCKER_HOST: proxy.host,
});

/** A run that runs no test of `file`, so it only recovers and ends. */
const emptyRun = (file: string, env: Record<string, string | undefined>) =>
  promisify(execFile)(
    process.execPath,
    runnerArgs('--test-name-pattern=no-matching-tests', file),
    { env, timeout: 90_000 },
  );

/** Pulls `image` when the engine does not have it, for a create that does not pull. */
async function present(image: string): Promise<void> {
  if ((await docker.images.inspect(image)) === undefined)
    await docker.images.pull(image);
}

const exists = async (id: string): Promise<boolean> =>
  (await docker.containers.find(id)) !== undefined;

const volumeExists = async (name: string): Promise<boolean> =>
  (await docker.volumes.find(name)) !== undefined;

const running = async (id: string): Promise<boolean | undefined> =>
  (await (await docker.containers.find(id))?.inspect())?.State?.Running;

/** The containers that carry `label`, as `key=value`. */
const labelled = async (label: string): Promise<string[]> =>
  (
    await docker.containers.list({ all: true, filters: { label: [label] } })
  ).map(({ Id }) => Id);

/**
 * Resolves when `check` passes: the reaper of a run acts about 2 s after the
 * last test process of the run ended (ADR 0020).
 */
const reaped = (t: TestContext, check: () => Promise<void>): Promise<void> =>
  waitFor(check, { signal: t.signal, interval: 100 });

const removeContainer = async (id: string): Promise<void> =>
  (await docker.containers.find(id))?.remove({ force: true, v: true });

const removeVolume = async (name: string): Promise<void> =>
  (await docker.volumes.find(name))?.remove({ force: true });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readState<T>(t: TestContext, statePath: string): Promise<T> {
  return waitFor(async () => JSON.parse(await readFile(statePath, 'utf8')), {
    signal: t.signal,
    interval: 250,
  });
}

async function removeLeftovers(state: State | undefined): Promise<void> {
  if (!state) return;
  for (const id of [state.id, state.general]) await removeContainer(id);
  for (const name of [
    state.volume,
    ...state.anonymousVolumes,
    ...state.generalVolumes,
  ])
    await removeVolume(name);
}

/**
 * A temporary directory for the state of the runs that a test starts. A run
 * that the test kills can leave a container that only its records name, such
 * as a process lease that the engine created after the kill, and the records
 * go with the directory. Disposal removes what carries the label of each run
 * recorded below the directory, except a shared server, and then the
 * directory.
 */
async function runsDirectory(prefix: string): Promise<TemporaryDirectory> {
  const directory = await new TemporaryFiles().directory(prefix);
  const cleanup = async () => {
    await using removal = new AsyncDisposableStack();
    removal.defer(() => directory.cleanup());
    for (const entry of await readdir(directory.path, { recursive: true })) {
      if (!/(^|\/)zukhruf-testing\/docker-runs\/[^/]+\/run\.json$/.test(entry))
        continue;
      const { id }: { id: string } = JSON.parse(
        await readFile(join(directory.path, entry), 'utf8'),
      );
      const label = `dev.zukhruf.testing.run=${id}`;
      for (const { Id, Labels } of await docker.containers.list({
        all: true,
        filters: { label: [label] },
      }))
        if (Labels?.['dev.zukhruf.testing.server'] === undefined)
          await removeContainer(Id);
      for (const { Name } of await docker.volumes.list({
        filters: { label: [label] },
      }))
        await removeVolume(Name);
    }
  };
  return { path: directory.path, cleanup, [Symbol.asyncDispose]: cleanup };
}

/** The pid of a process that has ended. */
async function endedPid(): Promise<number> {
  const { child, exited } = started(['--eval', ''], process.env);
  await exited;
  assert.ok(child.pid !== undefined);
  return child.pid;
}

/** A child process with its output collected and its exit awaited. */
function started(args: string[], env: Record<string, string | undefined>) {
  const child = spawnProcess(process.execPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  return { child, exited, output: () => output };
}

/**
 * Arrange: a run whose runner and test processes were killed, so nothing
 * removed what its worker created. Its engine is `proxy`, and so is the
 * engine of the runners that recover it.
 */
async function killedRun(
  t: TestContext,
  directory: string,
  proxy: EngineProxy,
) {
  const statePath = join(directory, 'state.json');
  const file = join(directory, 'worker.test.ts');
  const stateHome = join(directory, 'state');
  await writeFile(
    file,
    workerSource(statePath, 'await setTimeout(120_000);', 150_000),
  );
  const dead = started(
    runnerArgs('--test-force-exit', file),
    proxiedEnvironment(stateHome, proxy),
  );
  let worker: number | undefined;
  try {
    const state = await readState<State>(t, statePath);
    worker = state.pid;
    dead.child.kill('SIGKILL');
    process.kill(worker, 'SIGKILL');
    await dead.exited;
    const pid = worker;
    await waitFor(() => assert.equal(alive(pid), false), { signal: t.signal });
    assert.equal(await exists(state.general), true);
    const recover = () =>
      promisify(execFile)(
        process.execPath,
        runnerArgs('--test-name-pattern=no-matching-tests', file),
        {
          // Another project: the runs are per user, not per directory.
          cwd: directory,
          env: proxiedEnvironment(stateHome, proxy),
          timeout: 90_000,
        },
      );
    return {
      state,
      recover,
      root: join(stateHome, 'zukhruf-testing', 'docker-runs'),
    };
  } finally {
    if (dead.child.exitCode === null && dead.child.signalCode === null)
      dead.child.kill('SIGKILL');
    if (worker !== undefined && alive(worker)) process.kill(worker, 'SIGKILL');
  }
}

/** Both runners succeeded, the killed run's reaper removed its objects, and its records are gone. */
async function assertRecovered(
  t: TestContext,
  results: PromiseSettledResult<unknown>[],
  state: State,
  root: string,
): Promise<void> {
  for (const result of results)
    assert.equal(
      result.status,
      'fulfilled',
      result.status === 'rejected'
        ? Error.isError(result.reason) && 'stdout' in result.reason
          ? `${result.reason.message}\n${String(result.reason.stdout)}`
          : String(result.reason)
        : '',
    );
  await reaped(t, async () => {
    for (const id of [state.id, state.general])
      assert.equal(await exists(id), false);
    assert.equal(await volumeExists(state.volume), false);
  });
  assert.deepEqual(await readdir(root), []);
}

/** A process that holds the reaper of `run`, as a test process of it does, until it is killed. */
async function reaperHolder(t: TestContext, run: string) {
  const holding = started(
    [
      '--input-type=module',
      '--eval',
      `
        import { Docker } from ${client};
        import { REAPER_DEFAULTS, ReaperHold } from ${JSON.stringify(new URL('../docker/reaper.ts', import.meta.url).href)};
        const docker = await Docker.connect({ clock: globalThis, environment: process.env });
        await ReaperHold.take(docker, docker.host, ${JSON.stringify(run)}, REAPER_DEFAULTS, globalThis);
        console.log('held');
        setInterval(() => {}, 60_000);
      `,
    ],
    process.env,
  );
  await waitFor(() => assert.match(holding.output(), /^held$/m), {
    signal: t.signal,
    interval: 50,
  });
  return holding;
}

/** What a worker created that only labels tie to its run, and a shared server. */
interface LabelState {
  container: string;
  volume: string;
  shared: string;
}

/** The manifest of this package. */
const manifest: { version: string } = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);

/**
 * Another version of this package: a copy of its source below `directory`,
 * whose package.json names `version`. The copy resolves its dependencies
 * from the node_modules of this package. Gives the URL of its docker area.
 */
async function anotherVersion(
  directory: string,
  version: string,
): Promise<string> {
  const root = join(directory, 'another-version');
  await cp(fileURLToPath(new URL('../', import.meta.url)), join(root, 'src'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ ...manifest, version }),
  );
  const dependency = findPackageJSON('p-memoize', import.meta.url);
  assert.ok(dependency !== undefined);
  await symlink(dirname(dirname(dependency)), join(root, 'node_modules'));
  return pathToFileURL(join(root, 'src', 'docker', 'index.ts')).href;
}

/** Code that reuses one shared server from the docker area at `library`, and writes its id to `statePath`. */
const reuseSource = (library: string, statePath: string, probe: string) => `
  const { DockerTestbed } = await import(${JSON.stringify(library)});
  const { writeFile } = await import('node:fs/promises');
  const docker = new DockerTestbed({ environment: process.env });
  const server = await docker.reuse({ Image: 'alpine:latest', Cmd: ['sleep', '3600'], Labels: { 'dev.zukhruf.testing.probe': ${JSON.stringify(probe)} } }, { internalPort: 80 });
  await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: server.container.id }));
  await server.disconnect();
  await (await docker.client())[Symbol.asyncDispose]();
`;

/**
 * Code that reuses one shared server from the docker area at `library`,
 * writes its id to `statePath`, and then keeps running until its standard
 * input ends.
 */
const holdingSource = (library: string, statePath: string, probe: string) => `
  const { DockerTestbed } = await import(${JSON.stringify(library)});
  const { writeFile } = await import('node:fs/promises');
  const docker = new DockerTestbed({ environment: process.env });
  const server = await docker.reuse({ Image: 'alpine:latest', Cmd: ['sleep', '3600'], Labels: { 'dev.zukhruf.testing.probe': ${JSON.stringify(probe)} } }, { internalPort: 80 });
  await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: server.container.id }));
  for await (const _ of process.stdin);
`;

/** A process that reuses a shared server and keeps running until `end()`. */
async function holder(
  t: TestContext,
  directory: string,
  probe: string,
  env: Record<string, string | undefined>,
) {
  const statePath = join(directory, `holder-${randomUUID()}.json`);
  const file = join(directory, `holder-${randomUUID()}.ts`);
  await writeFile(file, holdingSource(JSON.parse(library), statePath, probe));
  const child = spawnProcess(process.execPath, [file], {
    env,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  const end = async () => {
    child.stdin.end();
    await exited;
  };
  try {
    const { id } = await readState<{ id: string }>(t, statePath);
    return { id, child, exited, end };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

/** The fingerprint of the shared server `id`: the value of its server label. */
async function fingerprintOf(id: string): Promise<string> {
  const labels = (await (await docker.containers.find(id))?.inspect())?.Config
    ?.Labels;
  const fingerprint = labels?.['dev.zukhruf.testing.server'];
  assert.ok(fingerprint !== undefined, `${id} is not a shared server`);
  return fingerprint;
}

/** The name of the sweep lease of `fingerprint`: the name every teardown and every test process of that server agree on. */
const sweepLease = (fingerprint: string): string =>
  `zukhruf-testing-sweep-${fingerprint}`;

/** The running process leases of the shared server of `fingerprint`. */
const processLeases = async (fingerprint: string): Promise<string[]> =>
  (
    await docker.containers.list({
      filters: {
        label: [
          'dev.zukhruf.testing.lease=process',
          `dev.zukhruf.testing.lease.server=${fingerprint}`,
        ],
      },
    })
  ).map(({ Id }) => Id);

/** Waits until the shared server of `fingerprint` has no process lease. */
async function unleased(t: TestContext, fingerprint: string): Promise<void> {
  await waitFor(
    async () => assert.deepEqual(await processLeases(fingerprint), []),
    { signal: t.signal, interval: 100 },
  );
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The expiry pass of a reaper of a new run with a TTL of 1 ms, as the reaper
 * of a run that used Docker does at its end eight days later, one day after
 * the TTL of each shared server (ADR 0020, item 4). `settings` changes the
 * settings of that reaper. It may take the sweep lease of the servers of
 * `fingerprints` only, so it keeps every other shared server of the engine.
 * Resolves, once the reaper ended once (endedOnce), with the fingerprints of
 * `fingerprints` whose sweep lease it asked for: a server it kept without
 * asking was never swept.
 */
async function sweep(
  fingerprints: readonly string[],
  settings: Partial<ReaperSettings>,
): Promise<Set<string>> {
  await using stack = new AsyncDisposableStack();
  const proxy = stack.use(await EngineProxy.start(engine));
  const { finished } = await proxiedReaper(
    stack,
    proxy,
    fingerprints,
    settings,
  );
  await finished;
  const asked = new Set<string>();
  for (const { method, path, body } of proxy.requests) {
    if (method !== 'POST' || path !== '/containers/create') continue;
    const { Labels: labels }: { Labels: Record<string, string> } =
      JSON.parse(body);
    const ours = fingerprints.find(
      (fingerprint) =>
        fingerprint === labels['dev.zukhruf.testing.lease.server'],
    );
    if (labels['dev.zukhruf.testing.lease'] === 'sweep' && ours !== undefined)
      asked.add(ours);
  }
  return asked;
}

/**
 * A process of the docker area at `library` reuses a shared server and exits.
 * Gives the server's id. A process that does not exit fails the test at
 * the test's limit, and is killed.
 */
async function reusedAndExited(
  t: TestContext,
  directory: string,
  library: string,
  probe: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const statePath = join(directory, `reused-${randomUUID()}.json`);
  const file = join(directory, `reused-${randomUUID()}.ts`);
  await writeFile(file, reuseSource(library, statePath, probe));
  const stop = new AbortController();
  try {
    const reuse = promisify(execFile)(process.execPath, [file], {
      env,
      signal: stop.signal,
      killSignal: 'SIGKILL',
    });
    reuse.catch(() => {});
    // The process must reuse the server and exit.
    await untilAborted(reuse, t.signal);
  } finally {
    stop.abort();
  }
  return (await readState<{ id: string }>(t, statePath)).id;
}

/*
 * Each test below reuses a server with its own probe label, thus its own
 * fingerprint. A teardown of a run removes only servers older than the TTL,
 * so only the sweeps of these tests, eight days ahead, remove a server that
 * a test created. The tests of one file run one at a time. A test keeps its
 * server under a live process lease (`holder`) until the sweep under test
 * holds the sweep lease of that server: while it holds it, no other sweep
 * of this tree removes the server.
 */

/** Ends `other`, a holder of the server of `fingerprint`, and waits until its process lease is gone. */
async function ended(
  t: TestContext,
  other: Awaited<ReturnType<typeof holder>>,
  fingerprint: string,
): Promise<void> {
  await other.end();
  await unleased(t, fingerprint);
}

/** Takes the sweep lease of `fingerprint` as a reaper does, from this test process. */
async function sweepLeaseOf(fingerprint: string): Promise<EngineLease> {
  const lease = await EngineLease.take(
    await Docker.connect({ clock: globalThis, environment: process.env }),
    {
      'dev.zukhruf.testing.lease': 'sweep',
      'dev.zukhruf.testing.lease.server': fingerprint,
    },
    { name: sweepLease(fingerprint) },
  );
  assert.ok(lease, 'the sweep lease is free');
  return lease;
}

/**
 * A reaper of a new run whose engine requests go through `proxy`, as
 * moby-ryuk's tests give its reaper a client that fails chosen calls. Its
 * `docker` CLI reads `DOCKER_HOST`, so the test points it at a TCP port of
 * this process that forwards to the proxy. Its expiry pass removes a shared
 * server older than 1 ms, or than the `serverTtl` of `settings`, only if it
 * is a server of `fingerprints`: the proxy refuses the sweep lease of each
 * other shared server, so the test keeps the servers of other runs on the
 * engine. Gives its end once (endedOnce).
 */
async function proxiedReaper(
  stack: AsyncDisposableStack,
  proxy: EngineProxy,
  fingerprints: readonly string[],
  settings: Partial<ReaperSettings>,
): Promise<{ finished: Promise<void> }> {
  proxy.sweepOnly(fingerprints);
  // Docker Desktop resolves host.docker.internal to this machine for each
  // container. On a native Linux engine the reaper reaches this machine at
  // the gateway of the default bridge, through the host-gateway entry: the
  // relay listens there, never on every address, because an engine proxy
  // that the LAN reaches is root on the machine.
  await present('alpine:latest');
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
  const { port } = address;
  // The test creates the reaper itself, so it pulls its image as a hold does.
  await present(REAPER_IMAGE);
  const run = randomUUID();
  const body = reaperRequest(
    run,
    {
      ...REAPER_DEFAULTS,
      grace: 0,
      passes: 0,
      firstHolder: 0,
      serverTtl: 1,
      ...settings,
    },
    '/var/run/docker.sock',
    directoryParent(docker.host),
  );
  const since = Math.floor(Date.now() / 1000) - 1;
  const reaper = await docker.containers.create(
    {
      ...body,
      Env: [
        ...(body.Env ?? []),
        `DOCKER_HOST=tcp://host.docker.internal:${port}`,
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
  stack.defer(async () => {
    await (await docker.containers.find(reaper.id))?.remove({ force: true });
  });
  const finished = endedOnce(reaper.id, since);
  finished.catch(() => {});
  // The reaper reads the age of a server in whole seconds.
  await setTimeout(1_100);
  await reaper.start();
  return { finished };
}

/**
 * Resolves when the engine destroyed the reaper `id`, from `since` on, after
 * one start and one end. A reaper removes itself, so its exit code is 137 at
 * its end, also after a crash that its restart policy followed with a start:
 * that rejects.
 */
async function endedOnce(id: string, since: number): Promise<void> {
  const actions: (string | undefined)[] = [];
  for await (const { Action } of docker.events({
    since,
    filters: { container: [id], event: ['start', 'die', 'destroy'] },
  })) {
    actions.push(Action);
    if (Action === 'destroy') break;
  }
  assert.deepEqual(
    actions,
    ['start', 'die', 'destroy'],
    'the reaper ends once, and its policy never starts it again',
  );
}

/**
 * Holds the look of a reaper through `proxy` for the process leases of
 * `fingerprint`: the first list after the start of the sweep lease of that
 * server through the proxy.
 */
function sweepHold(proxy: EngineProxy, fingerprint: string) {
  const starts: string[] = [];
  proxy.intercept('POST', /^\/containers\/[^/]+\/start$/, async ({ path }) => {
    const id = path.split('/')[2] ?? '';
    const name = (await (await docker.containers.find(id))?.inspect())?.Name;
    if (name === `/${sweepLease(fingerprint)}`) starts.push(id);
  });
  return proxy.hold('GET', '/containers/json', 1, async () => {
    const lease = await docker.containers.find(sweepLease(fingerprint));
    return lease !== undefined && starts.includes(lease.id);
  });
}

/**
 * Arrange: what a reaper leaves when it is killed after the create of the
 * sweep lease of `fingerprint` and before its start: a `created` lease.
 * `beforeSweepLeases` runs first.
 */
async function killedSweep(
  fingerprint: string,
  beforeSweepLeases: () => Promise<void> = async () => {},
): Promise<void> {
  await beforeSweepLeases();
  await docker.containers.create(
    {
      Image: 'busybox:1.37.0',
      Entrypoint: ['cat'],
      Cmd: [],
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      Labels: {
        'dev.zukhruf.testing.lease': 'sweep',
        'dev.zukhruf.testing.lease.server': fingerprint,
      },
      HostConfig: { AutoRemove: true },
    },
    { name: sweepLease(fingerprint) },
  );
}

/**
 * Records whether the subject that runs through `proxy` removes the sweep
 * lease `id`. A process or sweep of another tree on the engine can remove that
 * lease first (#3221), and only a removal through this proxy, of a lease that
 * was still there, proves the subject removed it. A skip needs positive
 * evidence of the other removal (the subject sent no request about the lease,
 * and the lease is gone), so a subject that leaves the lease fails instead of
 * passing as inconclusive.
 */
function leaseRemoval(proxy: EngineProxy, id: string) {
  let removed = false;
  proxy.intercept('DELETE', `/containers/${id}`, async () => {
    if (await exists(id)) removed = true;
  });
  return {
    /** Skips `t` as inconclusive with `foreign`, or asserts the removal; resolves to whether `t` goes on. */
    async asserted(t: TestContext, foreign: string): Promise<boolean> {
      const reached = proxy.requests.some(
        ({ path }) =>
          path === `/containers/${id}` || path.startsWith(`/containers/${id}/`),
      );
      if (!reached && !(await exists(id))) {
        t.skip(`inconclusive: ${foreign}`);
        return false;
      }
      assert.equal(removed, true);
      return true;
    },
  };
}

// Each test below keeps its runs under a state root of its own (runEnvironment), and its reaper removes only its own run, so they run four at a time.
describe('a run and its recovery', { concurrency: 4 }, () => {
  for (const mode of [
    'failure',
    'timeout',
    'SIGINT',
    'SIGTERM',
    'recovery',
  ] as const) {
    test(
      mode === 'recovery'
        ? "a run whose engine stops answering before its global teardown ends cleanly: the teardown makes no engine call, and the reaper removes the run's containers and volumes"
        : `the reaper cleans an interrupted run (${mode}) and preserves another run's containers and volumes`,
      {
        skip:
          mode === 'recovery'
            ? proxyless
            : mode === 'SIGINT' || mode === 'SIGTERM'
              ? signals
              : false,
      },
      async (t) => {
        await using directory = await runsDirectory('zukhruf-testing-cleanup-');
        // Another run's container and volume: the sweep must match the run id,
        // not only the label.
        const unrelated = new DockerTestbed({
          environment: {
            ...process.env,
            ZUKHRUF_TESTING_RUN_ID: `unrelated-${randomUUID()}`,
            ZUKHRUF_TESTING_RUN_DIR: directory.path,
          },
        });
        await using sentinel = await unrelated.start({
          Image: 'alpine:latest',
          Cmd: ['sleep', '600'],
        });
        await using sentinelVolume = await unrelated.volume();
        const statePath = join(directory.path, 'state.json');
        const file = join(directory.path, 'worker.test.ts');
        // In recovery mode the run's engine is a proxy, which stops before the
        // global teardown: the hold of the test process ends with it.
        await using proxy =
          mode === 'recovery' ? await EngineProxy.start(engine) : undefined;
        const stopped = join(directory.path, 'stopped');
        await writeFile(
          file,
          workerSource(
            statePath,
            [
              mode === 'recovery'
                ? `await t.waitFor(() => { if (!existsSync(${JSON.stringify(stopped)})) throw new Error('the proxy has not stopped'); }, { timeout: 80_000 });`
                : '',
              mode === 'failure'
                ? "throw new Error('intentional assertion failure');"
                : mode === 'recovery'
                  ? ''
                  : 'await setTimeout(120_000);',
            ].join('\n'),
            mode === 'timeout' ? 30_000 : 90_000,
          ),
        );
        const env = proxy
          ? proxiedEnvironment(join(directory.path, 'state'), proxy)
          : runEnvironment(join(directory.path, 'state'));
        const run = started(
          runnerArgs('--test-timeout=90000', '--test-force-exit', file),
          env,
        );
        // Disposed after the end of the run, which then creates nothing more.
        await using leftovers = new AsyncDisposableStack();
        await using cleanup = new AsyncDisposableStack();
        cleanup.defer(async () => {
          if (run.child.exitCode === null && run.child.signalCode === null)
            run.child.kill('SIGKILL');
          await run.exited.catch(() => null);
        });

        const state = await readState<State>(t, statePath);
        leftovers.defer(() => removeLeftovers(state));
        assert.ok(state.anonymousVolumes.length > 0);
        assert.ok(state.generalVolumes.length > 0);
        if (mode === 'SIGINT' || mode === 'SIGTERM') run.child.kill(mode);
        if (proxy) {
          await proxy.close();
          await writeFile(stopped, '');
        }
        const code = await run.exited;
        if (proxy) {
          // The test passed, and the teardown needs no engine.
          assert.equal(code, 0, run.output());
          assert.doesNotMatch(run.output(), /retained ownership record/);
        } else assert.notEqual(code, 0, run.output());
        const ended = state;
        await reaped(t, async () => {
          for (const id of [ended.id, ended.general])
            assert.equal(await exists(id), false, run.output());
          for (const name of [
            ended.volume,
            ...ended.anonymousVolumes,
            ...ended.generalVolumes,
          ])
            assert.equal(
              await volumeExists(name),
              false,
              `the run left volume ${name}: ${run.output()}`,
            );
          // The reaper removes the directory after its first pass. Docker
          // validates the remote path. This probe never creates the source.
          await assert.rejects(
            docker.containers.run({
              Image: 'alpine:latest',
              Cmd: ['true'],
              HostConfig: {
                Mounts: [
                  { Type: 'bind', Source: ended.path, Target: '/fixture' },
                ],
              },
            }),
            BindSourceNotFoundError,
          );
        });
        if (mode === 'SIGINT' || mode === 'SIGTERM') {
          // The runner does not wait for a signalled test process, so the
          // teardown may keep the run's records; the next run removes them.
          const { pid } = state;
          await waitFor(() => assert.equal(alive(pid), false), {
            signal: t.signal,
          });
          await emptyRun(file, env);
        }
        // The teardown deletes the run's records with no engine call, also
        // when the proxy is gone. After a signal, the next run deletes them.
        assert.deepEqual(
          await readdir(
            join(directory.path, 'state', 'zukhruf-testing', 'docker-runs'),
          ),
          [],
        );
        assert.equal(await running(sentinel.id), true);
        assert.equal(await volumeExists(sentinelVolume.name), true);
      },
    );
  }

  test(
    'a create that the engine finishes after its test process was killed and after the first pass of the reaper is removed by a re-check pass, with no later run',
    { skip: proxyless },
    async (t) => {
      await using directory = await runsDirectory(
        'zukhruf-testing-late-create-',
      );
      const statePath = join(directory.path, 'state.json');
      const file = join(directory.path, 'worker.test.ts');
      // The image must not be pulled behind the held create.
      await present('alpine:latest');
      // A slow create, such as one on a busy engine: the engine has the
      // request, and it creates the container after the test removes the gate.
      // Disposed after the proxy, which waits until the engine answered the
      // held create: then its container is listed.
      await using leftovers = new AsyncDisposableStack();
      await using proxy = await EngineProxy.start(engine);
      const late = randomUUID();
      const gate = proxy.hold('POST', '/containers/create', 1, ({ body }) => {
        const { Labels } = JSON.parse(body);
        return Labels?.['dev.zukhruf.testing.probe'] === late;
      });
      // The first pass of the reaper removes the early container: the late
      // create reaches the engine after that pass listed the run.
      await writeFile(
        file,
        `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { DockerTestbed } from ${library};
      test('a slow create', { timeout: 150000 }, async () => {
        const testbed = new DockerTestbed({ environment: process.env });
        const early = await testbed.start({ Image: 'alpine:latest', Cmd: ['sleep', '600'] });
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ run: process.env.ZUKHRUF_TESTING_RUN_ID, record: process.env.ZUKHRUF_TESTING_RUN_DIR, pid: process.pid, early: early.id }));
        await testbed.start({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: { 'dev.zukhruf.testing.probe': ${JSON.stringify(late)} } });
      });
    `,
      );
      const env = proxiedEnvironment(join(directory.path, 'state'), proxy);
      let run: string | undefined;
      const killed = started(runnerArgs(file), env);
      let worker: number | undefined;
      try {
        const ended = killed.exited.then((code) => {
          throw new Error(
            `the run ended with ${code} before its late create reached the engine:\n${killed.output()}`,
          );
        });
        ended.catch(() => {});
        const state = await Promise.race([
          readState<Omit<SmallState, 'id'> & { early: string }>(t, statePath),
          ended,
        ]);
        run = state.run;
        worker = state.pid;
        // The kill comes while the engine still has the late create.
        await Promise.race([gate.reached, ended]);
        process.kill(worker, 'SIGKILL');
        assert.notEqual(await killed.exited, 0, killed.output());
        const label = `dev.zukhruf.testing.run=${state.run}`;
        // The engine created the run's reaper before the early container, so
        // the events from that second of the engine's own clock on hold each
        // event of both containers, however late the stream attaches.
        const [reaper] = await docker.containers.list({
          all: true,
          filters: { label: [`${REAPER_LABEL}=${state.run}`] },
        });
        const since = reaper?.Created;
        assert.ok(
          reaper !== undefined && since !== undefined,
          'the run has its reaper',
        );

        // The engine filters labels with AND, so the stream has all
        // containers and the loop picks the run's and its reaper's.
        const seen: { action: string | undefined; id: string | undefined }[] =
          [];
        for await (const { Action, Actor } of docker.events({
          since,
          filters: { type: ['container'], event: ['create', 'destroy'] },
          signal: t.signal,
        })) {
          if (Actor?.ID === reaper.Id) {
            assert.notEqual(
              Action,
              'destroy',
              `the reaper ended before it removed the late container: ${JSON.stringify(seen)}`,
            );
            continue;
          }
          if (Actor?.Attributes?.['dev.zukhruf.testing.run'] !== state.run)
            continue;
          if (Actor?.ID === state.early) {
            if (Action === 'destroy') gate.release();
            continue;
          }
          seen.push({ action: Action, id: Actor?.ID });
          if (Action === 'destroy') break;
        }
        const created = seen[0]?.id;
        assert.notEqual(
          created,
          undefined,
          'the engine created the late container',
        );
        assert.deepEqual(seen, [
          { action: 'create', id: created },
          { action: 'destroy', id: created },
        ]);
        assert.deepEqual(await labelled(label), []);
      } finally {
        if (killed.child.exitCode === null && killed.child.signalCode === null)
          killed.child.kill('SIGKILL');
        if (worker !== undefined && alive(worker))
          process.kill(worker, 'SIGKILL');
        // Never leave the create held.
        gate.release();
        leftovers.defer(async () => {
          if (run === undefined) return;
          for (const id of await labelled(`dev.zukhruf.testing.run=${run}`))
            await removeContainer(id);
        });
      }
    },
  );

  test(
    'a run whose tests never touch Docker leaves no record and makes no daemon call',
    { skip: proxyless },
    async () => {
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-testing-untouched-',
      );
      await using proxy = await EngineProxy.start(engine);
      const file = join(directory.path, 'plain.test.ts');
      await writeFile(
        file,
        "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
      );
      const state = join(directory.path, 'state');

      await promisify(execFile)(process.execPath, runnerArgs(file), {
        env: proxiedEnvironment(state, proxy),
        timeout: 60_000,
      });

      assert.deepEqual(
        await readdir(join(state, 'zukhruf-testing', 'docker-runs')),
        [],
      );
      assert.deepEqual(proxy.requests, []);
    },
  );

  test(
    'two runs that start together recover a dead run, and both succeed',
    { skip: proxyless },
    async (t) => {
      await using directory = await runsDirectory('zukhruf-testing-recovery-');
      await using proxy = await EngineProxy.start(engine);
      const { state, recover, root } = await killedRun(
        t,
        directory.path,
        proxy,
      );
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(async () => {
        await removeLeftovers(state);
      });

      const results = await Promise.allSettled([recover(), recover()]);

      await assertRecovered(t, results, state, root);
    },
  );

  test(
    'the recovery of a dead run that used Docker makes no engine call, and deletes its records',
    { skip: proxyless },
    async (t) => {
      await using directory = await runsDirectory('zukhruf-testing-recovery-');
      await using proxy = await EngineProxy.start(engine);
      const { state, recover, root } = await killedRun(
        t,
        directory.path,
        proxy,
      );
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(async () => {
        await removeLeftovers(state);
      });

      assert.notDeepEqual(
        await readdir(root),
        [],
        'the killed run left its records',
      );
      const from = proxy.requests.length;

      await recover();

      assert.deepEqual(proxy.requests.slice(from), []);
      assert.deepEqual(await readdir(root), []);
    },
  );

  test('recovery leaves a dead run alone while a live runner holds its claim', async () => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-claimed-',
    );
    const runner = started(
      ['--eval', 'setTimeout(() => {}, 600_000)'],
      process.env,
    );
    try {
      assert.ok(runner.child.pid !== undefined);
      // Only a recovery claims a run, by a rename: this claim is of a live
      // runner inside the recovery of a run whose runner died.
      const claim = join(
        directory.path,
        'state',
        'zukhruf-testing',
        'docker-runs',
        `recovering-${runner.child.pid}-${randomUUID()}`,
      );
      await mkdir(claim, { recursive: true });
      await writeFile(
        join(claim, 'run.json'),
        JSON.stringify({
          id: randomUUID(),
          endpoint: engine,
          pid: await endedPid(),
        }),
      );
      const file = join(directory.path, 'plain.test.ts');
      await writeFile(
        file,
        "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
      );

      // Control: the claim of a runner that died is taken and removed.
      const abandoned = join(
        dirname(claim),
        `recovering-${await endedPid()}-${randomUUID()}`,
      );
      await mkdir(abandoned);
      await writeFile(
        join(abandoned, 'run.json'),
        JSON.stringify({
          id: randomUUID(),
          endpoint: engine,
          pid: await endedPid(),
        }),
      );

      await emptyRun(file, runEnvironment(join(directory.path, 'state')));

      await access(join(claim, 'run.json'));
      assert.equal(existsSync(abandoned), false);
    } finally {
      runner.child.kill('SIGKILL');
      await runner.exited.catch(() => null);
    }
  });

  test('the recovery of a dead run removes the folder of its sockets in /tmp, and then its records', async () => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-dead-sockets-',
    );
    const id = randomUUID();
    const record = join(
      directory.path,
      'state',
      'zukhruf-testing',
      'docker-runs',
      id,
    );
    await mkdir(record, { recursive: true });
    // Only a global setup writes run.json and the folder of the run's sockets:
    // these are of a run whose runner died.
    await writeFile(
      join(record, 'run.json'),
      JSON.stringify({ id, endpoint: engine, pid: await endedPid() }),
    );
    const sockets = runSocketFolder(id);
    await mkdir(sockets, { mode: 0o700 });
    try {
      await writeFile(join(sockets, 'ssh.sock'), '');
      const file = join(directory.path, 'plain.test.ts');
      await writeFile(
        file,
        "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
      );

      await emptyRun(file, runEnvironment(join(directory.path, 'state')));

      assert.equal(existsSync(sockets), false);
      assert.equal(existsSync(record), false);
    } finally {
      await rm(sockets, { recursive: true, force: true });
    }
  });

  test('recovery leaves a dead run on another engine alone', async () => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-other-engine-',
    );
    const id = randomUUID();
    const record = join(
      directory.path,
      'state',
      'zukhruf-testing',
      'docker-runs',
      id,
    );
    await mkdir(record, { recursive: true });
    // Only a global setup writes run.json: this one is of a run on another
    // engine whose runner and test process died.
    await writeFile(
      join(record, 'run.json'),
      JSON.stringify({
        id,
        endpoint: 'ssh://elsewhere.invalid',
        pid: await endedPid(),
      }),
    );
    const file = join(directory.path, 'plain.test.ts');
    await writeFile(
      file,
      "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
    );

    await emptyRun(file, runEnvironment(join(directory.path, 'state')));

    await access(join(record, 'run.json'));
  });

  test('a reaper of another run that was left created, with no records, is started by the reaper of the next run on its engine, and its run’s objects go; a younger created reaper, and a running reaper of another run with its objects, stay', async (t) => {
    await using directory = await runsDirectory(
      'zukhruf-testing-created-reaper-',
    );
    const stale = randomUUID();
    const live = randomUUID();
    await present(REAPER_IMAGE);
    await present('alpine:latest');
    await using objects = new AsyncDisposableStack();
    const owned = async (run: string) => {
      const container = await docker.containers.create({
        Image: 'alpine:latest',
        Cmd: ['sleep', '600'],
        Labels: { 'dev.zukhruf.testing.run': run },
      });
      objects.defer(() => removeContainer(container.id));
      await container.start();
      const { name } = await docker.volumes.create({
        Labels: { 'dev.zukhruf.testing.run': run },
      });
      objects.defer(() => removeVolume(name));
      return { container: container.id, volume: name };
    };
    const staleObjects = await owned(stale);
    const liveObjects = await owned(live);
    // The reaper of a process that was killed between its create and its
    // start: no operation of the package leaves one, so the test creates it.
    const created = await docker.containers.create(
      reaperRequest(
        stale,
        {
          ...REAPER_DEFAULTS,
          grace: 300,
          interval: 200,
          passes: 1,
          // Its window to be started is twice this: 4 s, less than the run below takes.
          requestTimeout: 2_000,
          firstHolder: 0,
        },
        '/var/run/docker.sock',
        directoryParent(docker.host),
      ),
      { name: reaperName(stale) },
    );
    objects.defer(() => removeContainer(created.id));
    // A reaper whose creator may still start it: its window is 2 h.
    const young = randomUUID();
    const waiting = await docker.containers.create(
      reaperRequest(
        young,
        { ...REAPER_DEFAULTS, requestTimeout: 3_600_000 },
        '/var/run/docker.sock',
        directoryParent(docker.host),
      ),
      { name: reaperName(young) },
    );
    objects.defer(() => removeContainer(waiting.id));
    const holding = await reaperHolder(t, live);
    objects.defer(async () => {
      holding.child.kill('SIGKILL');
      await holding.exited.catch(() => null);
    });
    const liveReaper = await docker.containers.find(reaperName(live));
    assert.ok(liveReaper);
    objects.defer(() => removeContainer(liveReaper.id));
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(file, smallWorkerSource(statePath, ''));

    await promisify(execFile)(process.execPath, runnerArgs(file), {
      env: runEnvironment(join(directory.path, 'state')),
      timeout: 150_000,
    });

    await waitFor(
      async () => {
        assert.equal(await exists(created.id), false);
        assert.equal(await exists(staleObjects.container), false);
        assert.equal(await volumeExists(staleObjects.volume), false);
      },
      { signal: t.signal, interval: 200 },
    );
    assert.equal((await waiting.inspect()).State?.Status, 'created');
    assert.equal(await running(liveReaper.id), true);
    assert.equal(await running(liveObjects.container), true);
    assert.equal(await volumeExists(liveObjects.volume), true);
  });

  test('the global teardown removes a container and a volume that carry only the run’s labels, and keeps a shared server that carries the run’s label', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-labels-',
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    // The test removes the shared server through this label: the teardown
    // keeps it.
    const scope = randomUUID();
    const verification = `dev.zukhruf.testing.verification=${scope}`;
    // Another Docker client, such as a sandbox launcher, creates the container
    // and the volume: only the labels of docker.defaults() tie them to the run.
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { Docker } from ${client};
      import { DockerTestbed } from ${library};
      test('resources that the run owns through its labels', { timeout: 150000 }, async () => {
        const docker = new DockerTestbed({ environment: process.env });
        const { Labels: labels } = await docker.defaults();
        const shared = await docker.reuse({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: { ...labels, 'dev.zukhruf.testing.verification': ${JSON.stringify(scope)} } }, { internalPort: 80 });
        await shared.disconnect();
        await using other = await Docker.connect({ clock: globalThis, environment: process.env });
        const created = await other.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: labels });
        await created.start();
        const { name: volume } = await other.volumes.create({ Labels: labels });
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container: created.id, volume, shared: shared.container.id }));
      });
    `,
    );
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      for (const id of await labelled(verification)) await removeContainer(id);
    });

    await promisify(execFile)(process.execPath, runnerArgs(file), {
      env: runEnvironment(join(directory.path, 'state')),
      timeout: 150_000,
    });
    const state = await readState<LabelState>(t, statePath);
    cleanup.defer(async () => {
      await removeContainer(state.container);
      await removeVolume(state.volume);
    });

    await reaped(t, async () => {
      assert.equal(await exists(state?.container ?? ''), false);
      assert.equal(await volumeExists(state?.volume ?? ''), false);
    });
    assert.equal(await running(state.shared), true);
  });

  test('the reaper removes a container and a volume of a test process that only read docker.defaults(), when its run ends', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-defaults-',
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    // A sandbox launcher reads the labels and creates everything through its
    // own Docker client: the test process makes no other acquisition.
    await present('alpine:latest');
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { Docker } from ${client};
      import { DockerTestbed } from ${library};
      test('resources of another Docker client', { timeout: 150000 }, async () => {
        const { Labels: labels } = await new DockerTestbed({ environment: process.env }).defaults();
        await using other = await Docker.connect({ clock: globalThis, environment: process.env });
        const created = await other.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: labels });
        await created.start();
        const { name: volume } = await other.volumes.create({ Labels: labels });
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container: created.id, volume }));
      });
    `,
    );
    const stateHome = join(directory.path, 'state');
    await using cleanup = new AsyncDisposableStack();

    await promisify(execFile)(process.execPath, runnerArgs(file), {
      env: runEnvironment(stateHome),
      timeout: 150_000,
    });
    const state = await readState<Omit<LabelState, 'shared'>>(t, statePath);
    cleanup.defer(async () => {
      await removeContainer(state.container);
      await removeVolume(state.volume);
    });

    const ended = state;
    await reaped(t, async () => {
      assert.equal(await exists(ended.container), false);
      assert.equal(await volumeExists(ended.volume), false);
    });
    // The teardown deleted the run's records.
    assert.deepEqual(
      await readdir(join(stateHome, 'zukhruf-testing', 'docker-runs')),
      [],
    );
  });

  test('start() pulls an image that the engine does not have', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-pull-',
    );
    // Only this test uses this tag, so it can remove the image.
    const image = 'busybox:1.37.0-musl';
    const removeImage = () => docker.images.remove(image, { force: true });
    await removeImage();
    assert.equal(await docker.images.inspect(image), undefined);
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { DockerTestbed } from ${library};
      test('an image that the engine does not have', { timeout: 150000 }, async () => {
        const docker = new DockerTestbed({ environment: process.env });
        await using container = await docker.start({ Image: ${JSON.stringify(image)}, Cmd: ['sleep', '600'] });
        const { exitCode } = await container.exec({ Cmd: ['true'] });
        if (exitCode !== 0) throw new Error('true exited with ' + exitCode);
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.id }));
      });
    `,
    );
    try {
      await promisify(execFile)(process.execPath, runnerArgs(file), {
        env: runEnvironment(join(directory.path, 'state')),
        timeout: 150_000,
      });

      const state = await readState<{ id: string }>(t, statePath);
      assert.match(state.id, /^[\da-f]{64}$/);
      assert.notEqual(await docker.images.inspect(image), undefined);
    } finally {
      await removeImage();
    }
  });

  test('a runner whose DOCKER_HOST names a tcp:// engine fails in the global setup', async () => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-tcp-',
    );
    const file = join(directory.path, 'plain.test.ts');
    await writeFile(
      file,
      "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
    );
    const state = join(directory.path, 'state');
    const run = started(runnerArgs(file), {
      ...runEnvironment(state),
      // A selected context wins over DOCKER_HOST.
      DOCKER_CONTEXT: undefined,
      DOCKER_HOST: 'tcp://127.0.0.1:1',
    });

    const code = await run.exited;

    assert.notEqual(code, 0, run.output());
    assert.match(
      run.output(),
      /Unsupported Docker endpoint tcp:\/\/127\.0\.0\.1:1/,
    );
    assert.deepEqual(
      await readdir(join(state, 'zukhruf-testing', 'docker-runs')),
      [],
    );
  });

  test('the global setup and teardown of the built package clean a run', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-dist-',
    );
    const built = import.meta.resolve('@zukhruf/testing/docker-global-setup');
    assert.match(built, /\/dist\/scripts\/docker-global-setup\.js$/);
    const setupFile = join(directory.path, 'setup.mjs');
    await writeFile(
      setupFile,
      `export { globalSetup, globalTeardown } from ${JSON.stringify(built)};\n`,
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { DockerTestbed } from ${JSON.stringify(import.meta.resolve('@zukhruf/testing/docker'))};
      test('a container of the run', { timeout: 150000 }, async () => {
        const created = await new DockerTestbed({ environment: process.env }).start({ Image: 'alpine:latest', Cmd: ['sleep', '600'] });
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container: created.id }));
      });
    `,
    );
    const stateHome = join(directory.path, 'state');
    let state: { container: string } | undefined;
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      // A failed teardown leaves the container: the state still names it.
      state ??= await readFile(statePath, 'utf8').then(
        (text): { container: string } => JSON.parse(text),
        (error: unknown) => {
          // The worker failed before it wrote the state.
          if (isErrno(error, 'ENOENT')) return undefined;
          throw error;
        },
      );
      if (state) await removeContainer(state.container);
    });

    await promisify(execFile)(
      process.execPath,
      ['--test', `--test-global-setup=${setupFile}`, file],
      { env: runEnvironment(stateHome), timeout: 150_000 },
    );
    state = await readState<{ container: string }>(t, statePath);

    const { container } = state;
    await reaped(t, async () => assert.equal(await exists(container), false));
    // The teardown deleted the run's records.
    assert.deepEqual(
      await readdir(join(stateHome, 'zukhruf-testing', 'docker-runs')),
      [],
    );
  });

  test('two processes that send the same request get one server, whatever their version', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-one-request-',
    );
    const probe = randomUUID();
    const env = runEnvironment(join(directory.path, 'state'));
    const ids: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      for (const id of ids) await removeContainer(id);
    });

    ids.push(
      await reusedAndExited(
        t,
        directory.path,
        await anotherVersion(directory.path, `${manifest.version}-next.0`),
        probe,
        env,
      ),
    );

    ids.push(
      await reusedAndExited(t, directory.path, JSON.parse(library), probe, env),
    );

    assert.equal(ids[1], ids[0]);
  });

  test('a server younger than the TTL is kept', async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-young-',
    );
    const env = runEnvironment(join(directory.path, 'state'));
    const ids: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      for (const id of ids) await removeContainer(id);
    });

    // A process of another version: before ADR 0019, the run below removed its server.
    const server = await reusedAndExited(
      t,
      directory.path,
      await anotherVersion(directory.path, `${manifest.version}-next.0`),
      randomUUID(),
      env,
    );
    ids.push(server);
    await unleased(t, await fingerprintOf(server));
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(file, smallWorkerSource(statePath, ''));

    await promisify(execFile)(process.execPath, runnerArgs(file), {
      env,
      timeout: 150_000,
    });
    ids.push((await readState<SmallState>(t, statePath)).id);

    assert.equal(await running(server), true);
  });
});

// The tests below run one at a time: a sweep eight days ahead removes every server past the TTL that no live lease holds (see the note "Each test below reuses a server with its own probe label"), and one waits on a fixed window of real time.

test(
  'a server older than the TTL with no process lease is removed when a run that used Docker ends',
  { skip: proxyless },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-expired-',
    );
    const env = runEnvironment(join(directory.path, 'state'));
    const ids: string[] = [];
    // A live process of another server: its lease must not keep this server.
    const other = await holder(t, directory.path, randomUUID(), env);
    ids.push(other.id);
    // Not a shared server: the sweep must not select it.
    const container = await docker.containers.create({
      Image: 'alpine:latest',
      Cmd: ['sleep', '3600'],
      Labels: { 'dev.zukhruf.testing.probe': randomUUID() },
    });
    ids.push(container.id);
    // A shared server of a version before ADR 0019: this version does not see it.
    const older = await docker.containers.create({
      Image: 'alpine:latest',
      Cmd: ['sleep', '3600'],
      Labels: {
        'dev.zukhruf.testing.shared': '1',
        'dev.zukhruf.testing.probe': randomUUID(),
      },
    });
    ids.push(older.id);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await other.exited;
      for (const id of ids) await removeContainer(id);
    });

    const server = await reusedAndExited(
      t,
      directory.path,
      JSON.parse(library),
      randomUUID(),
      env,
    );
    ids.push(server);
    const fingerprint = await fingerprintOf(server);
    await unleased(t, fingerprint);
    // Six days later, the server is younger than its TTL.
    const askedEarly = await sweep([fingerprint], {
      serverTtl: REAPER_DEFAULTS.serverTtl - 6 * DAY,
    });
    const keptEarly = await exists(server);

    await sweep([fingerprint], {});

    assert.deepEqual(askedEarly, new Set());
    assert.equal(keptEarly, true);
    assert.equal(await exists(server), false);
    assert.equal(await exists(container.id), true);
    assert.equal(await exists(older.id), true);
  },
);

test(
  'a server older than the TTL with a live process lease is kept, for each server that the process uses',
  { skip: proxyless },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-leased-',
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'two-servers.ts');
    await writeFile(
      file,
      `
    const { DockerTestbed } = await import(${library});
    const { writeFile } = await import('node:fs/promises');
    const docker = new DockerTestbed({ environment: process.env });
    const reuse = (probe) => docker.reuse({ Image: 'alpine:latest', Cmd: ['sleep', '3600'], Labels: { 'dev.zukhruf.testing.probe': probe } }, { internalPort: 80 });
    const first = await reuse(${JSON.stringify(randomUUID())});
    const second = await reuse(${JSON.stringify(randomUUID())});
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify([first.container.id, second.container.id]));
    for await (const _ of process.stdin);
  `,
    );
    const child = spawnProcess(process.execPath, [file], {
      env: runEnvironment(join(directory.path, 'state')),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    let servers: string[] = [];
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      child.kill('SIGKILL');
      await exited;
      for (const server of servers) await removeContainer(server);
    });

    servers = await readState<string[]>(t, statePath);

    const fingerprints = await Promise.all(servers.map(fingerprintOf));

    const asked = await sweep(fingerprints, {});

    assert.deepEqual(asked, new Set(fingerprints));
    for (const server of servers) assert.equal(await running(server), true);
  },
);

test(
  'a server older than the TTL whose holder was killed is removed',
  { skip: proxyless || signals },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-killed-holder-',
    );
    const other = await holder(
      t,
      directory.path,
      randomUUID(),
      runEnvironment(join(directory.path, 'state')),
    );
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await removeContainer(other.id);
    });

    other.child.kill('SIGKILL');
    await other.exited;
    const fingerprint = await fingerprintOf(other.id);
    await unleased(t, fingerprint);

    await sweep([fingerprint], {});

    assert.equal(await exists(other.id), false);
  },
);

test(
  'the process lease of a test process is gone after the process is killed',
  { skip: signals },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-killed-lease-',
    );
    const other = await holder(
      t,
      directory.path,
      randomUUID(),
      runEnvironment(join(directory.path, 'state')),
    );
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await removeContainer(other.id);
    });

    const fingerprint = await fingerprintOf(other.id);
    assert.equal((await processLeases(fingerprint)).length, 1);

    other.child.kill('SIGKILL');
    await other.exited;

    await unleased(t, fingerprint);
  },
);

test(
  'a reaper keeps an expired server whose test process takes its process lease while the reaper holds the sweep lease and has not listed the process leases yet',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-sweep-order-');
    await using stack = new AsyncDisposableStack();
    const probe = randomUUID();
    const env = runEnvironment(join(directory.path, 'state'));
    const keeper = await holder(t, directory.path, probe, env);
    const server = keeper.id;
    const fingerprint = await fingerprintOf(server);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      keeper.child.kill('SIGKILL');
      await removeContainer(server);
    });

    await ended(t, keeper, fingerprint);
    const proxy = stack.use(await EngineProxy.start(engine));
    const listing = sweepHold(proxy, fingerprint);
    stack.defer(() => listing.release());
    const { finished } = await proxiedReaper(stack, proxy, [fingerprint], {});
    assert.equal(
      await untilAborted(
        Promise.race([
          listing.reached.then(() => 'reached'),
          finished.then(() => 'ended'),
        ]),
        t.signal,
      ),
      'reached',
      'the reaper must hold the sweep lease of the server',
    );
    const held = await listing.reached;
    const lease = await docker.containers.find(sweepLease(fingerprint));
    assert.ok(lease, 'the reaper holds the sweep lease');
    const start = proxy.requests.findIndex(
      ({ method, path }) =>
        method === 'POST' && path === `/containers/${lease.id}/start`,
    );
    assert.ok(
      start !== -1 && proxy.requests.indexOf(held) > start,
      'the held list comes after the start of the sweep lease',
    );
    const holding = holder(t, directory.path, probe, env);
    holding.catch(() => {});
    await waitFor(
      async () => assert.equal((await processLeases(fingerprint)).length, 1),
      { signal: t.signal, interval: 100 },
    );

    listing.release();
    const other = await holding;
    cleanup.defer(() => {
      other.child.kill('SIGKILL');
    });

    await finished;
    assert.equal(other.id, server);
    assert.equal(await running(server), true);
  },
);

test(
  'a reaper whose removal of an expired shared server fails keeps that server and ends once',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory(
      'zukhruf-testing-refused-removal-',
    );
    await using stack = new AsyncDisposableStack();
    const other = await holder(
      t,
      directory.path,
      randomUUID(),
      runEnvironment(join(directory.path, 'state')),
    );
    const server = other.id;
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await removeContainer(server);
    });

    const fingerprint = await fingerprintOf(server);
    await ended(t, other, fingerprint);
    const proxy = stack.use(await EngineProxy.start(engine));
    proxy.intercept('DELETE', `/containers/${server}`, () => {
      throw new Error('The engine refuses this removal.');
    });

    const { finished } = await proxiedReaper(stack, proxy, [fingerprint], {});

    await finished;
    assert.ok(
      proxy.requests.some(
        ({ method, path }) =>
          method === 'DELETE' && path === `/containers/${server}`,
      ),
    );
    assert.equal(await running(server), true);
  },
);

test('a process waits for the sweep lease of its server, and then gets a running server', async (t) => {
  await using directory = await runsDirectory('zukhruf-testing-sweep-wait-');
  const probe = randomUUID();
  const env = runEnvironment(join(directory.path, 'state'));
  const ids: string[] = [];
  const other = await holder(t, directory.path, probe, env);
  const server = other.id;
  ids.push(server);
  const fingerprint = await fingerprintOf(server);
  const statePath = join(directory.path, 'waiting.json');
  const file = join(directory.path, 'waiting.ts');
  await writeFile(file, holdingSource(JSON.parse(library), statePath, probe));
  let lease: EngineLease | undefined;
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    await lease?.[Symbol.asyncDispose]();
    other.child.kill('SIGKILL');
    for (const id of ids) await removeContainer(id);
  });

  await ended(t, other, fingerprint);
  // A reaper that found no process lease of the server, and removes it.
  lease = await sweepLeaseOf(fingerprint);
  await removeContainer(server);
  const waiting = started([file], env);
  cleanup.defer(() => {
    waiting.child.kill('SIGKILL');
  });
  await waitFor(
    async () => assert.equal((await processLeases(fingerprint)).length, 1),
    { signal: t.signal, interval: 100 },
  );
  // A fixed window: it proves that the process does not get the server
  // while the sweep lease lives, and it gets one in well under 5 s without it.
  await setTimeout(5_000);
  const proceededBeforeRelease = existsSync(statePath);

  await lease[Symbol.asyncDispose]();
  lease = undefined;
  const { id } = await readState<{ id: string }>(t, statePath);
  ids.push(id);

  assert.equal(proceededBeforeRelease, false, waiting.output());
  assert.notEqual(id, server);
  assert.equal(await running(id), true);
});

test(
  'two reapers that sweep one expired server at once both end, and the server is removed',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-two-sweeps-');
    const other = await holder(
      t,
      directory.path,
      randomUUID(),
      runEnvironment(join(directory.path, 'state')),
    );
    const server = other.id;
    const fingerprint = await fingerprintOf(server);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await removeContainer(server);
    });

    await ended(t, other, fingerprint);

    await Promise.all([sweep([fingerprint], {}), sweep([fingerprint], {})]);

    assert.equal(await exists(server), false);
    assert.equal(await exists(sweepLease(fingerprint)), false);
  },
);

test(
  'a sweep lease that a killed sweep left created does not stop a test process of its server',
  { skip: proxyless || signals },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-stale-sweep-');
    const probe = randomUUID();
    const env = runEnvironment(join(directory.path, 'state'));
    const ids: string[] = [];
    const other = await holder(t, directory.path, probe, env);
    const server = other.id;
    ids.push(server);
    const fingerprint = await fingerprintOf(server);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await other.exited;
      await (
        await docker.containers.find(sweepLease(fingerprint))
      )?.remove({ force: true });
      for (const id of ids) await removeContainer(id);
    });

    // A sweep that finds the sweep lease created removes it. With the
    // server gone, no sweep looks at its sweep lease again, so only the
    // test process below can remove the stale lease.
    await killedSweep(fingerprint, () => removeContainer(server));
    const stale = await docker.containers.find(sweepLease(fingerprint));
    assert.ok(stale);
    await using proxy = await EngineProxy.start(engine);
    const removal = leaseRemoval(proxy, stale.id);

    const reused = await reusedAndExited(
      t,
      directory.path,
      JSON.parse(library),
      probe,
      proxiedEnvironment(join(directory.path, 'state'), proxy),
    );
    ids.push(reused);

    if (
      !(await removal.asserted(
        t,
        'another process removed the stale sweep lease',
      ))
    )
      return;
    assert.notEqual(reused, server);
    assert.equal(await running(reused), true);
    assert.equal(await exists(stale.id), false);
  },
);

test(
  'a sweep lease that a killed sweep left created does not stop the next sweep from removing its server',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory(
      'zukhruf-testing-stale-sweep-teardown-',
    );
    const other = await holder(
      t,
      directory.path,
      randomUUID(),
      runEnvironment(join(directory.path, 'state')),
    );
    const server = other.id;
    const fingerprint = await fingerprintOf(server);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await other.exited;
      await (
        await docker.containers.find(sweepLease(fingerprint))
      )?.remove({ force: true });
      await removeContainer(server);
    });

    await killedSweep(fingerprint);
    const stale = await docker.containers.find(sweepLease(fingerprint));
    assert.ok(stale);
    await ended(t, other, fingerprint);

    await sweep([fingerprint], { leasePatience: 500 });

    assert.equal(await exists(server), false);
    assert.equal(
      await docker.containers.find(sweepLease(fingerprint)),
      undefined,
    );
  },
);

test(
  'a reaper that finds another sweep of the same server running for longer than it waits keeps that server and ends',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-long-sweep-');
    const other = await holder(
      t,
      directory.path,
      randomUUID(),
      runEnvironment(join(directory.path, 'state')),
    );
    const server = other.id;
    const fingerprint = await fingerprintOf(server);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await removeContainer(server);
    });

    await ended(t, other, fingerprint);
    const lease = await sweepLeaseOf(fingerprint);
    cleanup.defer(() => lease[Symbol.asyncDispose]());

    const asked = await sweep([fingerprint], {
      sweepWait: 2000,
      leasePatience: 500,
    });

    assert.deepEqual(asked, new Set([fingerprint]));
    assert.equal(await running(server), true);
  },
);

test(
  'a sweep lease that ended and was not removed does not stop the next sweep from removing its server',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-ended-sweep-');
    const other = await holder(
      t,
      directory.path,
      randomUUID(),
      runEnvironment(join(directory.path, 'state')),
    );
    const server = other.id;
    const fingerprint = await fingerprintOf(server);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      other.child.kill('SIGKILL');
      await removeContainer(sweepLease(fingerprint));
      await removeContainer(server);
    });

    await ended(t, other, fingerprint);
    // A lease whose removal the engine did not finish, such as one it left
    // dead: no operation of the package leaves one, so the test makes it.
    const stale = await docker.containers.create(
      {
        Image: 'busybox:1.37.0',
        Cmd: ['true'],
        Labels: { 'dev.zukhruf.testing.probe': fingerprint },
      },
      { name: sweepLease(fingerprint) },
    );
    await stale.start();
    await stale.wait({ condition: 'not-running', signal: t.signal });
    assert.equal((await stale.inspect()).State?.Status, 'exited');

    await sweep([fingerprint], {});

    assert.equal(await exists(server), false);
    assert.equal(await exists(stale.id), false);
  },
);
