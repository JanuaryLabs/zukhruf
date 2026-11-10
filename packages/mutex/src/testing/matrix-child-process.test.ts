import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { factTimeout } from './fact-timeout.ts';
import { mutexUrl } from './module-urls.ts';
import { subject as dockerSubject } from './subjects/docker-engine.ts';
import { startWorker } from './worker-process.ts';

const memoryUrl = new URL('./subjects/memory.ts', import.meta.url);
const dockerUrl = new URL('./subjects/docker-engine.ts', import.meta.url);
const workerProcessUrl = new URL('./worker-process.ts', import.meta.url);

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
				import { startWorker } from ${JSON.stringify(workerProcessUrl.href)};

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
  await t.waitFor(
    () =>
      assert.ok(
        testProcess.has('granting'),
        `The matrix child must grant.\n${testProcess.stderr}`,
      ),
    { interval: 5, timeout: factTimeout },
  );
  const pid = Number(testProcess.find('granting')?.pid);
  try {
    // Act
    testProcess.child.kill('SIGKILL');
    await testProcess.closed;

    // Assert
    await t.waitFor(
      () =>
        assert.ok(
          !isRunning(pid),
          'The matrix child must exit when its test process is killed',
        ),
      { interval: 5, timeout: factTimeout },
    );
  } finally {
    if (isRunning(pid)) process.kill(pid, 'SIGKILL');
  }
});

/** The pids of the process records in the records directory of a run. */
const recordedPids = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.startsWith('process-'))
    .map(
      (name): number =>
        JSON.parse(readFileSync(join(directory, name), 'utf8')).pid,
    );

test('a matrix child that opens the DockerEngineStore records itself in the run of the fixture', async (t) => {
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

				openInProcess(${JSON.stringify(fixture.location)});
				process.send({ type: 'started' });
				setInterval(() => {}, 1000);
			`,
    'child',
    { admit: (child) => store.process.admit(host, child) },
  );
  await t.waitFor(
    () =>
      assert.ok(
        child.has('started'),
        `The matrix child must start.\n${child.stderr}`,
      ),
    { interval: 5, timeout: factTimeout },
  );

  // Assert
  assert.ok(
    recordedPids(records.path).includes(child.child.pid!),
    'The run must have a process record of the matrix child once it opened the store',
  );
});
