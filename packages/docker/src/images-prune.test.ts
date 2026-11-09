import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Docker, DockerEngineError } from './index.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

// No test here prunes a real engine. On the containerd image store, each prune
// ends the lease of each pull in progress, whatever its filters (Moby,
// daemon/containerd/image_prune.go), and the tests of this package pull in
// parallel: they then reject with "lease does not exist".

test('prune() sends its filters to POST /images/prune, and gives the deleted images and the space reclaimed', async () => {
  // Arrange
  await using scratch = await scratchDirectory();
  const methods: (string | undefined)[] = [];
  await using engine = await fakeEngine({
    directory: scratch.path,
    apiVersion: '1.51',
    answer: ({ method }, response) => {
      methods.push(method);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          ImagesDeleted: [{ Untagged: 'app:1' }, { Deleted: 'sha256:abc' }],
          SpaceReclaimed: 1024,
        }),
      );
    },
  });
  await using docker = await Docker.connect({
    clock: globalThis,
    host: engine.host,
  });
  const filters = { dangling: ['false'], label: ['example.app=1'] };

  // Act
  const pruned = await docker.images.prune({ filters });

  // Assert
  assert.deepEqual(pruned, {
    ImagesDeleted: [{ Untagged: 'app:1' }, { Deleted: 'sha256:abc' }],
    SpaceReclaimed: 1024,
  });
  assert.deepEqual(methods, ['POST']);
  const url = new URL(engine.paths.at(-1) ?? '', 'http://engine');
  assert.match(url.pathname, /\/images\/prune$/);
  assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? ''), filters);
});

test('prune() with no filters sends no filters query', async () => {
  // Arrange
  await using scratch = await scratchDirectory();
  await using engine = await fakeEngine({
    directory: scratch.path,
    apiVersion: '1.51',
    answer: (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ImagesDeleted":null,"SpaceReclaimed":0}');
    },
  });
  await using docker = await Docker.connect({
    clock: globalThis,
    host: engine.host,
  });

  // Act
  const pruned = await docker.images.prune();

  // Assert
  assert.deepEqual(pruned, { ImagesDeleted: [], SpaceReclaimed: 0 });
  assert.match(engine.paths.at(-1) ?? '', /\/images\/prune$/);
});

test('prune() that the engine refuses rejects with DockerEngineError that names the request', async () => {
  // Arrange
  await using scratch = await scratchDirectory();
  await using engine = await fakeEngine({
    directory: scratch.path,
    apiVersion: '1.51',
    answer: (_request, response) => {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end('{"message":"a prune operation is already running"}');
    },
  });
  await using docker = await Docker.connect({
    clock: globalThis,
    host: engine.host,
  });

  // Act
  const pruning = docker.images.prune({ filters: { label: ['example.app'] } });

  // Assert
  await assert.rejects(pruning, (error) => {
    assert.ok(error instanceof DockerEngineError);
    assert.equal(error.status, 409);
    assert.equal(error.request.method, 'POST');
    assert.match(error.request.path, /\/images\/prune$/);
    return true;
  });
});

// A prune that ignores the signal never ends here, and that must fail the test, not hang it.
test(
  'prune() whose signal aborts rejects with the reason of the signal',
  { timeout: 5000 },
  async () => {
    // Arrange: the engine never answers the prune.
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: () => {},
    });
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const abort = new AbortController();
    const reason = new Error('The caller stopped waiting');

    // Act
    const pruning = docker.images.prune({
      filters: { label: ['example.app'] },
      signal: abort.signal,
    });
    setImmediate(() => abort.abort(reason));

    // Assert
    await assert.rejects(pruning, reason);
  },
);
