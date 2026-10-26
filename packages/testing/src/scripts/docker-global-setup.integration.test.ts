import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import spawn, { SubprocessError } from 'nano-spawn';

import { BindSourceNotFoundError, Docker } from '@zukhruf/docker';

import { DockerTestbed } from '../docker/index.ts';
import { RunRecords } from '../docker/run-records.ts';
import { TemporaryFiles } from '../fs/temporary-files.ts';
import { EngineProxy } from '../testing/engine-proxy.ts';

const docker = await Docker.connect({ environment: process.env });
/** The host of the engine that this process's context selects. */
const engine =
  (await Docker.contexts({ environment: process.env })).find(
    (context) => context.current,
  )?.host ?? '';
const proxyless = engine.startsWith('unix://')
  ? false
  : `the engine proxy forwards to a local unix:// engine only, not ${engine}`;
const signals =
  process.platform === 'win32'
    ? 'Windows ends a process on a signal, so it runs no global teardown'
    : false;
const setup = fileURLToPath(
  new URL('./docker-global-setup.ts', import.meta.url),
);
const library = JSON.stringify(
  new URL('../docker/index.ts', import.meta.url).href,
);
/** The internal module that writes a run's records, for workers that act as a test process. */
const runRecords = JSON.stringify(
  new URL('../docker/run-records.ts', import.meta.url).href,
);
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
  forwards: string[];
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
  import { readFile, readdir, writeFile } from 'node:fs/promises';
  import { setTimeout } from 'node:timers/promises';
  import { DockerTestbed } from ${library};
  test('disposable resources before interruption', { timeout: ${timeout} }, async () => {
    const docker = new DockerTestbed({ environment: process.env });
    const { container } = await docker.serve({ image: 'postgres:18-alpine', internalPort: 5432, env: { POSTGRES_PASSWORD: 'test' } });
    const general = await docker.start({ image: 'postgres:18-alpine', command: ['sleep', '600'] });
    const fixture = await docker.directory();
    await fixture.writeFile('sentinel.txt', 'owned');
    const volume = await docker.volume();
    const anonymous = async (handle) => (await handle.inspect()).Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name);
    const anonymousVolumes = await anonymous(container);
    const generalVolumes = await anonymous(general);
    const directory = process.env.ZUKHRUF_TESTING_RUN_DIR;
    const forwards = await Promise.all((await readdir(directory)).filter(name => name.startsWith('forward-')).map(async name => JSON.parse(await readFile(directory + '/' + name, 'utf8')).path));
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.id, general: general.id, path: fixture.path, volume: volume.name, anonymousVolumes, generalVolumes, forwards, run: process.env.ZUKHRUF_TESTING_RUN_ID, record: directory, pid: process.pid }));
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
    const container = await docker.start({ image: 'alpine:latest', command: ['sleep', '600'] });
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.id, run: process.env.ZUKHRUF_TESTING_RUN_ID, record: process.env.ZUKHRUF_TESTING_RUN_DIR, pid: process.pid }));
    ${ending}
  });
`;

/** The environment of a runner that keeps its runs under `state`. */
const runEnvironment = (
  state: string,
  path = process.env.PATH,
): Record<string, string | undefined> => ({
  ...process.env,
  XDG_STATE_HOME: state,
  PATH: path,
  // Undefined, not deleted: nano-spawn adds process.env back, and Node
  // passes no variable whose value is undefined.
  // A runner launched from a test worker would otherwise skip its files.
  NODE_TEST_CONTEXT: undefined,
  // This test may itself run in a run; a nested run must start its own.
  ZUKHRUF_TESTING_RUN_ID: undefined,
  ZUKHRUF_TESTING_RUN_DIR: undefined,
});

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

/** `node --test` with the Docker global setup. */
const runnerArgs = (...args: string[]) => [
  '--test',
  `--test-global-setup=${setup}`,
  ...args,
];

/** A run that runs no test of `file`, so it only recovers and ends. */
const emptyRun = (file: string, env: Record<string, string | undefined>) =>
  spawn(
    process.execPath,
    runnerArgs('--test-name-pattern=no-matching-tests', file),
    { env, timeout: 90_000 },
  );

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
  await t.waitFor(
    async () => {
      JSON.parse(await readFile(statePath, 'utf8'));
    },
    { timeout: 60_000, interval: 250 },
  );
  return JSON.parse(await readFile(statePath, 'utf8'));
}

async function removeLeftovers(state: State | undefined): Promise<void> {
  if (!state) return;
  for (const id of [state.id, state.general])
    await removeContainer(id).catch(() => {});
  for (const name of [
    state.volume,
    ...state.anonymousVolumes,
    ...state.generalVolumes,
  ])
    await removeVolume(name).catch(() => {});
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

for (const mode of [
  'failure',
  'timeout',
  'SIGINT',
  'SIGTERM',
  'recovery',
] as const) {
  test(
    `the global teardown cleans an interrupted run (${mode}) and preserves another run's containers and volumes`,
    {
      skip:
        mode === 'recovery'
          ? proxyless
          : mode === 'SIGINT' || mode === 'SIGTERM'
            ? signals
            : false,
      timeout: 180_000,
    },
    async (t) => {
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-testing-cleanup-',
      );
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
        image: 'alpine:latest',
        command: ['sleep', '600'],
      });
      await using sentinelVolume = await unrelated.volume();
      const statePath = join(directory.path, 'state.json');
      const file = join(directory.path, 'worker.test.ts');
      // In recovery mode the run's engine is a proxy, which stops before the
      // global teardown and listens again before the next run.
      await using proxy =
        mode === 'recovery' ? await EngineProxy.start(engine) : undefined;
      const stopped = join(directory.path, 'stopped');
      await writeFile(
        file,
        workerSource(
          statePath,
          [
            mode === 'recovery'
              ? `while (!existsSync(${JSON.stringify(stopped)})) await setTimeout(100);`
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
      let state: State | undefined;
      try {
        state = await readState<State>(t, statePath);
        assert.ok(state.anonymousVolumes.length > 0);
        assert.ok(state.generalVolumes.length > 0);
        if (mode === 'SIGINT' || mode === 'SIGTERM') run.child.kill(mode);
        if (proxy) {
          await proxy.close();
          await writeFile(stopped, '');
        }
        const code = await run.exited;
        if (proxy) {
          // The test passed, so only the failed cleanup sets the exit code.
          assert.equal(code, 1, run.output());
          assert.match(run.output(), /retained ownership record/);
          const record = JSON.parse(
            await readFile(join(state.record, 'run.json'), 'utf8'),
          );
          assert.equal(record.endpoint, proxy.host);
          assert.equal(await running(state.id), true);
          await proxy.listen();
          await emptyRun(file, env);
        } else assert.notEqual(code, 0, run.output());
        for (const id of [state.id, state.general])
          assert.equal(await exists(id), false, run.output());
        for (const name of [
          state.volume,
          ...state.anonymousVolumes,
          ...state.generalVolumes,
        ]) {
          assert.equal(
            await volumeExists(name),
            false,
            `the run left volume ${name}: ${run.output()}`,
          );
        }
        for (const path of state.forwards) {
          await assert.rejects(readFile(join(path, 's')), { code: 'ENOENT' });
        }
        // Docker validates the remote path. This probe never creates the source.
        await assert.rejects(
          docker.containers.run({
            Image: 'alpine:latest',
            Cmd: ['true'],
            HostConfig: {
              Mounts: [
                { Type: 'bind', Source: state.path, Target: '/fixture' },
              ],
            },
          }),
          BindSourceNotFoundError,
        );
        if (mode === 'SIGINT' || mode === 'SIGTERM') {
          // The runner does not wait for a signalled test process, so the
          // teardown may keep the run's records; the next run removes them.
          const { pid } = state;
          await t.waitFor(() => assert.equal(alive(pid), false), {
            timeout: 10_000,
          });
          await emptyRun(file, env);
        }
        // Every recorded process has ended, so nothing of the run is left,
        // not even a recovery's claim.
        assert.deepEqual(
          await readdir(
            join(directory.path, 'state', 'zukhruf-testing', 'docker-runs'),
          ),
          [],
        );
        assert.equal(await running(sentinel.id), true);
        assert.equal(await volumeExists(sentinelVolume.name), true);
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null)
          run.child.kill('SIGKILL');
        await run.exited.catch(() => null);
        await removeLeftovers(state);
      }
    },
  );
}

test(
  'a create that the engine finishes after its test process was killed keeps the run, and the next run removes what it created',
  { skip: proxyless, timeout: 180_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-orphan-create-',
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    // The image must not be pulled behind the held create.
    if ((await docker.images.inspect('alpine:latest')) === undefined)
      await docker.images.pull('alpine:latest');
    // A slow create, such as one on a busy engine: the engine has the
    // request, and it creates the container after the test removes the gate.
    // Disposed after the proxy, which waits until the engine answered the
    // held create: then its container is listed.
    await using leftovers = new AsyncDisposableStack();
    await using proxy = await EngineProxy.start(engine);
    const gate = Promise.withResolvers<void>();
    proxy.intercept('POST', '/containers/create', () => gate.promise);
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { Docker } from ${client};
      import { TEST_RUN_LABEL, readRun } from ${runRecords};
      test('a slow create', { timeout: 3000 }, async () => {
        const run = readRun(process.env);
        const docker = await Docker.connect({ environment: process.env });
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ run: run.id, record: run.records.directory, pid: process.pid }));
        await using _creating = await run.records.recordCreating();
        await docker.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: { [TEST_RUN_LABEL]: run.id } });
      });
    `,
    );
    const env = proxiedEnvironment(join(directory.path, 'state'), proxy);
    let run: string | undefined;
    try {
      // The test times out, and --test-force-exit ends its process while
      // the engine still has its create.
      const killed = started(runnerArgs('--test-force-exit', file), env);
      assert.notEqual(await killed.exited, 0, killed.output());
      // The teardown kept the run on purpose: it did not fail.
      assert.doesNotMatch(killed.output(), /retained ownership record/);
      const state = await readState<Omit<SmallState, 'id'>>(t, statePath);
      run = state.run;
      const label = `dev.zukhruf.testing.run=${state.run}`;
      assert.deepEqual(await labelled(label), []);
      await access(join(state.record, 'run.json'));
      gate.resolve();
      await t.waitFor(
        async () => assert.notDeepEqual(await labelled(label), []),
        { timeout: 60_000, interval: 250 },
      );

      await emptyRun(file, env);

      assert.deepEqual(await labelled(label), []);
      await assert.rejects(access(state.record), { code: 'ENOENT' });
    } finally {
      // Never leave the create held.
      gate.resolve();
      leftovers.defer(async () => {
        if (run === undefined) return;
        for (const id of await labelled(`dev.zukhruf.testing.run=${run}`))
          await removeContainer(id).catch(() => {});
      });
    }
  },
);

test(
  'recovery leaves a dead runner’s run alone while one of its test processes lives',
  { timeout: 180_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-orphan-',
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(
      file,
      smallWorkerSource(statePath, 'await setTimeout(120_000);'),
    );
    const env = runEnvironment(join(directory.path, 'state'));
    const killed = started(runnerArgs('--test-force-exit', file), env);
    let state: SmallState | undefined;
    let worker: number | undefined;
    try {
      state = await readState<SmallState>(t, statePath);
      worker = state.pid;
      killed.child.kill('SIGKILL');
      await killed.exited;
      assert.ok(alive(worker), 'the test process outlives its runner');

      await emptyRun(file, env);

      assert.equal(await running(state.id), true);
      await access(join(state.record, 'run.json'));
    } finally {
      if (killed.child.exitCode === null && killed.child.signalCode === null)
        killed.child.kill('SIGKILL');
      await killed.exited.catch(() => null);
      if (worker !== undefined && alive(worker))
        process.kill(worker, 'SIGKILL');
      if (state) await removeContainer(state.id).catch(() => {});
    }
  },
);

test(
  'a run whose tests never touch Docker leaves no record and makes no daemon call',
  { skip: proxyless, timeout: 120_000 },
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

    await spawn(process.execPath, runnerArgs(file), {
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
    await t.waitFor(() => assert.equal(alive(pid), false), {
      timeout: 5_000,
    });
    assert.equal(await exists(state.general), true);
    const recover = () =>
      spawn(
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

/** Both runners succeeded, and nothing of the killed run is left. */
async function assertRecovered(
  results: PromiseSettledResult<unknown>[],
  state: State,
  root: string,
): Promise<void> {
  for (const result of results)
    assert.equal(
      result.status,
      'fulfilled',
      result.status === 'rejected'
        ? result.reason instanceof SubprocessError
          ? `${result.reason.message}\n${result.reason.output}`
          : String(result.reason)
        : '',
    );
  for (const id of [state.id, state.general])
    assert.equal(await exists(id), false);
  assert.equal(await volumeExists(state.volume), false);
  assert.deepEqual(await readdir(root), []);
}

test(
  'two runs that start together recover a dead run, and both succeed',
  { skip: proxyless, timeout: 180_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-recovery-',
    );
    await using proxy = await EngineProxy.start(engine);
    const { state, recover, root } = await killedRun(t, directory.path, proxy);
    // The first volume list passes; every later one waits two seconds, so a
    // second runner inside the same dead run's cleanup runs after the
    // first one has finished it.
    const recovering = proxy.requests.length;
    proxy.intercept('GET', '/volumes', async () => {
      const lists = proxy.requests
        .slice(recovering)
        .filter(({ method, path }) => method === 'GET' && path === '/volumes');
      if (lists.length > 1) await setTimeout(2_000);
    });
    try {
      const results = await Promise.allSettled([recover(), recover()]);

      await assertRecovered(results, state, root);
    } finally {
      await removeLeftovers(state);
    }
  },
);

test(
  'a run that starts while another recovers a dead run leaves the run to it',
  { skip: proxyless, timeout: 180_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-recovery-',
    );
    await using proxy = await EngineProxy.start(engine);
    const { state, recover, root } = await killedRun(t, directory.path, proxy);
    // Every container list marks that a recovery has claimed its run and is
    // removing its containers, and takes two seconds, so the second runner
    // starts while the first one is still inside the dead run's cleanup.
    const marker = join(directory.path, 'recovering');
    proxy.intercept('GET', '/containers/json', async () => {
      await writeFile(marker, '');
      await setTimeout(2_000);
    });
    try {
      const first = recover();
      await t.waitFor(() => access(marker), { interval: 50, timeout: 30_000 });
      const results = await Promise.allSettled([first, recover()]);

      await assertRecovered(results, state, root);
    } finally {
      await removeLeftovers(state);
    }
  },
);

test(
  'recovery keeps a dead run while a command lives whose pid an ended command of the run had',
  { timeout: 120_000 },
  async () => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-reused-pid-',
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
    // Only a global setup writes run.json: this one is of a run whose runner died.
    await writeFile(
      join(record, 'run.json'),
      JSON.stringify({
        id,
        endpoint: engine,
        pid: await endedPid(),
      }),
    );
    const command = started(
      ['--eval', 'setTimeout(() => {}, 600_000)'],
      process.env,
    );
    try {
      assert.ok(command.child.pid !== undefined);
      const records = new RunRecords(record);
      // The OS gave the pid of a command that ended to the next command
      // before the record of the first one was removed.
      const ended = await records.recordProcess(command.child.pid);
      await records.recordProcess(command.child.pid);
      await ended[Symbol.asyncDispose]();
      const file = join(directory.path, 'plain.test.ts');
      await writeFile(
        file,
        "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
      );

      await emptyRun(file, runEnvironment(join(directory.path, 'state')));

      await access(join(record, 'run.json'));
    } finally {
      command.child.kill('SIGKILL');
      await command.exited.catch(() => null);
    }
  },
);

test(
  'recovery leaves a dead run on another engine alone',
  { timeout: 120_000 },
  async () => {
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
    await new RunRecords(record).recordProcess(await endedPid());
    const file = join(directory.path, 'plain.test.ts');
    await writeFile(
      file,
      "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
    );

    await emptyRun(file, runEnvironment(join(directory.path, 'state')));

    await access(join(record, 'run.json'));
  },
);

/** What a worker created that only labels tie to its run, and a shared server. */
interface LabelState {
  container: string;
  volume: string;
  shared: string;
}

test(
  'the global teardown removes a container and a volume that carry only the run’s labels, and keeps a shared server that carries the run’s label',
  { timeout: 180_000 },
  async (t) => {
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
    // and the volume: only docker.defaults.labels ties them to the run.
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { Docker } from ${client};
      import { DockerTestbed } from ${library};
      test('resources that the run owns through its labels', { timeout: 150000 }, async () => {
        const docker = new DockerTestbed({ environment: process.env });
        const shared = await docker.reuse({ image: 'alpine:latest', command: ['sleep', '600'], internalPort: 80, labels: { ...docker.defaults.labels, 'dev.zukhruf.testing.verification': ${JSON.stringify(scope)} } });
        await shared.disconnect();
        await using other = await Docker.connect({ environment: process.env });
        const created = await other.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: docker.defaults.labels });
        await created.start();
        const { name: volume } = await other.volumes.create({ Labels: docker.defaults.labels });
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container: created.id, volume, shared: shared.container.id }));
      });
    `,
    );
    let state: LabelState | undefined;
    try {
      await spawn(process.execPath, runnerArgs(file), {
        env: runEnvironment(join(directory.path, 'state')),
        timeout: 150_000,
      });
      state = await readState<LabelState>(t, statePath);

      assert.equal(await exists(state.container), false);
      assert.equal(await volumeExists(state.volume), false);
      assert.equal(await running(state.shared), true);
    } finally {
      for (const id of await labelled(verification))
        await removeContainer(id).catch(() => {});
      if (state) {
        await removeContainer(state.container).catch(() => {});
        await removeVolume(state.volume).catch(() => {});
      }
    }
  },
);

test(
  'the global teardown removes a container and a volume of a test process that only read docker.defaults',
  { timeout: 180_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-defaults-',
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    // A sandbox launcher reads the labels and creates everything through its
    // own Docker client: the test process makes no other acquisition.
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { Docker } from ${client};
      import { DockerTestbed } from ${library};
      test('resources of another Docker client', { timeout: 150000 }, async () => {
        const { labels } = new DockerTestbed({ environment: process.env }).defaults;
        await using other = await Docker.connect({ environment: process.env });
        const created = await other.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: labels });
        await created.start();
        const { name: volume } = await other.volumes.create({ Labels: labels });
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container: created.id, volume }));
      });
    `,
    );
    let state: Omit<LabelState, 'shared'> | undefined;
    try {
      await spawn(process.execPath, runnerArgs(file), {
        env: runEnvironment(join(directory.path, 'state')),
        timeout: 150_000,
      });
      state = await readState<Omit<LabelState, 'shared'>>(t, statePath);

      assert.equal(await exists(state.container), false);
      assert.equal(await volumeExists(state.volume), false);
    } finally {
      if (state) {
        await removeContainer(state.container).catch(() => {});
        await removeVolume(state.volume).catch(() => {});
      }
    }
  },
);

test(
  'start() pulls an image that the engine does not have',
  { timeout: 180_000 },
  async (t) => {
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
        await using container = await docker.start({ image: ${JSON.stringify(image)}, command: ['sleep', '600'] });
        const { exitCode } = await container.exec({ Cmd: ['true'] });
        if (exitCode !== 0) throw new Error('true exited with ' + exitCode);
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.id }));
      });
    `,
    );
    try {
      await spawn(process.execPath, runnerArgs(file), {
        env: runEnvironment(join(directory.path, 'state')),
        timeout: 150_000,
      });

      const state = await readState<{ id: string }>(t, statePath);
      assert.match(state.id, /^[\da-f]{64}$/);
      assert.notEqual(await docker.images.inspect(image), undefined);
    } finally {
      await removeImage();
    }
  },
);

test(
  'a runner whose DOCKER_HOST names a tcp:// engine fails in the global setup',
  { timeout: 60_000 },
  async () => {
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
  },
);

test(
  'the global setup and teardown of the built package clean a run',
  { timeout: 180_000 },
  async (t) => {
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
      import { Docker } from ${client};
      import { DockerTestbed } from ${JSON.stringify(import.meta.resolve('@zukhruf/testing/docker'))};
      test('a container of the run', { timeout: 150000 }, async () => {
        const { labels } = new DockerTestbed({ environment: process.env }).defaults;
        await using other = await Docker.connect({ environment: process.env });
        const created = await other.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: labels });
        await created.start();
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container: created.id }));
      });
    `,
    );
    const stateHome = join(directory.path, 'state');
    let state: { container: string } | undefined;
    try {
      await spawn(
        process.execPath,
        ['--test', `--test-global-setup=${setupFile}`, file],
        { env: runEnvironment(stateHome), timeout: 150_000 },
      );
      state = await readState<{ container: string }>(t, statePath);

      assert.equal(await exists(state.container), false);
      assert.deepEqual(
        await readdir(join(stateHome, 'zukhruf-testing', 'docker-runs')),
        [],
      );
    } finally {
      // A failed teardown leaves the container: the state still names it.
      state ??= await readFile(statePath, 'utf8').then(
        (text): { container: string } => JSON.parse(text),
        () => undefined,
      );
      if (state) await removeContainer(state.container).catch(() => {});
    }
  },
);

/** The manifest of this package, whose version its shared servers carry. */
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
  const server = await docker.reuse({ image: 'alpine:latest', command: ['sleep', '3600'], internalPort: 80, labels: { 'dev.zukhruf.testing.probe': ${JSON.stringify(probe)} } });
  await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: server.container.id }));
  await server.disconnect();
  await (await docker.client())[Symbol.asyncDispose]();
`;

/**
 * Arrange and act: another version of the package reuses a shared server
 * outside a run. Then a run of this version reuses a server with the same
 * options, and ends. `ids` gets each server, for the test's teardown.
 */
async function reusedByTwoVersions(
  t: TestContext,
  directory: string,
  ids: string[],
): Promise<{ another: string; current: string }> {
  const probe = randomUUID();
  const env = runEnvironment(join(directory, 'state'));
  const anotherState = join(directory, 'another.json');
  const anotherFile = join(directory, 'another.ts');
  await writeFile(
    anotherFile,
    reuseSource(
      await anotherVersion(directory, `${manifest.version}-next.0`),
      anotherState,
      probe,
    ),
  );
  await spawn(process.execPath, [anotherFile], { env, timeout: 120_000 });
  const { id: another } = await readState<{ id: string }>(t, anotherState);
  ids.push(another);
  const currentState = join(directory, 'current.json');
  const file = join(directory, 'current.test.ts');
  await writeFile(
    file,
    `
    import { test } from 'node:test';
    test('a shared server', { timeout: 120000 }, async () => {
      ${reuseSource(JSON.parse(library), currentState, probe)}
    });
  `,
  );
  await spawn(process.execPath, runnerArgs(file), { env, timeout: 150_000 });
  const { id: current } = await readState<{ id: string }>(t, currentState);
  ids.push(current);
  return { another, current };
}

/** Creates and starts a shared server that carries no version label. */
async function unversionedServer(): Promise<string> {
  if ((await docker.images.inspect('alpine:latest')) === undefined)
    await docker.images.pull('alpine:latest');
  const created = await docker.containers.create({
    Image: 'alpine:latest',
    Cmd: ['sleep', '3600'],
    Labels: {
      'dev.zukhruf.testing.shared': '1',
      'dev.zukhruf.testing.probe': randomUUID(),
    },
  });
  await created.start();
  return created.id;
}

test(
  'a shared server of another @zukhruf/testing version is removed when a run that used Docker ends',
  { timeout: 300_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-another-version-',
    );
    const ids: string[] = [];
    try {
      const { another } = await reusedByTwoVersions(t, directory.path, ids);

      assert.equal(await exists(another), false);
    } finally {
      for (const id of ids) await removeContainer(id).catch(() => {});
    }
  },
);

test(
  'a shared server of this version is kept',
  { timeout: 300_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-this-version-',
    );
    const ids: string[] = [];
    try {
      const { current } = await reusedByTwoVersions(t, directory.path, ids);

      assert.equal(await running(current), true);
    } finally {
      for (const id of ids) await removeContainer(id).catch(() => {});
    }
  },
);

test(
  'a shared server with no version label is removed',
  { timeout: 180_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-unversioned-',
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(file, smallWorkerSource(statePath, ''));
    const server = await unversionedServer();
    // Not a shared server: the sweep must not select it.
    const other = await docker.containers.create({
      Image: 'alpine:latest',
      Cmd: ['sleep', '3600'],
      Labels: { 'dev.zukhruf.testing.probe': randomUUID() },
    });
    let state: SmallState | undefined;
    try {
      await spawn(process.execPath, runnerArgs(file), {
        env: runEnvironment(join(directory.path, 'state')),
        timeout: 150_000,
      });
      state = await readState<SmallState>(t, statePath);

      assert.equal(await exists(server), false);
      assert.equal(await exists(other.id), true);
    } finally {
      await removeContainer(server).catch(() => {});
      await removeContainer(other.id).catch(() => {});
      if (state) await removeContainer(state.id).catch(() => {});
    }
  },
);
