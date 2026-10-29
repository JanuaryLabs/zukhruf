import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Docker } from '@zukhruf/docker';

import {
  type TemporaryDirectory,
  TemporaryFiles,
} from '../fs/temporary-files.ts';
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
const setup = fileURLToPath(
  new URL('./docker-global-setup.ts', import.meta.url),
);
const library = JSON.stringify(
  new URL('../docker/index.ts', import.meta.url).href,
);

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

const removeContainer = async (id: string): Promise<void> =>
  (await docker.containers.find(id))?.remove({ force: true, v: true });

const removeVolume = async (name: string): Promise<void> =>
  (await docker.volumes.find(name))?.remove({ force: true });

async function readState<T>(t: TestContext, statePath: string): Promise<T> {
  await t.waitFor(
    async () => {
      JSON.parse(await readFile(statePath, 'utf8'));
    },
    { timeout: 60_000, interval: 250 },
  );
  return JSON.parse(await readFile(statePath, 'utf8'));
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
          if (Labels?.['dev.zukhruf.testing.shared'] !== '1')
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

test(
  'a global teardown whose cleanup takes longer than 250 s keeps the run’s records and sets exit code 1',
  // The 250 s of the teardown, and margin.
  { skip: proxyless, timeout: 420_000 },
  async (t) => {
    await using directory = await runsDirectory(
      'zukhruf-testing-slow-teardown-',
    );
    const statePath = join(directory.path, 'state.json');
    const file = join(directory.path, 'worker.test.ts');
    await writeFile(file, smallWorkerSource(statePath, ''));
    await using proxy = await EngineProxy.start(engine);
    // After the test wrote its state, the lists are the teardown's. Each
    // one waits 150 s, below the 240 s of one engine call, so the teardown
    // gets no error and runs out of its 250 s.
    const stop = new AbortController();
    const slow = async () => {
      if (existsSync(statePath))
        await setTimeout(150_000, undefined, { signal: stop.signal }).catch(
          () => {},
        );
    };
    proxy.intercept('GET', '/containers/json', slow);
    proxy.intercept('GET', '/volumes', slow);
    const run = started(
      runnerArgs(file),
      proxiedEnvironment(join(directory.path, 'state'), proxy),
    );
    try {
      const code = await run.exited;
      const endedAt = Date.now();

      // The test passed, so only the teardown sets the exit code.
      assert.equal(code, 1, run.output());
      // The teardown starts after the test wrote its state, so the time from
      // that write to the run's end holds the whole 250 s wait, and load
      // cannot break the lower bound. The upper bound leaves 60 s for load.
      const seconds = (endedAt - (await stat(statePath)).mtimeMs) / 1000;
      assert.ok(
        seconds >= 250 && seconds <= 250 + 60,
        `the teardown ended ${seconds.toFixed(1)} s after the test wrote its state, not within 60 s after its 250 s`,
      );
      assert.match(
        run.output(),
        /The Docker cleanup did not finish within 250 s/,
      );
      assert.match(run.output(), /retained ownership record/);
      const state = await readState<SmallState>(t, statePath);
      await access(join(state.record, 'run.json'));
    } finally {
      stop.abort();
      if (run.child.exitCode === null && run.child.signalCode === null)
        run.child.kill('SIGKILL');
    }
  },
);
