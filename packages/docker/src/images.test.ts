import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import {
  Docker,
  DockerEngineError,
  ImageInUseError,
  ImageNotFoundError,
  UnsupportedEngineError,
} from './index.ts';
import { tarEntries } from './tar-reader.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

const TEST_LABEL = 'dev.zukhruf.docker.test';
const HELLO = 'hello-world';

/** The engine that the environment of the test run selects, with hello-world on it. */
async function connectWithHello(): Promise<Docker> {
  const docker = await Docker.connect({
    environment: process.env,
    signal: AbortSignal.timeout(15_000),
  });
  if (!(await docker.images.inspect(HELLO))) await docker.images.pull(HELLO);
  return docker;
}

/** Removes each container with the label of this test run, then the dedicated names of hello-world. */
async function removeOwn(
  docker: Docker,
  run: string,
  ...names: string[]
): Promise<void> {
  const filters = { label: [`${TEST_LABEL}=${run}`] };
  for (const summary of await docker.containers.list({ all: true, filters })) {
    const container = await docker.containers.find(summary.Id);
    await container?.remove({ force: true, v: true });
  }
  for (const name of names) await docker.images.remove(name);
}

/** A multi-platform image that no other test uses, so a pull of one platform changes no other test. */
const MULTI_PLATFORM = 'hello-world:linux';
const AMD64 = { os: 'linux', architecture: 'amd64' };
const ARM64 = { os: 'linux', architecture: 'arm64' };

/**
 * The architecture of each image configuration in a saved archive: each blob
 * that is JSON with an architecture and a rootfs. A layer is not JSON. The
 * attestation manifest of a platform has a configuration with the
 * architecture 'unknown', so it does not count.
 */
async function archiveArchitectures(
  archive: ReadableStream<Uint8Array>,
): Promise<string[]> {
  const architectures: string[] = [];
  for await (const entry of tarEntries(archive)) {
    if (entry.type !== 'file' || !entry.path.startsWith('blobs/')) continue;
    let blob: unknown;
    try {
      blob = JSON.parse(new TextDecoder().decode(entry.data));
    } catch {
      continue;
    }
    const architecture: unknown = Reflect.get(Object(blob), 'architecture');
    if (
      typeof architecture === 'string' &&
      architecture !== 'unknown' &&
      Reflect.has(Object(blob), 'rootfs')
    )
      architectures.push(architecture);
  }
  return architectures;
}

async function bytesOf(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return Buffer.concat(await Array.fromAsync(stream));
}

describe('docker.images', () => {
  test('inspect() gives the image by a short or a full reference, or undefined for an image that is not on the engine', async () => {
    // Arrange
    await using docker = await Docker.connect({ environment: process.env });
    if (!(await docker.images.inspect('alpine:3'))) {
      await docker.images.pull('alpine:3');
    }

    // Act
    const present = await docker.images.inspect('alpine:3');
    const full = await docker.images.inspect('docker.io/library/alpine:3');
    const missing = await docker.images.inspect(
      `zukhruf-missing-${randomUUID()}:1`,
    );

    // Assert
    assert.match(present?.Id ?? '', /^sha256:/);
    assert.equal(full?.Id, present?.Id);
    assert.equal(missing, undefined);
  });

  test('a pull that the engine answers with 404 is an ImageNotFoundError with the reference', async () => {
    // Arrange: the answer of an engine for a repository that the registry does not have.
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (_request, response) => {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            message:
              "pull access denied for zukhruf-missing/none, repository does not exist or may require 'docker login'",
          }),
        );
      },
    });
    await using docker = await Docker.connect({ host: engine.host });
    const reference = 'zukhruf-missing/none:1';

    // Act
    const pulling = docker.images.pull(reference);

    // Assert
    await assert.rejects(pulling, (error: unknown) => {
      assert.ok(error instanceof ImageNotFoundError);
      assert.equal(error.image, reference);
      assert.equal(error.status, 404);
      assert.deepEqual(error.request, {
        method: 'POST',
        path: '/images/create',
      });
      return true;
    });
  });

  test('an error in the progress of a pull is a DockerEngineError with no status, also when the lines arrive in parts', async () => {
    // Arrange: the engine answers 200, then reports the error in the progress.
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"status":"Pulling from library/app","id":"1"}\n{"sta');
        // The line of the error ends in the middle of the two bytes of 'é'.
        const rest = Buffer.from(
          'tus":"Downloading"}\n{"errorDetail":{"message":"unexpected EOF é"},"error":"unexpected EOF é"}\n{"status":"Done"}\n',
        );
        const middle = rest.indexOf(Buffer.from('é')) + 1;
        void setTimeout(20).then(() => {
          response.write(rest.subarray(0, middle));
          return setTimeout(20).then(() => {
            response.end(rest.subarray(middle));
          });
        });
      },
    });
    await using docker = await Docker.connect({ host: engine.host });

    // Act
    const pulling = docker.images.pull('app:1');

    // Assert
    await assert.rejects(pulling, (error: unknown) => {
      assert.ok(error instanceof DockerEngineError);
      assert.ok(!(error instanceof ImageNotFoundError));
      assert.equal(error.status, undefined);
      assert.equal(error.message, 'unexpected EOF é');
      assert.deepEqual(error.request, {
        method: 'POST',
        path: '/images/create',
      });
      return true;
    });
    const query = new URL(engine.paths.at(-1) ?? '', 'http://engine')
      .searchParams;
    assert.equal(query.get('fromImage'), 'app:1');
    assert.equal(query.get('tag'), null);
  });

  test('a pull reads the progress to its end, names the tag latest for a bare repository, and sends auth as base64url JSON', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const auths: (string | undefined)[] = [];
    const ended = Promise.withResolvers<void>();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (request, response) => {
        const header = request.headers['x-registry-auth'];
        auths.push(typeof header === 'string' ? header : undefined);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"status":"Pulling"}\n');
        void setTimeout(50).then(() => {
          response.end('{"status":"Status: Downloaded newer image"}\n');
          ended.resolve();
        });
      },
    });
    await using docker = await Docker.connect({ host: engine.host });
    const auth = {
      username: 'me',
      password: 'tok+/en?',
      serveraddress: 'ghcr.io',
    };
    let endedFirst = false;
    void ended.promise.then(() => (endedFirst = true));

    // Act
    await docker.images.pull('ghcr.io/example/app', { auth });
    const resolvedAfterEnd = endedFirst;

    // Assert
    assert.equal(resolvedAfterEnd, true);
    const pullPath = engine.paths.at(-1) ?? '';
    const query = new URL(pullPath, 'http://engine').searchParams;
    assert.equal(query.get('fromImage'), 'ghcr.io/example/app');
    assert.equal(query.get('tag'), 'latest');
    const header = auths.at(-1) ?? '';
    assert.match(header, /^[A-Za-z0-9_-]+={0,2}$/);
    assert.deepEqual(
      JSON.parse(Buffer.from(header, 'base64url').toString()),
      auth,
    );
  });

  for (const operation of ['pull', 'push'] as const) {
    test(`${operation}() sends auth as padded base64url, which the URLEncoding of Go decodes: its length is a multiple of 4`, async () => {
      // Arrange: a JSON of 37 bytes, so base64 of it ends with padding.
      await using scratch = await scratchDirectory();
      const auths: string[] = [];
      await using engine = await fakeEngine({
        directory: scratch.path,
        apiVersion: '1.51',
        answer: (request, response) => {
          const header = request.headers['x-registry-auth'];
          if (typeof header === 'string') auths.push(header);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"status":"Done"}\n');
        },
      });
      await using docker = await Docker.connect({ host: engine.host });
      const auth = { username: 'me', password: 'pwd' };
      assert.notEqual(JSON.stringify(auth).length % 3, 0);

      // Act
      await docker.images[operation]('ghcr.io/example/app:1', { auth });

      // Assert
      assert.equal(auths.length, 1);
      const [header = ''] = auths;
      assert.match(header, /^[A-Za-z0-9_-]+={1,2}$/);
      assert.equal(header.length % 4, 0);
      const standard = header.replaceAll('-', '+').replaceAll('_', '/');
      assert.deepEqual(
        JSON.parse(Buffer.from(standard, 'base64').toString('utf8')),
        auth,
      );
    });
  }

  test('tag() gives the image a second name that inspect() and list() find, tag() of a missing image is an ImageNotFoundError, and remove() of the name resolves twice', async () => {
    // Arrange
    await using docker = await connectWithHello();
    const run = randomUUID();
    const name = `zukhruf-test-${run}:x`;
    const missing = `zukhruf-missing-${run}:1`;
    try {
      const hello = await docker.images.inspect(HELLO);
      // A second image on the engine, so a list that ignores the filter gives more than one ID.
      if (!(await docker.images.inspect('alpine:3'))) {
        await docker.images.pull('alpine:3');
      }

      // Act
      await docker.images.tag(HELLO, name);
      const tagged = await docker.images.inspect(name);
      const listed = await docker.images.list({
        filters: { reference: [name] },
      });
      const tagMissing = docker.images.tag(missing, `zukhruf-test-${run}:y`);
      await Promise.allSettled([tagMissing]);
      await docker.images.remove(name);
      const removed = await docker.images.inspect(name);
      await docker.images.remove(name);

      // Assert
      assert.equal(tagged?.Id, hello?.Id);
      assert.deepEqual(
        listed.map(({ Id }) => Id),
        [hello?.Id],
      );
      await assert.rejects(tagMissing, (error) => {
        assert.ok(error instanceof ImageNotFoundError);
        assert.equal(error.image, missing);
        assert.equal(error.status, 404);
        return true;
      });
      assert.equal(removed, undefined);
      assert.equal(
        await docker.images.inspect(HELLO).then((image) => image?.Id),
        hello?.Id,
      );
    } finally {
      await removeOwn(docker, run, name);
    }
  });

  test('save() and load() carry images: two removed names come back with the same ID', async () => {
    // Arrange
    await using docker = await connectWithHello();
    const run = randomUUID();
    const first = `zukhruf-test-${run}:x`;
    const second = `zukhruf-test-${run}:y`;
    try {
      await docker.images.tag(HELLO, first);
      await docker.images.tag(HELLO, second);
      const saved = await docker.images.inspect(first);

      // Act
      const archive = await bytesOf(await docker.images.save([first, second]));
      await docker.images.remove(first);
      await docker.images.remove(second);
      const removed = await Promise.all([
        docker.images.inspect(first),
        docker.images.inspect(second),
      ]);
      await docker.images.load(ReadableStream.from([archive]));
      const loaded = await Promise.all([
        docker.images.inspect(first),
        docker.images.inspect(second),
      ]);

      // Assert
      assert.deepEqual(removed, [undefined, undefined]);
      assert.deepEqual(
        loaded.map((image) => image?.Id),
        [saved?.Id, saved?.Id],
      );
    } finally {
      await removeOwn(docker, run, first, second);
    }
  });

  test('load() of bytes that are not an image archive rejects with a DockerEngineError with no status', async () => {
    // Arrange
    await using docker = await Docker.connect({ environment: process.env });

    // Act
    const loading = docker.images.load(new Uint8Array(1024));

    // Assert
    await assert.rejects(loading, (error) => {
      assert.ok(error instanceof DockerEngineError);
      assert.equal(error.status, undefined);
      assert.deepEqual(error.request, {
        method: 'POST',
        path: '/images/load',
      });
      return true;
    });
  });

  test('push() of an image that is not on the engine rejects with ImageNotFoundError: the engine reports it in the progress after 200', async () => {
    // Arrange
    await using docker = await Docker.connect({ environment: process.env });
    const missing = `zukhruf-missing-${randomUUID()}:1`;

    // Act
    const pushing = docker.images.push(missing, {
      auth: { username: 'nobody', password: 'none' },
    });

    // Assert
    await assert.rejects(pushing, (error) => {
      assert.ok(error instanceof ImageNotFoundError);
      assert.equal(error.image, missing);
      assert.equal(error.status, undefined);
      return true;
    });
  });

  test('an error in the progress of a push of an image that is on the engine is a DockerEngineError with no status, not ImageNotFoundError', async () => {
    // Arrange: the engine answers 200, reports the error of the registry in the progress, and has the image.
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (request, response) => {
        const { pathname } = new URL(request.url ?? '', 'http://engine');
        if (
          request.method === 'POST' &&
          pathname === '/v1.51/images/registry.test%2Fapp/push'
        ) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            '{"status":"The push refers to repository [registry.test/app]"}\n{"errorDetail":{"message":"connection refused"},"error":"connection refused"}\n',
          );
        } else if (
          request.method === 'GET' &&
          pathname === '/v1.51/images/registry.test%2Fapp%3A1/json'
        ) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ Id: 'sha256:1' }));
        } else {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ message: 'unexpected request' }));
        }
      },
    });
    await using docker = await Docker.connect({ host: engine.host });

    // Act
    const pushing = docker.images.push('registry.test/app:1', {
      auth: { username: 'nobody', password: 'none' },
    });

    // Assert
    await assert.rejects(pushing, (error: unknown) => {
      assert.ok(error instanceof DockerEngineError);
      assert.ok(!(error instanceof ImageNotFoundError));
      assert.equal(error.status, undefined);
      assert.equal(error.message, 'connection refused');
      assert.deepEqual(error.request, {
        method: 'POST',
        path: '/images/registry.test%2Fapp/push',
      });
      return true;
    });
  });

  test('an error in the progress of a push of an image that is not on the engine is an ImageNotFoundError with the reference', async () => {
    // Arrange: the engine answers 200, reports the error in the progress, and an inspect of the reference gets 404.
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (request, response) => {
        const { pathname } = new URL(request.url ?? '', 'http://engine');
        if (
          request.method === 'POST' &&
          pathname === '/v1.51/images/registry.test%2Fapp/push'
        ) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            '{"errorDetail":{"message":"An image does not exist locally with the tag: registry.test/app"},"error":"An image does not exist locally with the tag: registry.test/app"}\n',
          );
        } else if (
          request.method === 'GET' &&
          pathname === '/v1.51/images/registry.test%2Fapp%3A1/json'
        ) {
          response.writeHead(404, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({ message: 'No such image: registry.test/app:1' }),
          );
        } else {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ message: 'unexpected request' }));
        }
      },
    });
    await using docker = await Docker.connect({ host: engine.host });

    // Act
    const pushing = docker.images.push('registry.test/app:1', {
      auth: { username: 'nobody', password: 'none' },
    });

    // Assert
    await assert.rejects(pushing, (error: unknown) => {
      assert.ok(error instanceof ImageNotFoundError);
      assert.equal(error.image, 'registry.test/app:1');
      assert.equal(error.status, undefined);
      return true;
    });
  });

  test('remove() of an image that a container uses rejects with ImageInUseError', async () => {
    // Arrange
    await using docker = await connectWithHello();
    const run = randomUUID();
    const name = `zukhruf-test-${run}:x`;
    try {
      await docker.images.tag(HELLO, name);
      await docker.containers.create({
        Image: name,
        Labels: { [TEST_LABEL]: run },
      });
      const image = await docker.images.inspect(name);
      assert.ok(image);
      // A name that another name shares only loses its tag, so the removal by ID meets the container.
      await docker.images.remove(name);

      // Act: without force, the engine refuses this removal, so the shared hello-world stays.
      const removing = docker.images.remove(image.Id);

      // Assert
      await assert.rejects(removing, (error) => {
        assert.ok(error instanceof ImageInUseError);
        assert.equal(error.image, image.Id);
        assert.equal(error.status, 409);
        assert.match(error.message, /container/);
        return true;
      });
      assert.equal((await docker.images.inspect(HELLO))?.Id, image.Id);
    } finally {
      await removeOwn(docker, run, name);
    }
  });

  test('inspect(), save() and load() with a platform reject with UnsupportedEngineError before the request when the API version is lower than the call needs', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const calls = [
      {
        apiVersion: '1.48',
        minimumVersion: '1.49',
        call: (docker: Docker) =>
          docker.images.inspect('alpine:3', { platform: AMD64 }),
      },
      {
        apiVersion: '1.47',
        minimumVersion: '1.48',
        call: (docker: Docker) =>
          docker.images.save(['alpine:3'], { platform: AMD64 }),
      },
      {
        apiVersion: '1.47',
        minimumVersion: '1.48',
        call: (docker: Docker) =>
          docker.images.load(new Uint8Array(1024), { platform: AMD64 }),
      },
      {
        apiVersion: '1.51',
        minimumVersion: '1.52',
        call: (docker: Docker) =>
          docker.images.save(['alpine:3'], { platform: [AMD64, ARM64] }),
      },
      {
        apiVersion: '1.51',
        minimumVersion: '1.52',
        call: (docker: Docker) =>
          docker.images.load(new Uint8Array(1024), {
            platform: [AMD64, ARM64],
          }),
      },
    ];

    for (const { apiVersion, minimumVersion, call } of calls) {
      await using engine = await fakeEngine({
        directory: scratch.path,
        apiVersion,
      });
      await using docker = await Docker.connect({ host: engine.host });

      // Act
      const calling = call(docker);

      // Assert
      await assert.rejects(calling, (error: unknown) => {
        assert.ok(error instanceof UnsupportedEngineError);
        assert.equal(error.host, engine.host);
        assert.equal(error.engineVersion, apiVersion);
        assert.equal(error.minimumVersion, minimumVersion);
        return true;
      });
      assert.deepEqual(engine.paths, ['/_ping']);
    }
  });

  test('at the lowest API version of each call, inspect(), save() and load() send each platform as one platform parameter of OCI platform JSON', async () => {
    // Arrange: an engine at the version of the call that answers with an empty success.
    await using scratch = await scratchDirectory();
    const platformsOf = (path: string | undefined) =>
      new URL(path ?? '', 'http://engine').searchParams
        .getAll('platform')
        .map((each) => JSON.parse(each));
    const calls = [
      {
        apiVersion: '1.49',
        platforms: [{ ...ARM64, variant: 'v8' }],
        call: (docker: Docker) =>
          docker.images.inspect('alpine:3', {
            platform: { ...ARM64, variant: 'v8' },
          }),
      },
      {
        apiVersion: '1.48',
        platforms: [AMD64],
        call: async (docker: Docker) =>
          (
            await docker.images.save(['alpine:3'], { platform: AMD64 })
          ).cancel(),
      },
      {
        apiVersion: '1.52',
        platforms: [AMD64, ARM64],
        call: async (docker: Docker) =>
          (
            await docker.images.save(['alpine:3'], {
              platform: [AMD64, ARM64],
            })
          ).cancel(),
      },
      {
        apiVersion: '1.48',
        platforms: [AMD64],
        call: (docker: Docker) =>
          docker.images.load(new Uint8Array(0), { platform: AMD64 }),
      },
      {
        apiVersion: '1.52',
        platforms: [AMD64, ARM64],
        call: (docker: Docker) =>
          docker.images.load(new Uint8Array(0), { platform: [AMD64, ARM64] }),
      },
    ];

    for (const { apiVersion, platforms, call } of calls) {
      await using engine = await fakeEngine({
        directory: scratch.path,
        apiVersion,
        answer: (request, response) => {
          request.resume();
          if (request.url?.includes('/json')) {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ Id: 'sha256:0' }));
            return;
          }
          response.writeHead(200);
          response.end();
        },
      });
      await using docker = await Docker.connect({ host: engine.host });

      // Act
      await call(docker);

      // Assert
      const [, request] = engine.paths;
      assert.match(request ?? '', new RegExp(`^/v${apiVersion}/images/`));
      assert.deepEqual(platformsOf(request), platforms);
    }
  });

  test('save() with a platform gives only the content of that platform of a multi-platform image', async () => {
    // Arrange: a tag for each platform. The containerd image store keeps both
    // platforms under each tag; the classic image store keeps one platform per tag.
    await using docker = await Docker.connect({ environment: process.env });
    const run = randomUUID();
    const tags = [`zukhruf-test-${run}:amd64`, `zukhruf-test-${run}:arm64`];
    try {
      for (const [index, platform] of [AMD64, ARM64].entries()) {
        await docker.images.pull(MULTI_PLATFORM, {
          platform: `linux/${platform.architecture}`,
        });
        await docker.images.tag(MULTI_PLATFORM, tags[index] ?? '');
      }

      // Act
      const saved = await Promise.all(
        [AMD64, ARM64].map((platform, index) =>
          docker.images
            .save([tags[index] ?? ''], { platform })
            .then(archiveArchitectures),
        ),
      );

      // Assert
      assert.deepEqual(saved, [['amd64'], ['arm64']]);
    } finally {
      await removeOwn(docker, run, ...tags);
    }
  });

  test('inspect() with a platform gives that platform of a multi-platform image, or UnsupportedEngineError below API 1.49', async () => {
    // Arrange
    await using docker = await Docker.connect({ environment: process.env });
    const run = randomUUID();
    const tags = [`zukhruf-test-${run}:amd64`, `zukhruf-test-${run}:arm64`];
    try {
      for (const [index, platform] of [AMD64, ARM64].entries()) {
        await docker.images.pull(MULTI_PLATFORM, {
          platform: `linux/${platform.architecture}`,
        });
        await docker.images.tag(MULTI_PLATFORM, tags[index] ?? '');
      }

      // Act
      const inspected = await Promise.allSettled(
        [AMD64, ARM64].map((platform, index) =>
          docker.images.inspect(tags[index] ?? '', { platform }),
        ),
      );

      // Assert: the engine of the run decides the partition. Docker 28.0 (API 1.48) has no platform for an inspect.
      const [major = 0, minor = 0] = docker.apiVersion.split('.').map(Number);
      if (major === 1 && minor < 49) {
        for (const result of inspected) {
          assert.equal(result.status, 'rejected');
          assert.ok(result.reason instanceof UnsupportedEngineError);
          assert.equal(result.reason.minimumVersion, '1.49');
        }
      } else {
        assert.deepEqual(
          inspected.map((result) =>
            result.status === 'fulfilled'
              ? result.value?.Architecture
              : result.reason,
          ),
          ['amd64', 'arm64'],
        );
      }
    } finally {
      await removeOwn(docker, run, ...tags);
    }
  });

  test('load() with a platform that the archive does not have loads no image', async () => {
    // Arrange: an archive of the amd64 platform only, under a name of this run.
    await using docker = await Docker.connect({ environment: process.env });
    const run = randomUUID();
    const name = `zukhruf-test-${run}:amd64`;
    try {
      await docker.images.pull(MULTI_PLATFORM, { platform: 'linux/amd64' });
      await docker.images.tag(MULTI_PLATFORM, name);
      const archive = await bytesOf(
        await docker.images.save([name], { platform: AMD64 }),
      );
      await docker.images.remove(name);

      // Act
      const loading = await docker.images
        .load(archive, { platform: ARM64 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      // Assert: the containerd image store reports the platform in the
      // progress; the classic image store skips the image and resolves.
      if (loading === undefined) {
        assert.equal(await docker.images.inspect(name), undefined);
      } else {
        assert.ok(loading instanceof DockerEngineError);
        assert.equal(loading.status, undefined);
        assert.match(loading.message, /platform/);
      }
    } finally {
      await removeOwn(docker, run, name);
    }
  });
});
