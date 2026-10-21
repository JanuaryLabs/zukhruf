import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import spawn, { SubprocessError } from 'nano-spawn';

import { Docker, TestRun } from '../docker/index.ts';

const docker = new Docker();
const standIn =
  process.platform === 'win32'
    ? 'the Docker CLI stand-in is a POSIX shell script'
    : false;
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
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
  import { readFile, readdir, writeFile } from 'node:fs/promises';
  import { setTimeout } from 'node:timers/promises';
  import { Docker, TestRun } from ${library};
  test('disposable resources before interruption', { timeout: ${timeout} }, async () => {
    const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
    const container = await docker.serve({ image: 'postgres:18-alpine', internalPort: 5432, env: { POSTGRES_PASSWORD: 'test' } });
    const general = await docker.start({ image: 'postgres:18-alpine', command: ['sleep', '600'] });
    const fixture = await docker.directory();
    await fixture.writeFile('sentinel.txt', 'owned');
    const volume = await docker.volume();
    const anonymous = async (id) => JSON.parse((await docker.command(['inspect', id])).stdout)[0].Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name);
    const anonymousVolumes = await anonymous(container.containerId);
    const generalVolumes = await anonymous(general.containerId);
    const directory = process.env.ZUKHRUF_TESTING_RUN_DIR;
    const forwards = await Promise.all((await readdir(directory)).filter(name => name.startsWith('forward-')).map(async name => JSON.parse(await readFile(directory + '/' + name, 'utf8')).path));
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.containerId, general: general.containerId, path: fixture.path, volume: volume.name, anonymousVolumes, generalVolumes, forwards, run: process.env.ZUKHRUF_TESTING_RUN_ID, record: directory, pid: process.pid }));
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
  import { Docker, TestRun } from ${library};
  test('one container', { timeout: 150000 }, async () => {
    const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
    const container = await docker.start({ image: 'alpine:latest', command: ['sleep', '600'] });
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.containerId, run: process.env.ZUKHRUF_TESTING_RUN_ID, record: process.env.ZUKHRUF_TESTING_RUN_DIR, pid: process.pid }));
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

const listed = async (args: string[]): Promise<string> =>
  (await docker.command(args)).stdout;

const exists = (id: string) => listed(['ps', '-aq', '--filter', `id=${id}`]);

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

/** The pids in a run's process records. */
async function recordedProcesses(record: string): Promise<number[]> {
  return (await readdir(record)).flatMap((name) => {
    const pid = /^process-(\d+)-[\da-f-]{36}\.json$/.exec(name)?.[1];
    return pid === undefined ? [] : [Number(pid)];
  });
}

async function removeLeftovers(state: State | undefined): Promise<void> {
  if (!state) return;
  for (const id of [state.id, state.general])
    await docker.command(['rm', '--force', '--volumes', id]).catch(() => {});
  for (const name of [
    state.volume,
    ...state.anonymousVolumes,
    ...state.generalVolumes,
  ])
    await docker.command(['volume', 'rm', '--force', name]).catch(() => {});
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
          ? standIn
          : mode === 'SIGINT' || mode === 'SIGTERM'
            ? signals
            : false,
      timeout: 180_000,
    },
    async (t) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-testing-cleanup-'),
      );
      // Another run's container and volume: the sweep must match the run id,
      // not only the label.
      const unrelated = new Docker({
        testRun: new TestRun(`unrelated-${randomUUID()}`, directory.path),
      });
      await using sentinel = await unrelated.start({
        image: 'alpine:latest',
        command: ['sleep', '600'],
      });
      await using sentinelVolume = await unrelated.volume();
      const statePath = join(directory.path, 'state.json');
      const file = join(directory.path, 'worker.test.ts');
      const disconnected = join(directory.path, 'disconnected');
      if (mode === 'recovery') {
        const { stdout: dockerPath } = await spawn('which', ['docker']);
        await writeFile(
          join(directory.path, 'docker'),
          `#!/bin/sh\nif [ -f ${quote(disconnected)} ]; then echo 'Cannot connect to Docker daemon (injected transport failure)' >&2; exit 1; fi\nexec ${quote(dockerPath)} "$@"\n`,
          { mode: 0o755 },
        );
      }
      await writeFile(
        file,
        workerSource(
          statePath,
          [
            mode === 'recovery'
              ? `await writeFile(${JSON.stringify(disconnected)}, 'offline');`
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
      const env = runEnvironment(
        join(directory.path, 'state'),
        mode === 'recovery'
          ? `${directory.path}:${process.env.PATH}`
          : process.env.PATH,
      );
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
        const code = await run.exited;
        if (mode === 'recovery') {
          // The test passed, so only the failed cleanup sets the exit code.
          assert.equal(code, 1, run.output());
          assert.match(run.output(), /retained ownership record/);
          const record = JSON.parse(
            await readFile(join(state.record, 'run.json'), 'utf8'),
          );
          assert.equal(record.endpoint, (await docker.info()).endpoint);
          assert.equal(
            await listed([
              'inspect',
              '--format',
              '{{.State.Running}}',
              state.id,
            ]),
            'true',
          );
          await rm(disconnected);
          await emptyRun(file, env);
        } else assert.notEqual(code, 0, run.output());
        for (const id of [state.id, state.general])
          assert.equal(await exists(id), '', run.output());
        for (const name of [
          state.volume,
          ...state.anonymousVolumes,
          ...state.generalVolumes,
        ]) {
          assert.equal(
            await listed(['volume', 'ls', '-q', '--filter', `name=^${name}$`]),
            '',
            `the run left volume ${name}: ${run.output()}`,
          );
        }
        for (const path of state.forwards) {
          await assert.rejects(readFile(join(path, 's')), { code: 'ENOENT' });
        }
        // Docker validates the remote path. This probe never creates the source.
        await assert.rejects(
          docker.command([
            'run',
            '--rm',
            '--mount',
            `type=bind,src=${state.path},dst=/fixture`,
            'alpine:latest',
            'true',
          ]),
          (error) =>
            error instanceof SubprocessError &&
            /bind source path does not exist/.test(error.stderr),
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
        assert.equal(
          await listed([
            'inspect',
            '--format',
            '{{.State.Running}}',
            sentinel.containerId,
          ]),
          'true',
        );
        assert.equal(
          await listed([
            'volume',
            'ls',
            '-q',
            '--filter',
            `name=^${sentinelVolume.name}$`,
          ]),
          sentinelVolume.name,
        );
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
  'a Docker command that outlives its killed test process keeps the run until it ends, and the next run removes what it created',
  { skip: standIn, timeout: 180_000 },
  async (t) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-orphan-command-'),
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    const { stdout: dockerPath } = await spawn('which', ['docker']);
    // A slow `docker run`, such as one that pulls a large image: it waits
    // until the test removes the gate.
    const gate = join(directory.path, 'gate');
    await writeFile(gate, '');
    await writeFile(
      join(directory.path, 'docker'),
      `#!/bin/sh\nif [ "$1" = run ]; then while [ -f ${quote(gate)} ]; do sleep 0.1; done; fi\nexec ${quote(dockerPath)} "$@"\n`,
      { mode: 0o755 },
    );
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { Docker, TestRun } from ${library};
      test('a slow start', { timeout: 3000 }, async () => {
        const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
        await docker.isAvailable();
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ run: process.env.ZUKHRUF_TESTING_RUN_ID, record: process.env.ZUKHRUF_TESTING_RUN_DIR, pid: process.pid }));
        await docker.start({ image: 'alpine:latest', command: ['sleep', '600'] });
      });
    `,
    );
    const env = runEnvironment(join(directory.path, 'state'));
    let run: string | undefined;
    try {
      // The test times out, and --test-force-exit ends its process while
      // its `docker run` still runs.
      await assert.rejects(
        spawn(process.execPath, runnerArgs('--test-force-exit', file), {
          env: runEnvironment(
            join(directory.path, 'state'),
            `${directory.path}:${process.env.PATH}`,
          ),
          timeout: 60_000,
        }),
      );
      const state = await readState<Omit<SmallState, 'id'>>(t, statePath);
      run = state.run;
      const commands = (await recordedProcesses(state.record)).filter(
        (pid) => pid !== state.pid,
      );
      assert.ok(commands.some(alive), 'the docker run outlives its test');
      await access(join(state.record, 'run.json'));
      await rm(gate);
      await t.waitFor(() => assert.equal(commands.some(alive), false), {
        timeout: 60_000,
        interval: 250,
      });
      const label = ['--filter', `label=dev.zukhruf.testing.run=${state.run}`];
      assert.notEqual(await listed(['ps', '-aq', ...label]), '');

      await emptyRun(file, env);

      assert.equal(await listed(['ps', '-aq', ...label]), '');
      await assert.rejects(access(state.record), { code: 'ENOENT' });
    } finally {
      // Never leave the stand-in waiting.
      await rm(gate, { force: true });
      if (run !== undefined) {
        const ids = await listed([
          'ps',
          '-aq',
          '--filter',
          `label=dev.zukhruf.testing.run=${run}`,
        ]);
        for (const id of ids.split('\n').filter(Boolean))
          await docker.command(['rm', '--force', id]).catch(() => {});
      }
    }
  },
);

test(
  'recovery leaves a dead runner’s run alone while one of its test processes lives',
  { timeout: 180_000 },
  async (t) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-orphan-'),
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

      assert.equal(
        await listed(['inspect', '--format', '{{.State.Running}}', state.id]),
        'true',
      );
      await access(join(state.record, 'run.json'));
    } finally {
      if (killed.child.exitCode === null && killed.child.signalCode === null)
        killed.child.kill('SIGKILL');
      await killed.exited.catch(() => null);
      if (worker !== undefined && alive(worker))
        process.kill(worker, 'SIGKILL');
      if (state)
        await docker
          .command(['rm', '--force', '--volumes', state.id])
          .catch(() => {});
    }
  },
);

test(
  'a run whose tests never touch Docker leaves no record and makes no daemon call',
  { skip: standIn, timeout: 120_000 },
  async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-untouched-'),
    );
    const log = join(directory.path, 'docker.log');
    const { stdout: dockerPath } = await spawn('which', ['docker']);
    // Only `docker context inspect` reads the CLI's configuration; every
    // other command needs the daemon, which this stand-in refuses.
    await writeFile(
      join(directory.path, 'docker'),
      `#!/bin/sh\necho "$*" >> ${quote(log)}\nif [ "$1" = context ] && [ "$2" = inspect ]; then exec ${quote(dockerPath)} "$@"; fi\necho 'no daemon (injected)' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const file = join(directory.path, 'plain.test.ts');
    await writeFile(
      file,
      "import { test } from 'node:test';\ntest('no Docker', () => {});\n",
    );
    const state = join(directory.path, 'state');

    await spawn(process.execPath, runnerArgs(file), {
      env: runEnvironment(state, `${directory.path}:${process.env.PATH}`),
      timeout: 60_000,
    });

    assert.deepEqual(
      await readdir(join(state, 'zukhruf-testing', 'docker-runs')),
      [],
    );
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.ok(
      calls.every((call) => call.startsWith('context inspect')),
      calls.join('\n'),
    );
  },
);

/**
 * Arrange: a run whose runner and test processes were killed, so nothing
 * removed what its worker created. Runners that recover it use a Docker
 * CLI stand-in that runs `standInLine`, a shell line, before the real CLI.
 */
async function killedRun(
  t: TestContext,
  directory: string,
  standInLine: string,
) {
  const statePath = join(directory, 'state.json');
  const file = join(directory, 'worker.test.ts');
  const stateHome = join(directory, 'state');
  await writeFile(
    file,
    workerSource(statePath, 'await setTimeout(120_000);', 150_000),
  );
  const { stdout: dockerPath } = await spawn('which', ['docker']);
  await writeFile(
    join(directory, 'docker'),
    `#!/bin/sh\n${standInLine}\nexec ${quote(dockerPath)} "$@"\n`,
    { mode: 0o755 },
  );
  const dead = started(
    runnerArgs('--test-force-exit', file),
    runEnvironment(stateHome),
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
    assert.equal(await exists(state.general), state.general.slice(0, 12));
    const recover = () =>
      spawn(
        process.execPath,
        runnerArgs('--test-name-pattern=no-matching-tests', file),
        {
          // Another project: the runs are per user, not per directory.
          cwd: directory,
          env: runEnvironment(stateHome, `${directory}:${process.env.PATH}`),
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
    assert.equal(await exists(id), '');
  assert.equal(
    await listed(['volume', 'ls', '-q', '--filter', `name=^${state.volume}$`]),
    '',
  );
  assert.deepEqual(await readdir(root), []);
}

test(
  'two runs that start together recover a dead run, and both succeed',
  { skip: standIn, timeout: 180_000 },
  async (t) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-recovery-'),
    );
    // The first `volume ls` passes; every later one waits two seconds, so a
    // second runner inside the same dead run's cleanup runs after the
    // first one has finished it.
    const { state, recover, root } = await killedRun(
      t,
      directory.path,
      `if [ "$1" = volume ] && [ "$2" = ls ] && ! mkdir ${quote(join(directory.path, 'first-volume-ls'))} 2>/dev/null; then sleep 2; fi`,
    );
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
  { skip: standIn, timeout: 180_000 },
  async (t) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-recovery-'),
    );
    // Every `ps` marks that a recovery has claimed its run and is removing its
    // containers, and takes two seconds, so the second runner starts while
    // the first one is still inside the dead run's cleanup.
    const marker = join(directory.path, 'recovering');
    const { state, recover, root } = await killedRun(
      t,
      directory.path,
      `if [ "$1" = ps ]; then touch ${quote(marker)}; sleep 2; fi`,
    );
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
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-reused-pid-'),
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
        endpoint: (await docker.info()).endpoint,
        pid: await endedPid(),
      }),
    );
    const command = started(
      ['--eval', 'setTimeout(() => {}, 600_000)'],
      process.env,
    );
    try {
      assert.ok(command.child.pid !== undefined);
      const run = new TestRun(id, record);
      // The OS gave the pid of a command that ended to the next command
      // before the record of the first one was removed.
      const ended = await run.recordProcess(command.child.pid);
      await run.recordProcess(command.child.pid);
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
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-other-engine-'),
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
    await new TestRun(id, record).recordProcess(await endedPid());
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
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-labels-'),
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
      import { execFileSync } from 'node:child_process';
      import { writeFile } from 'node:fs/promises';
      import { Docker, TestRun } from ${library};
      test('resources that the run owns through its labels', { timeout: 150000 }, async () => {
        const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
        const shared = await docker.reuse({ image: 'alpine:latest', command: ['sleep', '600'], internalPort: 80, labels: { ...docker.defaults.labels, 'dev.zukhruf.testing.verification': ${JSON.stringify(scope)} } });
        await shared.disconnect();
        const labels = Object.entries(docker.defaults.labels).flatMap(([key, value]) => ['--label', key + '=' + value]);
        const cli = (args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
        const container = cli(['run', '--detach', ...labels, 'alpine:latest', 'sleep', '600']);
        const volume = cli(['volume', 'create', ...labels]);
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ container, volume, shared: shared.containerId }));
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

      assert.equal(await exists(state.container), '');
      assert.equal(
        await listed([
          'volume',
          'ls',
          '-q',
          '--filter',
          `name=^${state.volume}$`,
        ]),
        '',
      );
      assert.equal(
        await listed([
          'inspect',
          '--format',
          '{{.State.Running}}',
          state.shared,
        ]),
        'true',
      );
    } finally {
      for (const id of (
        await listed(['ps', '-aq', '--filter', `label=${verification}`])
      )
        .split('\n')
        .filter(Boolean))
        await docker
          .command(['rm', '--force', '--volumes', id])
          .catch(() => {});
      if (state) {
        await docker
          .command(['rm', '--force', '--volumes', state.container])
          .catch(() => {});
        await docker
          .command(['volume', 'rm', '--force', state.volume])
          .catch(() => {});
      }
    }
  },
);

test(
  'start() pulls an image that the engine does not have',
  { timeout: 180_000 },
  async (t) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-pull-'),
    );
    // Only this test uses this tag, so it can remove the image.
    const image = 'busybox:1.37.0-musl';
    const removeImage = () =>
      docker.command(['image', 'rm', image]).catch((error: unknown) => {
        if (
          !(error instanceof SubprocessError) ||
          !/No such image/i.test(error.stderr)
        )
          throw error;
      });
    await removeImage();
    assert.equal(await listed(['image', 'ls', '-q', image]), '');
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { Docker, TestRun } from ${library};
      test('an image that the engine does not have', { timeout: 150000 }, async () => {
        const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
        await using container = await docker.start({ image: ${JSON.stringify(image)}, command: ['sleep', '600'] });
        await container.exec(['true']);
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.containerId }));
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
      assert.notEqual(await listed(['image', 'ls', '-q', image]), '');
    } finally {
      await removeImage();
    }
  },
);

test(
  'a runner whose DOCKER_HOST names a tcp:// engine fails in the global setup',
  { timeout: 60_000 },
  async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-tcp-'),
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
