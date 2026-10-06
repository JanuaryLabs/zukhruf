import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Docker, skipWithoutDocker } from './index.ts';

/**
 * Runs `act` while the Docker CLI selects an engine that does not exist. The
 * CLI reads DOCKER_HOST from this process's environment, so it is swapped and
 * restored around `act`.
 */
async function withUnreachableEngine<T>(act: () => Promise<T>): Promise<T> {
  const previous = {
    host: process.env.DOCKER_HOST,
    context: process.env.DOCKER_CONTEXT,
  };
  try {
    process.env.DOCKER_HOST = 'unix:///nonexistent/zukhruf-testing.sock';
    delete process.env.DOCKER_CONTEXT;
    return await act();
  } finally {
    if (previous.host === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous.host;
    if (previous.context === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = previous.context;
  }
}

test('a machine that requires Docker fails when the engine does not answer', async () => {
  await withUnreachableEngine(async () => {
    await assert.rejects(
      skipWithoutDocker(new Docker(), { ZUKHRUF_TESTING_DOCKER: 'required' }),
      (error: unknown) =>
        error instanceof Error &&
        /ZUKHRUF_TESTING_DOCKER=required, but Docker does not answer/.test(
          error.message,
        ) &&
        error.cause instanceof Error,
    );
  });
});

test('a mistyped mode is refused instead of running or skipping', async () => {
  await assert.rejects(
    skipWithoutDocker(new Docker(), { ZUKHRUF_TESTING_DOCKER: 'requird' }),
    /"required" or "skip", not "requird"/,
  );
});

test('without a mode, tests skip with a reason when the engine does not answer', async () => {
  const skip = await withUnreachableEngine(() =>
    skipWithoutDocker(new Docker(), {}),
  );

  assert.match(String(skip), /needs Docker/);
});

test('the skip mode skips even when the engine answers', async () => {
  const skip = await skipWithoutDocker(new Docker(), {
    ZUKHRUF_TESTING_DOCKER: 'skip',
  });

  assert.equal(skip, 'ZUKHRUF_TESTING_DOCKER=skip');
});

const docker = new Docker();

test(
  'without a mode or with required, tests run when the engine answers',
  { skip: await skipWithoutDocker(docker, process.env) },
  async () => {
    assert.equal(await skipWithoutDocker(docker, {}), false);
    assert.equal(
      await skipWithoutDocker(docker, { ZUKHRUF_TESTING_DOCKER: 'required' }),
      false,
    );
  },
);
