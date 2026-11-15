import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { hash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
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
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import spawn, { SubprocessError } from 'nano-spawn';

import {
  BindSourceNotFoundError,
  ContainerNotFoundError,
  Docker,
} from '@zukhruf/docker';

import { EngineLease } from '../docker/engine-lease.ts';
import { DockerTestbed } from '../docker/index.ts';
import {
  REAPER_DEFAULTS,
  REAPER_IMAGE,
  reaperName,
  reaperRequest,
} from '../docker/reaper.ts';
import { RunRecords } from '../docker/run-records.ts';
import {
  type TemporaryDirectory,
  TemporaryFiles,
} from '../fs/temporary-files.ts';
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

/**
 * Resolves when `check` passes: the reaper of a run acts about 2 s after the
 * last test process of the run ended (ADR 0020).
 */
const reaped = (t: TestContext, check: () => Promise<void>): Promise<void> =>
  t.waitFor(check, { timeout: 30_000, interval: 100 });

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
    try {
      for (const entry of await readdir(directory.path, { recursive: true })) {
        if (
          !/(^|\/)zukhruf-testing\/docker-runs\/[^/]+\/run\.json$/.test(entry)
        )
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
            await removeContainer(Id).catch(() => {});
        for (const { Name } of await docker.volumes.list({
          filters: { label: [label] },
        }))
          await removeVolume(Name).catch(() => {});
      }
    } finally {
      await directory.cleanup();
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
        });
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
        const root = join(
          directory.path,
          'state',
          'zukhruf-testing',
          'docker-runs',
        );
        // The teardown keeps the records of a run that used the engine. The
        // proxy is gone, so no later run reaches this one's engine.
        if (proxy) assert.deepEqual(await recordedRuns(root), [state.run]);
        // Every recorded process has ended, so once the run's reaper ended,
        // the next run leaves nothing of it, not even a recovery's claim.
        else
          assert.deepEqual(
            await afterReapers(root, () => emptyRun(file, env)),
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
  'a create that the engine finishes after its test process was killed and after the first pass of the reaper is removed by a re-check pass, with no later run',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-late-create-');
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
    // The second create: the first one is the create of the run's reaper.
    let creates = 0;
    proxy.intercept('POST', '/containers/create', () => {
      creates += 1;
      if (creates === 2) return gate.promise;
    });
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { DockerTestbed } from ${library};
      test('a slow create', { timeout: 5000 }, async () => {
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ run: process.env.ZUKHRUF_TESTING_RUN_ID, record: process.env.ZUKHRUF_TESTING_RUN_DIR, pid: process.pid }));
        await new DockerTestbed({ environment: process.env }).start({ Image: 'alpine:latest', Cmd: ['sleep', '600'] });
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
      const state = await readState<Omit<SmallState, 'id'>>(t, statePath);
      run = state.run;
      const label = `dev.zukhruf.testing.run=${state.run}`;
      // After the grace of 2 s and the first pass, before the last re-check pass.
      await setTimeout(3_000);

      gate.resolve();

      await t.waitFor(
        async () => assert.notDeepEqual(await labelled(label), []),
        { timeout: 10_000, interval: 50 },
      );
      await reaped(t, async () => assert.deepEqual(await labelled(label), []));
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

test('recovery leaves a dead runner’s run alone while one of its test processes lives', async (t) => {
  await using directory = await runsDirectory('zukhruf-testing-orphan-');
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
    if (worker !== undefined && alive(worker)) process.kill(worker, 'SIGKILL');
    if (state) await removeContainer(state.id).catch(() => {});
  }
});

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
      timeout: 10_000,
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

/** Both runners succeeded, and nothing of the killed run is left once its reaper ran. */
async function assertRecovered(
  t: TestContext,
  results: PromiseSettledResult<unknown>[],
  state: State,
  root: string,
  recover: () => Promise<unknown>,
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
  await reaped(t, async () => {
    for (const id of [state.id, state.general])
      assert.equal(await exists(id), false);
    assert.equal(await volumeExists(state.volume), false);
  });
  assert.deepEqual(await afterReapers(root, recover), []);
}

test(
  'two runs that start together recover a dead run, and both succeed',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-recovery-');
    await using proxy = await EngineProxy.start(engine);
    const { state, recover, root } = await killedRun(t, directory.path, proxy);
    // The first create of a reaper passes; every later one waits two
    // seconds, so a second runner inside the same dead run's recovery runs
    // after the first one has finished it.
    const recovering = proxy.requests.length;
    proxy.intercept('POST', '/containers/create', async () => {
      const creates = proxy.requests
        .slice(recovering)
        .filter(
          ({ method, path }) =>
            method === 'POST' && path === '/containers/create',
        );
      if (creates.length > 1) await setTimeout(2_000);
    });
    try {
      const results = await Promise.allSettled([recover(), recover()]);

      await assertRecovered(t, results, state, root, recover);
    } finally {
      await removeLeftovers(state);
    }
  },
);

test(
  'a run that starts while another recovers a dead run leaves the run to it',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-recovery-');
    await using proxy = await EngineProxy.start(engine);
    const { state, recover, root } = await killedRun(t, directory.path, proxy);
    // Each create of a reaper marks that a recovery has claimed its run and
    // starts its reaper, and takes two seconds, so the second runner starts
    // while the first one is still inside the dead run's recovery.
    const marker = join(directory.path, 'recovering');
    proxy.intercept('POST', '/containers/create', async () => {
      await writeFile(marker, '');
      await setTimeout(2_000);
    });
    try {
      const first = recover();
      await t.waitFor(() => access(marker), { interval: 50, timeout: 30_000 });
      const results = await Promise.allSettled([first, recover()]);

      await assertRecovered(t, results, state, root, recover);
    } finally {
      await removeLeftovers(state);
    }
  },
);

test('recovery keeps a dead run while a command lives whose pid an ended command of the run had', async () => {
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
  await new RunRecords(record).recordProcess(await endedPid());
  const file = join(directory.path, 'plain.test.ts');
  await writeFile(
    file,
    "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
  );

  await emptyRun(file, runEnvironment(join(directory.path, 'state')));

  await access(join(record, 'run.json'));
});

/** The ids of the runs whose records are in `root`, also under a recovery's claim. */
async function recordedRuns(root: string): Promise<string[]> {
  return Promise.all(
    (await readdir(root)).map(async (name) => {
      const { id }: { id: string } = JSON.parse(
        await readFile(join(root, name, 'run.json'), 'utf8'),
      );
      return id;
    }),
  );
}

/** Resolves when the engine removed the reaper of `run`, or has none. */
async function reaperGone(run: string): Promise<void> {
  try {
    await (
      await docker.containers.find(reaperName(run))
    )?.wait({
      condition: 'removed',
    });
  } catch (error) {
    if (!(error instanceof ContainerNotFoundError)) throw error;
  }
}

/**
 * The records left in `root` after `next`, a later run, once the reaper of
 * each recorded run ended: a recovery deletes the records of a run only when
 * its reaper is gone and left nothing (ADR 0020, item 9).
 */
async function afterReapers(
  root: string,
  next: () => Promise<unknown>,
): Promise<string[]> {
  for (const run of await recordedRuns(root)) await reaperGone(run);
  await next();
  return readdir(root);
}

/** Whether the shared Postgres server `server` has the database `name`. */
async function hasDatabase(server: string, name: string): Promise<boolean> {
  const container = await docker.containers.find(server);
  assert.ok(container);
  const { exitCode, stdout, output } = await container.exec({
    Cmd: [
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-Atc',
      `SELECT COUNT(*) FROM pg_database WHERE datname = '${name}'`,
    ],
  });
  assert.equal(exitCode, 0, output);
  return stdout.trim() === '1';
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
        await ReaperHold.take(docker, ${JSON.stringify(run)}, REAPER_DEFAULTS, globalThis);
        console.log('held');
        setInterval(() => {}, 60_000);
      `,
    ],
    process.env,
  );
  await t.waitFor(() => assert.match(holding.output(), /^held$/m), {
    timeout: 60_000,
    interval: 50,
  });
  return holding;
}

/** What a worker created in a run: a container, a volume, and a database on a shared server. */
interface DatabaseState {
  container: string;
  volume: string;
  database: string;
  server: string;
  run: string;
}

/** Waits until the file `go` exists, as source text for a worker. */
const untilGo = (go: string) =>
  `while (!(await import('node:fs')).existsSync(${JSON.stringify(go)})) await setTimeout(50);`;

for (const objects of [true, false])
  test(
    objects
      ? 'a run whose reaper was killed before it acted is cleaned by the next run’s recovery: its container, volume and database go, and then its records'
      : 'a run whose reaper was killed before it acted, and that left only a database, is cleaned by the next run’s recovery: the database goes, and then its records',
    { timeout: 400_000 },
    async (t) => {
      await using directory = await runsDirectory(
        'zukhruf-testing-killed-reaper-',
      );
      const scope = randomUUID();
      const verification = `dev.zukhruf.testing.verification=${scope}`;
      const statePath = join(directory.path, 'state.json');
      const go = join(directory.path, 'go');
      const file = join(directory.path, 'worker.test.ts');
      await writeFile(
        file,
        `
          import { test } from 'node:test';
          import { writeFile } from 'node:fs/promises';
          import { setTimeout } from 'node:timers/promises';
          import { DockerTestbed } from ${library};
          import { Postgres } from ${JSON.stringify(new URL('../databases/postgres.ts', import.meta.url).href)};
          test('what a run owns', { timeout: 300000 }, async () => {
            const docker = new DockerTestbed({ environment: process.env });
            const container = ${objects} ? (await docker.start({ Image: 'alpine:latest', Cmd: ['sleep', '600'] })).id : undefined;
            const volume = ${objects} ? (await docker.volume()).name : undefined;
            const { database, containerId } = await new Postgres({ environment: process.env, labels: { 'dev.zukhruf.testing.verification': ${JSON.stringify(scope)} } }).database();
            await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container, volume, database, server: containerId, run: process.env.ZUKHRUF_TESTING_RUN_ID }));
            ${untilGo(go)}
          });
        `,
      );
      const env = runEnvironment(join(directory.path, 'state'));
      const root = join(
        directory.path,
        'state',
        'zukhruf-testing',
        'docker-runs',
      );
      const run = started(runnerArgs(file), env);
      let state: Partial<DatabaseState> | undefined;
      try {
        state = await readState<Partial<DatabaseState>>(t, statePath);
        const { container, volume, database, server, run: id } = state;
        assert.ok(database && server && id);
        // A frozen reaper does no pass: it is killed before it acted, as at
        // a restart of the engine or an out-of-memory kill.
        const reaper = await docker.containers.find(reaperName(id));
        assert.ok(reaper);
        await reaper.pause();
        await writeFile(go, '');
        assert.equal(await run.exited, 0, run.output());
        await reaper.remove({ force: true });
        await reaperGone(id);
        if (container) assert.equal(await exists(container), true);
        if (volume) assert.equal(await volumeExists(volume), true);
        assert.equal(await hasDatabase(server, database), true);

        await emptyRun(file, env);

        await reaped(t, async () => {
          if (container) assert.equal(await exists(container), false);
          if (volume) assert.equal(await volumeExists(volume), false);
          assert.equal(await hasDatabase(server, database), false);
        });
        assert.deepEqual(
          await afterReapers(root, () => emptyRun(file, env)),
          [],
        );
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null)
          run.child.kill('SIGKILL');
        await run.exited.catch(() => null);
        for (const id of await labelled(verification))
          await removeContainer(id).catch(() => {});
        if (state?.container)
          await removeContainer(state.container).catch(() => {});
        if (state?.volume) await removeVolume(state.volume).catch(() => {});
      }
    },
  );

test(
  'a run whose reaper finished keeps its records until the next run’s recovery, which deletes them and changes nothing on the engine',
  { skip: proxyless },
  async (t) => {
    await using directory = await runsDirectory('zukhruf-testing-reaper-done-');
    await using proxy = await EngineProxy.start(engine);
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(file, smallWorkerSource(statePath, ''));
    const env = proxiedEnvironment(join(directory.path, 'state'), proxy);
    const root = join(
      directory.path,
      'state',
      'zukhruf-testing',
      'docker-runs',
    );
    let state: SmallState | undefined;
    try {
      await spawn(process.execPath, runnerArgs(file), {
        env,
        timeout: 150_000,
      });
      state = await readState<SmallState>(t, statePath);
      // The teardown cannot know that the reaper acted: it keeps the records.
      assert.deepEqual(await recordedRuns(root), [state.run]);
      await reaperGone(state.run);
      assert.equal(await exists(state.id), false);
      const from = proxy.requests.length;

      await emptyRun(file, env);

      assert.deepEqual(await readdir(root), []);
      // Reads only: inspects, lists, and the lists in the shared servers.
      assert.deepEqual(
        proxy.requests
          .slice(from)
          .filter(
            ({ method, path }) =>
              method !== 'GET' &&
              method !== 'HEAD' &&
              !/^\/containers\/[^/]+\/exec$|^\/exec\/[^/]+\/start$/.test(path),
          ),
        [],
      );
    } finally {
      if (state) await removeContainer(state.id).catch(() => {});
    }
  },
);

test('a dead run whose reaper still runs keeps its records at the next run’s recovery, which leaves the reaper alone, also when the run has nothing else left', async (t) => {
  await using directory = await runsDirectory('zukhruf-testing-reaper-runs-');
  const statePath = join(directory.path, 'state.json');
  const go = join(directory.path, 'go');
  const file = join(directory.path, 'worker.test.ts');
  // The process holds the run's reaper through defaults() and creates
  // nothing: only the reaper is of the run.
  await writeFile(
    file,
    `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      import { DockerTestbed } from ${library};
      test('a hold', { timeout: 150000 }, async () => {
        await new DockerTestbed({ environment: process.env }).defaults();
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ run: process.env.ZUKHRUF_TESTING_RUN_ID }));
        ${untilGo(go)}
      });
    `,
  );
  const env = runEnvironment(join(directory.path, 'state'));
  const root = join(directory.path, 'state', 'zukhruf-testing', 'docker-runs');
  const run = started(runnerArgs(file), env);
  let holding: ReturnType<typeof started> | undefined;
  try {
    const state = await readState<{ run: string }>(t, statePath);
    // A holder that is not a process of the run's records, such as a
    // process of the run on another machine.
    holding = await reaperHolder(t, state.run);
    await writeFile(go, '');
    assert.equal(await run.exited, 0, run.output());
    const reaper = await docker.containers.find(reaperName(state.run));
    assert.ok(reaper);

    await emptyRun(file, env);

    assert.deepEqual(await recordedRuns(root), [state.run]);
    assert.equal(await running(reaper.id), true);
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null)
      run.child.kill('SIGKILL');
    await run.exited.catch(() => null);
    holding?.child.kill('SIGKILL');
    await holding?.exited.catch(() => null);
  }
});

test('a reaper of another run that was left created, with no records, is started by the reaper of the next run on its engine, and its run’s objects go; a younger created reaper, and a running reaper of another run with its objects, stay', async (t) => {
  await using directory = await runsDirectory(
    'zukhruf-testing-created-reaper-',
  );
  const stale = randomUUID();
  const live = randomUUID();
  if ((await docker.images.inspect(REAPER_IMAGE)) === undefined)
    await docker.images.pull(REAPER_IMAGE);
  await using objects = new AsyncDisposableStack();
  const owned = async (run: string) => {
    const container = await docker.containers.create({
      Image: 'alpine:latest',
      Cmd: ['sleep', '600'],
      Labels: { 'dev.zukhruf.testing.run': run },
    });
    objects.defer(() => removeContainer(container.id).catch(() => {}));
    await container.start();
    const { name } = await docker.volumes.create({
      Labels: { 'dev.zukhruf.testing.run': run },
    });
    objects.defer(() => removeVolume(name).catch(() => {}));
    return { container: container.id, volume: name };
  };
  const staleObjects = await owned(stale);
  const liveObjects = await owned(live);
  // The reaper of a process that was killed between its create and its
  // start: no operation of the package leaves one, so the test creates it.
  const created = await docker.containers.create(
    reaperRequest(stale, {
      ...REAPER_DEFAULTS,
      grace: 300,
      interval: 200,
      passes: 1,
      // Its window to be started is twice this: 4 s, less than the run below takes.
      requestTimeout: 2_000,
      firstHolder: 0,
    }),
    { name: reaperName(stale) },
  );
  objects.defer(() => removeContainer(created.id).catch(() => {}));
  // A reaper whose creator may still start it: its window is 2 h.
  const young = randomUUID();
  const waiting = await docker.containers.create(
    reaperRequest(young, { ...REAPER_DEFAULTS, requestTimeout: 3_600_000 }),
    { name: reaperName(young) },
  );
  objects.defer(() => removeContainer(waiting.id).catch(() => {}));
  const holding = await reaperHolder(t, live);
  objects.defer(async () => {
    holding.child.kill('SIGKILL');
    await holding.exited.catch(() => null);
  });
  const liveReaper = await docker.containers.find(reaperName(live));
  assert.ok(liveReaper);
  objects.defer(() => removeContainer(liveReaper.id).catch(() => {}));
  const statePath = join(directory.path, 'state.json');
  const file = join(directory.path, 'worker.test.ts');
  await writeFile(file, smallWorkerSource(statePath, ''));

  await spawn(process.execPath, runnerArgs(file), {
    env: runEnvironment(join(directory.path, 'state')),
    timeout: 150_000,
  });

  await t.waitFor(
    async () => {
      assert.equal(await exists(created.id), false);
      assert.equal(await exists(staleObjects.container), false);
      assert.equal(await volumeExists(staleObjects.volume), false);
    },
    { timeout: 60_000, interval: 200 },
  );
  assert.equal((await waiting.inspect()).State?.Status, 'created');
  assert.equal(await running(liveReaper.id), true);
  assert.equal(await running(liveObjects.container), true);
  assert.equal(await volumeExists(liveObjects.volume), true);
});

/** What a worker created that only labels tie to its run, and a shared server. */
interface LabelState {
  container: string;
  volume: string;
  shared: string;
}

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
  let state: LabelState | undefined;
  try {
    await spawn(process.execPath, runnerArgs(file), {
      env: runEnvironment(join(directory.path, 'state')),
      timeout: 150_000,
    });
    state = await readState<LabelState>(t, statePath);

    await reaped(t, async () => {
      assert.equal(await exists(state?.container ?? ''), false);
      assert.equal(await volumeExists(state?.volume ?? ''), false);
    });
    assert.equal(await running(state.shared), true);
  } finally {
    for (const id of await labelled(verification))
      await removeContainer(id).catch(() => {});
    if (state) {
      await removeContainer(state.container).catch(() => {});
      await removeVolume(state.volume).catch(() => {});
    }
  }
});

test('the reaper removes a container and a volume of a test process that only read docker.defaults(), when its run ends', async (t) => {
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
        const { Labels: labels } = await new DockerTestbed({ environment: process.env }).defaults();
        await using other = await Docker.connect({ clock: globalThis, environment: process.env });
        const created = await other.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '600'], Labels: labels });
        await created.start();
        const { name: volume } = await other.volumes.create({ Labels: labels });
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container: created.id, volume }));
      });
    `,
  );
  let state: Omit<LabelState, 'shared'> | undefined;
  const stateHome = join(directory.path, 'state');
  try {
    await spawn(process.execPath, runnerArgs(file), {
      env: runEnvironment(stateHome),
      timeout: 150_000,
    });
    state = await readState<Omit<LabelState, 'shared'>>(t, statePath);

    const ended = state;
    await reaped(t, async () => {
      assert.equal(await exists(ended.container), false);
      assert.equal(await volumeExists(ended.volume), false);
    });
    assert.deepEqual(
      await afterReapers(
        join(stateHome, 'zukhruf-testing', 'docker-runs'),
        () => emptyRun(file, runEnvironment(stateHome)),
      ),
      [],
    );
  } finally {
    if (state) {
      await removeContainer(state.container).catch(() => {});
      await removeVolume(state.volume).catch(() => {});
    }
  }
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
  try {
    await spawn(
      process.execPath,
      ['--test', `--test-global-setup=${setupFile}`, file],
      { env: runEnvironment(stateHome), timeout: 150_000 },
    );
    state = await readState<{ container: string }>(t, statePath);

    const { container } = state;
    await reaped(t, async () => assert.equal(await exists(container), false));
    assert.deepEqual(
      await afterReapers(
        join(stateHome, 'zukhruf-testing', 'docker-runs'),
        () => emptyRun(file, runEnvironment(stateHome)),
      ),
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
});

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
  await t.waitFor(
    async () => assert.deepEqual(await processLeases(fingerprint), []),
    { timeout: 20_000, interval: 100 },
  );
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The expiry pass of a reaper of a new run, as the reaper of a run that used
 * Docker does at its end, as if it ran `ahead` ms later: the TTL of the
 * reaper is that much shorter (ADR 0020, item 4). It ends when the reaper is
 * gone.
 */
const sweepSource = (endpoint: string, ahead: number, settings: string) => `
  import { randomUUID } from 'node:crypto';
  import { ContainerNotFoundError, Docker } from ${client};
  import { REAPER_DEFAULTS, reaperName, startReaper } from ${JSON.stringify(new URL('../docker/reaper.ts', import.meta.url).href)};
  const run = randomUUID();
  await using docker = await Docker.connect({ clock: globalThis, host: ${JSON.stringify(endpoint)} });
  await startReaper(docker, run, { ...REAPER_DEFAULTS, grace: 0, passes: 0, serverTtl: Math.max(1, REAPER_DEFAULTS.serverTtl - ${ahead}), ...${settings} });
  await (await docker.containers.find(reaperName(run)))?.wait({ condition: 'removed' }).catch((error) => {
    if (!(error instanceof ContainerNotFoundError)) throw error;
  });
`;

/** The process of a sweep, `ahead` ms later, on the engine at `endpoint`. */
async function sweeper(
  directory: string,
  endpoint: string,
  ahead: number,
  settings = '{}',
) {
  const file = join(directory, `sweep-${randomUUID()}.ts`);
  await writeFile(file, sweepSource(endpoint, ahead, settings));
  // The reaper reads the age of a server in whole seconds: a server that a
  // test just created is 0 s old, younger than any TTL.
  await setTimeout(1_100);
  return started([file], process.env);
}

/**
 * Runs a sweep eight days later, one day after the TTL of each shared server
 * on the engine at `endpoint`, and resolves when it ends successfully. `signal` kills it with SIGKILL.
 */
async function sweep(
  directory: string,
  endpoint: string,
  signal?: AbortSignal,
  settings?: string,
): Promise<void> {
  const { child, exited, output } = await sweeper(
    directory,
    endpoint,
    8 * DAY,
    settings,
  );
  const kill = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', kill);
  try {
    const code = await exited;
    if (code !== 0) throw new Error(`The sweep failed (${code}):\n${output()}`);
  } finally {
    signal?.removeEventListener('abort', kill);
  }
}

/**
 * A process of the docker area at `library` reuses a shared server and exits.
 * Gives the server's id. A process that does not exit by the deadline of
 * `firstOf` fails the test, and is killed.
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
    const reuse = spawn(process.execPath, [file], {
      env,
      signal: stop.signal,
      killSignal: 'SIGKILL',
    });
    reuse.catch(() => {});
    assert.equal(
      await firstOf(new Promise<void>(() => {}), reuse),
      'ended',
      'the process must reuse the server and exit',
    );
  } finally {
    stop.abort();
  }
  return (await readState<{ id: string }>(t, statePath)).id;
}

test('two processes that send the same request get one server, whatever their version', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-one-request-',
  );
  const probe = randomUUID();
  const env = runEnvironment(join(directory.path, 'state'));
  const ids: string[] = [];
  try {
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
  } finally {
    for (const id of ids) await removeContainer(id).catch(() => {});
  }
});

test('a server older than the TTL with no process lease is removed when a run that used Docker ends', async (t) => {
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
  try {
    const server = await reusedAndExited(
      t,
      directory.path,
      JSON.parse(library),
      randomUUID(),
      env,
    );
    ids.push(server);
    await unleased(t, await fingerprintOf(server));
    // Six days later, the server is younger than its TTL.
    const early = await sweeper(directory.path, engine, 6 * DAY);
    assert.equal(await early.exited, 0, early.output());
    const keptEarly = await exists(server);

    await sweep(directory.path, engine);

    assert.equal(keptEarly, true);
    assert.equal(await exists(server), false);
    assert.equal(await exists(container.id), true);
    assert.equal(await exists(older.id), true);
  } finally {
    other.child.kill('SIGKILL');
    await other.exited;
    for (const id of ids) await removeContainer(id).catch(() => {});
  }
});

test('a server younger than the TTL is kept', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-young-',
  );
  const env = runEnvironment(join(directory.path, 'state'));
  const ids: string[] = [];
  try {
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

    await spawn(process.execPath, runnerArgs(file), { env, timeout: 150_000 });
    ids.push((await readState<SmallState>(t, statePath)).id);

    assert.equal(await running(server), true);
  } finally {
    for (const id of ids) await removeContainer(id).catch(() => {});
  }
});

test('a server older than the TTL with a live process lease is kept, for each server that the process uses', async (t) => {
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
  try {
    servers = await readState<string[]>(t, statePath);

    await sweep(directory.path, engine);

    for (const server of servers) assert.equal(await running(server), true);
  } finally {
    child.kill('SIGKILL');
    await exited;
    for (const server of servers) await removeContainer(server).catch(() => {});
  }
});

test(
  'a server older than the TTL whose holder was killed is removed',
  { skip: signals },
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
    try {
      other.child.kill('SIGKILL');
      await other.exited;
      await unleased(t, await fingerprintOf(other.id));

      await sweep(directory.path, engine);

      assert.equal(await exists(other.id), false);
    } finally {
      other.child.kill('SIGKILL');
      await removeContainer(other.id).catch(() => {});
    }
  },
);

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

/**
 * Which comes first: `event`, the end of `run`, or a deadline. A sweep gets
 * to its sweep leases in a few seconds, and waits at most 30 s for a taken
 * sweep lease; the deadline is above both and far below the timeout of each
 * test, so a test whose event never comes fails and disposes of what it
 * started. A run that fails rejects with its error.
 */
async function firstOf(
  event: Promise<void>,
  run: Promise<unknown>,
): Promise<'reached' | 'ended' | 'deadline'> {
  const deadline = new AbortController();
  try {
    return await Promise.race([
      event.then(() => 'reached' as const),
      run.then(() => 'ended' as const),
      setTimeout(45_000, 'deadline' as const, { signal: deadline.signal }),
    ]);
  } finally {
    deadline.abort();
  }
}

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
    try {
      const fingerprint = await fingerprintOf(other.id);
      assert.equal((await processLeases(fingerprint)).length, 1);

      other.child.kill('SIGKILL');
      await other.exited;

      await unleased(t, fingerprint);
    } finally {
      other.child.kill('SIGKILL');
      await removeContainer(other.id).catch(() => {});
    }
  },
);

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
 * this process that forwards to the proxy. Its expiry pass removes each
 * shared server older than 1 ms. Gives its exit code once the engine
 * removed it.
 */
async function proxiedReaper(
  stack: AsyncDisposableStack,
  proxy: EngineProxy,
): Promise<{ exited: Promise<number> }> {
  // Docker Desktop resolves host.docker.internal to this machine for each
  // container. On a native Linux engine the reaper reaches this machine at
  // the gateway of the default bridge, through the host-gateway entry: the
  // relay listens there, never on every address, because an engine proxy
  // that the LAN reaches is root on the machine.
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
  if ((await docker.images.inspect(REAPER_IMAGE)) === undefined)
    await docker.images.pull(REAPER_IMAGE);
  const run = randomUUID();
  const body = reaperRequest(run, {
    ...REAPER_DEFAULTS,
    grace: 0,
    passes: 0,
    firstHolder: 0,
    serverTtl: 1,
  });
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
    await (
      await docker.containers.find(reaper.id)
    )
      ?.remove({ force: true })
      .catch(() => {});
  });
  const exited = reaper
    .wait({ condition: 'removed' })
    .then(({ StatusCode }) => StatusCode);
  exited.catch(() => {});
  // The reaper reads the age of a server in whole seconds.
  await setTimeout(1_100);
  await reaper.start();
  return { exited };
}

/**
 * Holds the look of a reaper through `proxy` for the process leases of
 * `fingerprint`: the first list after the start of the sweep lease of that
 * server through the proxy.
 */
function sweepHold(proxy: EngineProxy, fingerprint: string) {
  const starts: string[] = [];
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  proxy.intercept('POST', /^\/containers\/[^/]+\/start$/, async ({ path }) => {
    const id = path.split('/')[2] ?? '';
    const name = (await (await docker.containers.find(id))?.inspect())?.Name;
    if (name === `/${sweepLease(fingerprint)}`) starts.push(id);
  });
  let holding = false;
  proxy.intercept('GET', '/containers/json', async () => {
    if (holding) return;
    const lease = await docker.containers.find(sweepLease(fingerprint));
    if (lease === undefined || !starts.includes(lease.id)) return;
    holding = true;
    held.resolve();
    await release.promise;
  });
  return { held: held.promise, release: () => release.resolve() };
}

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
    let other: Awaited<ReturnType<typeof holder>> | undefined;
    try {
      await ended(t, keeper, fingerprint);
      const proxy = stack.use(await EngineProxy.start(engine));
      const listing = sweepHold(proxy, fingerprint);
      stack.defer(() => listing.release());
      const { exited } = await proxiedReaper(stack, proxy);
      assert.equal(
        await firstOf(listing.held, exited),
        'reached',
        'the reaper must hold the sweep lease of the server',
      );
      const holding = holder(t, directory.path, probe, env);
      holding.catch(() => {});
      await t.waitFor(
        async () => assert.equal((await processLeases(fingerprint)).length, 1),
        { timeout: 60_000, interval: 100 },
      );

      listing.release();
      other = await holding;

      assert.equal(await exited, 0);
      assert.equal(other.id, server);
      assert.equal(await running(server), true);
    } finally {
      keeper.child.kill('SIGKILL');
      other?.child.kill('SIGKILL');
      await removeContainer(server).catch(() => {});
    }
  },
);

test(
  'a reaper whose removal of an expired shared server fails keeps that server and ends with exit code 0',
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
    try {
      await ended(t, other, await fingerprintOf(server));
      const proxy = stack.use(await EngineProxy.start(engine));
      proxy.intercept('DELETE', `/containers/${server}`, () => {
        throw new Error('The engine refuses this removal.');
      });

      const { exited } = await proxiedReaper(stack, proxy);

      assert.equal(await exited, 0);
      assert.ok(
        proxy.requests.some(
          ({ method, path }) =>
            method === 'DELETE' && path === `/containers/${server}`,
        ),
      );
      assert.equal(await running(server), true);
    } finally {
      other.child.kill('SIGKILL');
      await removeContainer(server).catch(() => {});
    }
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
  let waiting: ReturnType<typeof started> | undefined;
  let lease: EngineLease | undefined;
  try {
    await ended(t, other, fingerprint);
    // A reaper that found no process lease of the server, and removes it.
    lease = await sweepLeaseOf(fingerprint);
    await removeContainer(server);
    waiting = started([file], env);
    await t.waitFor(
      async () => assert.equal((await processLeases(fingerprint)).length, 1),
      { timeout: 60_000, interval: 100 },
    );
    // Without the wait, the process gets the server in well under 5 s.
    await setTimeout(5_000);
    const proceededBeforeRelease = existsSync(statePath);

    await lease[Symbol.asyncDispose]();
    lease = undefined;
    const { id } = await readState<{ id: string }>(t, statePath);
    ids.push(id);

    assert.equal(proceededBeforeRelease, false, waiting.output());
    assert.notEqual(id, server);
    assert.equal(await running(id), true);
  } finally {
    await lease?.[Symbol.asyncDispose]();
    other.child.kill('SIGKILL');
    waiting?.child.kill('SIGKILL');
    for (const id of ids) await removeContainer(id).catch(() => {});
  }
});

test('two reapers that sweep one expired server at once both end, and the server is removed', async (t) => {
  await using directory = await runsDirectory('zukhruf-testing-two-sweeps-');
  const other = await holder(
    t,
    directory.path,
    randomUUID(),
    runEnvironment(join(directory.path, 'state')),
  );
  const server = other.id;
  const fingerprint = await fingerprintOf(server);
  try {
    await ended(t, other, fingerprint);

    await Promise.all([
      sweep(directory.path, engine),
      sweep(directory.path, engine),
    ]);

    assert.equal(await exists(server), false);
    assert.equal(await exists(sweepLease(fingerprint)), false);
  } finally {
    other.child.kill('SIGKILL');
    await removeContainer(server).catch(() => {});
  }
});

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
    try {
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
    } finally {
      other.child.kill('SIGKILL');
      await other.exited;
      await (
        await docker.containers.find(sweepLease(fingerprint))
      )
        ?.remove({ force: true })
        .catch(() => {});
      for (const id of ids) await removeContainer(id).catch(() => {});
    }
  },
);

test('a sweep lease that a killed sweep left created does not stop the next sweep from removing its server', async (t) => {
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
  try {
    await killedSweep(fingerprint);
    const stale = await docker.containers.find(sweepLease(fingerprint));
    assert.ok(stale);
    await ended(t, other, fingerprint);

    await sweep(directory.path, engine, undefined, '{ leasePatience: 500 }');

    assert.equal(await exists(server), false);
    assert.equal(
      await docker.containers.find(sweepLease(fingerprint)),
      undefined,
    );
  } finally {
    other.child.kill('SIGKILL');
    await other.exited;
    await (
      await docker.containers.find(sweepLease(fingerprint))
    )
      ?.remove({ force: true })
      .catch(() => {});
    await removeContainer(server).catch(() => {});
  }
});

test('a reaper that finds another sweep of the same server running for longer than it waits keeps that server and ends', async (t) => {
  await using directory = await runsDirectory('zukhruf-testing-long-sweep-');
  const other = await holder(
    t,
    directory.path,
    randomUUID(),
    runEnvironment(join(directory.path, 'state')),
  );
  const server = other.id;
  const fingerprint = await fingerprintOf(server);
  let lease: EngineLease | undefined;
  try {
    await ended(t, other, fingerprint);
    lease = await sweepLeaseOf(fingerprint);

    await sweep(
      directory.path,
      engine,
      undefined,
      '{ sweepWait: 2000, leasePatience: 500 }',
    );

    assert.equal(await running(server), true);
  } finally {
    await lease?.[Symbol.asyncDispose]();
    other.child.kill('SIGKILL');
    await removeContainer(server).catch(() => {});
  }
});

test('a sweep lease that ended and was not removed does not stop the next sweep from removing its server', async (t) => {
  await using directory = await runsDirectory('zukhruf-testing-ended-sweep-');
  const other = await holder(
    t,
    directory.path,
    randomUUID(),
    runEnvironment(join(directory.path, 'state')),
  );
  const server = other.id;
  const fingerprint = await fingerprintOf(server);
  try {
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
    await t.waitFor(
      async () => assert.equal((await stale.inspect()).State?.Status, 'exited'),
      { timeout: 20_000, interval: 100 },
    );

    await sweep(directory.path, engine);

    assert.equal(await exists(server), false);
    assert.equal(await exists(stale.id), false);
  } finally {
    other.child.kill('SIGKILL');
    await removeContainer(sweepLease(fingerprint)).catch(() => {});
    await removeContainer(server).catch(() => {});
  }
});
