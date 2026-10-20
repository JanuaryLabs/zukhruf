import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { Docker, DockerEngineError, ImageNotFoundError } from './index.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

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
    assert.match(header, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(
      JSON.parse(Buffer.from(header, 'base64url').toString()),
      auth,
    );
  });
});
