import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdtempDisposable,
  readFile,
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
const skip =
  process.platform === 'win32'
    ? 'the supervisor stops a run as a POSIX process group'
    : false;
const supervisor = fileURLToPath(
  new URL('./run-docker-tests.ts', import.meta.url),
);
const library = JSON.stringify(
  new URL('../docker/index.ts', import.meta.url).href,
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** What a supervised worker created, written where the test can read it. */
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
}

/**
 * A supervised test file that creates one of everything the supervisor
 * owns, records it in `statePath`, and then ends the way `ending` says.
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
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.containerId, general: general.containerId, path: fixture.path, volume: volume.name, anonymousVolumes, generalVolumes, forwards, run: process.env.ZUKHRUF_TESTING_RUN_ID, record: directory }));
    ${ending}
  });
`;

/** The environment of a supervisor that keeps its runs under `state`. */
const supervisorEnvironment = (state: string, path = process.env.PATH) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_STATE_HOME: state,
    PATH: path,
  };
  // A runner launched from a test worker would otherwise skip its files.
  delete env.NODE_TEST_CONTEXT;
  return env;
};

const listed = async (args: string[]): Promise<string> =>
  (await docker.command(args)).stdout;

async function readState(t: TestContext, statePath: string): Promise<State> {
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
    await docker.command(['rm', '--force', '--volumes', id]).catch(() => {});
  for (const name of [
    state.volume,
    ...state.anonymousVolumes,
    ...state.generalVolumes,
  ])
    await docker.command(['volume', 'rm', '--force', name]).catch(() => {});
}

test('the supervisor refuses Windows, which has no process group to stop a run with', async () => {
  await assert.rejects(
    spawn(process.execPath, [
      '--import',
      `data:text/javascript,${encodeURIComponent(
        "Object.defineProperty(process, 'platform', { value: 'win32' });",
      )}`,
      supervisor,
    ]),
    (error: unknown) =>
      error instanceof SubprocessError &&
      /stops a run as one process group, which Windows does not have/.test(
        error.stderr,
      ),
  );
});

for (const mode of [
  'failure',
  'cancel',
  'timeout',
  'recovery',
  'signal-error',
  'signal-race',
] as const) {
  test(
    `the supervisor cleans an interrupted run (${mode}) and preserves another run's containers and volumes`,
    { skip, timeout: 180_000 },
    async (t) => {
      // Another run's container and volume: the sweep must match the run id,
      // not only the label.
      const unrelated = new Docker({
        testRun: new TestRun(`unrelated-${randomUUID()}`, tmpdir()),
      });
      await using sentinel = await unrelated.start({
        image: 'alpine:latest',
        command: ['sleep', '600'],
      });
      await using sentinelVolume = await unrelated.volume();
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-testing-cleanup-'),
      );
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
            mode === 'cancel' || mode === 'timeout'
              ? 'await setTimeout(120_000);'
              : "throw new Error('intentional assertion failure');",
          ].join('\n'),
          mode === 'timeout' ? 30_000 : 90_000,
        ),
      );
      const env = supervisorEnvironment(
        join(directory.path, 'state'),
        mode === 'recovery'
          ? `${directory.path}:${process.env.PATH}`
          : process.env.PATH,
      );
      const child = spawnProcess(
        process.execPath,
        [
          ...(mode === 'signal-error' || mode === 'signal-race'
            ? [
                '--import',
                `data:text/javascript,${encodeURIComponent(`
                  const kill = process.kill.bind(process);
                  let denied = false;
                  process.kill = (pid, signal) => {
                    if (pid < 0 && signal === 'SIGKILL' && (${mode === 'signal-error'} || !denied)) {
                      denied = true;
                      // Terminate the real group before replaying the observed OS
                      // error, so this regression cannot orphan its SSH process.
                      try { kill(pid, signal); } catch (error) {
                        if (error.code !== 'ESRCH') throw error;
                      }
                      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
                    }
                    return kill(pid, signal);
                  };
                `)}`,
              ]
            : []),
          supervisor,
          '--test-timeout=90000',
          '--test-force-exit',
          file,
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
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
      let state: State | undefined;
      try {
        state = await readState(t, statePath);
        const worker = JSON.parse(
          await readFile(join(state.record, 'run.json'), 'utf8'),
        );
        assert.ok(state.anonymousVolumes.length > 0);
        assert.ok(state.generalVolumes.length > 0);
        if (mode === 'cancel') child.kill('SIGTERM');
        assert.notEqual(await exited, 0, output);
        await t.waitFor(
          () => {
            assert.throws(() => process.kill(-worker.childPid, 0), {
              code: 'ESRCH',
            });
          },
          { timeout: 5_000 },
        );
        if (mode === 'recovery' || mode === 'signal-error') {
          assert.match(output, /retained ownership record/);
          const record = JSON.parse(
            await readFile(join(state.record, 'run.json'), 'utf8'),
          );
          assert.equal(record.endpoint, (await docker.info()).endpoint);
          if (mode === 'recovery') {
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
          } else {
            assert.equal(
              await listed(['ps', '-aq', '--filter', `id=${state.id}`]),
              '',
              'signalling errors must not bypass resource cleanup',
            );
          }
          await spawn(
            process.execPath,
            [
              supervisor,
              '--test-timeout=60000',
              '--test-name-pattern=no-matching-tests',
              file,
            ],
            { env, timeout: 90_000 },
          );
        }
        for (const id of [state.id, state.general]) {
          assert.equal(
            await listed(['ps', '-aq', '--filter', `id=${id}`]),
            '',
            output,
          );
        }
        for (const name of [
          state.volume,
          ...state.anonymousVolumes,
          ...state.generalVolumes,
        ]) {
          assert.equal(
            await listed(['volume', 'ls', '-q', '--filter', `name=^${name}$`]),
            '',
            `supervisor left volume ${name}: ${output}`,
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
        await assert.rejects(readFile(join(state.record, 'run.json')), {
          code: 'ENOENT',
        });
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
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGTERM');
        await exited.catch(() => null);
        await removeLeftovers(state);
      }
    },
  );
}

/**
 * Arrange: a run whose supervisor and test processes were killed, so nothing
 * removed what its worker created. Supervisors that recover it use a Docker
 * CLI stand-in that runs `standIn`, a shell line, before the real CLI.
 */
async function killedRun(t: TestContext, directory: string, standIn: string) {
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
    `#!/bin/sh\n${standIn}\nexec ${quote(dockerPath)} "$@"\n`,
    { mode: 0o755 },
  );
  const dead = spawnProcess(
    process.execPath,
    [supervisor, '--test-force-exit', file],
    { env: supervisorEnvironment(stateHome), stdio: 'ignore' },
  );
  const deadExited = new Promise<void>((resolve) =>
    dead.once('exit', () => resolve()),
  );
  try {
    const state = await readState(t, statePath);
    const { childPid } = JSON.parse(
      await readFile(join(state.record, 'run.json'), 'utf8'),
    );
    dead.kill('SIGKILL');
    process.kill(-childPid, 'SIGKILL');
    await deadExited;
    await t.waitFor(
      () => {
        assert.throws(() => process.kill(-childPid, 0), { code: 'ESRCH' });
      },
      { timeout: 5_000 },
    );
    assert.equal(
      await listed(['ps', '-aq', '--filter', `id=${state.general}`]),
      state.general.slice(0, 12),
    );
    const recover = () =>
      spawn(
        process.execPath,
        [supervisor, '--test-name-pattern=no-matching-tests', file],
        {
          // Another project: the runs are per user, not per directory.
          cwd: directory,
          env: supervisorEnvironment(
            stateHome,
            `${directory}:${process.env.PATH}`,
          ),
          timeout: 90_000,
        },
      );
    return { state, recover };
  } finally {
    if (dead.exitCode === null && dead.signalCode === null)
      dead.kill('SIGKILL');
  }
}

/** Both supervisors succeeded, and nothing of the killed run is left. */
async function assertRecovered(
  results: PromiseSettledResult<unknown>[],
  state: State,
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
    assert.equal(await listed(['ps', '-aq', '--filter', `id=${id}`]), '');
  assert.equal(
    await listed(['volume', 'ls', '-q', '--filter', `name=^${state.volume}$`]),
    '',
  );
  await assert.rejects(readFile(join(state.record, 'run.json')), {
    code: 'ENOENT',
  });
}

test(
  'two supervisors that start together recover a dead run once, and both succeed',
  { skip, timeout: 180_000 },
  async (t) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-recovery-'),
    );
    // The first `volume ls` passes; every later one waits two seconds, so a
    // second supervisor inside the same dead run's cleanup runs after the
    // first one has finished it.
    const { state, recover } = await killedRun(
      t,
      directory.path,
      `if [ "$1" = volume ] && [ "$2" = ls ] && ! mkdir ${quote(join(directory.path, 'first-volume-ls'))} 2>/dev/null; then sleep 2; fi`,
    );
    try {
      const results = await Promise.allSettled([recover(), recover()]);

      await assertRecovered(results, state);
    } finally {
      await removeLeftovers(state);
    }
  },
);

test(
  'a supervisor that starts while another recovers a dead run leaves the run to it',
  { skip, timeout: 180_000 },
  async (t) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-recovery-'),
    );
    // Every `ps` marks that a recovery has claimed its run and is removing its
    // containers, and takes two seconds, so the second supervisor starts while
    // the first one is still inside the dead run's cleanup.
    const marker = join(directory.path, 'recovering');
    const { state, recover } = await killedRun(
      t,
      directory.path,
      `if [ "$1" = ps ]; then touch ${quote(marker)}; sleep 2; fi`,
    );
    try {
      const first = recover();
      await t.waitFor(() => access(marker), { interval: 50, timeout: 30_000 });
      const results = await Promise.allSettled([first, recover()]);

      await assertRecovered(results, state);
    } finally {
      await removeLeftovers(state);
    }
  },
);
